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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  beginAuthorization,
  isExpired,
  type OAuthClient,
  refreshTokens,
} from "../src/security/oauth.ts";

/**
 * The loopback redirect is the part that looked impossible under
 * `deno desktop` (the runtime substitutes Deno.serve's port and hides the
 * socket from other processes). It works because Deno.listen is untouched —
 * these tests drive the real listener over real TCP to keep it that way.
 */

const client: OAuthClient = {
  clientId: "test-client",
  authorizeUrl: "https://provider.example/authorize",
  tokenUrl: "https://provider.example/token",
  scopes: ["files.read", "files.write"],
};

/** A token endpoint that records what it was asked. */
function fakeTokenEndpoint(
  response: Record<string, unknown>,
  status = 200,
): { fetchFn: typeof fetch; calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Play the browser: fetch the redirect URI the way a real one would. */
async function visitCallback(
  authorizeUrl: string,
  params: Record<string, string>,
): Promise<string> {
  const redirect = new URL(
    new URL(authorizeUrl).searchParams.get("redirect_uri")!,
  );
  for (const [key, value] of Object.entries(params)) {
    redirect.searchParams.set(key, value);
  }
  const response = await fetch(redirect, { signal: AbortSignal.timeout(5000) });
  return await response.text();
}

Deno.test("the authorize URL carries PKCE and a loopback redirect", async () => {
  const request = await beginAuthorization(client);
  const url = new URL(request.url);

  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  assert(url.searchParams.get("code_challenge")!.length > 20);
  assert(url.searchParams.get("state")!.length > 20);
  assertEquals(url.searchParams.get("scope"), "files.read files.write");

  const redirect = new URL(url.searchParams.get("redirect_uri")!);
  // Never 0.0.0.0: the redirect must not be reachable off this machine.
  assertEquals(redirect.hostname, "127.0.0.1");
  assert(Number(redirect.port) > 0);

  // Capture before cancelling: a rejection with no handler attached yet is an
  // unhandled rejection, which takes the whole test runner down.
  const settled = request.completion.catch((e: unknown) => e);
  request.cancel();
  assert(await settled instanceof Error);
});

Deno.test("a browser callback completes the exchange over real TCP", async () => {
  const { fetchFn, calls } = fakeTokenEndpoint({
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    token_type: "Bearer",
  });
  const request = await beginAuthorization(client, { fetchFn });
  const state = new URL(request.url).searchParams.get("state")!;

  const page = await visitCallback(request.url, { code: "the-code", state });
  const tokens = await request.completion;

  assertEquals(tokens.accessToken, "at-1");
  assertEquals(tokens.refreshToken, "rt-1");
  assert(tokens.expiresAt! > Date.now());
  assert(page.includes("connected"), "the browser should see a success page");

  // PKCE: the verifier is sent, and it is not the challenge.
  const body = calls[0];
  assertEquals(body.get("grant_type"), "authorization_code");
  assert(body.get("code_verifier")!.length > 20);
  assertEquals(
    body.get("code_verifier") === new URL(request.url).searchParams.get("code_challenge"),
    false,
  );
});

Deno.test("a callback with the wrong state is refused", async () => {
  const { fetchFn, calls } = fakeTokenEndpoint({ access_token: "at" });
  const request = await beginAuthorization(client, { fetchFn });

  const settled = request.completion.catch((e: unknown) => e);
  await visitCallback(request.url, { code: "stolen", state: "not-ours" });

  const error = await settled;
  assert(error instanceof Error);
  assert(error.message.includes("did not match"));
  // The code must never have been exchanged.
  assertEquals(calls.length, 0);
});

Deno.test("a provider error is surfaced, not swallowed", async () => {
  const { fetchFn } = fakeTokenEndpoint({ access_token: "at" });
  const request = await beginAuthorization(client, { fetchFn });
  const state = new URL(request.url).searchParams.get("state")!;

  const settled = request.completion.catch((e: unknown) => e);
  await visitCallback(request.url, {
    error: "access_denied",
    error_description: "The user said no",
    state,
  });

  const error = await settled;
  assert(error instanceof Error);
  assert(error.message.includes("The user said no"));
});

Deno.test("a token endpoint that refuses the code says so", async () => {
  const { fetchFn } = fakeTokenEndpoint({ error: "invalid_grant" }, 400);
  const request = await beginAuthorization(client, { fetchFn });
  const state = new URL(request.url).searchParams.get("state")!;

  const settled = request.completion.catch((e: unknown) => e);
  await visitCallback(request.url, { code: "expired", state });

  const error = await settled;
  assert(error instanceof Error);
  assert(error.message.includes("400"));
});

Deno.test("an authorization that is never completed times out", async () => {
  const request = await beginAuthorization(client, { timeoutMs: 50 });
  const settled = request.completion.catch((e: unknown) => e);
  const error = await settled;
  assert(error instanceof Error);
  assert(error.message.includes("cancelled or timed out"));
});

Deno.test("a refresh keeps the old refresh token when none is returned", async () => {
  // Providers differ; overwriting with undefined would silently break the
  // next refresh and force a re-login the user cannot explain.
  const { fetchFn } = fakeTokenEndpoint({
    access_token: "at-2",
    expires_in: 3600,
  });
  const tokens = await refreshTokens(client, "rt-original", fetchFn);
  assertEquals(tokens.accessToken, "at-2");
  assertEquals(tokens.refreshToken, "rt-original");
});

Deno.test("a rotated refresh token replaces the old one", async () => {
  const { fetchFn } = fakeTokenEndpoint({
    access_token: "at-3",
    refresh_token: "rt-rotated",
  });
  const tokens = await refreshTokens(client, "rt-original", fetchFn);
  assertEquals(tokens.refreshToken, "rt-rotated");
});

Deno.test("expiry is judged with slack, so a token is refreshed before it fails", () => {
  assertEquals(isExpired({ accessToken: "a" }), false);
  assertEquals(isExpired({ accessToken: "a", expiresAt: Date.now() + 10_000 }), false);
  assertEquals(isExpired({ accessToken: "a", expiresAt: Date.now() - 1 }), true);
});

Deno.test("a client secret is sent only when the provider needs one", async () => {
  const withSecret = { ...client, clientSecret: "not-really-secret" };
  const { fetchFn, calls } = fakeTokenEndpoint({ access_token: "at" });
  await refreshTokens(withSecret, "rt", fetchFn);
  assertEquals(calls[0].get("client_secret"), "not-really-secret");

  const plain = fakeTokenEndpoint({ access_token: "at" });
  await refreshTokens(client, "rt", plain.fetchFn);
  assertEquals(plain.calls[0].get("client_secret"), null);
});
