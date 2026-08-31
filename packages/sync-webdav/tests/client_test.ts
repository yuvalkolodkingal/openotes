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
import { WebDavClient } from "../src/client.ts";
import { FetchTransport, toBasicAuth } from "../src/http.ts";
import { SyncError } from "../src/types.ts";
import { parseMultistatus } from "../src/xml.ts";
import { FakeWebDavServer } from "./fake-server.ts";

function clientFor(
  server: FakeWebDavServer,
  options: {
    username?: string;
    password?: string;
    maxRetries?: number;
    requestTimeout?: number;
  } = {},
) {
  const transport = new FetchTransport(
    options.username
      ? {
        getBasicAuth: () =>
          Promise.resolve(
            toBasicAuth(options.username!, options.password ?? ""),
          ),
      }
      : undefined,
  );
  return new WebDavClient(transport, {
    baseUrl: server.url,
    allowInsecureHttp: true,
    maxRetries: options.maxRetries ?? 0,
    requestTimeout: options.requestTimeout ?? 3000,
    delay: () => Promise.resolve(),
  });
}

async function withServer(
  options: ConstructorParameters<typeof FakeWebDavServer>[0],
  fn: (server: FakeWebDavServer) => Promise<void> | void,
) {
  const server = new FakeWebDavServer(options);
  await server.start();
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

Deno.test("HTTPS is required unless insecure HTTP is explicitly allowed", () => {
  const transport = new FetchTransport();
  const error = assertThrows(
    () => new WebDavClient(transport, { baseUrl: "http://example.com/dav" }),
  );
  assert(error instanceof SyncError);
  assertEquals(error.code, "insecure-url");

  // Explicit opt-in works, and https never needs it.
  new WebDavClient(transport, {
    baseUrl: "http://example.com/dav",
    allowInsecureHttp: true,
  });
  new WebDavClient(transport, { baseUrl: "https://example.com/dav" });
});

function assertThrows(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("Expected function to throw");
}

Deno.test("OPTIONS, MKCOL, PUT, GET, HEAD, DELETE round-trip", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);

    const options = await client.options();
    assert(options.dav.includes("1"));

    await client.mkcolRecursive("vault/objects/");
    const body = new TextEncoder().encode("hello webdav");
    const { etag } = await client.put("vault/objects/a.bin", body);
    assert(etag);

    assertEquals(
      new TextDecoder().decode(await client.get("vault/objects/a.bin")),
      "hello webdav",
    );

    const head = await client.head("vault/objects/a.bin");
    assertEquals(head.exists, true);
    assertEquals(head.contentLength, body.length);

    await client.verifyUpload("vault/objects/a.bin", body.length);

    await client.delete("vault/objects/a.bin");
    assertEquals((await client.head("vault/objects/a.bin")).exists, false);
    // Deleting a missing resource is a no-op, not an error.
    await client.delete("vault/objects/a.bin");
  });
});

Deno.test("PROPFIND lists children and ignores the collection itself", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);
    await client.mkcolRecursive("repo/changes/");
    await client.put("repo/changes/0000000001.bin", "one");
    await client.put("repo/changes/0000000002.bin", "two");

    const entries = await client.list("repo/changes/");
    const names = entries
      .map((entry) => client.relativePath(entry).split("/").pop())
      .sort();
    assertEquals(names, ["0000000001.bin", "0000000002.bin"]);
  });
});

Deno.test("PROPFIND on a missing collection returns an empty list", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);
    assertEquals(await client.list("nope/"), []);
  });
});

Deno.test("absolute hrefs and minimal props are handled", async () => {
  await withServer(
    { absoluteHrefs: true, minimalProps: true },
    async (server) => {
      const client = clientFor(server);
      await client.mkcolRecursive("repo/");
      await client.put("repo/x.bin", "x");
      const entries = await client.list("repo/");
      assertEquals(entries.length, 1);
      assertEquals(client.relativePath(entries[0]), "repo/x.bin");
      // No getcontentlength: verifyUpload must not fail on unknown length.
      await client.verifyUpload("repo/x.bin", 1);
    },
  );
});

Deno.test("If-None-Match prevents overwriting an existing object", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);
    await client.put("a.bin", "first", { ifNoneMatch: true });
    const error = await assertRejects(() =>
      client.put("a.bin", "second", { ifNoneMatch: true })
    );
    assert(error instanceof SyncError);
    assertEquals(error.code, "precondition-failed");
    assertEquals(new TextDecoder().decode(await client.get("a.bin")), "first");
  });
});

Deno.test("If-Match rejects a stale ETag", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);
    const { etag } = await client.put("a.bin", "v1");
    await client.put("a.bin", "v2"); // etag changes
    const error = await assertRejects(() =>
      client.put("a.bin", "v3", { ifMatch: etag })
    );
    assert(error instanceof SyncError);
    assertEquals(error.code, "precondition-failed");
  });
});

