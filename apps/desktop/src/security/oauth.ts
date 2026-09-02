/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

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

import { logger } from "../native/logger.ts";

const log = logger.scope("oauth");

/**
 * OAuth 2.0 Authorization Code with PKCE, for connecting a cloud drive.
 *
 * WHY A LOOPBACK REDIRECT WORKS HERE, WHEN IT LOOKED LIKE IT WOULD NOT
 *
 * native/server.ts documents that under `deno desktop` the runtime owns the
 * listening address: a port passed to `Deno.serve` is ignored, and the socket
 * is wired to the embedded webview rather than published — nothing outside
 * the process can reach it. That would rule out a loopback redirect, because
 * the system browser is very much outside the process.
 *
 * Measured rather than assumed: the substitution applies to `Deno.serve`
 * only. A `Deno.listen` socket in the same process got its own port and was
 * reachable from a separate process, receiving `GET /callback?code=…&state=…`
 * intact. So the ordinary loopback flow is available, and this uses it.
 *
 * WHAT THE FLOW GUARANTEES
 *
 *  - PKCE, so the authorization code is useless to anyone who intercepts it.
 *  - `state`, compared before the code is accepted, so a callback the user did
 *    not initiate is discarded.
 *  - The listener binds 127.0.0.1 explicitly, never 0.0.0.0, so the redirect
 *    is not reachable from the network.
 *  - The listener opens *before* the browser does, so there is no window in
 *    which the callback arrives at a closed port.
 *  - Exactly one connection is served, then it closes.
 */

export interface OAuthClient {
  /**
   * Public client id. Installed-app client ids are not secrets — they are
   * embedded in every copy of the binary and OAuth's threat model accounts
   * for that, which is exactly why PKCE exists.
   */
  clientId: string;
  /**
   * Some providers (Google) still require a "client secret" for installed
   * apps while documenting that it is not treated as confidential. Where a
   * provider does not, this stays undefined.
   */
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra parameters the provider needs on the authorize request. */
  authorizeParams?: Record<string, string>;
  /**
   * How the client authenticates to the token endpoint. Most providers read
   * the id and secret from the form body; Supabase wants them as HTTP Basic.
   */
  tokenAuth?: "body" | "basic";
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds, or undefined when the provider does not say. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export interface AuthorizationRequest {
  /** Where to send the user. */
  url: string;
  /** Resolves when the browser comes back, or rejects on timeout/mismatch. */
  completion: Promise<OAuthTokens>;
  /** Abandon the attempt and release the port. */
  cancel(): void;
}

const CALLBACK_PATH = "/openotes/oauth";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Begin an authorization.
 *
 * Returns immediately with the URL to open and a promise for the result, so
 * the caller can open a browser and show a "waiting" state without racing the
 * listener into existence.
 */
export async function beginAuthorization(
  client: OAuthClient,
  options: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<AuthorizationRequest> {
  const verifier = randomUrlSafe(64);
  const challenge = await codeChallenge(verifier);
  const state = randomUrlSafe(32);

  // Bind before building the URL: the redirect must name a port that is
  // already listening, or a fast browser can arrive at nothing.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

  const url = new URL(client.authorizeUrl);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  // A provider with no scopes (Supabase) rejects an empty scope parameter.
  if (client.scopes.length > 0) {
    url.searchParams.set("scope", client.scopes.join(" "));
  }
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(client.authorizeParams ?? {})) {
    url.searchParams.set(key, value);
  }

  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    try {
      listener.close();
    } catch {
      // Already closed.
    }
  };

  const completion = (async () => {
    const timer = setTimeout(cancel, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const code = await awaitCallback(listener, state);
      return await exchangeCode(
        client,
        code,
        verifier,
        redirectUri,
        options.fetchFn,
      );
    } catch (e) {
      if (cancelled) {
        throw new Error("Authorization was cancelled or timed out.");
      }
      throw e;
    } finally {
      clearTimeout(timer);
      cancel();
    }
  })();

  return { url: url.toString(), completion, cancel };
}

