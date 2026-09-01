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
 * Two devices synchronizing through one folder.
 *
 * The store conformance suite checks the verbs; this checks the thing users
 * will actually do with them — point two machines at the same Dropbox folder
 * and expect a note written on one to turn up on the other. It runs the real
 * SyncEngine against a real directory, so a break in the protocol's
 * assumptions about a filesystem backend fails here rather than in someone's
 * notes.
 */

import { assert, assertEquals } from "@std/assert";
import { SyncCrypto } from "../src/crypto.ts";
import { FolderStore } from "../src/folder-store.ts";
import { MemoryQueueStorage, OutgoingQueue } from "../src/queue.ts";
import { SyncEngine } from "../src/engine.ts";
import { MemoryAttachments, MemorySyncStore } from "./memory-store.ts";
import { masterKeyFor } from "./harness.ts";
import type { SyncRecord } from "../src/types.ts";

async function device(id: string, root: string) {
  const crypto = new SyncCrypto();
  // The shared derivation: Argon2 is slow on purpose and every device in a
  // test has to arrive at the same key anyway.
  const masterKey = await masterKeyFor();
  const store = new MemorySyncStore(id);
  // "immediate": a temp directory is a local disk, and the two-minute grace
  // an "eventual" folder declares would make every assertion here wait.
  const remote = new FolderStore({ root, consistency: "immediate" });
  const engine = new SyncEngine({
    remote,
    crypto,
    store,
    queue: new OutgoingQueue(new MemoryQueueStorage()),
    masterKey,
    attachments: new MemoryAttachments(),
    syncAttachments: true,
    deviceName: id,
    appVersion: "2.1.0-test",
    platform: "linux",
  });
  return { id, store, engine, remote };
}

function put(store: MemorySyncStore, id: string, title: string) {
  store.put({ type: "note", id, title });
}

/** A record for rebuildRemote, which takes full state rather than a store. */
function record(id: string, title: string): SyncRecord {
  return {
    entityId: id,
    entityType: "note",
    operation: "upsert",
    revision: 1,
    timestamp: Date.now(),
    item: { id, type: "note", title, revision: 1, dateModified: Date.now() },
  };
}

async function withFolder(body: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "openotes-folder-sync-" });
  try {
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test("a note written on one device arrives on the other", async () => {
  await withFolder(async (root) => {
    const a = await device("DEVICEA", root);
    const metadata = await a.engine.connect();
    assertEquals(metadata.version, 1);

    // The folder holds ciphertext and nothing that names the note.
    const protocolJson = await Deno.readTextFile(`${root}/protocol.json`);
    assert(protocolJson.includes("notesnook-webdav-sync"));
    assert(!protocolJson.includes("Groceries"));

    put(a.store, "note-1", "Groceries");
    await a.engine.sync();

    const b = await device("DEVICEB", root);
    // The second device adopts the repository rather than making a new one.
    const adopted = await b.engine.connect();
    assertEquals(adopted.generation, metadata.generation);
    assertEquals(adopted.createdBy, "DEVICEA");

    await b.engine.sync();
    assertEquals(b.store.get("note", "note-1")?.title, "Groceries");

    // ...and back the other way.
    put(b.store, "note-2", "Recipes");
    await b.engine.sync();
    await a.engine.sync();
    assertEquals(a.store.get("note", "note-2")?.title, "Recipes");
  });
});

Deno.test("nothing in the folder names a note", async () => {
  await withFolder(async (root) => {
    const a = await device("DEVICEA", root);
    await a.engine.connect();
    put(a.store, "note-1", "Divorce papers");
    await a.engine.sync();

    const names: string[] = [];
    const bodies: string[] = [];
    const walk = async (directory: string) => {
      for await (const entry of Deno.readDir(directory)) {
        const path = `${directory}/${entry.name}`;
        names.push(entry.name);
        if (entry.isDirectory) await walk(path);
        else bodies.push(await Deno.readTextFile(path));
      }
    };
    await walk(root);

    assert(names.length > 0);
    for (const name of names) {
      assert(
        !name.toLowerCase().includes("divorce"),
        `a filename leaked note content: ${name}`,
      );
    }
    for (const body of bodies) {
      assert(
        !body.includes("Divorce papers"),
        "a file body leaked note content in plaintext",
      );
    }
  });
});

Deno.test("a half-written batch is invisible until it is complete", async () => {
  await withFolder(async (root) => {
    const a = await device("DEVICEA", root);
    await a.engine.connect();

    // A temp file is exactly what a partial write looks like on disk. The
    // engine must not see it as a journal entry, or a device would read a
    // truncated batch and skip the real one when it lands.
    const changes = `${root}/devices/DEVICEA/changes`;
    await Deno.mkdir(changes, { recursive: true });
    await Deno.writeTextFile(
      `${changes}/.0000000001.bin.0123456789abcdef.tmp`,
      "half a batch",
    );

    const entries = await a.remote.list("devices/DEVICEA/changes/");
    assertEquals(entries.map((entry) => entry.path), []);
  });
});

Deno.test("the rebuild staging directory is not mistaken for debris", async () => {
  await withFolder(async (root) => {
    const a = await device("DEVICEA", root);
    await a.engine.connect();
    put(a.store, "note-1", "Before");
    await a.engine.sync();

    // rebuildRemote works under a dot-prefixed staging prefix. Hiding every
    // dotfile from list() — which is the obvious way to hide temp files —
    // would make the staged generation invisible to its own verification.
    const generation = await a.engine.rebuildRemote([
      record("note-1", "After"),
    ]);
    assert(generation.length > 0);

    const b = await device("DEVICEB", root);
    await b.engine.connect();
    await b.engine.sync();
    assertEquals(b.store.get("note", "note-1")?.title, "After");
  });
});

Deno.test("an unmounted folder is an error, not an empty repository", async () => {
  await withFolder(async (root) => {
    const mount = `${root}/mount`;
    await Deno.mkdir(mount);
    const a = await device("DEVICEA", `${mount}/Openotes`);
    await a.engine.connect();
    put(a.store, "note-1", "Kept");
    await a.engine.sync();

    // The drive was unplugged. Reporting "no devices, no batches" here is
    // how a device talks itself into initializing a fresh repository over a
    // mount point and losing everything behind it.
    await Deno.remove(mount, { recursive: true });
    let failed = false;
    try {
      await a.remote.list("devices/");
    } catch {
      failed = true;
    }
    assert(failed, "listing an unmounted root must throw, not return []");
  });
});
