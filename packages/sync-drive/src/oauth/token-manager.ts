/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited
Copyright (C) 2026 Openotes contributors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

/**
 * The one place that talks to a token endpoint.
 *
 * Four decisions are worth the paragraph, because each of them is a bug
 * that only shows up hours into a real account:
 *
 *  - The access token is held in memory and nowhere else. It is valid for
 *    an hour; writing it to disk would mean a stolen app-data directory
 *    yields a live token as well as an encrypted refresh token.
 *  - Every response that carries a refresh token is persisted immediately.
 *    Microsoft rotates on every refresh and invalidates the token it was
 *    given, so a single missed write disconnects the account at the next
 *    refresh — an hour later, with no user action in between to blame.
 *  - Refresh happens a minute before expiry, not on the 401. A large upload
 *    that starts with 30 s left on the token would otherwise die halfway.
 *  - Concurrent refreshes are collapsed into one request. Ten parallel
 *    uploads all see the same expired token at the same instant; ten
 *    refreshes would be rate-limited and, on Microsoft, would rotate the
 *    refresh token out from under each other.
 */

import { SyncError } from "@notesnook/sync-remote";
import type {
  DriveProvider,
  OAuthClient,
  TokenSet,
  TokenStorage,
} from "../types.ts";
import { endpointsFor, type ProviderEndpoints } from "./endpoints.ts";
import { parseRetryAfter, RetryAfterError, withRetry } from "../http/retry.ts";

/** Refresh this long before expiry so an in-flight request cannot age out. */
const REFRESH_SKEW_MS = 60_000;

/** All three issue one-hour tokens; used only if `expires_in` is missing. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface TokenManagerOptions {
  client: OAuthClient;
  storage: TokenStorage;
  /** Injected by tests to point the flow at a loopback server. */
  fetch?: typeof fetch;
  /** Injected by tests to make expiry deterministic. */
  now?: () => number;
  requestTimeout?: number;
  maxRetries?: number;
  delay?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Overrides the table in endpoints.ts; tests use a local token endpoint. */
  endpoints?: ProviderEndpoints;
}

export interface AuthorizationCodeGrant {
  /** The `code` query parameter from the loopback redirect. */
  code: string;
  /** Must be byte-identical to the one in the authorization request. */
  redirectUri: string;
  /** The verifier whose challenge started the flow. */
  codeVerifier: string;
}

interface ParsedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds: number;
}

export class TokenManager {
  private readonly client: OAuthClient;
  private readonly storage: TokenStorage;
  private readonly endpoints: ProviderEndpoints;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly delay?: (ms: number) => Promise<void>;
  private readonly random?: () => number;

  /** Memory only — see the note at the top of the file. */
  private tokens?: TokenSet;

  /** The refresh in flight, shared by everyone who asked while it runs. */
  private refreshing?: Promise<string>;

  constructor(options: TokenManagerOptions) {
    this.client = options.client;
    this.storage = options.storage;
    this.endpoints = options.endpoints ?? endpointsFor(options.client.provider);
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeout = options.requestTimeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.delay = options.delay;
    this.random = options.random;
  }

  get provider(): DriveProvider {
    return this.client.provider;
  }

  get label(): string {
    return this.endpoints.label;
  }

  /** Whether a refresh token is on disk, i.e. whether this account is set up. */
  async isConnected(): Promise<boolean> {
    return (await this.storage.read(this.provider)) !== undefined;
  }

