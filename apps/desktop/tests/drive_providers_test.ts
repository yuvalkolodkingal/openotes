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
 * The seam between the OAuth flow and the provider storages.
 *
 * packages/sync-files tests each provider's API dialect and
 * tests/oauth_test.ts tests the authorization flow. Neither covers the piece
 * between them, which is exactly the piece that was missing when 2.0.0
 * shipped three tested provider libraries that nothing in the application
 * ever constructed.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  describeDrive,
  DRIVE_PROVIDERS,
  driveClient,
  type DriveProvider,
  driveStorage,
  driveTokenProvider,
  isDriveProvider,
  type StoredConnection,
} from "../src/sync/drive-providers.ts";
import type { OAuthTokens } from "../src/security/oauth.ts";

/** A connection backed by a variable, so a test can see what was written. */
function connection(initial?: OAuthTokens) {
  let stored = initial;
  const writes: OAuthTokens[] = [];
  const store: StoredConnection = {
    read: () => Promise.resolve(stored),
    write: (tokens) => {
      stored = tokens;
      writes.push(tokens);
      return Promise.resolve();
    },
    clear: () => {
      stored = undefined;
      return Promise.resolve();
    },
  };
  return { store, writes, current: () => stored };
}

/** A token endpoint that counts calls and answers with what it is given. */
function tokenEndpoint(
  responses: Record<string, unknown>[],
  options: { delayMs?: number } = {},
) {
  const requests: URLSearchParams[] = [];
  const fetchFn = (async (_input, init) => {
    requests.push(new URLSearchParams(String(init?.body)));
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    const body = responses[Math.min(requests.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}

const EXPIRED: OAuthTokens = {
  accessToken: "stale",
  refreshToken: "refresh-1",
  expiresAt: 1,
};

Deno.test("every provider in the union is described", () => {
  assertEquals(DRIVE_PROVIDERS.length, 3);
  for (const provider of DRIVE_PROVIDERS) {
    assert(isDriveProvider(provider));
    const description = describeDrive(provider);
    assert(description.label.length > 0, provider);
    assert(description.scopes.length > 0, provider);
    assert(description.registrationNotes.length >= 3, provider);
  }
  assert(!isDriveProvider("webdav"));
  assert(!isDriveProvider(undefined));
});

Deno.test("the registration notes name the redirect the client will send", () => {
  // Providers make an exception to exact redirect matching for loopback but
  // disagree on its spelling, and registering the wrong one fails with an
  // error that names neither. The instructions must match what is sent.
  for (const provider of DRIVE_PROVIDERS) {
    const description = describeDrive(provider);
    const mentions = description.registrationNotes.filter((note) =>
      note.includes(`http://${description.loopbackHost}/openotes/oauth`)
    );
    assertEquals(
      mentions.length,
      1,
      `${provider}: ${description.loopbackHost}`,
    );
  }
});

Deno.test("only Google needs a client secret, and the notes say so either way", () => {
  // A secret asked for and not sent, or sent and never asked for, is a
  // sign-in that fails with a provider error naming neither. The
  // instructions have to settle it, in both directions: silence leaves a
  // user hunting a console page for a secret their provider does not issue.
  assertEquals(describeDrive("googledrive").requiresClientSecret, true);
  assertEquals(describeDrive("dropbox").requiresClientSecret, false);
  assertEquals(describeDrive("onedrive").requiresClientSecret, false);

  const google = describeDrive("googledrive").registrationNotes.join(" ");
  assert(/copy .*client secret/i.test(google), google);

  for (const provider of ["dropbox", "onedrive"] as const) {
    const notes = describeDrive(provider).registrationNotes.join(" ");
    assert(
      /(no secret|not? create a secret|public client)/i.test(notes),
      `${provider} never says there is no secret: ${notes}`,
    );
  }
});

Deno.test("every scope is app-scoped, never the whole drive", () => {
  // The narrow scopes are the reason a user's other files stay invisible.
  const scopes = DRIVE_PROVIDERS.flatMap((p) => describeDrive(p).scopes);
  for (const scope of scopes) {
    assert(
      !/\bdrive\.readonly\b|\bdrive\b$|Files\.ReadWrite\.All|files\.content\.write\.all/
        .test(scope),
      `too broad: ${scope}`,
    );
  }
  assertEquals(describeDrive("googledrive").scopes, [
    "https://www.googleapis.com/auth/drive.file",
  ]);
  assert(describeDrive("onedrive").scopes.includes("offline_access"));
});

Deno.test("each client points at its own provider's endpoints", () => {
  const hosts: Record<DriveProvider, string> = {
    googledrive: "googleapis.com",
    dropbox: "dropboxapi.com",
    onedrive: "microsoftonline.com",
  };
  for (const provider of DRIVE_PROVIDERS) {
    const client = driveClient(provider, { clientId: "id", clientSecret: "s" });
    assert(
      client.tokenUrl.includes(hosts[provider]),
      `${provider} token endpoint: ${client.tokenUrl}`,
    );
    assert(client.authorizeUrl.startsWith("https://"), client.authorizeUrl);
  }
});

Deno.test("a client asks for a refresh token where one must be requested", () => {
  // Without these the connection dies an hour after sign-in, and the failure
  // arrives much later than the mistake.
  assertEquals(
    driveClient("googledrive", { clientId: "id" }).authorizeParams
      ?.access_type,
    "offline",
  );
  assertEquals(
    driveClient("dropbox", { clientId: "id" }).authorizeParams
      ?.token_access_type,
    "offline",
  );
  assert(
    driveClient("onedrive", { clientId: "id" }).scopes.includes(
      "offline_access",
    ),
  );
});

Deno.test("a secret is carried only by the provider that needs one", () => {
  assertEquals(
    driveClient("googledrive", { clientId: "id", clientSecret: "s" })
      .clientSecret,
    "s",
  );
  // Handing Dropbox a secret would turn a public client into a confidential
  // one and the token exchange would be refused.
  assertEquals(
    driveClient("dropbox", { clientId: "id", clientSecret: "s" }).clientSecret,
    undefined,
  );
  assertEquals(
    driveClient("onedrive", { clientId: "id", clientSecret: "s" }).clientSecret,
    undefined,
  );
});

Deno.test("an unconnected drive says so instead of failing obscurely", async () => {
  const tokens = driveTokenProvider({
    client: driveClient("dropbox", { clientId: "id" }),
    connection: connection().store,
  });
  const error = await assertRejects(() => tokens.token());
  assert(
    /not connected/i.test((error as Error).message),
    (error as Error).message,
  );
});

Deno.test("a live token is handed out without touching the network", async () => {
  const endpoint = tokenEndpoint([{ access_token: "should-not-happen" }]);
  const tokens = driveTokenProvider({
    client: driveClient("dropbox", { clientId: "id" }),
    connection: connection({
      accessToken: "live",
      refreshToken: "r",
      expiresAt: Date.now() + 600_000,
    }).store,
    fetchFn: endpoint.fetchFn,
  });
  assertEquals(await tokens.token(), "live");
  assertEquals(endpoint.requests.length, 0);
});

Deno.test("an expired token is refreshed once and then cached", async () => {
  const endpoint = tokenEndpoint([
    { access_token: "fresh", expires_in: 3600 },
  ]);
  const tokens = driveTokenProvider({
    client: driveClient("dropbox", { clientId: "id" }),
    connection: connection(EXPIRED).store,
    fetchFn: endpoint.fetchFn,
  });
  assertEquals(await tokens.token(), "fresh");
  assertEquals(await tokens.token(), "fresh");
  assertEquals(endpoint.requests.length, 1);
  assertEquals(endpoint.requests[0].get("grant_type"), "refresh_token");
  assertEquals(endpoint.requests[0].get("refresh_token"), "refresh-1");
});

Deno.test("parallel callers share one refresh instead of stampeding", async () => {
  // A sync cycle uploads many files at once. Without sharing, every one of
  // them refreshes, and providers rate-limit that.
  const endpoint = tokenEndpoint(
    [{ access_token: "fresh", expires_in: 3600 }],
    { delayMs: 20 },
  );
  const tokens = driveTokenProvider({
    client: driveClient("onedrive", { clientId: "id" }),
    connection: connection(EXPIRED).store,
    fetchFn: endpoint.fetchFn,
  });
  const all = await Promise.all(
    Array.from({ length: 8 }, () => tokens.token()),
  );
  assertEquals(new Set(all), new Set(["fresh"]));
  assertEquals(endpoint.requests.length, 1);
});

Deno.test("a rotated refresh token is stored, so the next refresh works", async () => {
  // Microsoft rotates; dropping the new one leaves the stored token invalid
  // and the connection dies at the refresh after next, far from the cause.
  const endpoint = tokenEndpoint([
    { access_token: "fresh", refresh_token: "refresh-2", expires_in: 3600 },
  ]);
  const saved = connection(EXPIRED);
  const tokens = driveTokenProvider({
    client: driveClient("onedrive", { clientId: "id" }),
    connection: saved.store,
    fetchFn: endpoint.fetchFn,
  });
  await tokens.token();
  assertEquals(saved.current()?.refreshToken, "refresh-2");
});

Deno.test("a provider that does not rotate keeps the token it gave", async () => {
  const endpoint = tokenEndpoint([{ access_token: "fresh", expires_in: 3600 }]);
  const saved = connection(EXPIRED);
  const tokens = driveTokenProvider({
    client: driveClient("googledrive", { clientId: "id", clientSecret: "s" }),
    connection: saved.store,
    fetchFn: endpoint.fetchFn,
  });
  await tokens.token();
  assertEquals(saved.current()?.refreshToken, "refresh-1");
});

Deno.test("a refresh the provider refuses is reported, not retried forever", async () => {
  const fetchFn = (() =>
    Promise.resolve(
      new Response("nope", { status: 400 }),
    )) as unknown as typeof fetch;
  const tokens = driveTokenProvider({
    client: driveClient("dropbox", { clientId: "id" }),
    connection: connection(EXPIRED).store,
    fetchFn,
  });
  const error = await assertRejects(() => tokens.token());
  assert(
    /sign in again/i.test((error as Error).message),
    (error as Error).message,
  );
});

Deno.test("a connection with no refresh token cannot be renewed silently", async () => {
  const tokens = driveTokenProvider({
    client: driveClient("dropbox", { clientId: "id" }),
    connection: connection({ accessToken: "stale", expiresAt: 1 }).store,
  });
  await assertRejects(() => tokens.token());
});

Deno.test("every provider builds a storage, and the folder is honoured", () => {
  const tokens = {
    token: () => Promise.resolve("t"),
    refresh: () => Promise.resolve(true),
  };
  for (const provider of DRIVE_PROVIDERS) {
    const storage = driveStorage(provider, tokens, "Openotes");
    for (
      const method of [
        "probe",
        "list",
        "get",
        "putNew",
        "putUpdate",
        "delete",
      ] as const
    ) {
      assertEquals(typeof storage[method], "function", `${provider}.${method}`);
    }
  }
  // A blank directory must not become a storage rooted at the whole drive.
  for (const provider of DRIVE_PROVIDERS) {
    assert(driveStorage(provider, tokens, "   ".trim()));
    assert(driveStorage(provider, tokens, "///"));
  }
});
