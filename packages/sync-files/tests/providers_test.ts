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
import { SyncError } from "@notesnook/sync-core";
import { DropboxStorage } from "../src/providers/dropbox.ts";
import { OneDriveStorage } from "../src/providers/onedrive.ts";
import { GoogleDriveStorage } from "../src/providers/gdrive.ts";
import { authedFetch, type TokenProvider } from "../src/providers/auth.ts";

/**
 * These stub the providers' HTTP surfaces rather than their classes, so the
 * request shapes -- the headers, the mode objects, the query strings that
 * carry the whole correctness argument -- are what is under test.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

function tokenProvider(overrides: Partial<TokenProvider> = {}): TokenProvider {
  return {
    token: () => Promise.resolve("test-token"),
    refresh: () => Promise.resolve(true),
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fetch that answers from a routing table and records every call. */
function stubFetch(
  routes: (call: Call) => { status?: number; body?: unknown; raw?: Uint8Array },
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init?.headers ?? {})) {
      headers[k.toLowerCase()] = String(v);
    }
    // Bodies arrive as strings for JSON calls and as bytes for uploads; the
    // fakes need to read both, so decode rather than dropping the binary ones.
    let body: string | undefined;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body instanceof Uint8Array) {
      body = new TextDecoder().decode(init.body);
    }

    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body,
    };
    calls.push(call);
    const answer = routes(call);
    if (answer.raw) {
      return new Response(answer.raw as unknown as BodyInit, {
        status: answer.status ?? 200,
      });
    }
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

// ---------------------------------------------------------------------------
// Shared auth layer
// ---------------------------------------------------------------------------

Deno.test("a 401 refreshes the token once and retries", async () => {
  let refreshes = 0;
  let attempt = 0;
  const { fetchFn } = stubFetch(() => {
    attempt++;
    return attempt === 1
      ? { status: 401 }
      : { status: 200, body: { ok: true } };
  });
  const tokens = tokenProvider({
    refresh: () => {
      refreshes++;
      return Promise.resolve(true);
    },
  });

  const result = await authedFetch(tokens, "https://x.example/y", {}, fetchFn);
  assertEquals(result.status, 200);
  assertEquals(refreshes, 1);
  assertEquals(attempt, 2);
});

Deno.test("a second 401 after a refresh means sign in again, not a loop", async () => {
  let attempts = 0;
  const { fetchFn } = stubFetch(() => {
    attempts++;
    return { status: 401 };
  });

  const error = await assertRejects(
    () => authedFetch(tokenProvider(), "https://x.example/y", {}, fetchFn),
    SyncError,
  );
  assertEquals(error.code, "unauthorized");
  // One original attempt plus exactly one retry: never an unbounded loop.
  assertEquals(attempts, 2);
});

Deno.test("running out of space says so, rather than 'unexpected response'", async () => {
  const { fetchFn } = stubFetch(() => ({ status: 507 }));
  const error = await assertRejects(
    () => authedFetch(tokenProvider(), "https://x.example/y", {}, fetchFn),
    SyncError,
  );
  assert(error.message.includes("out of storage"));
});

// ---------------------------------------------------------------------------
// Dropbox
// ---------------------------------------------------------------------------

Deno.test("dropbox creates with mode=add and autorename off", async () => {
  // autorename defaults to true, which would silently fork a note into
  // "note (1).md" instead of reporting the collision.
  const { fetchFn, calls } = stubFetch(() => ({
    body: {
      ".tag": "file",
      name: "a.md",
      path_display: "/Openotes/a.md",
      rev: "r1",
      size: 5,
    },
  }));
  const dropbox = new DropboxStorage(tokenProvider(), "/Openotes", fetchFn);

  await dropbox.putNew("a.md", bytes("hello"));

  const arg = JSON.parse(calls[0].headers["dropbox-api-arg"]);
  assertEquals(arg.mode, { ".tag": "add" });
  assertEquals(arg.autorename, false);
  assertEquals(arg.path, "/Openotes/a.md");
});

Deno.test("dropbox turns a create collision into precondition-failed", async () => {
  const { fetchFn } = stubFetch(() => ({ status: 409, body: { error: {} } }));
  const dropbox = new DropboxStorage(tokenProvider(), "/Openotes", fetchFn);

  const error = await assertRejects(
    () => dropbox.putNew("a.md", bytes("hello")),
    SyncError,
  );
  assertEquals(error.code, "precondition-failed");
});

