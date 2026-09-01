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
 * The OAuth half of the drive backends: PKCE, the per-provider endpoint
 * table, the token lifecycle, the retry policy and the redirect-safe HTTP
 * client.
 *
 * Everything that involves a request runs against a real loopback server
 * rather than a stubbed `fetch`, because the failures these tests exist to
 * catch are failures of what actually goes on the wire — a client_secret
 * arriving at a public-client registration, a bearer token following a
 * redirect off the API's origin. A mock can only report what the code
 * believes it sent; a socket reports what it sent.
 *
 * The one wrapper around `fetch` is `viaFakes`, and it exists for a single
 * reason: AuthorizedFetch refuses to follow anything that is not https, so
 * two loopback servers cannot be addressed as themselves in a redirect
 * test. It rewrites an https authority onto the port its fake listens on
 * and touches nothing else, so every decision about scheme and origin is
 * still made by the code under test.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { SyncError } from "@notesnook/sync-remote";
import {
  createCodeChallenge,
  createCodeVerifier,
  createPkceChallenge,
  createState,
  MAX_VERIFIER_LENGTH,
  MIN_VERIFIER_LENGTH,
  statesMatch,
} from "../src/oauth/pkce.ts";
import {
  buildAuthorizationUrl,
  endpointsFor,
  OAUTH_ENDPOINTS,
} from "../src/oauth/endpoints.ts";
import { TokenManager } from "../src/oauth/token-manager.ts";
import {
  backoffDelay,
  parseRetryAfter,
  RetryAfterError,
  withRetry,
} from "../src/http/retry.ts";
import { AuthorizedFetch } from "../src/http/authorized-fetch.ts";
import type { DriveProvider, OAuthClient, TokenStorage } from "../src/types.ts";

const PROVIDERS: readonly DriveProvider[] = [
  "googledrive",
  "onedrive",
  "dropbox",
];

/** The one registration of the three that carries a client secret. */
const GOOGLE_CLIENT: OAuthClient = {
  provider: "googledrive",
  clientId: "google-client",
  clientSecret: "google-secret",
};

/** A public client: Microsoft rejects the request if a secret turns up. */
const GRAPH_CLIENT: OAuthClient = {
  provider: "onedrive",
  clientId: "graph-client",
};

const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  headers: Headers;
  body: string;
  /**
   * The body parsed as a form. Meaningful only for the token endpoint,
   * which is the only thing here that posts one.
   */
  form: URLSearchParams;
  /** How many requests this fake had already taken, so a handler can
   * answer the first call differently from the second. */
  index: number;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

/** A real HTTP server on a loopback port that remembers what it was sent. */
class FakeServer {
  readonly requests: RecordedRequest[] = [];
  private server?: Deno.HttpServer;

  constructor(private readonly handler: Handler) {}

  get origin(): string {
    const address = this.server?.addr as Deno.NetAddr | undefined;
    if (!address) throw new Error("Fake server was not started");
    return `http://127.0.0.1:${address.port}`;
  }

  start(): void {
    this.server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      async (request) => {
        const body = await request.text();
        const recorded: RecordedRequest = {
          method: request.method,
          path: new URL(request.url).pathname,
          headers: request.headers,
          body,
          form: new URLSearchParams(body),
          index: this.requests.length,
        };
        this.requests.push(recorded);
        return await this.handler(recorded);
      },
    );
  }

  async stop(): Promise<void> {
    await this.server?.shutdown();
    this.server = undefined;
  }
}

async function withServers(
  servers: FakeServer[],
  body: () => Promise<void>,
): Promise<void> {
  for (const server of servers) server.start();
  try {
    await body();
  } finally {
    for (const server of servers) await server.stop();
  }
}

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A TokenStorage that keeps every value it was ever handed, so a test can
 * assert about what was *not* written as well as about what was.
 */
class RecordingStorage implements TokenStorage {
  readonly writes: string[] = [];
  readonly clears: DriveProvider[] = [];
  /** Set to fail the next write, standing in for a locked credential store. */
  writeError?: Error;
  private readonly saved = new Map<DriveProvider, string>();

  constructor(seed?: { provider: DriveProvider; refreshToken: string }) {
    if (seed) this.saved.set(seed.provider, seed.refreshToken);
  }

  read(provider: DriveProvider): Promise<string | undefined> {
    return Promise.resolve(this.saved.get(provider));
  }

  write(provider: DriveProvider, refreshToken: string): Promise<void> {
    this.writes.push(refreshToken);
    if (this.writeError) return Promise.reject(this.writeError);
    this.saved.set(provider, refreshToken);
    return Promise.resolve();
  }

  clear(provider: DriveProvider): Promise<void> {
    this.clears.push(provider);
    this.saved.delete(provider);
    return Promise.resolve();
  }
}

interface ManagerFixture {
  manager: TokenManager;
  storage: RecordingStorage;
  /** Every wait withRetry asked for, in order. Nothing actually sleeps. */
  delays: number[];
}

function managerFor(
  endpoint: FakeServer,
  client: OAuthClient,
  options: {
    storage?: RecordingStorage;
    now?: () => number;
    maxRetries?: number;
  } = {},
): ManagerFixture {
  const storage = options.storage ?? new RecordingStorage();
  const delays: number[] = [];
  const manager = new TokenManager({
    client,
    storage,
    // The shipped table with only the endpoint moved, so the per-provider
    // flags these tests turn on are the ones users will run against.
    endpoints: {
      ...OAUTH_ENDPOINTS[client.provider],
      tokenEndpoint: `${endpoint.origin}/token`,
    },
    now: options.now,
    maxRetries: options.maxRetries ?? 0,
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    // A full-jitter draw of zero makes the recorded waits exact.
    random: () => 0,
    requestTimeout: 5_000,
  });
  return { manager, storage, delays };
}

