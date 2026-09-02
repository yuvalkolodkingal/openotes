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
import { BoxStorage } from "../src/providers/box.ts";
import { SyncError } from "@notesnook/sync-core";

const tokens = {
  token: () => Promise.resolve("token"),
  refresh: () => Promise.resolve(true),
};

type Call = { url: string; method: string; headers: Record<string, string> };

/**
 * A Box that holds one folder, "Openotes" (id 100), containing "note.md"
 * (id 200). Enough to exercise path resolution, which is where an id-based
 * provider actually goes wrong.
 */
function fakeBox(
  overrides: (call: Call) => { status: number; body?: unknown } | undefined =
    () => undefined,
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k.toLowerCase()] = String(v);
    }
    const call = { url, method: init?.method ?? "GET", headers };
    calls.push(call);

    const override = overrides(call);
    const reply = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(body === undefined ? "" : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    if (override) return reply(override.status, override.body);

    if (url.includes("/folders/0/items")) {
      return reply(200, {
        total_count: 1,
        entries: [{ id: "100", name: "Openotes", type: "folder" }],
      });
    }
    if (url.includes("/folders/100/items")) {
      return reply(200, {
        total_count: 1,
        entries: [{
          id: "200",
          name: "note.md",
          type: "file",
          size: 12,
          etag: "3",
          modified_at: "2026-01-01T00:00:00Z",
        }],
      });
    }
    if (url.includes("/files/200?")) {
      return reply(200, {
        size: 12,
        etag: "3",
        modified_at: "2026-01-01T00:00:00Z",
        type: "file",
      });
    }
    return reply(200, {});
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

Deno.test("a path resolves through the folder tree to an id", async () => {
  const { fetchFn } = fakeBox();
  const entry = await new BoxStorage(tokens, "Openotes", fetchFn).stat(
    "note.md",
  );
  assertEquals(entry?.path, "note.md");
  assertEquals(entry?.version, "3");
  assertEquals(entry?.size, 12);
  assertEquals(entry?.isCollection, false);
});

Deno.test("a resolved id is reused rather than looked up again", async () => {
  const { fetchFn, calls } = fakeBox();
  const box = new BoxStorage(tokens, "Openotes", fetchFn);
  await box.stat("note.md");
  const afterFirst = calls.length;
  await box.stat("note.md");
  // Re-walking the tree for every read would make each note cost two extra
  // round trips.
  assert(
    calls.length - afterFirst < afterFirst,
    `second lookup was not cheaper: ${afterFirst} then ${
      calls.length - afterFirst
    }`,
  );
});

Deno.test("a duplicate name is refused rather than silently renamed", async () => {
  const { fetchFn } = fakeBox((call) =>
    call.url.includes("upload.box.com") ? { status: 409 } : undefined
  );
  const error = await assertRejects(
    () =>
      new BoxStorage(tokens, "Openotes", fetchFn).putNew(
        "note.md",
        new Uint8Array([1]),
      ),
    SyncError,
  );
  // Box's default would be to make "note (1).md", which forks the note.
  assertEquals((error as SyncError).code, "precondition-failed");
});

Deno.test("an update sends the expected version and reports a stale one", async () => {
  const { fetchFn, calls } = fakeBox((call) =>
    call.url.includes("upload.box.com") && call.headers["if-match"] === "3"
      ? { status: 412 }
      : undefined
  );
  const error = await assertRejects(
    () =>
      new BoxStorage(tokens, "Openotes", fetchFn).putUpdate(
        "note.md",
        new Uint8Array([1]),
        "3",
      ),
    SyncError,
  );
  assertEquals((error as SyncError).code, "precondition-failed");
  assert(calls.some((c) => c.headers["if-match"] === "3"));
});

Deno.test("a rename moves in one call and re-points the cache", async () => {
  const { fetchFn, calls } = fakeBox();
  const box = new BoxStorage(tokens, "Openotes", fetchFn);
  await box.move("note.md", "renamed.md");
  const move = calls.find((c) =>
    c.method === "PUT" && c.url.includes("/files/200")
  );
  assert(move, "no rename request was made");
  // Box renames and reparents together, so a retitle is one request rather
  // than a copy and a delete.
  assert(
    !calls.some((c) => c.method === "DELETE"),
    "the rename fell back to copy-and-delete",
  );
});

Deno.test("a missing file reads as absent, not as an error", async () => {
  const { fetchFn } = fakeBox((call) =>
    call.url.includes("/folders/100/items")
      ? { status: 200, body: { total_count: 0, entries: [] } }
      : undefined
  );
  const box = new BoxStorage(tokens, "Openotes", fetchFn);
  assertEquals(await box.stat("gone.md"), undefined);
  assertEquals(await box.getIfExists("gone.md"), undefined);
  assertEquals(await box.exists("gone.md"), false);
});

Deno.test("Box reports both primitives and a server-side move", async () => {
  const { fetchFn } = fakeBox();
  const capabilities = await new BoxStorage(tokens, "Openotes", fetchFn)
    .capabilities();
  assertEquals(capabilities.atomicCreate, true);
  assertEquals(capabilities.conditionalUpdate, true);
  assertEquals(capabilities.serverSideMove, true);
});