Deno.test("dropbox updates conditionally on the rev", async () => {
  const { fetchFn, calls } = stubFetch(() => ({
    body: {
      ".tag": "file",
      name: "a.md",
      path_display: "/Openotes/a.md",
      rev: "r2",
    },
  }));
  const dropbox = new DropboxStorage(tokenProvider(), "/Openotes", fetchFn);

  await dropbox.putUpdate("a.md", bytes("new"), "r1");

  const arg = JSON.parse(calls[0].headers["dropbox-api-arg"]);
  assertEquals(arg.mode, { ".tag": "update", update: "r1" });
});

Deno.test("dropbox rejects a stale conditional update", async () => {
  const { fetchFn } = stubFetch(() => ({ status: 409, body: { error: {} } }));
  const dropbox = new DropboxStorage(tokenProvider(), "/Openotes", fetchFn);

  const error = await assertRejects(
    () => dropbox.putUpdate("a.md", bytes("new"), "r1"),
    SyncError,
  );
  assertEquals(error.code, "precondition-failed");
  assert(error.message.includes("changed on Dropbox"));
});

Deno.test("dropbox escapes non-ASCII in the argument header", async () => {
  // The argument rides in an HTTP header; a raw accented character makes the
  // header invalid and the upload fails for the whole note.
  const { fetchFn, calls } = stubFetch(() => ({
    body: { ".tag": "file", name: "x", path_display: "/Openotes/x", rev: "r" },
  }));
  const dropbox = new DropboxStorage(tokenProvider(), "/Openotes", fetchFn);

  await dropbox.putNew("Café — notes.md", bytes("x"));

  const header = calls[0].headers["dropbox-api-arg"];
  // Every character is ASCII, and the originals survive as escapes.
  const highest = Math.max(...[...header].map((c) => c.charCodeAt(0)));
  assert(
    highest <= 0x7f,
    `header must be ASCII-only, saw U+${highest.toString(16)}`,
  );
  assert(header.includes("\\u00e9"));
  assert(header.includes("\\u2014"));
});

Deno.test("a dropbox folder that does not exist lists as empty", async () => {
  const { fetchFn } = stubFetch(() => ({ status: 409, body: { error: {} } }));
  const dropbox = new DropboxStorage(tokenProvider(), "/Openotes", fetchFn);
  assertEquals(await dropbox.list("Missing"), []);
});

// ---------------------------------------------------------------------------
// OneDrive
// ---------------------------------------------------------------------------

Deno.test("onedrive creates with conflictBehavior=fail", async () => {
  const { fetchFn, calls } = stubFetch(() => ({
    body: { id: "1", name: "a.md", size: 5, cTag: "c1", eTag: "e1" },
  }));
  const drive = new OneDriveStorage(tokenProvider(), "Openotes", fetchFn);

  await drive.putNew("a.md", bytes("hello"));

  assert(calls[0].url.includes("conflictBehavior=fail"));
  assertEquals(calls[0].method, "PUT");
});

Deno.test("onedrive updates with if-match", async () => {
  const { fetchFn, calls } = stubFetch(() => ({
    body: { id: "1", name: "a.md", cTag: "c2" },
  }));
  const drive = new OneDriveStorage(tokenProvider(), "Openotes", fetchFn);

  await drive.putUpdate("a.md", bytes("new"), "c1");
  assertEquals(calls[0].headers["if-match"], "c1");
});

Deno.test("onedrive turns 412 into precondition-failed", async () => {
  const { fetchFn } = stubFetch(() => ({ status: 412 }));
  const drive = new OneDriveStorage(tokenProvider(), "Openotes", fetchFn);

  const error = await assertRejects(
    () => drive.putUpdate("a.md", bytes("new"), "c1"),
    SyncError,
  );
  assertEquals(error.code, "precondition-failed");
});

Deno.test("onedrive prefers cTag, because eTag also changes on a rename", async () => {
  // Comparing eTag would report a renamed note as edited and manufacture a
  // conflict copy nobody asked for.
  const { fetchFn } = stubFetch(() => ({
    body: {
      id: "1",
      name: "a.md",
      size: 3,
      cTag: "content-tag",
      eTag: "any-tag",
    },
  }));
  const drive = new OneDriveStorage(tokenProvider(), "Openotes", fetchFn);

  const entry = await drive.stat("a.md");
  assertEquals(entry?.version, "content-tag");
});

Deno.test("onedrive percent-encodes path segments", async () => {
  const { fetchFn, calls } = stubFetch(() => ({ status: 404 }));
  const drive = new OneDriveStorage(tokenProvider(), "Openotes", fetchFn);

  await drive.stat("Work Notes/Q3 plan.md");
  assert(calls[0].url.includes("Work%20Notes/Q3%20plan.md"));
});

