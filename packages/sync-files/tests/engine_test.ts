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

import { assert, assertEquals } from "@std/assert";
import { MemoryTextStore } from "@notesnook/sync-core";
import { FileSyncEngine } from "../src/engine.ts";
import { ManifestStore } from "../src/manifest.ts";
import type { RenderedNote } from "../src/types.ts";
import { FolderStorage } from "./folder-storage.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function note(id: string, path: string, body: string): RenderedNote {
  return { noteId: id, path, content: utf8(body) };
}

function makeEngine(storage: FolderStorage, deviceId = "device-a") {
  const manifest = new ManifestStore(new MemoryTextStore(), deviceId);
  const conflicts: string[] = [];
  const engine = new FileSyncEngine({
    storage,
    manifest,
    deviceName: deviceId,
    onConflict: (info) => conflicts.push(info.reason),
  });
  return { engine, manifest, conflicts };
}

Deno.test("a new note becomes a readable file in the folder", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  const result = await engine.sync([
    note("n1", "Work/Plan.md", "# Plan\n\nhi"),
  ]);

  assertEquals(result.pushed, 1);
  assertEquals(text(await storage.get("Work/Plan.md")), "# Plan\n\nhi");
});

Deno.test("an unchanged note is not re-uploaded", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);
  const notes = [note("n1", "Plan.md", "body")];

  await engine.sync(notes);
  storage.writes.length = 0;
  const second = await engine.sync(notes);

  assertEquals(second.pushed, 0);
  assertEquals(storage.writes, []);
});

Deno.test("a local edit is pushed", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await engine.sync([note("n1", "Plan.md", "one")]);
  const result = await engine.sync([note("n1", "Plan.md", "two")]);

  assertEquals(result.pushed, 1);
  assertEquals(text(await storage.get("Plan.md")), "two");
});

Deno.test("an edit made in the folder is pulled back", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await engine.sync([note("n1", "Plan.md", "one")]);
  // Someone edits the file in Drive's web UI.
  await storage.putUpdate("Plan.md", utf8("edited elsewhere"));

  const result = await engine.sync([note("n1", "Plan.md", "one")]);

  assertEquals(result.pulled, 1);
  assertEquals(result.incoming.length, 1);
  assertEquals(text(result.incoming[0].content), "edited elsewhere");
});

Deno.test("concurrent edits keep BOTH versions", async () => {
  const storage = new FolderStorage();
  const { engine, conflicts } = makeEngine(storage);

  await engine.sync([note("n1", "Plan.md", "base")]);
  await storage.putUpdate("Plan.md", utf8("theirs"));

  const result = await engine.sync([note("n1", "Plan.md", "mine")]);

  assertEquals(result.conflicts, 1);
  assertEquals(conflicts, ["both-edited"]);
  // Ours took the note's own path...
  assertEquals(text(await storage.get("Plan.md")), "mine");
  // ...and theirs survived beside it.
  const copies = storage.paths().filter((p) => p.includes("conflicts/"));
  assertEquals(copies.length, 1);
  assertEquals(text(await storage.get(copies[0])), "theirs");
  // The user sees it as a note, not only as a file.
  assert(result.incoming.some((n) => n.conflictOf === "n1"));
});

Deno.test("a file deleted in the folder removes the note locally", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await engine.sync([note("n1", "Plan.md", "one")]);
  await storage.delete("Plan.md");

  const result = await engine.sync([note("n1", "Plan.md", "one")]);

  assertEquals(result.removedNoteIds, ["n1"]);
  assertEquals(result.deletedLocally, 1);
});

Deno.test("a remote delete does NOT discard an unsynced local edit", async () => {
  const storage = new FolderStorage();
  const { engine, conflicts } = makeEngine(storage);

  await engine.sync([note("n1", "Plan.md", "one")]);
  await storage.delete("Plan.md");

  const result = await engine.sync([note("n1", "Plan.md", "edited locally")]);

  assertEquals(conflicts, ["deleted-remotely-edited-locally"]);
  assertEquals(result.removedNoteIds, []);
  assertEquals(text(await storage.get("Plan.md")), "edited locally");
});

Deno.test("deleting a note locally removes its file", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await engine.sync([note("n1", "Plan.md", "one")]);
  const result = await engine.sync([], ["n1"]);

  assertEquals(result.deletedRemotely, 1);
  assertEquals(await storage.stat("Plan.md"), undefined);
});

Deno.test("a local delete does NOT discard a remote edit", async () => {
  const storage = new FolderStorage();
  const { engine, conflicts } = makeEngine(storage);

  await engine.sync([note("n1", "Plan.md", "one")]);
  await storage.putUpdate("Plan.md", utf8("someone else's work"));

  const result = await engine.sync([], ["n1"]);

  assertEquals(conflicts, ["deleted-locally-edited-remotely"]);
  assertEquals(result.deletedRemotely, 0);
  assertEquals(text(await storage.get("Plan.md")), "someone else's work");
});

Deno.test("retitling a note moves its file instead of orphaning one", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await engine.sync([note("n1", "Old title.md", "body")]);
  await engine.sync([note("n1", "New title.md", "body")]);

  assertEquals(await storage.stat("Old title.md"), undefined);
  assertEquals(text(await storage.get("New title.md")), "body");
});

Deno.test("a foreign markdown file in the folder is adopted", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await storage.putUpdate("Dropped in.md", utf8("written by hand"));
  const result = await engine.sync([]);

  assertEquals(result.pulled, 1);
  assertEquals(result.incoming[0].path, "Dropped in.md");
  assertEquals(result.incoming[0].noteId, undefined);
});

Deno.test("the engine's own state directory is not treated as notes", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await storage.mkdirp(".openotes/conflicts/");
  await storage.putUpdate(".openotes/conflicts/Old (conflict).md", utf8("x"));

  const result = await engine.sync([]);
  assertEquals(result.pulled, 0);
  assertEquals(result.incoming, []);
});

Deno.test("non-markdown files are left alone", async () => {
  const storage = new FolderStorage();
  const { engine } = makeEngine(storage);

  await storage.putUpdate("attachments/photo.png", utf8("binary-ish"));
  const result = await engine.sync([]);

  assertEquals(result.pulled, 0);
  assert(await storage.stat("attachments/photo.png"));
});

Deno.test("two devices converge through the same folder", async () => {
  const storage = new FolderStorage();
  const a = makeEngine(storage, "device-a");
  const b = makeEngine(storage, "device-b");

  // A writes a note.
  await a.engine.sync([note("n1", "Shared.md", "from A")]);

  // B has never seen it: it arrives as incoming.
  const first = await b.engine.sync([]);
  assertEquals(first.pulled, 1);
  assertEquals(text(first.incoming[0].content), "from A");

  // B edits it; A picks the edit up without a conflict.
  await b.engine.sync([note("n1", "Shared.md", "from B")]);
  const back = await a.engine.sync([note("n1", "Shared.md", "from A")]);
  assertEquals(back.pulled, 1);
  assertEquals(text(back.incoming[0].content), "from B");
});

Deno.test("a lost manifest costs work, never content", async () => {
  const storage = new FolderStorage();
  const first = makeEngine(storage);
  await first.engine.sync([note("n1", "Plan.md", "identical")]);

  // A fresh device — or the same one after losing its manifest — sees the
  // file as untracked. Identical content must adopt, not conflict.
  const second = makeEngine(storage);
  const result = await second.engine.sync([note("n1", "Plan.md", "identical")]);

  assertEquals(result.conflicts, 0);
  assertEquals(text(await storage.get("Plan.md")), "identical");
});
