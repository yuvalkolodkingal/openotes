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
 * Every HTTP request the three drive adapters make goes through here, for
 * one reason above the others: REDIRECTS.
 *
 * A Graph content GET answers 302 to *.up.1drv.com or *.sharepoint.com, and
 * a Drive `alt=media` download can answer 302 to *.googleusercontent.com.
 * Those hosts are not the API and must never see the bearer token. Left to
 * `redirect: "follow"`, fetch re-sends every header — Authorization
 * included — to whatever host the Location says, so a single compromised
 * or misconfigured redirect would hand out a live token with write access
 * to the user's Drive.
 *
 * So redirects are followed by hand: at most three hops, https only, and
 * the Authorization header is dropped the moment the origin changes and is
 * never put back. Concentrating it here makes that a property of one file
 * with one test, rather than three adapters each remembering.
 *
 * The 401 dance lives here too: one forced refresh and one replay, so a
 * token revoked before its stated expiry costs a retry instead of a failed
 * sync.
 */

import { SyncError } from "@notesnook/sync-remote";
import type { TokenManager } from "../oauth/token-manager.ts";
import { parseRetryAfter, RetryAfterError, withRetry } from "./retry.ts";

/** Deep enough for the provider chains above, shallow enough to be a bug. */
const MAX_REDIRECTS = 3;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 408 and 429 included: both mean "the same request, later". */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 507]);

export interface AuthorizedRequest {
  url: string;
  /** Defaults to GET. */
  method?: string;
  headers?: Record<string, string>;
  /**
   * Bytes or text only. The request is replayed on a retry and on a 401,
   * and a stream cannot be replayed — accepting one here would produce
   * uploads that silently truncate on the second attempt.
   */
  body?: Uint8Array | string;
  /**
   * Send no Authorization header. For pre-signed URLs — a Drive resumable
   * upload session, a Dropbox temporary link — which carry their own
   * credential in the URL and reject a bearer token.
   */
  anonymous?: boolean;
  /** Overrides the client-wide timeout for this request. */
  timeout?: number;
  /** Caller's cancellation, in addition to the timeout. */
  signal?: AbortSignal;
}

export interface AuthorizedResponse {
  status: number;
  /** Header names lowercased, matching sync-remote's HttpResponse. */
  headers: Record<string, string>;
  body: Uint8Array;
  /** Where the response actually came from, after any redirects. */
  url: string;
}

export interface AuthorizedFetchOptions {
  tokens: TokenManager;
  /** Injected by tests to answer without a network. */
  fetch?: typeof fetch;
  requestTimeout?: number;
  maxRetries?: number;
  /** Injectable so tests do not spend real seconds asleep. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable so tests get a predictable jitter. */
  random?: () => number;
}

export class AuthorizedFetch {
  private readonly tokens: TokenManager;
  private readonly fetchFn: typeof fetch;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly delay?: (ms: number) => Promise<void>;
  private readonly random?: () => number;

  constructor(options: AuthorizedFetchOptions) {
    this.tokens = options.tokens;
    this.fetchFn = options.fetch ?? fetch;
    this.timeout = options.requestTimeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.delay = options.delay;
    this.random = options.random;
  }

  /**
   * Perform the request, retrying throttling and server failures.
   *
   * Statuses the adapter has to interpret (404, 409, 412, and Drive's 403
   * with a reason in the body) are RETURNED, because what they mean differs
   * per provider and only the adapter knows. Statuses nobody can act on are
   * thrown: 429 and 5xx as retryable SyncErrors, a 401 that survives a
   * token refresh as `unauthorized`.
   */
  request(request: AuthorizedRequest): Promise<AuthorizedResponse> {
    return withRetry(() => this.attempt(request), {
      maxRetries: this.maxRetries,
      delay: this.delay,
      random: this.random,
    });
  }

  private async attempt(
    request: AuthorizedRequest,
  ): Promise<AuthorizedResponse> {
    const response = await this.follow(request);
    if (response.status !== 401) return this.checkStatus(response, request);

    if (request.anonymous) {
      // Nothing to refresh: the credential was in the URL and has expired.
      throw unauthorized(response, request);
    }
    // The provider revoked the token early, or its clock disagrees with
    // ours. One forced refresh and one replay; a second 401 means the
    // grant itself is gone and repeating would only burn quota.
    this.tokens.invalidateAccessToken();
    const replayed = await this.follow(request);
    if (replayed.status === 401) throw unauthorized(replayed, request);
    return this.checkStatus(replayed, request);
  }

