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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { SyncError } from "@notesnook/sync-core";
import {
  describeSqlProvider,
  NeonAccount,
  provisionSupabaseProject,
  sqlStorage,
  sqlSummary,
  SupabaseManagement,
  supabaseOAuthClient,
  supabaseProjectUrl,
} from "../src/sync/sql-providers.ts";
import { PROCEDURE_NAMES } from "../src/rpc/protocol.ts";
import { OBJECTS_TABLE } from "@notesnook/sync-sql";

/**
 * The management APIs, stubbed at the HTTP surface the way the drive
 * providers are: the paths, bodies and headers are the contract, and they
 * were read from the providers' own API references rather than assumed.
 */

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function stub(
  routes: (call: Call) => { status?: number; body?: unknown } | undefined,
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k.toLowerCase()] = String(v);
    }
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = routes(call) ?? { status: 404, body: { message: "no route" } };
    return Promise.resolve(
      new Response(
        answer.body === undefined ? null : JSON.stringify(answer.body),
        {
          status: answer.status ?? 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// Neon
// ---------------------------------------------------------------------------

const NEON_URI =
  "postgresql://neondb_owner:pw@ep-x-123.eu-central-1.aws.neon.tech/neondb?sslmode=require";

Deno.test("neon: creating a project sends the documented body and keeps the URI", async () => {
  const { fetchFn, calls } = stub((call) => {
    if (call.method === "POST" && call.url.endsWith("/projects")) {
      return {
        status: 201,
        body: {
          project: {
            id: "cool-lab-123",
            name: "openotes",
            region_id: "aws-eu-central-1",
            created_at: "2026-09-02T00:00:00Z",
          },
          connection_uris: [{ connection_uri: NEON_URI }],
        },
      };
    }
  });
  const account = new NeonAccount("neon-key", fetchFn);
  const created = await account.createProject({
    name: "openotes",
    regionId: "aws-eu-central-1",
  });

  assertEquals(calls[0].headers.authorization, "Bearer neon-key");
  assertEquals(calls[0].url, "https://console.neon.tech/api/v2/projects");
  assertEquals(calls[0].body, {
    project: { name: "openotes", region_id: "aws-eu-central-1" },
  });
  assertEquals(created.project.id, "cool-lab-123");
  assertEquals(created.connectionString, NEON_URI);
});

Deno.test("neon: an existing project's URI comes from its default branch and first database", async () => {
  const { fetchFn, calls } = stub((call) => {
    if (call.url.endsWith("/projects/p1/branches")) {
      return {
        body: {
          branches: [{ id: "br-old", default: false }, { id: "br-main", default: true }],
        },
      };
    }
    if (call.url.endsWith("/projects/p1/branches/br-main/databases")) {
      return { body: { databases: [{ name: "neondb", owner_name: "neondb_owner" }] } };
    }
    if (call.url.includes("/projects/p1/connection_uri?")) {
      return { body: { uri: NEON_URI } };
    }
  });
  const account = new NeonAccount("k", fetchFn);
  assertEquals(await account.connectionString("p1"), NEON_URI);
  const uriCall = calls.find((c) => c.url.includes("connection_uri"))!;
  const params = new URL(uriCall.url).searchParams;
  assertEquals(params.get("branch_id"), "br-main");
  assertEquals(params.get("database_name"), "neondb");
  assertEquals(params.get("role_name"), "neondb_owner");
});

Deno.test("neon: a refused key says where to make a new one", async () => {
  const { fetchFn } = stub(() => ({ status: 401, body: { message: "unauthorized" } }));
  const error = await assertRejects(
    () => new NeonAccount("bad", fetchFn).projects(),
    SyncError,
  );
  assertEquals(error.code, "unauthorized");
  assert(error.message.includes("API keys"));
});

Deno.test("neon: regions and projects are read in the API's shape", async () => {
  const { fetchFn } = stub((call) => {
    if (call.url.endsWith("/regions")) {
      return {
        body: {
          regions: [{ region_id: "aws-us-east-1", name: "US East (N. Virginia)", default: true }],
        },
      };
    }
    if (call.url.includes("/projects?limit=100")) {
      return {
        body: {
          projects: [{ id: "p1", name: "one", region_id: "aws-us-east-1", created_at: "x" }],
        },
      };
    }
  });
  const account = new NeonAccount("k", fetchFn);
  assertEquals((await account.regions())[0], {
    id: "aws-us-east-1",
    name: "US East (N. Virginia)",
    default: true,
  });
  assertEquals((await account.projects())[0].id, "p1");
});

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

const REF = "abcdefghijklmnopqrst";

Deno.test("supabase: creating a project waits until it is healthy", async () => {
  let polls = 0;
  const { fetchFn, calls } = stub((call) => {
    if (call.method === "POST" && call.url.endsWith("/v1/projects")) {
      return {
        status: 201,
        body: {
          id: "1", ref: REF, name: "openotes", region: "eu-central-1",
          status: "COMING_UP", organization_slug: "org",
        },
      };
    }
    if (call.method === "GET" && call.url.endsWith(`/v1/projects/${REF}`)) {
      polls++;
      return {
        body: {
          id: "1", ref: REF, name: "openotes", region: "eu-central-1",
          status: polls < 3 ? "COMING_UP" : "ACTIVE_HEALTHY", organization_slug: "org",
        },
      };
    }
  });
  const management = new SupabaseManagement("tok", fetchFn, "https://api.supabase.com/v1", 1);
  const { project, databasePassword } = await management.createProject({
    name: "openotes",
    organizationSlug: "org",
    region: "eu-central-1",
  });
  assertEquals(calls[0].headers.authorization, "Bearer tok");
  const body = calls[0].body as Record<string, unknown>;
  assertEquals(body.name, "openotes");
  assertEquals(body.organization_slug, "org");
  assertEquals(body.region, "eu-central-1");
  assertEquals(body.db_pass, databasePassword);
  assert(databasePassword.length >= 32);

  const seen: string[] = [];
  await management.waitUntilReady(project.ref, 10_000, (s) => seen.push(s));
  assertEquals(seen, ["COMING_UP", "COMING_UP", "ACTIVE_HEALTHY"]);
});

Deno.test("supabase: a project that fails to start is an error, not a wait", async () => {
  const { fetchFn } = stub(() => ({
    body: {
      id: "1", ref: REF, name: "x", region: "r", status: "INIT_FAILED", organization_slug: "o",
    },
  }));
  const management = new SupabaseManagement("tok", fetchFn, "https://api.supabase.com/v1", 1);
  await assertRejects(() => management.waitUntilReady(REF, 1000), SyncError, "INIT_FAILED");
});

Deno.test("supabase: provisioning runs the schema, picks the service key and proves it", async () => {
  const { fetchFn, calls } = stub((call) => {
    if (call.url.endsWith(`/v1/projects/${REF}/database/query`)) {
      return { status: 201, body: [] };
    }
    if (call.url.endsWith(`/v1/projects/${REF}/api-keys?reveal=true`)) {
      return {
        body: [
          { name: "anon", api_key: "anon-key", type: "legacy" },
          { name: "service_role", api_key: "service-key", type: "legacy" },
        ],
      };
    }
    if (call.url.startsWith(`https://${REF}.supabase.co/rest/v1/${OBJECTS_TABLE}`)) {
      return { body: [] };
    }
  });
  const management = new SupabaseManagement("tok", fetchFn);
  // The probe inside uses the global fetch; swap it for the stub.
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  try {
    const result = await provisionSupabaseProject(management, REF);
    assertEquals(result.url, `https://${REF}.supabase.co`);
    assertEquals(result.serviceKey, "service-key");
  } finally {
    globalThis.fetch = realFetch;
  }
  const schema = calls.find((c) => c.url.endsWith("/database/query"))!;
  const query = (schema.body as { query: string }).query;
  assert(query.includes(`CREATE TABLE IF NOT EXISTS ${OBJECTS_TABLE}`));
  assert(query.includes("ENABLE ROW LEVEL SECURITY"));
  const probe = calls.find((c) => c.url.includes("/rest/v1/"))!;
  assertEquals(probe.headers.apikey, "service-key");
});

Deno.test("supabase: without a legacy service_role key a secret key is created", async () => {
  const { fetchFn, calls } = stub((call) => {
    if (call.method === "GET" && call.url.endsWith("/api-keys?reveal=true")) {
      return { body: [{ name: "default", api_key: "sb_publishable_x", type: "publishable" }] };
    }
    if (call.method === "POST" && call.url.endsWith("/api-keys?reveal=true")) {
      return { status: 201, body: { name: "openotes_sync", api_key: "sb_secret_y", type: "secret" } };
    }
  });
  const management = new SupabaseManagement("tok", fetchFn);
  assertEquals(await management.serviceKey(REF), "sb_secret_y");
  const created = calls.find((c) => c.method === "POST")!;
  assertEquals((created.body as { type: string }).type, "secret");
});

Deno.test("supabase: the OAuth client uses Basic auth at the token endpoint and no scopes", () => {
  const client = supabaseOAuthClient({ clientId: "id", clientSecret: "secret" });
  assertEquals(client.tokenAuth, "basic");
  assertEquals(client.scopes, []);
  assertEquals(client.authorizeUrl, "https://api.supabase.com/v1/oauth/authorize");
  assertEquals(client.tokenUrl, "https://api.supabase.com/v1/oauth/token");
});

Deno.test("supabase: a project URL is only ever built from a ref", () => {
  assertEquals(supabaseProjectUrl(REF), `https://${REF}.supabase.co`);
  assertThrows(() => supabaseProjectUrl("../evil"), SyncError);
});

// ---------------------------------------------------------------------------
// Storage selection and the settings summary
// ---------------------------------------------------------------------------

Deno.test("neon defaults to the HTTP transport, everything else to a socket", async () => {
  const base = { directory: "Openotes", supabaseUrl: "", timeoutSeconds: 30 };
  const http = sqlStorage(
    { ...base, provider: "neon", sqlTransport: "http" },
    { connectionString: NEON_URI },
    (() => Promise.reject(new TypeError("offline"))) as typeof fetch,
  );
  // Reaching the HTTP transport means fetch is what fails, not a socket.
  const error = await assertRejects(() => http.storage.probe(), SyncError);
  assertEquals(error.code, "network");
  await http.close();

  const missing = () =>
    sqlStorage({ ...base, provider: "supabase", sqlTransport: "http" }, {});
  assertThrows(missing, SyncError, "not connected");
  const noString = () =>
    sqlStorage({ ...base, provider: "postgres", sqlTransport: "socket" }, {});
  assertThrows(noString, SyncError, "connection string");
});

Deno.test("the settings summary never contains the password", () => {
  const summary = sqlSummary(NEON_URI);
  assertEquals(summary, {
    sqlHost: "ep-x-123.eu-central-1.aws.neon.tech",
    sqlDatabase: "neondb",
    sqlUser: "neondb_owner",
  });
});

Deno.test("every SQL provider explains itself and the procedures are allowlisted", () => {
  for (const provider of ["postgres", "neon", "supabase"] as const) {
    const description = describeSqlProvider(provider);
    assert(description.label.length > 0);
    assert(description.manual.length > 0);
    assert(description.schemaSql.includes(OBJECTS_TABLE));
    assertEquals(description.provisions, provider !== "postgres");
  }
  const names = new Set<string>(PROCEDURE_NAMES);
  for (
    const required of [
      "webdav.sqlSetup",
      "webdav.testSql",
      "webdav.connectSql",
      "webdav.disconnectSql",
      "webdav.neonAccount",
      "webdav.provisionNeon",
      "webdav.connectSupabaseAccount",
      "webdav.supabaseAccount",
      "webdav.provisionSupabase",
    ]
  ) {
    assert(names.has(required), `${required} is not on the allowlist`);
  }
});
