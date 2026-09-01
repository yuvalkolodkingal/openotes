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
 * WebDavStore against the fake server: the shared conformance suite, plus
 * the case that is specific to this backend — a server with no MOVE, where
 * WebDavClient silently falls back to GET + PUT + DELETE and moveRecursive
 * has to make sure that fallback is only ever handed a file.
 */

import { assert, assertEquals } from "@std/assert";
import { WebDavClient } from "../src/client.ts";
import { FetchTransport } from "../src/http.ts";
import { WebDavStore } from "../src/webdav-store.ts";
import { FakeWebDavServer } from "./fake-server.ts";
import { runStoreConformance } from "./conformance.ts";

runStoreConformance("WebDavStore", async () => {
  const server = new FakeWebDavServer();
  await server.start();
  return { store: storeFor(server), dispose: () => server.stop() };
});

Deno.test("WebDavStore: moveRecursive walks a subtree without MOVE", async () => {
  // dufs and a few embedded servers answer MOVE with 405. The client hides
  // that behind a GET + PUT + DELETE fallback, so the store cannot tell
  // which kind of server it is on and has to be correct on both.
  await withServer({ noMove: true }, async (server, store) => {
    await store.makeDirectory("staging/sub");
    await store.put("staging/top.bin", bytes("top"));
    await store.put("staging/sub/leaf.bin", bytes("leaf"));

    await store.moveRecursive("staging", "live");

    assert(
      server.requestLog.some(
        (entry) => entry.method === "MOVE" && entry.status === 405,
      ),
      "the MOVE fallback was never exercised, so this proved nothing",
    );
    assertEquals(await store.get("live/top.bin"), bytes("top"));
    assertEquals(await store.get("live/sub/leaf.bin"), bytes("leaf"));

    // The regression this guards: one MOVE aimed at the collection fell
    // back to GET on a directory — an HTML index on a real server — and
    // PUT it into a file named "live", then deleted the tree it came from.
    // A file at either of these paths means the walk collapsed a directory
    // into its own listing.
    assertEquals(await store.getIfExists("live"), undefined);
    assertEquals(await store.getIfExists("live/sub"), undefined);

    assertEquals(await store.list("staging"), []);
    assertEquals(await store.exists("staging/top.bin"), false);
  });
});

Deno.test("WebDavStore: moveRecursive of a file makes its parent", async () => {
  await withServer({ noMove: true }, async (_server, store) => {
    await store.put("loose.bin", bytes("loose"));

    // A native MOVE creates the destination's collection on the way; the
    // fallback's PUT answers 409 without it. moveRecursive has to land the
    // same way whichever server is on the other end.
    await store.moveRecursive("loose.bin", "archive/loose.bin");

    assertEquals(await store.get("archive/loose.bin"), bytes("loose"));
    assertEquals(await store.getIfExists("loose.bin"), undefined);
  });
});

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function storeFor(server: FakeWebDavServer): WebDavStore {
  const client = new WebDavClient(new FetchTransport(), {
    baseUrl: server.url,
    // The fake server listens on loopback without TLS.
    allowInsecureHttp: true,
    // No retries: every failure here is either injected on purpose or a
    // real defect, and retrying would only turn one into a slow version of
    // the other.
    maxRetries: 0,
    requestTimeout: 3000,
    delay: () => Promise.resolve(),
  });
  return new WebDavStore(client);
}

async function withServer(
  options: ConstructorParameters<typeof FakeWebDavServer>[0],
  body: (server: FakeWebDavServer, store: WebDavStore) => Promise<void>,
): Promise<void> {
  const server = new FakeWebDavServer(options);
  await server.start();
  try {
    const store = storeFor(server);
    await store.connect();
    await body(server, store);
  } finally {
    await server.stop();
  }
}