/** See the note at the top of the file. */
function viaFakes(hosts: Record<string, FakeServer>): typeof fetch {
  return (input, init) => {
    const requested = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    // Keyed by origin, not by host, so a redirect the code should have
    // refused (http://cdn.test) finds nothing rather than quietly working.
    const fake = hosts[requested.origin];
    if (!fake) {
      return Promise.reject(
        new Error(`No fake is listening for ${requested.origin}`),
      );
    }
    return fetch(
      `${fake.origin}${requested.pathname}${requested.search}`,
      init,
    );
  };
}

interface FetchFixture {
  client: AuthorizedFetch;
  delays: number[];
}

function authorizedFetchFor(
  tokenEndpoint: FakeServer,
  hosts: Record<string, FakeServer>,
  options: { maxRetries?: number } = {},
): FetchFixture {
  const { manager } = managerFor(tokenEndpoint, GRAPH_CLIENT, {
    storage: new RecordingStorage({
      provider: "onedrive",
      refreshToken: "stored-refresh",
    }),
  });
  const delays: number[] = [];
  const client = new AuthorizedFetch({
    tokens: manager,
    fetch: viaFakes(hosts),
    maxRetries: options.maxRetries ?? 0,
    delay: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
    requestTimeout: 5_000,
  });
  return { client, delays };
}