// ---------------------------------------------------------------------------
// Google Drive -- the backend with neither primitive
// ---------------------------------------------------------------------------

/** A minimal in-memory Drive: files with ids, names, parents. */
function fakeDrive(seed: { id: string; name: string; parent: string }[] = []) {
  const files = new Map(
    seed.map((f) => [f.id, { ...f, revision: "rev-1", size: 1 }]),
  );
  let nextId = 100;
  /**
   * When set, a competing device creates this name the instant after our own
   * upload lands -- which is exactly the window Drive cannot close, since it
   * has no create-if-absent. Its id sorts below any we generate, so it wins.
   */
  let raceAfterUpload: string | undefined;
  const trashed: string[] = [];

  const { fetchFn, calls } = stubFetch((call) => {
    const url = new URL(call.url);

    const isUpload = url.pathname.startsWith("/upload/");

    // Content upload of an existing file (PATCH ...?uploadType=media).
    if (isUpload && call.method === "PATCH") {
      const id = /\/files\/([^/?]+)/.exec(url.pathname)?.[1] ?? "";
      const file = files.get(id);
      if (!file) return { status: 404 };
      file.revision = `rev-${nextId++}`;
      file.size = call.body?.length ?? 0;
      return {
        body: {
          id: file.id,
          name: file.name,
          size: String(file.size),
          headRevisionId: file.revision,
        },
      };
    }

    // files.list
    if (
      !isUpload && url.pathname.endsWith("/drive/v3/files") &&
      call.method === "GET"
    ) {
      const query = url.searchParams.get("q") ?? "";
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]
        ?.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
      const matches = [...files.values()].filter((f) =>
        (!parent || f.parent === parent) && (!name || f.name === name) &&
        !trashed.includes(f.id)
      );
      return {
        body: {
          files: matches.map((f) => ({
            id: f.id,
            name: f.name,
            size: String(f.size),
            headRevisionId: f.revision,
          })),
        },
      };
    }

    // files.create (folder) -- metadata only, never the multipart upload
    if (
      !isUpload && url.pathname.endsWith("/drive/v3/files") &&
      call.method === "POST"
    ) {
      const meta = JSON.parse(call.body ?? "{}");
      const id = `f${nextId++}`;
      files.set(id, {
        id,
        name: meta.name,
        parent: meta.parents?.[0] ?? "root",
        revision: "rev-1",
        size: 0,
      });
      return { body: { id } };
    }

    // Multipart create: metadata and content in one request.
    if (isUpload && call.method === "POST") {
      const meta = JSON.parse(
        /\{"name".*?\}/.exec(call.body ?? "")?.[0] ?? "{}",
      );
      const id = `u${nextId++}`;
      files.set(id, {
        id,
        name: meta.name,
        parent: meta.parents?.[0] ?? "root",
        revision: "rev-1",
        size: 5,
      });
      if (raceAfterUpload && meta.name === raceAfterUpload) {
        // The other device's write lands between our create and our re-check.
        files.set("000-other-device", {
          id: "000-other-device",
          name: meta.name,
          parent: meta.parents?.[0] ?? "root",
          revision: "rev-1",
          size: 5,
        });
        raceAfterUpload = undefined;
      }
      return {
        body: { id, name: meta.name, size: "5", headRevisionId: "rev-1" },
      };
    }

    // files.get / update / trash
    const idMatch = /\/drive\/v3\/files\/([^/?]+)/.exec(url.pathname);
    if (idMatch) {
      const file = files.get(idMatch[1]);
      if (!file) return { status: 404 };
      if (call.method === "PATCH") {
        const patch = JSON.parse(call.body ?? "{}");
        if (patch.trashed) trashed.push(file.id);
        return { body: { id: file.id } };
      }
      return {
        body: {
          id: file.id,
          name: file.name,
          size: String(file.size),
          headRevisionId: file.revision,
        },
      };
    }
    return { body: {} };
  });

  return {
    fetchFn,
    calls,
    files,
    trashed,
    raceOn: (name: string) => (raceAfterUpload = name),
    bump: (id: string, revision: string) => {
      const file = files.get(id);
      if (file) file.revision = revision;
    },
  };
}

Deno.test("google drive is honest that it cannot guarantee atomicity", async () => {
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fakeDrive().fetchFn,
  );
  const caps = await drive.capabilities();
  // The whole point: a caller must be able to see this rather than assume it.
  assertEquals(caps.atomicCreate, false);
  assertEquals(caps.conditionalUpdate, false);
});