  /**
   * Trade the authorization code for tokens. Called once, by the connect
   * flow, with the verifier that produced the challenge.
   */
  async exchangeCode(grant: AuthorizationCodeGrant): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: grant.code,
      redirect_uri: grant.redirectUri,
      code_verifier: grant.codeVerifier,
      client_id: this.client.clientId,
    });
    this.addClientSecret(body);
    // Not retried: an authorization code is single-use, so a retry after a
    // request that did reach the provider spends a code that was already
    // consumed and reports invalid_grant instead of the real failure. This
    // is a user-initiated click; failing it plainly lets them press it
    // again.
    const parsed = await this.post(body, false);
    if (!parsed.refreshToken) {
      // Accepting this would produce a connection that works beautifully
      // for an hour and then cannot be renewed without another browser
      // round trip. The cause is always a missing authorization parameter
      // (Google's access_type/prompt, Dropbox's token_access_type) or a
      // re-consent Google answered from cache.
      throw new SyncError(
        `${this.endpoints.label} did not return a refresh token, so the ` +
          `connection would stop working within the hour. Disconnect the ` +
          `app in your ${this.endpoints.label} account settings and ` +
          `connect again.`,
        "unauthorized",
      );
    }
    await this.apply(parsed);
  }

  /**
   * A token that is valid now and will still be valid a minute from now,
   * refreshing if it is not.
   */
  async getAccessToken(): Promise<string> {
    const current = this.tokens;
    if (current && this.now() + REFRESH_SKEW_MS < current.expiresAt) {
      return current.accessToken;
    }
    return await this.refresh();
  }

  /**
   * Drop the cached access token after the API rejected it. A provider can
   * revoke a token before its stated expiry (password change, consent
   * withdrawn on another device), and without this the manager would go on
   * handing out the dead one until the clock says otherwise.
   */
  invalidateAccessToken(): void {
    this.tokens = undefined;
  }

  /** Forget the account entirely. The UI's "disconnect". */
  async disconnect(): Promise<void> {
    this.tokens = undefined;
    await this.storage.clear(this.provider);
  }

  private refresh(): Promise<string> {
    const existing = this.refreshing;
    if (existing) return existing;
    const started = this.requestRefresh().finally(() => {
      // Only clear our own: a refresh that started after this one finished
      // is still the current one and must stay shared.
      if (this.refreshing === started) this.refreshing = undefined;
    });
    this.refreshing = started;
    return started;
  }

  private async requestRefresh(): Promise<string> {
    const refreshToken = await this.storage.read(this.provider);
    if (!refreshToken) {
      throw new SyncError(
        `Not connected to ${this.endpoints.label}. Connect the account ` +
          `again in Settings.`,
        "unauthorized",
      );
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.client.clientId,
    });
    this.addClientSecret(body);
    const parsed = await this.post(body, true);
    await this.apply(parsed);
    return parsed.accessToken;
  }

  private async apply(parsed: ParsedTokens): Promise<void> {
    if (parsed.refreshToken) {
      // Persisted before the access token is handed out, and awaited: on
      // Microsoft the token used in the request is already dead, so a
      // storage failure means the account is disconnected whatever we do.
      // Failing here says so while the user is watching, instead of an hour
      // later in the middle of a sync.
      await this.storage.write(this.provider, parsed.refreshToken);
    }
    this.tokens = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: this.now() + parsed.expiresInSeconds * 1000,
    };
  }

  private addClientSecret(body: URLSearchParams): void {
    // A public-client registration rejects the whole request when a secret
    // is present, so this is decided by the provider's registration model
    // and not by whether the user happens to have pasted one.
    if (!this.endpoints.requiresClientSecret) return;
    const secret = this.client.clientSecret;
    if (!secret) {
      throw new SyncError(
        `${this.endpoints.label} requires the client secret from your ` +
          `OAuth client. Add it in Settings.`,
        "unauthorized",
      );
    }
    body.set("client_secret", secret);
  }

  private post(body: URLSearchParams, retry: boolean): Promise<ParsedTokens> {
    if (!retry) return this.send(body);
    return withRetry(() => this.send(body), {
      maxRetries: this.maxRetries,
      delay: this.delay,
      random: this.random,
    });
  }

  private async send(body: URLSearchParams): Promise<ParsedTokens> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchFn(this.endpoints.tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: body.toString(),
        signal: controller.signal,
        // A token request carries the refresh token and, for Google, the
        // client secret. A token endpoint has no reason to redirect, so a
        // redirect here is either a hijacked DNS answer or a captive
        // portal; either way the credentials must not follow it.
        redirect: "error",
      });
      const text = await response.text();
      if (!response.ok) throw await this.toError(response, text);
      return parseTokenPayload(text, this.endpoints.label);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      if (controller.signal.aborted) {
        throw new SyncError(
          `${this.endpoints.label} sign-in timed out after ${this.timeout}ms`,
          "timeout",
        );
      }
      throw new SyncError(
        `Could not reach ${this.endpoints.label}: ${describe(error)}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async toError(response: Response, text: string): Promise<SyncError> {
    const payload = asRecord(safeParseJson(text));
    const code = typeof payload?.error === "string" ? payload.error : undefined;
    const description = typeof payload?.error_description === "string"
      ? payload.error_description
      : text.slice(0, 200);
    const suffix = ` (${this.endpoints.label} → HTTP ${response.status}` +
      `${code ? ` ${code}` : ""}${description ? `: ${description}` : ""})`;

    if (code === "invalid_grant") {
      // The refresh token is gone for good: revoked, expired, or — on
      // Microsoft — superseded by a rotation whose result never reached
      // storage. Clearing it is what makes isConnected() report the truth,
      // so the UI can offer "reconnect" instead of retrying forever.
      this.tokens = undefined;
      await this.storage.clear(this.provider);
      return new SyncError(
        `${this.endpoints.label} rejected the saved sign-in. Connect the ` +
          `account again in Settings.` + suffix,
        "unauthorized",
        response.status,
      );
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfter = parseRetryAfter(
        response.headers.get("retry-after"),
        this.now(),
      );
      const message = `${this.endpoints.label} is temporarily unavailable` +
        suffix;
      return retryAfter === undefined
        ? new SyncError(message, "server-error", response.status)
        : new RetryAfterError(
          message,
          "server-error",
          response.status,
          retryAfter,
        );
    }

    if (response.status === 403) {
      return new SyncError(
        `${this.endpoints.label} denied the request` + suffix,
        "forbidden",
        response.status,
      );
    }

    // Everything left is a rejected client: a wrong client id or secret, a
    // scope the registration does not have, a redirect URI that does not
    // match. All of them are fixed by the user in Settings or the
    // provider's console, so none of them are retried.
    return new SyncError(
      `${this.endpoints.label} rejected the sign-in` + suffix,
      "unauthorized",
      response.status,
    );
  }
}

function parseTokenPayload(text: string, label: string): ParsedTokens {
  const record = asRecord(safeParseJson(text));
  if (!record) {
    throw new SyncError(
      `${label} returned a token response that is not JSON`,
      "corrupt-data",
    );
  }
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new SyncError(
      `${label} returned a token response with no access token`,
      "corrupt-data",
    );
  }
  const refreshToken = typeof record.refresh_token === "string" &&
      record.refresh_token.length > 0
    ? record.refresh_token
    : undefined;
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: parseExpiresIn(record.expires_in),
  };
}

/**
 * `expires_in` is a number in every provider's documentation and a string
 * in some of their answers. Treating an unparsable one as an hour is safe
 * in the direction that matters: too short only costs an extra refresh,
 * while too long hands out a dead token.
 */
function parseExpiresIn(value: unknown): number {
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return DEFAULT_EXPIRES_IN_SECONDS;
  }
  return seconds > 0 ? seconds : DEFAULT_EXPIRES_IN_SECONDS;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // An error body that is not JSON is normal (a proxy's HTML 502 page);
    // the caller falls back to the status and the raw text.
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
