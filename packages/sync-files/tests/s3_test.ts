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
import { S3Storage } from "../src/providers/s3.ts";
import { SyncError } from "@notesnook/sync-core";

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Uint8Array;
};

function stub(
  handler: (
    call: Call,
  ) => { status?: number; body?: string; headers?: Record<string, string> },
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k.toLowerCase()] = String(v);
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body instanceof Uint8Array ? init.body : undefined,
    };
    calls.push(call);
    const result = handler(call);
    return Promise.resolve(
      new Response(result.body ?? "", {
        status: result.status ?? 200,
        headers: result.headers ?? {},
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function storage(fetchFn: typeof fetch, overrides = {}) {
  return new S3Storage(
    { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    { bucket: "notes", region: "eu-west-1", ...overrides },
    "Openotes",
    fetchFn,
  );
}

Deno.test("every request is signed, and the signature covers the payload", async () => {
  const { fetchFn, calls } = stub(() => ({
    status: 200,
    headers: { etag: '"abc"' },
  }));
  await storage(fetchFn).putUpdate("a.md", new TextEncoder().encode("hello"));

  const call = calls[0];
  assert(
    call.headers.authorization?.startsWith(
      "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/",
    ),
    `not signed: ${call.headers.authorization}`,
  );
  assert(call.headers.authorization.includes("SignedHeaders="));
  // An unsigned payload would let a proxy alter the note in flight.
  assert(
    /^[0-9a-f]{64}$/.test(call.headers["x-amz-content-sha256"] ?? ""),
    "payload hash missing",
  );
  assert(call.headers["x-amz-date"]?.endsWith("Z"));
});

Deno.test("putNew asks the server to refuse an existing object", async () => {
  const { fetchFn, calls } = stub(() => ({
    status: 200,
    headers: { etag: '"v1"' },
  }));
  await storage(fetchFn).putNew("note.md", new Uint8Array([1]));
  assertEquals(calls[0].headers["if-none-match"], "*");
});

Deno.test("a create that loses the race is precondition-failed, not a clobber", async () => {
  const { fetchFn } = stub(() => ({ status: 412 }));
  const error = await assertRejects(
    () => storage(fetchFn).putNew("note.md", new Uint8Array([1])),
    SyncError,
  );
  assertEquals((error as SyncError).code, "precondition-failed");
});

Deno.test("putUpdate sends the expected version and reports a stale one", async () => {
  const { fetchFn, calls } = stub((call) =>
    call.headers["if-match"] === "old" ? { status: 412 } : { status: 200 }
  );
  const error = await assertRejects(
    () => storage(fetchFn).putUpdate("note.md", new Uint8Array([1]), "old"),
    SyncError,
  );
  assertEquals((error as SyncError).code, "precondition-failed");
  assertEquals(calls[0].headers["if-match"], "old");
});

Deno.test("a missing object reads as not-found and stats as undefined", async () => {
  const { fetchFn } = stub(() => ({ status: 404 }));
  const s3 = storage(fetchFn);
  assertEquals(await s3.stat("gone.md"), undefined);
  assertEquals(await s3.getIfExists("gone.md"), undefined);
  const error = await assertRejects(() => s3.get("gone.md"), SyncError);
  assertEquals((error as SyncError).code, "not-found");
});

Deno.test("refused credentials are reported as unauthorized, not as a server fault", async () => {
  const { fetchFn } = stub(() => ({ status: 403, body: "<Error/>" }));
  const error = await assertRejects(
    () => storage(fetchFn).get("a.md"),
    SyncError,
  );
  assertEquals((error as SyncError).code, "unauthorized");
});

Deno.test("listing parses keys, sizes and versions, and follows continuation", async () => {
  let page = 0;
  const { fetchFn } = stub(() => {
    page++;
    return page === 1
      ? {
        body: `<ListBucketResult>
          <IsTruncated>true</IsTruncated>
          <NextContinuationToken>t2</NextContinuationToken>
          <Contents><Key>Openotes/one.md</Key><Size>11</Size>
            <ETag>"e1"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>
        </ListBucketResult>`,
      }
      : {
        body: `<ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <Contents><Key>Openotes/two.md</Key><Size>22</Size>
            <ETag>"e2"</ETag><LastModified>2026-01-02T00:00:00.000Z</LastModified></Contents>
        </ListBucketResult>`,
      };
  });

  const entries = await storage(fetchFn).list("");
  // A single page would silently lose notes past the first thousand.
  assertEquals(entries.length, 2);
  assertEquals(entries.map((e) => e.path), ["one.md", "two.md"]);
  assertEquals(entries[0].size, 11);
  assertEquals(entries[0].version, "e1");
  assertEquals(entries[1].modifiedAt, "2026-01-02T00:00:00.000Z");
  assert(entries.every((e) => e.isCollection === false));
});

Deno.test("a move is a copy and a delete, naming the source bucket", async () => {
  const { fetchFn, calls } = stub((call) =>
    call.method === "HEAD" ? { status: 404 } : { status: 200 }
  );
  await storage(fetchFn).move("old.md", "new.md");
  const copy = calls.find((c) => c.headers["x-amz-copy-source"]);
  assert(copy, "no copy request was made");
  assertEquals(copy.headers["x-amz-copy-source"], "/notes/Openotes/old.md");
  assert(
    calls.some((c) => c.method === "DELETE"),
    "the source was not removed",
  );
});

Deno.test("a truncated upload is caught rather than reported as success", async () => {
  const { fetchFn } = stub((call) =>
    call.method === "HEAD"
      ? { status: 200, headers: { "content-length": "3" } }
      : { status: 200 }
  );
  const error = await assertRejects(
    () => storage(fetchFn).verifyUpload("note.md", 10),
    SyncError,
  );
  assert((error as SyncError).message.includes("3 bytes"));
});

Deno.test("addressing follows the endpoint style the server needs", async () => {
  const virtual = stub(() => ({ status: 200 }));
  await storage(virtual.fetchFn).delete("a.md");
  assert(
    virtual.calls[0].url.startsWith(
      "https://notes.s3.eu-west-1.amazonaws.com/Openotes/a.md",
    ),
    `virtual-hosted addressing wrong: ${virtual.calls[0].url}`,
  );

  const pathStyle = stub(() => ({ status: 200 }));
  await storage(pathStyle.fetchFn, { endpoint: "minio.example.com" }).delete(
    "a.md",
  );
  assert(
    pathStyle.calls[0].url.startsWith(
      "https://minio.example.com/notes/Openotes/a.md",
    ),
    `path-style addressing wrong: ${pathStyle.calls[0].url}`,
  );
});

Deno.test("a key with characters S3 signs differently is encoded consistently", async () => {
  const { fetchFn, calls } = stub(() => ({ status: 200 }));
  await storage(fetchFn).delete("Ivan's note (draft).md");
  // encodeURIComponent leaves ' ( ) alone; SigV4 wants them encoded, and a
  // mismatch is a signature error rather than a wrong path.
  assert(!calls[0].url.includes("'"), `apostrophe left raw: ${calls[0].url}`);
  assert(!calls[0].url.includes("("), `parenthesis left raw: ${calls[0].url}`);
});
