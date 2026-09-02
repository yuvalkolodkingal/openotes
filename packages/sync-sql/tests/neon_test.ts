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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SyncError } from "@notesnook/sync-core";
import {
  fromByteaValue,
  neonHttpEndpoint,
  NeonHttpExecutor,
  toByteaLiteral,
} from "../src/index.ts";

/**
 * The wire protocol, checked against what @neondatabase/serverless sends.
 * These stub fetch rather than the executor: the headers and body shape are
 * the contract, and a fake that answered at a higher level would not catch
 * a drift in them.
 */

const CONNECTION =
  "postgresql://neondb_owner:secret@ep-cool-lab-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { query: string; params: unknown[] };
}

function stub(
  answer: (call: Call) => { status?: number; body: unknown },
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k.toLowerCase()] = String(v);
    }
    const call: Call = {
      url: String(input),
      headers,
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    const result = answer(call);
    return Promise.resolve(
      new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

Deno.test("the endpoint is /sql on the connection string's host", () => {
  assertEquals(
    neonHttpEndpoint(CONNECTION),
    "https://ep-cool-lab-123456.eu-central-1.aws.neon.tech/sql",
  );
  assertRejects(
    () => Promise.resolve().then(() => neonHttpEndpoint("mysql://x/y")),
    SyncError,
  );
});

Deno.test("a query is POSTed with the driver's headers and body shape", async () => {
  const { fetchFn, calls } = stub(() => ({
    body: {
      fields: [{ name: "path" }, { name: "size" }],
      rows: [["protocol.json", "12"]],
      rowCount: 1,
      command: "SELECT",
    },
  }));
  const executor = new NeonHttpExecutor(CONNECTION, fetchFn);

  const result = await executor.query(
    "SELECT path, size FROM t WHERE path = $1",
    [
      "protocol.json",
    ],
  );

  const call = calls[0];
  assertEquals(
    call.url,
    "https://ep-cool-lab-123456.eu-central-1.aws.neon.tech/sql",
  );
  assertEquals(call.headers["neon-connection-string"], CONNECTION);
  assertEquals(call.headers["neon-raw-text-output"], "true");
  assertEquals(call.headers["neon-array-mode"], "true");
  assertEquals(call.body, {
    query: "SELECT path, size FROM t WHERE path = $1",
    params: ["protocol.json"],
  });
  // Array rows come back as objects keyed by the field names.
  assertEquals(result.rows, [{ path: "protocol.json", size: "12" }]);
  assertEquals(result.rowCount, 1);
});

Deno.test("bytes travel as Postgres's own \\x hex text, both ways", async () => {
  const payload = new Uint8Array([0, 1, 2, 250, 255]);
  const { fetchFn, calls } = stub(() => ({
    body: {
      fields: [{ name: "body" }],
      rows: [["\\x000102faff"]],
      rowCount: 1,
    },
  }));
  const executor = new NeonHttpExecutor(CONNECTION, fetchFn);

  const result = await executor.query("INSERT … $1::bytea RETURNING body", [
    payload,
    42,
    null,
    true,
  ]);

  assertEquals(calls[0].body.params, ["\\x000102faff", "42", null, "true"]);
  assertEquals(toByteaLiteral(payload), "\\x000102faff");
  assertEquals(fromByteaValue(result.rows[0].body), payload);
});

Deno.test("a 400 carries the Postgres error message, and a bad password is unauthorized", async () => {
  const wrong = new NeonHttpExecutor(
    CONNECTION,
    stub(() => ({
      status: 400,
      body: { message: 'relation "x" does not exist', code: "42P01" },
    })).fetchFn,
  );
  const error = await assertRejects(() => wrong.query("SELECT 1"), SyncError);
  assert(error.message.includes("does not exist"));
  assertEquals(error.code, "server-error");

  const denied = new NeonHttpExecutor(
    CONNECTION,
    stub(() => ({
      status: 400,
      body: { message: "password authentication failed", code: "28P01" },
    })).fetchFn,
  );
  const auth = await assertRejects(() => denied.query("SELECT 1"), SyncError);
  assertEquals(auth.code, "unauthorized");
});

Deno.test("a fetch that cannot connect is a network error, never a crash", async () => {
  const executor = new NeonHttpExecutor(
    CONNECTION,
    (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch,
  );
  const error = await assertRejects(
    () => executor.query("SELECT 1"),
    SyncError,
  );
  assertEquals(error.code, "network");
});

Deno.test("malformed bytea from the server is refused rather than decoded wrongly", () => {
  assertRejects(
    () => Promise.resolve().then(() => fromByteaValue("\\xzz")),
    Error,
  );
  assertRejects(
    () => Promise.resolve().then(() => fromByteaValue("not bytea")),
    Error,
  );
});