Deno.test("MOVE falls back to copy+delete when unsupported", async () => {
  await withServer({ noMove: true }, async (server) => {
    const client = clientFor(server);
    await client.put("from.bin", "payload");
    await client.move("from.bin", "to.bin");
    assertEquals(
      new TextDecoder().decode(await client.get("to.bin")),
      "payload",
    );
    assertEquals((await client.head("from.bin")).exists, false);
  });
});

Deno.test("HTTP error codes map to actionable SyncErrors", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);
    await client.put("a.bin", "x");

    for (
      const [status, code] of [
        [401, "unauthorized"],
        [403, "forbidden"],
        [404, "not-found"],
        [409, "conflict"],
        [412, "precondition-failed"],
      ] as const
    ) {
      server.injectFault({ status, method: "GET" });
      const error = await assertRejects(() => client.get("a.bin"));
      assert(error instanceof SyncError, `status ${status}`);
      assertEquals(error.code, code, `status ${status}`);
      assertEquals(error.status, status);
      // The message must never leak credentials, only the URL and status.
      assert(!error.message.includes("Basic "));
    }
  });
});

Deno.test("500 responses are retried, then surface as server-error", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server, { maxRetries: 2 });
    await client.put("a.bin", "value");

    // Two failures then success: the retry policy should recover.
    server.injectFault({ status: 500, method: "GET", times: 2 });
    assertEquals(new TextDecoder().decode(await client.get("a.bin")), "value");

    // More failures than retries: surfaces as a retryable server error.
    server.injectFault({ status: 503, method: "GET", times: 5 });
    const error = await assertRejects(() => client.get("a.bin"));
    assert(error instanceof SyncError);
    assertEquals(error.code, "server-error");
    assert(error.isRetryable);
  });
});

Deno.test("a hung request times out instead of hanging forever", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server, { requestTimeout: 250, maxRetries: 0 });
    server.injectFault({ hang: true, method: "GET" });
    const error = await assertRejects(() => client.get("whatever.bin"));
    assert(error instanceof SyncError);
    assertEquals(error.code, "timeout");
  });
});

Deno.test("a malformed PROPFIND body is reported, not silently accepted", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);
    await client.mkcolRecursive("repo/");
    server.injectFault({ malformedPropfind: true, method: "PROPFIND" });
    const error = await assertRejects(() => client.list("repo/"));
    assert(error instanceof SyncError);
    assertEquals(error.code, "corrupt-data");
  });
});

Deno.test("a truncated PUT fails upload verification", async () => {
  await withServer({}, async (server) => {
    const client = clientFor(server);
    const body = new TextEncoder().encode("0123456789");
    server.injectFault({ truncatePutTo: 4, method: "PUT" });
    await client.put("a.bin", body);
    const error = await assertRejects(() =>
      client.verifyUpload("a.bin", body.length)
    );
    assert(error instanceof SyncError);
    assertEquals(error.code, "corrupt-data");
  });
});

Deno.test("bad credentials produce an unauthorized error", async () => {
  await withServer(
    { username: "alice", password: "s3cret" },
    async (server) => {
      const good = clientFor(server, { username: "alice", password: "s3cret" });
      await good.put("a.bin", "ok");

      const bad = clientFor(server, { username: "alice", password: "wrong" });
      const error = await assertRejects(() => bad.get("a.bin"));
      assert(error instanceof SyncError);
      assertEquals(error.code, "unauthorized");
    },
  );
});

Deno.test("path traversal segments are rejected", async () => {
  await withServer({}, (server) => {
    const client = clientFor(server);
    for (const path of ["../escape.bin", "a/../../b.bin", "./x"]) {
      const error = assertThrows(() => client.url(path));
      assert(error instanceof SyncError, path);
      assertEquals(error.code, "corrupt-data");
    }
  });
});

Deno.test("PROPFIND parser tolerates prefix and namespace variation", () => {
  const nextcloudStyle = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/user/App/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/user/App/protocol.json</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>412</d:getcontentlength>
        <d:getetag>&quot;abc123&quot;</d:getetag>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><oc:size/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

  const entries = parseMultistatus(nextcloudStyle);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].isCollection, true);
  assertEquals(entries[1].isCollection, false);
  assertEquals(entries[1].contentLength, 412);
  assertEquals(entries[1].etag, '"abc123"');

  // Apache mod_dav uses an lp1: prefix and no explicit namespace declaration.
  const apacheStyle = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:ns0="DAV:">
<D:response xmlns:lp1="DAV:">
<D:href>/dav/App/objects/</D:href>
<D:propstat>
<D:prop>
<lp1:resourcetype><D:collection/></lp1:resourcetype>
<lp1:getlastmodified>Mon, 31 Aug 2026 12:00:00 GMT</lp1:getlastmodified>
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>
</D:multistatus>`;
  const apache = parseMultistatus(apacheStyle);
  assertEquals(apache.length, 1);
  assertEquals(apache[0].isCollection, true);
  assertEquals(apache[0].href, "/dav/App/objects/");
});

Deno.test("percent-encoded hrefs are decoded", () => {
  const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/My%20App/a%2Bb.bin</D:href>
    <D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</D:multistatus>`;
  const entries = parseMultistatus(xml);
  assertEquals(entries[0].href, "/dav/My App/a+b.bin");
});