  /** The manual redirect chain. See the note at the top of the file. */
  private async follow(
    request: AuthorizedRequest,
  ): Promise<AuthorizedResponse> {
    let url = request.url;
    let method = request.method ?? "GET";
    let body = request.body;
    // Once false this never goes back to true, so a chain that leaves our
    // origin and returns (A → B → A) still does not re-attach the token:
    // by then the Location was chosen by B.
    let authorize = request.anonymous !== true;

    for (let hop = 0;; hop++) {
      const response = await this.send(url, method, body, request, authorize);
      if (!REDIRECT_STATUS.has(response.status)) return response;
      if (hop >= MAX_REDIRECTS) {
        // Deliberately not a retryable code: a chain this long is a loop or
        // a misconfiguration, and withRetry would walk the whole chain
        // again three more times before reporting the same thing.
        throw new SyncError(
          `Too many redirects (${MAX_REDIRECTS}) starting at ${request.url}`,
          "corrupt-data",
          response.status,
        );
      }

      const next = resolveLocation(response, url);
      if (next.protocol !== "https:") {
        throw new SyncError(
          `Refusing to follow a redirect to ${next.protocol}//${next.host} ` +
            `— drive APIs are https only`,
          "insecure-url",
          response.status,
        );
      }
      if (next.origin !== new URL(url).origin) authorize = false;

      // RFC 9110 §15.4: 303 always becomes a GET, and 301/302 after a
      // non-GET are turned into one by every client in existence. Carrying
      // the body on would re-POST it to the CDN the download redirected to.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method !== "GET" && method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
      }
      url = next.toString();
    }
  }

  private async send(
    url: string,
    method: string,
    body: Uint8Array | string | undefined,
    request: AuthorizedRequest,
    authorize: boolean,
  ): Promise<AuthorizedResponse> {
    const headers = new Headers(request.headers);
    if (authorize) {
      headers.set(
        "Authorization",
        `Bearer ${await this.tokens.getAccessToken()}`,
      );
    } else {
      // The caller may have written one by hand; the guarantee this class
      // makes is that no token reaches a foreign origin, whoever set it.
      headers.delete("Authorization");
    }

    const timeout = request.timeout ?? this.timeout;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const response = await this.fetchFn(url, {
        method,
        headers,
        // The bundled DOM lib types BodyInit's BufferSource narrowly enough
        // that a Uint8Array over an ArrayBufferLike does not match, though
        // Deno's fetch takes one. Same cast as sync-remote's FetchTransport.
        body: body as BodyInit | undefined,
        signal: controller.signal,
        // Deno's fetch hands back the real 3xx response — status, Location
        // and all — under "manual", where a browser would return an opaque
        // filtered response with status 0. This code only ever runs in the
        // desktop process, never in the webview.
        redirect: "manual",
      });
      return {
        status: response.status,
        headers: lowercaseHeaders(response.headers),
        body: new Uint8Array(await response.arrayBuffer()),
        url,
      };
    } catch (error) {
      if (error instanceof SyncError) throw error;
      if (request.signal?.aborted) {
        throw new SyncError(`Request cancelled: ${method} ${url}`, "cancelled");
      }
      if (controller.signal.aborted) {
        throw new SyncError(
          `Request timed out after ${timeout}ms: ${method} ${url}`,
          "timeout",
        );
      }
      throw new SyncError(
        `Network error: ${method} ${url} — ${describe(error)}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private checkStatus(
    response: AuthorizedResponse,
    request: AuthorizedRequest,
  ): AuthorizedResponse {
    if (!RETRYABLE_STATUS.has(response.status)) return response;
    const method = request.method ?? "GET";
    const message = `${describeStatus(response.status)} (${method} ` +
      `${response.url} → HTTP ${response.status})`;
    const retryAfter = parseRetryAfter(response.headers["retry-after"]);
    // Drive answers some throttling with 403 and a reason in the body
    // instead of 429; only the adapter can read that, so it maps that case
    // to a retryable SyncError itself.
    throw retryAfter === undefined
      ? new SyncError(message, "server-error", response.status)
      : new RetryAfterError(
        message,
        "server-error",
        response.status,
        retryAfter,
      );
  }
}

/**
 * Parse a JSON response body. `unknown` on purpose: the three providers
 * disagree about every field name, so validation belongs to the adapter
 * that knows which shape it asked for.
 */
export function decodeJson(response: AuthorizedResponse): unknown {
  if (response.body.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    throw new SyncError(
      `Expected JSON from ${response.url} (HTTP ${response.status})`,
      "corrupt-data",
      response.status,
    );
  }
}

function resolveLocation(response: AuthorizedResponse, from: string): URL {
  const location = response.headers["location"];
  if (!location) {
    throw new SyncError(
      `Redirect (HTTP ${response.status}) from ${from} with no Location`,
      "corrupt-data",
      response.status,
    );
  }
  try {
    return new URL(location, from);
  } catch {
    throw new SyncError(
      `Redirect from ${from} to an unparsable Location`,
      "corrupt-data",
      response.status,
    );
  }
}

function unauthorized(
  response: AuthorizedResponse,
  request: AuthorizedRequest,
): SyncError {
  return new SyncError(
    `Access was refused after refreshing the token ` +
      `(${request.method ?? "GET"} ${response.url} → HTTP 401). ` +
      `Connect the account again in Settings.`,
    "unauthorized",
    response.status,
  );
}

function describeStatus(status: number): string {
  if (status === 408) return "The server timed out waiting for the request";
  if (status === 429) return "Rate limited";
  return "Server error";
}

function lowercaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