/** Serve exactly one request, validate `state`, return the code. */
async function awaitCallback(
  listener: Deno.Listener,
  expectedState: string,
): Promise<string> {
  const connection = await listener.accept();
  try {
    const buffer = new Uint8Array(8192);
    const read = await connection.read(buffer);
    const request = new TextDecoder().decode(buffer.subarray(0, read ?? 0));
    const target = request.split(/\r?\n/)[0]?.split(" ")[1] ?? "/";
    const url = new URL(target, "http://127.0.0.1");

    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    let message: string;
    let failure: string | undefined;

    if (error) {
      failure = url.searchParams.get("error_description") ?? error;
      message = "Openotes could not connect this account.";
    } else if (state !== expectedState) {
      // A callback we did not initiate. Refuse it without saying why on the
      // page — whoever sent it does not need the detail.
      failure = "The authorization response did not match this request.";
      message = "Openotes could not connect this account.";
    } else if (!code) {
      failure = "The provider did not return an authorization code.";
      message = "Openotes could not connect this account.";
    } else {
      message = "Openotes is connected. You can close this tab.";
    }

    await respond(connection, message);
    if (failure) throw new Error(failure);
    return code!;
  } finally {
    try {
      connection.close();
    } catch {
      // Already closed by the browser.
    }
  }
}

async function respond(connection: Deno.Conn, message: string): Promise<void> {
  const body = `<!doctype html><meta charset="utf-8"><title>Openotes</title>` +
    `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;` +
    `text-align:center"><p>${escapeHtml(message)}</p></body>`;
  const bytes = new TextEncoder().encode(body);
  const headers = new TextEncoder().encode(
    "HTTP/1.1 200 OK\r\n" +
      "Content-Type: text/html; charset=utf-8\r\n" +
      `Content-Length: ${bytes.length}\r\n` +
      "Connection: close\r\n\r\n",
  );
  await connection.write(headers);
  await connection.write(bytes);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]!));
}

async function exchangeCode(
  client: OAuthClient,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const response = await fetchFn(client.tokenUrl, {
    method: "POST",
    headers: tokenHeaders(client, body),
    body,
  });
  if (!response.ok) {
    throw new Error(
      `The provider refused the authorization code (HTTP ${response.status}).`,
    );
  }
  return toTokens(await response.json());
}

/**
 * Trade a refresh token for a fresh access token.
 *
 * Providers differ on whether they return a new refresh token; when one is
 * absent the old one stays valid, so the caller must keep it rather than
 * overwrite it with undefined.
 */
export async function refreshTokens(
  client: OAuthClient,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await fetchFn(client.tokenUrl, {
    method: "POST",
    headers: tokenHeaders(client, body),
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Could not refresh the connection (HTTP ${response.status}). ` +
        `Signing in again will fix it.`,
    );
  }
  const tokens = toTokens(await response.json());
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/**
 * Client credentials on a token request: in the body (the common form) or
 * as HTTP Basic, which is what Supabase's token endpoint expects. The body
 * form is also what every provider test asserts on, so it stays the default.
 */
function tokenHeaders(
  client: OAuthClient,
  body: URLSearchParams,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (client.tokenAuth === "basic") {
    headers.authorization = `Basic ${
      btoa(`${client.clientId}:${client.clientSecret ?? ""}`)
    }`;
  } else {
    body.set("client_id", client.clientId);
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
  }
  return headers;
}

function toTokens(payload: unknown): OAuthTokens {
  const record = (payload ?? {}) as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string") {
    throw new Error("The provider's response did not include an access token.");
  }
  const expiresIn = typeof record.expires_in === "number"
    ? record.expires_in
    : undefined;
  return {
    accessToken,
    refreshToken: typeof record.refresh_token === "string"
      ? record.refresh_token
      : undefined,
    // A minute of slack, so a token that expires mid-request is refreshed
    // before it is used rather than after it fails.
    expiresAt: expiresIn ? Date.now() + (expiresIn - 60) * 1000 : undefined,
    scope: typeof record.scope === "string" ? record.scope : undefined,
    tokenType: typeof record.token_type === "string"
      ? record.token_type
      : undefined,
  };
}

export function isExpired(tokens: OAuthTokens): boolean {
  return tokens.expiresAt !== undefined && Date.now() >= tokens.expiresAt;
}

function randomUrlSafe(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

export { log as oauthLog };