Deno.test("google drive refuses to create over a file it can already see", async () => {
  const fake = fakeDrive([
    { id: "root-folder", name: "Openotes", parent: "root" },
    { id: "file-1", name: "a.md", parent: "root-folder" },
  ]);
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fake.fetchFn,
  );

  const error = await assertRejects(
    () => drive.putNew("a.md", bytes("hello")),
    SyncError,
  );
  assertEquals(error.code, "precondition-failed");
});

Deno.test("losing a create race deletes OUR file, never the winner's", async () => {
  // Drive allows duplicate names, so two devices can both create "a.md".
  // The loser must retreat by removing the file whose id it knows -- touching
  // the winner's would destroy the note that actually survived.
  const fake = fakeDrive([
    { id: "root-folder", name: "Openotes", parent: "root" },
  ]);
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fake.fetchFn,
  );
  fake.raceOn("a.md");

  const error = await assertRejects(
    () => drive.putNew("a.md", bytes("hello")),
    SyncError,
  );
  assertEquals(error.code, "precondition-failed");
  assert(error.message.includes("another device"));

  assertEquals(fake.trashed.length, 1);
  assert(
    fake.trashed[0].startsWith("u"),
    `expected our own uploaded file to be trashed, got ${fake.trashed[0]}`,
  );
  assert(
    !fake.trashed.includes("000-other-device"),
    "the winner's file must never be touched",
  );
});

Deno.test("google drive rejects an update whose revision moved on", async () => {
  const fake = fakeDrive([
    { id: "root-folder", name: "Openotes", parent: "root" },
    { id: "file-1", name: "a.md", parent: "root-folder" },
  ]);
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fake.fetchFn,
  );
  fake.bump("file-1", "rev-9");

  const error = await assertRejects(
    () => drive.putUpdate("a.md", bytes("new"), "rev-1"),
    SyncError,
  );
  assertEquals(error.code, "precondition-failed");
  assert(error.message.includes("changed on Google Drive"));
});

Deno.test("google drive allows an update when the revision still matches", async () => {
  const fake = fakeDrive([
    { id: "root-folder", name: "Openotes", parent: "root" },
    { id: "file-1", name: "a.md", parent: "root-folder" },
  ]);
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fake.fetchFn,
  );

  const entry = await drive.putUpdate("a.md", bytes("new"), "rev-1");
  assertEquals(entry.path, "a.md");
});

Deno.test("google drive picks the same duplicate on every device", async () => {
  // Duplicates are legal on Drive, so two devices must agree which one is the
  // real file or they will fight over it forever. Lowest id wins, and the
  // rule is deterministic rather than "whichever came back first".
  const fake = fakeDrive([
    { id: "root-folder", name: "Openotes", parent: "root" },
    { id: "bbb-second", name: "a.md", parent: "root-folder" },
    { id: "aaa-first", name: "a.md", parent: "root-folder" },
  ]);
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fake.fetchFn,
  );

  const entry = await drive.stat("a.md");
  assert(entry !== undefined);
  // Resolved through the lower id, regardless of the order Drive listed them.
  const fetched = fake.calls.find((c) => c.url.includes("/files/aaa-first"));
  assert(fetched !== undefined, "should have resolved to the lowest id");
});

Deno.test("a note title with an apostrophe cannot break the drive query", async () => {
  // Titles are user input and go straight into a Drive query string. An
  // unescaped quote would change which files the query matches.
  const fake = fakeDrive([
    { id: "root-folder", name: "Openotes", parent: "root" },
    { id: "file-1", name: "Sam's plan.md", parent: "root-folder" },
  ]);
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fake.fetchFn,
  );

  assertEquals(await drive.exists("Sam's plan.md"), true);
  const query = fake.calls
    .map((c) => new URL(c.url).searchParams.get("q") ?? "")
    .find((q) => q.includes("plan.md"));
  assert(query!.includes("Sam\\'s plan.md"), `query was: ${query}`);
});

Deno.test("google drive trashes rather than destroying", async () => {
  // The backend that cannot promise atomicity is the one where a mistake most
  // needs to be recoverable from the user's own bin.
  const fake = fakeDrive([
    { id: "root-folder", name: "Openotes", parent: "root" },
    { id: "file-1", name: "a.md", parent: "root-folder" },
  ]);
  const drive = new GoogleDriveStorage(
    tokenProvider(),
    "Openotes",
    fake.fetchFn,
  );

  await drive.delete("a.md");
  assertEquals(fake.trashed, ["file-1"]);
});