/** A token endpoint that issues access-1, access-2, ... on demand. */
function issuingEndpoint(extra: Record<string, unknown> = {}): FakeServer {
  return new FakeServer((request) =>
    json({
      access_token: `access-${request.index + 1}`,
      expires_in: 3600,
      ...extra,
    })
  );
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

Deno.test("a code verifier is 43-128 characters of the unreserved set", () => {
  assertEquals(MIN_VERIFIER_LENGTH, 43);
  assertEquals(MAX_VERIFIER_LENGTH, 128);

  const verifier = createCodeVerifier();
  assertEquals(verifier.length, 64);
  for (
    const candidate of [
      verifier,
      createCodeVerifier(MIN_VERIFIER_LENGTH),
      createCodeVerifier(MAX_VERIFIER_LENGTH),
    ]
  ) {
    // Anything outside RFC 7636's unreserved set would need percent-encoding
    // in the token request, and the verifier the provider hashes would stop
    // being the one we generated.
    assert(/^[A-Za-z0-9\-._~]+$/.test(candidate), candidate);
  }
  assertEquals(createCodeVerifier(MIN_VERIFIER_LENGTH).length, 43);
  assertEquals(createCodeVerifier(MAX_VERIFIER_LENGTH).length, 128);

  // A verifier that ever repeats is a verifier an attacker can replay.
  const drawn = new Set(
    Array.from({ length: 64 }, () => createCodeVerifier()),
  );
  assertEquals(drawn.size, 64);
});

Deno.test("a verifier length outside RFC 7636's bounds is refused, not clamped", () => {
  for (const length of [0, 1, 42, 129, 1024, 64.5, Number.NaN]) {
    const error = assertThrows(
      () => createCodeVerifier(length),
      SyncError,
      undefined,
      `length ${length} was accepted`,
    );
    assertEquals(error.code, "corrupt-data");
  }
});

Deno.test("the S256 challenge is the unpadded base64url SHA-256 of the verifier", async () => {
  // The worked example in RFC 7636 appendix B. A challenge computed any
  // other way produces an authorization code the token endpoint refuses.
  assertEquals(
    await createCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );

  const challenge = await createPkceChallenge();
  assertEquals(challenge.method, "S256");
  assertEquals(
    challenge.challenge,
    await createCodeChallenge(challenge.verifier),
  );
  // A 32-byte digest is 43 base64 characters and one "=" of padding, which
  // the RFC requires stripped.
  assertEquals(challenge.challenge.length, 43);
  assert(!challenge.challenge.includes("="));
});

Deno.test("a state that differs anywhere is rejected", () => {
  const state = createState();
  assertEquals(state.length, 32);
  assert(statesMatch(state, state));

  for (let index = 0; index < state.length; index++) {
    const other = state[index] === "A" ? "B" : "A";
    const mutated = state.slice(0, index) + other + state.slice(index + 1);
    assert(
      !statesMatch(state, mutated),
      `a state differing at position ${index} was accepted`,
    );
  }
  // Truncation and extension are mismatches too: accepting a prefix would
  // let a caller find the value one character at a time.
  assert(!statesMatch(state, state.slice(0, -1)));
  assert(!statesMatch(state, `${state}A`));
  assert(!statesMatch(state, ""));
  assert(!statesMatch("", state));
});

Deno.test("state comparison costs the same whether the first or the last character differs", () => {
  // Long enough that a comparison returning at the first difference would
  // be hundreds of times faster on `early`. The assertion only demands
  // within 4x, so scheduler noise cannot fail it but a short circuit must.
  const length = 200_000;
  const expected = "a".repeat(length);
  const early = `b${expected.slice(1)}`;
  const late = `${expected.slice(1)}b`;

  const time = (received: string) => {
    const started = performance.now();
    statesMatch(expected, received);
    return performance.now() - started;
  };
  const earlySamples: number[] = [];
  const lateSamples: number[] = [];
  for (let round = 0; round < 31; round++) {
    // Interleaved, so a machine that slows down partway slows both.
    earlySamples.push(time(early));
    lateSamples.push(time(late));
  }
  const median = (samples: number[]) =>
    [...samples].sort((a, b) => a - b)[samples.length >> 1];

  const earlyMedian = median(earlySamples);
  const lateMedian = median(lateSamples);
  assert(
    earlyMedian * 4 > lateMedian,
    `an early mismatch took ${earlyMedian.toFixed(3)}ms against ` +
      `${lateMedian.toFixed(3)}ms for a late one, so the comparison is ` +
      `returning as soon as it finds a difference`,
  );
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

Deno.test("every provider's authorization URL carries the PKCE challenge and its own scopes", () => {
  for (const provider of PROVIDERS) {
    const endpoints = OAUTH_ENDPOINTS[provider];
    const redirectUri = `http://${endpoints.loopbackHost}:51789/`;
    const url = new URL(
      buildAuthorizationUrl({
        client: { provider, clientId: "the-client-id" },
        redirectUri,
        codeChallenge: "the-challenge",
        state: "the-state",
      }),
    );

    assertEquals(url.origin + url.pathname, endpoints.authorizationEndpoint);
    assertEquals(url.searchParams.get("client_id"), "the-client-id");
    assertEquals(url.searchParams.get("response_type"), "code");
    assertEquals(url.searchParams.get("redirect_uri"), redirectUri);
    assertEquals(url.searchParams.get("scope"), endpoints.scopes.join(" "));
    assertEquals(url.searchParams.get("state"), "the-state");
    assertEquals(url.searchParams.get("code_challenge"), "the-challenge");
    // "plain" would put the verifier in the URL we are assuming leaks.
    assertEquals(url.searchParams.get("code_challenge_method"), "S256");
  }
});

Deno.test("each provider is asked for the thing that makes it issue a refresh token", () => {
  const parametersFor = (provider: DriveProvider) =>
    new URL(
      buildAuthorizationUrl({
        client: { provider, clientId: "the-client-id" },
        redirectUri: "http://127.0.0.1:51789/",
        codeChallenge: "the-challenge",
        state: "the-state",
      }),
    ).searchParams;

  const google = parametersFor("googledrive");
  assertEquals(google.get("access_type"), "offline");
  // Google issues the refresh token on first consent only, so a reconnect
  // without this returns an access token that cannot be renewed.
  assertEquals(google.get("prompt"), "consent");

  assertEquals(parametersFor("dropbox").get("token_access_type"), "offline");

  // Microsoft spells the same request as a scope rather than a parameter.
  assertEquals(
    parametersFor("onedrive").get("scope"),
    "Files.ReadWrite.AppFolder offline_access",
  );
});

Deno.test("the per-provider quirks that decide whether a connection survives are the documented ones", () => {
  assertEquals(OAUTH_ENDPOINTS.googledrive.requiresClientSecret, true);
  assertEquals(OAUTH_ENDPOINTS.onedrive.requiresClientSecret, false);
  assertEquals(OAUTH_ENDPOINTS.dropbox.requiresClientSecret, false);

  assertEquals(OAUTH_ENDPOINTS.onedrive.rotatesRefreshToken, true);
  assertEquals(OAUTH_ENDPOINTS.googledrive.rotatesRefreshToken, false);
  assertEquals(OAUTH_ENDPOINTS.dropbox.rotatesRefreshToken, false);

  // Registering one spelling and sending the other is rejected with an
  // error that names neither.
  assertEquals(OAUTH_ENDPOINTS.googledrive.loopbackHost, "127.0.0.1");
  assertEquals(OAUTH_ENDPOINTS.onedrive.loopbackHost, "localhost");
  assertEquals(OAUTH_ENDPOINTS.dropbox.loopbackHost, "localhost");

  for (const provider of PROVIDERS) {
    const endpoints = endpointsFor(provider);
    // Every request to these carries the refresh token, and Google's also
    // carries the client secret.
    assert(endpoints.tokenEndpoint.startsWith("https://"), provider);
    assert(endpoints.authorizationEndpoint.startsWith("https://"), provider);
    assert(endpoints.registrationNotes.length > 0, provider);
  }
});

Deno.test("an unknown provider is named in the error rather than yielding undefined endpoints", () => {
  const error = assertThrows(
    () => endpointsFor("icloud" as DriveProvider),
    SyncError,
  );
  assertEquals(error.code, "corrupt-data");
  assertStringIncludes(error.message, "icloud");
});

// ---------------------------------------------------------------------------
// TokenManager: the authorization-code exchange
// ---------------------------------------------------------------------------

Deno.test("exchanging a code stores the refresh token and keeps the access token out of storage", async () => {
  const endpoint = new FakeServer(() =>
    json({
      access_token: "access-only-in-memory",
      refresh_token: "refresh-1",
      expires_in: 3600,
    })
  );
  await withServers([endpoint], async () => {
    const { manager, storage } = managerFor(endpoint, GOOGLE_CLIENT);
    await manager.exchangeCode({
      code: "the-code",
      redirectUri: "http://127.0.0.1:51789/",
      codeVerifier: "the-verifier",
    });

    assertEquals(endpoint.requests.length, 1);
    const request = endpoint.requests[0];
    assertEquals(request.method, "POST");
    assertEquals(
      request.headers.get("content-type"),
      "application/x-www-form-urlencoded",
    );
    assertEquals(request.form.get("grant_type"), "authorization_code");
    assertEquals(request.form.get("code"), "the-code");
    assertEquals(request.form.get("code_verifier"), "the-verifier");
    assertEquals(
      request.form.get("redirect_uri"),
      "http://127.0.0.1:51789/",
    );
    assertEquals(request.form.get("client_id"), "google-client");

    assertEquals(storage.writes, ["refresh-1"]);
    assertEquals(await storage.read("googledrive"), "refresh-1");
    assertEquals(await manager.isConnected(), true);

    // The access token is handed out and never persisted: a stolen app-data
    // directory must not also yield a token that is live right now.
    assertEquals(await manager.getAccessToken(), "access-only-in-memory");
    assertEquals(storage.writes, ["refresh-1"]);
    assertEquals(endpoint.requests.length, 1);
  });
});

Deno.test("an exchange with no refresh token is refused instead of yielding an hour-long connection", async () => {
  const endpoint = new FakeServer(() =>
    json({ access_token: "access-1", expires_in: 3600 })
  );
  await withServers([endpoint], async () => {
    const { manager, storage } = managerFor(endpoint, GOOGLE_CLIENT);
    const error = await assertRejects(
      () =>
        manager.exchangeCode({
          code: "the-code",
          redirectUri: "http://127.0.0.1:51789/",
          codeVerifier: "the-verifier",
        }),
      SyncError,
    );
    assertEquals(error.code, "unauthorized");
    assertStringIncludes(error.message, "did not return a refresh token");
    assertEquals(storage.writes, []);
    assertEquals(await manager.isConnected(), false);
  });
});

Deno.test("an authorization code is never retried, because a code is single-use", async () => {
  const endpoint = new FakeServer(() => json({ error: "server_error" }, 500));
  await withServers([endpoint], async () => {
    const { manager, delays } = managerFor(endpoint, GOOGLE_CLIENT, {
      maxRetries: 3,
    });
    const error = await assertRejects(
      () =>
        manager.exchangeCode({
          code: "the-code",
          redirectUri: "http://127.0.0.1:51789/",
          codeVerifier: "the-verifier",
        }),
      SyncError,
    );
    assertEquals(error.code, "server-error");
    assertEquals(error.status, 500);
    // A retry would spend a code the provider had already consumed and
    // report invalid_grant instead of the 500 that actually happened.
    assertEquals(endpoint.requests.length, 1);
    assertEquals(delays, []);
  });
});

// ---------------------------------------------------------------------------
// TokenManager: refreshing
// ---------------------------------------------------------------------------

Deno.test("a token is reused until one minute before expiry and refreshed at it", async () => {
  const endpoint = issuingEndpoint();
  await withServers([endpoint], async () => {
    const clock = { now: 1_000_000 };
    const { manager } = managerFor(endpoint, GOOGLE_CLIENT, {
      storage: new RecordingStorage({
        provider: "googledrive",
        refreshToken: "refresh-1",
      }),
      now: () => clock.now,
    });

    assertEquals(await manager.getAccessToken(), "access-1");
    const expiresAt = clock.now + 3_600_000;

    // A millisecond more than the skew of life left: still the same token.
    clock.now = expiresAt - 60_001;
    assertEquals(await manager.getAccessToken(), "access-1");
    assertEquals(endpoint.requests.length, 1);

    // Exactly a minute left: refreshed, so an upload starting now cannot
    // age out halfway through.
    clock.now = expiresAt - 60_000;
    assertEquals(await manager.getAccessToken(), "access-2");
    assertEquals(endpoint.requests.length, 2);
  });
});

Deno.test("ten concurrent callers cause exactly one refresh request", async () => {
  const endpoint = issuingEndpoint();
  await withServers([endpoint], async () => {
    const clock = { now: 1_000_000 };
    const { manager } = managerFor(endpoint, GOOGLE_CLIENT, {
      storage: new RecordingStorage({
        provider: "googledrive",
        refreshToken: "refresh-1",
      }),
      now: () => clock.now,
    });

    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => manager.getAccessToken()),
    );
    // A fleet of parallel uploads must not stampede the token endpoint —
    // and on Microsoft would rotate the refresh token out from under each
    // other if they did.
    assertEquals(endpoint.requests.length, 1);
    assertEquals(tokens, Array.from({ length: 10 }, () => "access-1"));

    // The shared promise is released once it settles, so the next expiry
    // still refreshes rather than handing out the stale token forever.
    clock.now += 3_600_000;
    assertEquals(await manager.getAccessToken(), "access-2");
    assertEquals(endpoint.requests.length, 2);
  });
});

Deno.test("a rotated refresh token is sent on the next refresh, and the one it replaced is not", async () => {
  const endpoint = new FakeServer((request) =>
    json({
      access_token: `access-${request.index + 1}`,
      refresh_token: `rotated-${request.index + 1}`,
      expires_in: 3600,
    })
  );
  await withServers([endpoint], async () => {
    const clock = { now: 5_000_000 };
    const storage = new RecordingStorage({
      provider: "onedrive",
      refreshToken: "initial",
    });
    const { manager } = managerFor(endpoint, GRAPH_CLIENT, {
      storage,
      now: () => clock.now,
    });

    assertEquals(await manager.getAccessToken(), "access-1");
    assertEquals(endpoint.requests[0].form.get("grant_type"), "refresh_token");
    assertEquals(endpoint.requests[0].form.get("refresh_token"), "initial");
    // Persisted by the time the access token came back, not at some later
    // convenient moment: "initial" is already dead on Microsoft.
    assertEquals(await storage.read("onedrive"), "rotated-1");

    clock.now += 3_600_000;
    assertEquals(await manager.getAccessToken(), "access-2");
    assertEquals(endpoint.requests[1].form.get("refresh_token"), "rotated-1");
    assertEquals(storage.writes, ["rotated-1", "rotated-2"]);
    assertEquals(await storage.read("onedrive"), "rotated-2");
  });
});

Deno.test("a rotated refresh token that cannot be saved fails the refresh instead of being lost", async () => {
  const endpoint = new FakeServer((request) =>
    json({
      access_token: `access-${request.index + 1}`,
      refresh_token: `rotated-${request.index + 1}`,
      expires_in: 3600,
    })
  );
  await withServers([endpoint], async () => {
    const storage = new RecordingStorage({
      provider: "onedrive",
      refreshToken: "initial",
    });
    storage.writeError = new Error("credential store is locked");
    const { manager } = managerFor(endpoint, GRAPH_CLIENT, { storage });

    await assertRejects(
      () => manager.getAccessToken(),
      Error,
      "credential store is locked",
    );
    // Handing the access token back anyway would leave the account working
    // for an hour and then disconnected, with nothing to point at.
    assertEquals(storage.writes, ["rotated-1"]);
    assertEquals(await storage.read("onedrive"), "initial");

    storage.writeError = undefined;
    assertEquals(await manager.getAccessToken(), "access-2");
    // The failed rotation was never saved, so the retry legitimately still
    // presents the token it started with.
    assertEquals(endpoint.requests[1].form.get("refresh_token"), "initial");
    assertEquals(await storage.read("onedrive"), "rotated-2");
  });
});

Deno.test("invalid_grant clears the saved sign-in so the UI can offer a reconnect", async () => {
  const endpoint = new FakeServer(() =>
    json(
      {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
      400,
    )
  );
  await withServers([endpoint], async () => {
    const storage = new RecordingStorage({
      provider: "googledrive",
      refreshToken: "refresh-1",
    });
    const { manager, delays } = managerFor(endpoint, GOOGLE_CLIENT, {
      storage,
      maxRetries: 3,
    });

    const error = await assertRejects(
      () => manager.getAccessToken(),
      SyncError,
    );
    assertEquals(error.code, "unauthorized");
    assertEquals(error.status, 400);
    assertStringIncludes(
      error.message,
      "Connect the account again in Settings",
    );
    assertStringIncludes(error.message, "Token has been expired or revoked.");

    assertEquals(storage.clears, ["googledrive"]);
    assertEquals(await storage.read("googledrive"), undefined);
    assertEquals(await manager.isConnected(), false);
    // A revoked grant does not come back, so it is not retried.
    assertEquals(endpoint.requests.length, 1);
    assertEquals(delays, []);
  });
});

Deno.test("a refresh with nothing in storage fails before it reaches the network", async () => {
  const endpoint = issuingEndpoint();
  await withServers([endpoint], async () => {
    const { manager } = managerFor(endpoint, GOOGLE_CLIENT);
    const error = await assertRejects(
      () => manager.getAccessToken(),
      SyncError,
    );
    assertEquals(error.code, "unauthorized");
    assertStringIncludes(error.message, "Not connected to Google Drive");
    assertEquals(endpoint.requests.length, 0);
  });
});

Deno.test("disconnect forgets the account, and the access token with it", async () => {
  const endpoint = issuingEndpoint();
  await withServers([endpoint], async () => {
    const storage = new RecordingStorage({
      provider: "dropbox",
      refreshToken: "refresh-1",
    });
    const { manager } = managerFor(
      endpoint,
      { provider: "dropbox", clientId: "dropbox-app-key" },
      { storage },
    );
    assertEquals(await manager.getAccessToken(), "access-1");

    await manager.disconnect();
    assertEquals(storage.clears, ["dropbox"]);
    assertEquals(await manager.isConnected(), false);
    // The in-memory token is dropped too, so nothing keeps working after a
    // disconnect the user asked for.
    const error = await assertRejects(
      () => manager.getAccessToken(),
      SyncError,
    );
    assertEquals(error.code, "unauthorized");
    assertEquals(endpoint.requests.length, 1);
  });
});

// ---------------------------------------------------------------------------
// TokenManager: the client secret
// ---------------------------------------------------------------------------

Deno.test("client_secret is sent for Google and never for the public clients", async () => {
  const endpoint = issuingEndpoint();
  await withServers([endpoint], async () => {
    const google = managerFor(endpoint, GOOGLE_CLIENT, {
      storage: new RecordingStorage({
        provider: "googledrive",
        refreshToken: "refresh-1",
      }),
    });
    await google.manager.getAccessToken();
    assertEquals(
      endpoint.requests[0].form.get("client_secret"),
      "google-secret",
    );

    for (const provider of ["onedrive", "dropbox"] as const) {
      const fixture = managerFor(
        endpoint,
        // The user may well have pasted a secret from some other console;
        // the registration model, not the field, decides.
        { provider, clientId: `${provider}-client`, clientSecret: "leaked" },
        {
          storage: new RecordingStorage({
            provider,
            refreshToken: "refresh-1",
          }),
        },
      );
      await fixture.manager.getAccessToken();
      const request = endpoint.requests[endpoint.requests.length - 1];
      assertEquals(request.form.get("client_id"), `${provider}-client`);
      assertEquals(request.form.get("client_secret"), null);
      assert(
        !request.body.includes("leaked"),
        `${provider} sent a secret: ${request.body}`,
      );
    }
    assertEquals(endpoint.requests.length, 3);
  });
});

Deno.test("Google without a client secret is refused before anything is sent", async () => {
  const endpoint = issuingEndpoint();
  await withServers([endpoint], async () => {
    const { manager } = managerFor(
      endpoint,
      { provider: "googledrive", clientId: "google-client" },
      {
        storage: new RecordingStorage({
          provider: "googledrive",
          refreshToken: "refresh-1",
        }),
      },
    );
    const error = await assertRejects(
      () => manager.getAccessToken(),
      SyncError,
    );
    assertEquals(error.code, "unauthorized");
    assertStringIncludes(error.message, "requires the client secret");
    // Sending the request without it would come back as a generic
    // invalid_client, which is exactly the error nobody can act on.
    assertEquals(endpoint.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// TokenManager: throttling, malformed answers and redirects
// ---------------------------------------------------------------------------

Deno.test("a throttled token request is retried after the Retry-After it named", async () => {
  const endpoint = new FakeServer((request) =>
    request.index === 0
      ? new Response("slow down", {
        status: 429,
        headers: { "retry-after": "2" },
      })
      : json({ access_token: "access-1", expires_in: 3600 })
  );
  await withServers([endpoint], async () => {
    const { manager, delays } = managerFor(endpoint, GOOGLE_CLIENT, {
      storage: new RecordingStorage({
        provider: "googledrive",
        refreshToken: "refresh-1",
      }),
      maxRetries: 3,
    });

    assertEquals(await manager.getAccessToken(), "access-1");
    assertEquals(endpoint.requests.length, 2);
    // The injected random() draws zero, so this is the server's number with
    // no jitter added.
    assertEquals(delays, [2_000]);
  });
});

Deno.test("a Retry-After beyond two minutes is handed back rather than parking the sync cycle", async () => {
  const endpoint = new FakeServer(() =>
    new Response("come back later", {
      status: 429,
      headers: { "retry-after": "121" },
    })
  );
  await withServers([endpoint], async () => {
    const { manager, delays } = managerFor(endpoint, GOOGLE_CLIENT, {
      storage: new RecordingStorage({
        provider: "googledrive",
        refreshToken: "refresh-1",
      }),
      maxRetries: 3,
    });

    const error = await assertRejects(
      () => manager.getAccessToken(),
      SyncError,
    );
    assert(error instanceof RetryAfterError);
    assertEquals(error.retryAfterMs, 121_000);
    // Retryable, so the scheduler can come back to it — just not from
    // inside this cycle, holding its locks and its progress open.
    assertEquals(error.code, "server-error");
    assertEquals(error.isRetryable, true);
    assertEquals(error.status, 429);
    assertEquals(endpoint.requests.length, 1);
    assertEquals(delays, []);
  });
});

Deno.test("expires_in is honoured as a string, and an unusable one falls back to an hour", async () => {
  const endpoint = new FakeServer((request) =>
    request.index === 0
      // Documented as a number by all three, sent as a string by some.
      ? json({ access_token: "access-1", expires_in: "120" })
      : json({ access_token: `access-${request.index + 1}` })
  );
  await withServers([endpoint], async () => {
    const clock = { now: 2_000_000 };
    const { manager } = managerFor(endpoint, GOOGLE_CLIENT, {
      storage: new RecordingStorage({
        provider: "googledrive",
        refreshToken: "refresh-1",
      }),
      now: () => clock.now,
    });

    assertEquals(await manager.getAccessToken(), "access-1");
    clock.now += 59_000;
    assertEquals(await manager.getAccessToken(), "access-1");
    clock.now += 1_000;
    assertEquals(await manager.getAccessToken(), "access-2");

    // The second response omitted expires_in, so it is treated as the hour
    // every provider issues — too short only costs a refresh, too long
    // hands out a dead token.
    const secondExpiry = clock.now + 3_600_000;
    clock.now = secondExpiry - 60_001;
    assertEquals(await manager.getAccessToken(), "access-2");
    clock.now = secondExpiry - 60_000;
    assertEquals(await manager.getAccessToken(), "access-3");
    assertEquals(endpoint.requests.length, 3);
  });
});

Deno.test("a token response that is not a token response is corrupt-data, not an empty token", async () => {
  const endpoint = new FakeServer((request) =>
    request.index === 0
      ? new Response("<html>captive portal</html>", { status: 200 })
      : json({ token_type: "Bearer", expires_in: 3600 })
  );
  await withServers([endpoint], async () => {
    const fixture = () =>
      managerFor(endpoint, GOOGLE_CLIENT, {
        storage: new RecordingStorage({
          provider: "googledrive",
          refreshToken: "refresh-1",
        }),
      });

    const notJson = await assertRejects(
      () => fixture().manager.getAccessToken(),
      SyncError,
    );
    assertEquals(notJson.code, "corrupt-data");
    assertStringIncludes(notJson.message, "not JSON");

    const noToken = await assertRejects(
      () => fixture().manager.getAccessToken(),
      SyncError,
    );
    assertEquals(noToken.code, "corrupt-data");
    assertStringIncludes(noToken.message, "no access token");
  });
});

Deno.test("a token endpoint that redirects is refused, so the refresh token cannot follow it", async () => {
  const elsewhere = new FakeServer(() => new Response("should be unreachable"));
  const endpoint = new FakeServer(() =>
    new Response(null, {
      status: 302,
      headers: { location: `${elsewhere.origin}/token` },
    })
  );
  await withServers([endpoint, elsewhere], async () => {
    const { manager } = managerFor(endpoint, GOOGLE_CLIENT, {
      storage: new RecordingStorage({
        provider: "googledrive",
        refreshToken: "refresh-1",
      }),
    });

    const error = await assertRejects(
      () => manager.getAccessToken(),
      SyncError,
    );
    assertEquals(error.code, "network");
    // A hijacked DNS answer or a captive portal must not be handed the
    // refresh token and, for Google, the client secret.
    assertEquals(elsewhere.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

Deno.test("a failure SyncError does not call retryable is reported on the first attempt", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const error = await assertRejects(
    () =>
      withRetry(
        () => {
          attempts++;
          return Promise.reject(new SyncError("gone", "not-found", 404));
        },
        {
          maxRetries: 5,
          delay: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
        },
      ),
    SyncError,
  );
  assertEquals(error.code, "not-found");
  assertEquals(attempts, 1);
  assertEquals(delays, []);
});

Deno.test("a retryable failure is attempted maxRetries times more, then reported", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  const error = await assertRejects(
    () =>
      withRetry(
        (attempt) => {
          attempts.push(attempt);
          return Promise.reject(new SyncError("busy", "server-error", 503));
        },
        {
          maxRetries: 2,
          delay: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          random: () => 0.5,
        },
      ),
    SyncError,
  );
  assertEquals(error.code, "server-error");
  assertEquals(attempts, [0, 1, 2]);
  // Half of a 500 ms window, then half of a 1000 ms one.
  assertEquals(delays, [250, 500]);
});

Deno.test("a retryable failure that clears returns the operation's value", async () => {
  const delays: number[] = [];
  const value = await withRetry(
    (attempt) =>
      attempt === 0
        ? Promise.reject(new SyncError("dropped", "network"))
        : Promise.resolve("uploaded"),
    {
      delay: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: () => 0.5,
    },
  );
  assertEquals(value, "uploaded");
  assertEquals(delays, [250]);
});

Deno.test("full-jitter backoff is bounded by 32 s and can draw anywhere below it", () => {
  for (let attempt = 0; attempt <= 20; attempt++) {
    // Full jitter is a draw over the whole window, so zero is a legal wait.
    assertEquals(backoffDelay(attempt, () => 0), 0);
    const longest = backoffDelay(attempt, () => 0.999999);
    assert(
      longest >= 0 && longest <= 32_000,
      `attempt ${attempt} drew ${longest}ms`,
    );
  }
  assertEquals(backoffDelay(0, () => 0.5), 250);
  assertEquals(backoffDelay(3, () => 0.5), 2_000);
  // The window stops doubling at 32 s, so a long outage does not turn into
  // an hour-long sleep inside one sync cycle.
  assertEquals(backoffDelay(6, () => 0.5), 16_000);
  assertEquals(backoffDelay(20, () => 0.5), 16_000);
});

Deno.test("Retry-After is read as seconds or as an HTTP date, and never as negative time", () => {
  assertEquals(parseRetryAfter("2"), 2_000);
  assertEquals(parseRetryAfter(" 0.5 "), 500);
  assertEquals(parseRetryAfter("0"), 0);
  assertEquals(parseRetryAfter(undefined), undefined);
  assertEquals(parseRetryAfter(null), undefined);
  assertEquals(parseRetryAfter(""), undefined);
  assertEquals(parseRetryAfter("   "), undefined);
  assertEquals(parseRetryAfter("soon"), undefined);

  // A proxy in front of the API may substitute the date form.
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  assertEquals(
    parseRetryAfter(new Date(now + 120_000).toUTCString(), now),
    120_000,
  );
  // A date already past means "now", not a negative sleep.
  assertEquals(parseRetryAfter(new Date(now - 60_000).toUTCString(), now), 0);
});

// ---------------------------------------------------------------------------
// AuthorizedFetch: where the bearer token is allowed to go
// ---------------------------------------------------------------------------

Deno.test("the bearer token is dropped the moment a redirect leaves the API's origin", async () => {
  const tokens = issuingEndpoint();
  const cdn = new FakeServer(() => new Response("the file bytes"));
  const api = new FakeServer(() =>
    new Response(null, {
      status: 302,
      headers: { location: "https://cdn.test/download" },
    })
  );

  await withServers([tokens, api, cdn], async () => {
    const { client } = authorizedFetchFor(tokens, {
      "https://api.test": api,
      "https://cdn.test": cdn,
    });

    const response = await client.request({
      url: "https://api.test/items/1/content",
    });
    assertEquals(response.status, 200);
    assertEquals(decoder.decode(response.body), "the file bytes");
    assertEquals(response.url, "https://cdn.test/download");

    assertEquals(
      api.requests[0].headers.get("authorization"),
      "Bearer access-1",
    );
    // The download host is not the API and has no business holding a token
    // with write access to the user's drive.
    assertEquals(cdn.requests.length, 1);
    assertEquals(cdn.requests[0].headers.get("authorization"), null);
  });
});

Deno.test("a redirect inside the API's own origin keeps the token", async () => {
  const tokens = issuingEndpoint();
  const api = new FakeServer((request) =>
    request.index === 0
      // Relative, the way a real API writes an internal redirect.
      ? new Response(null, {
        status: 302,
        headers: { location: "/items/1/content?final=1" },
      })
      : new Response("the file bytes")
  );

  await withServers([tokens, api], async () => {
    const { client } = authorizedFetchFor(tokens, { "https://api.test": api });
    const response = await client.request({
      url: "https://api.test/items/1/content",
    });

    assertEquals(decoder.decode(response.body), "the file bytes");
    assertEquals(response.url, "https://api.test/items/1/content?final=1");
    assertEquals(
      api.requests.map((request) => request.headers.get("authorization")),
      ["Bearer access-1", "Bearer access-1"],
    );
  });
});

Deno.test("the token is not re-attached when a redirect chain comes back to the API's origin", async () => {
  const tokens = issuingEndpoint();
  const cdn = new FakeServer(() =>
    new Response(null, {
      status: 302,
      headers: { location: "https://api.test/final" },
    })
  );
  const api = new FakeServer((request) =>
    request.index === 0
      ? new Response(null, {
        status: 302,
        headers: { location: "https://cdn.test/hop" },
      })
      : new Response("the file bytes")
  );

  await withServers([tokens, api, cdn], async () => {
    const { client } = authorizedFetchFor(tokens, {
      "https://api.test": api,
      "https://cdn.test": cdn,
    });
    const response = await client.request({ url: "https://api.test/start" });

    assertEquals(decoder.decode(response.body), "the file bytes");
    assertEquals(cdn.requests[0].headers.get("authorization"), null);
    // By the time the chain points back at the API, the URL was chosen by
    // the foreign host — so it is not our origin's request any more.
    assertEquals(api.requests[1].path, "/final");
    assertEquals(api.requests[1].headers.get("authorization"), null);
  });
});

Deno.test("a redirect to http is refused and the http host is never contacted", async () => {
  const tokens = issuingEndpoint();
  const cdn = new FakeServer(() => new Response("should be unreachable"));
  const api = new FakeServer(() =>
    new Response(null, {
      status: 302,
      headers: { location: "http://cdn.test/download" },
    })
  );

  await withServers([tokens, api, cdn], async () => {
    const { client } = authorizedFetchFor(tokens, {
      "https://api.test": api,
      "https://cdn.test": cdn,
      // Mapped so a followed redirect would reach a live server rather than
      // failing for the wrong reason.
      "http://cdn.test": cdn,
    });

    const error = await assertRejects(
      () => client.request({ url: "https://api.test/items/1/content" }),
      SyncError,
    );
    assertEquals(error.code, "insecure-url");
    assertStringIncludes(error.message, "cdn.test");
    assertEquals(cdn.requests.length, 0);
  });
});

Deno.test("a redirect chain longer than three hops fails instead of being walked again", async () => {
  const tokens = issuingEndpoint();
  const api = new FakeServer((request) =>
    new Response(null, {
      status: 302,
      headers: { location: `/hop-${request.index + 1}` },
    })
  );

  await withServers([tokens, api], async () => {
    const { client, delays } = authorizedFetchFor(
      tokens,
      { "https://api.test": api },
      { maxRetries: 2 },
    );
    const error = await assertRejects(
      () => client.request({ url: "https://api.test/start" }),
      SyncError,
    );
    assertStringIncludes(error.message, "Too many redirects");
    // Not a retryable code: withRetry would walk the whole loop three more
    // times to report the same thing.
    assertEquals(error.code, "corrupt-data");
    assertEquals(api.requests.length, 4);
    assertEquals(delays, []);
  });
});

// ---------------------------------------------------------------------------
// AuthorizedFetch: statuses
// ---------------------------------------------------------------------------

Deno.test("a 401 costs one forced refresh and one replay with the new token", async () => {
  const tokens = issuingEndpoint();
  const api = new FakeServer((request) =>
    request.index === 0
      ? new Response("token revoked", { status: 401 })
      : new Response("the file bytes")
  );

  await withServers([tokens, api], async () => {
    const { client } = authorizedFetchFor(tokens, { "https://api.test": api });
    const response = await client.request({ url: "https://api.test/items/1" });

    assertEquals(response.status, 200);
    assertEquals(decoder.decode(response.body), "the file bytes");
    // A token revoked before its stated expiry costs a retry, not a failed
    // sync.
    assertEquals(
      api.requests.map((request) => request.headers.get("authorization")),
      ["Bearer access-1", "Bearer access-2"],
    );
    assertEquals(tokens.requests.length, 2);
  });
});

Deno.test("a 401 that survives the refresh is reported as unauthorized", async () => {
  const tokens = issuingEndpoint();
  const api = new FakeServer(() => new Response("no", { status: 401 }));

  await withServers([tokens, api], async () => {
    const { client } = authorizedFetchFor(
      tokens,
      { "https://api.test": api },
      { maxRetries: 2 },
    );
    const error = await assertRejects(
      () => client.request({ url: "https://api.test/items/1" }),
      SyncError,
    );
    assertEquals(error.code, "unauthorized");
    assertEquals(error.status, 401);
    assertStringIncludes(
      error.message,
      "Connect the account again in Settings",
    );
    // One refresh and one replay; repeating past that only burns quota.
    assertEquals(api.requests.length, 2);
  });
});

Deno.test("throttling from the API is retried after the Retry-After it named", async () => {
  const tokens = issuingEndpoint();
  const api = new FakeServer((request) =>
    request.index === 0
      ? new Response("slow down", {
        status: 429,
        headers: { "retry-after": "3" },
      })
      : new Response("the file bytes")
  );

  await withServers([tokens, api], async () => {
    const { client, delays } = authorizedFetchFor(
      tokens,
      { "https://api.test": api },
      { maxRetries: 2 },
    );
    const response = await client.request({ url: "https://api.test/items/1" });

    assertEquals(decoder.decode(response.body), "the file bytes");
    assertEquals(delays, [3_000]);
    assertEquals(api.requests.length, 2);
  });
});

Deno.test("a status only the adapter can interpret is returned rather than thrown", async () => {
  const tokens = issuingEndpoint();
  const api = new FakeServer(() =>
    json({ error: { code: "itemNotFound" } }, 404)
  );

  await withServers([tokens, api], async () => {
    const { client } = authorizedFetchFor(tokens, { "https://api.test": api });
    const response = await client.request({ url: "https://api.test/items/1" });

    // What a 404 means differs per provider and per call site — a missing
    // file, a missing folder, a path that has to be created first.
    assertEquals(response.status, 404);
    assertEquals(response.headers["content-type"], "application/json");
    assertEquals(
      decoder.decode(response.body),
      '{"error":{"code":"itemNotFound"}}',
    );
    assertEquals(api.requests.length, 1);
  });
});

Deno.test("an anonymous request carries no Authorization even when the caller set one", async () => {
  const tokens = issuingEndpoint();
  const api = new FakeServer(() => new Response(null, { status: 201 }));

  await withServers([tokens, api], async () => {
    const { client } = authorizedFetchFor(tokens, { "https://api.test": api });
    const response = await client.request({
      url: "https://api.test/upload-session/abc",
      method: "PUT",
      body: "the chunk",
      anonymous: true,
      headers: {
        Authorization: "Bearer would-be-leaked",
        "content-type": "application/octet-stream",
      },
    });

    assertEquals(response.status, 201);
    assertEquals(api.requests[0].method, "PUT");
    assertEquals(api.requests[0].body, "the chunk");
    assertEquals(
      api.requests[0].headers.get("content-type"),
      "application/octet-stream",
    );
    // A pre-signed URL carries its own credential and rejects a bearer
    // token — and the token endpoint is never even asked for one.
    assertEquals(api.requests[0].headers.get("authorization"), null);
    assertEquals(tokens.requests.length, 0);
  });
});
