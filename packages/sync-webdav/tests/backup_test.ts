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
import {
  BackupEngine,
  backupFileName,
  type BackupSnapshot,
  type FileSystemAdapter,
  LocalBackupTarget,
  parseBackupFileName,
  WebDavBackupTarget,
} from "../src/backup.ts";
import { SyncCrypto } from "../src/crypto.ts";
import { WebDavClient } from "../src/client.ts";
import { FetchTransport } from "../src/http.ts";
import { SyncError } from "../src/types.ts";
import { FakeWebDavServer } from "./fake-server.ts";
import { bytesEqual, masterKeyFor, testBytes } from "./harness.ts";
import { MemorySyncStore, type TestItem } from "./memory-store.ts";

const crypto_ = new SyncCrypto();

async function backupKey() {
  const master = await masterKeyFor();
  return await crypto_.deriveSubkey(master, "backup");
}

function engineFor(deviceId = "DEVICEA") {
  return new BackupEngine(crypto_, {
    appName: "Openotes",
    appVersion: "1.0.0-test",
    deviceId,
  });
}

/** An in-memory FileSystemAdapter for LocalBackupTarget. */
function memoryFs(): FileSystemAdapter & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    ensureDir: () => Promise.resolve(),
    listFiles: (path) =>
      Promise.resolve(
        [...files.entries()]
          .filter(([name]) => name.startsWith(path + "/"))
          .map(([name, data]) => ({
            name: name.slice(path.length + 1),
            size: data.length,
          })),
      ),
    readFile: (path) => {
      const data = files.get(path);
      if (!data) return Promise.reject(new Error(`Not found: ${path}`));
      return Promise.resolve(data);
    },
    writeFile: (path, data) => {
      files.set(path, data);
      return Promise.resolve();
    },
    deleteFile: (path) => {
      files.delete(path);
      return Promise.resolve();
    },
    join: (...parts) => parts.join("/"),
  };
}

Deno.test("backup file names round-trip through their timestamp", () => {
  const timestamp = Date.UTC(2026, 7, 31, 12, 0, 0);
  const name = backupFileName(timestamp);
  assertEquals(name, "2026-08-31T120000Z.backup.enc");
  assertEquals(parseBackupFileName(name), timestamp);
  assertEquals(parseBackupFileName("not-a-backup.txt"), undefined);
});

Deno.test("backup round-trip preserves every entity and attachment", async () => {
  const key = await backupKey();
  const engine = engineFor();

  const store = new MemorySyncStore("DEVICEA");
  store.put({ id: "n1", type: "note", title: "Alpha", content: "one" });
  store.put({ id: "n2", type: "note", title: "Beta", content: "two" });
  store.put({ id: "nb1", type: "notebook", title: "Work" });
  store.put({ id: "t1", type: "tag", title: "urgent" });
  store.put({
    id: "a1",
    type: "attachment",
    hash: "hashone",
    title: "photo.png",
  });

  const attachmentContent = testBytes(50_000, 3);
  const snapshot: BackupSnapshot = {
    data: store.snapshot(),
    counts: { note: 2, notebook: 1, tag: 1, attachment: 1 },
    attachments: new Map([["hashone", attachmentContent]]),
  };

  const { name, data, manifest } = await engine.create(key, snapshot);
  assert(name.endsWith(".backup.enc"));
  assertEquals(manifest.encrypted, true);
  assertEquals(manifest.attachments, 1);
  assertEquals(manifest.counts.note, 2);

  // The blob must not contain plaintext.
  const asText = new TextDecoder("utf-8", { fatal: false }).decode(data);
  assert(!asText.includes("Alpha"), "note title leaked into the backup file");
  assert(!asText.includes("urgent"), "tag leaked into the backup file");

  const reopened = await engine.open(key, data);
  const restored = new MemorySyncStore("DEVICEB");
  restored.restore(
    reopened.snapshot.data as {
      items: TestItem[];
      tombstones: [string, number][];
    },
  );

  assertEquals(restored.get("note", "n1")?.title, "Alpha");
  assertEquals(restored.get("note", "n2")?.content, "two");
  assertEquals(restored.get("notebook", "nb1")?.title, "Work");
  assertEquals(restored.get("tag", "t1")?.title, "urgent");
  assertEquals(restored.get("attachment", "a1")?.hash, "hashone");

  const restoredAttachment = reopened.snapshot.attachments?.get("hashone");
  assert(restoredAttachment);
  assert(
    bytesEqual(restoredAttachment, attachmentContent),
    "attachment content changed across the backup round-trip",
  );
});

Deno.test("a corrupted backup is rejected instead of restored", async () => {
  const key = await backupKey();
  const engine = engineFor();
  const { data } = await engine.create(key, {
    data: { items: [{ id: "n1", title: "Alpha" }] },
    counts: { note: 1 },
  });

  // Flip a byte inside the ciphertext.
  const parsed = JSON.parse(new TextDecoder().decode(data));
  const cipher = parsed.payload.cipher as string;
  parsed.payload.cipher = cipher.slice(0, 10) +
    (cipher[10] === "A" ? "B" : "A") + cipher.slice(11);
  const corrupted = new TextEncoder().encode(JSON.stringify(parsed));

  const error = await assertRejects(() => engine.open(key, corrupted));
  assert(error instanceof SyncError);
  // Either authentication fails (bad-key) or the hash check does.
  assert(["bad-key", "corrupt-data"].includes(error.code), error.code);
});

Deno.test("a backup with a tampered content hash is rejected", async () => {
  const key = await backupKey();
  const engine = engineFor();
  const { data } = await engine.create(key, {
    data: { items: [] },
    counts: {},
  });
  const parsed = JSON.parse(new TextDecoder().decode(data));
  parsed.manifest.contentHash = "0".repeat(64);
  const tampered = new TextEncoder().encode(JSON.stringify(parsed));

  const error = await assertRejects(() => engine.open(key, tampered));
  assert(error instanceof SyncError);
  assertEquals(error.code, "corrupt-data");
  assert(error.message.includes("integrity"));
});

Deno.test("the wrong key cannot open a backup", async () => {
  const key = await backupKey();
  const engine = engineFor();
  const { data } = await engine.create(key, {
    data: { items: [{ id: "n1" }] },
    counts: { note: 1 },
  });

  const otherMaster = await crypto_.deriveMasterKey(
    "a different passphrase",
    "QkJCQkJCQkJCQkJCQkJCQg",
  );
  const otherKey = await crypto_.deriveSubkey(otherMaster, "backup");
  const error = await assertRejects(() => engine.open(otherKey, data));
  assert(error instanceof SyncError);
  assertEquals(error.code, "bad-key");
});

Deno.test("a newer backup format is refused rather than misread", async () => {
  const key = await backupKey();
  const engine = engineFor();
  const { data } = await engine.create(key, { data: {}, counts: {} });
  const parsed = JSON.parse(new TextDecoder().decode(data));
  parsed.manifest.format = 99;
  const future = new TextEncoder().encode(JSON.stringify(parsed));

  const error = await assertRejects(() => engine.open(key, future));
  assert(error instanceof SyncError);
  assertEquals(error.code, "protocol-mismatch");
});

Deno.test("full backup lifecycle: create, upload, wipe, download, restore", async () => {
  // The mandatory scenario from spec §51.
  const server = new FakeWebDavServer();
  await server.start();
  try {
    const key = await backupKey();
    const engine = engineFor();
    const client = new WebDavClient(new FetchTransport(), {
      baseUrl: server.url,
      allowInsecureHttp: true,
      delay: () => Promise.resolve(),
    });
    const remote = new WebDavBackupTarget(client, "backups");

    // Create notes and attachments.
    const store = new MemorySyncStore("DEVICEA");
    for (let index = 1; index <= 25; index++) {
      store.put({
        id: `n${index}`,
        type: "note",
        title: `Note ${index}`,
        content: `content ${index}`,
      });
    }
    store.put({ id: "a1", type: "attachment", hash: "att1" });
    store.put({ id: "a2", type: "attachment", hash: "att2" });
    const attachments = new Map([
      ["att1", testBytes(20_000, 11)],
      ["att2", testBytes(5_000, 12)],
    ]);

    // Create the encrypted backup and upload it.
    const { name, data } = await engine.create(key, {
      data: store.snapshot(),
      counts: { note: 25, attachment: 2 },
      attachments,
    });
    await remote.write(name, data);

    // It really is on the server, and it is not plaintext.
    const stored = server.getFile(`/backups/${name}`);
    assert(stored, "the backup was not uploaded");
    const storedText = new TextDecoder("utf-8", { fatal: false }).decode(
      stored,
    );
    assert(!storedText.includes("Note 7"), "plaintext leaked to the server");

    // "Delete the local test vault."
    const wiped = new MemorySyncStore("DEVICEA");
    assertEquals(wiped.items.size, 0);

    // Download and restore.
    const listed = await remote.list();
    assertEquals(listed.length, 1);
    assertEquals(listed[0].name, name);

    const downloaded = await remote.read(listed[0].name);
    const { snapshot, manifest } = await engine.open(key, downloaded);
    wiped.restore(
      snapshot.data as { items: TestItem[]; tombstones: [string, number][] },
    );

    // Compare the resulting logical data.
    assertEquals(wiped.items.size, 27); // 25 notes + 2 attachments
    for (let index = 1; index <= 25; index++) {
      assertEquals(wiped.get("note", `n${index}`)?.content, `content ${index}`);
    }
    assertEquals(manifest.attachments, 2);
    for (const [hash, expected] of attachments) {
      const actual = snapshot.attachments?.get(hash);
      assert(actual, `attachment ${hash} missing after restore`);
      assert(
        bytesEqual(actual, expected),
        `attachment ${hash} content changed`,
      );
    }
  } finally {
    await server.stop();
  }
});

Deno.test("retention deletes the oldest snapshots only", async () => {
  const fs = memoryFs();
  const target = new LocalBackupTarget(fs, "/backups");
  const engine = engineFor();
  const key = await backupKey();

  const names: string[] = [];
  for (let index = 0; index < 5; index++) {
    const timestamp = Date.UTC(2026, 0, index + 1, 12, 0, 0);
    const name = backupFileName(timestamp);
    names.push(name);
    const { data } = await engine.create(key, {
      data: { index },
      counts: {},
    });
    await target.write(name, data);
  }
  assertEquals((await target.list()).length, 5);

  const removed = await engine.applyRetention(target, 3);
  assertEquals(removed.length, 2);
  // The two oldest go.
  assertEquals(removed.sort(), [names[0], names[1]].sort());

  const remaining = (await target.list()).map((entry) => entry.name).sort();
  assertEquals(remaining, [names[2], names[3], names[4]].sort());

  // Retention 0 means keep everything.
  assertEquals((await engine.applyRetention(target, 0)).length, 0);
});

Deno.test("backup schedules fire only when due", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 31, 12, 0, 0);

  assertEquals(
    BackupEngine.isDue({ interval: "manual", retention: 5 }, undefined, now),
    false,
  );
  assertEquals(
    BackupEngine.isDue({ interval: "daily", retention: 5 }, undefined, now),
    true,
    "the first scheduled backup should be due immediately",
  );
  assertEquals(
    BackupEngine.isDue({ interval: "daily", retention: 5 }, now - day / 2, now),
    false,
  );
  assertEquals(
    BackupEngine.isDue({ interval: "daily", retention: 5 }, now - day - 1, now),
    true,
  );
  assertEquals(
    BackupEngine.isDue(
      { interval: "weekly", retention: 5 },
      now - 6 * day,
      now,
    ),
    false,
  );
  assertEquals(
    BackupEngine.isDue(
      { interval: "weekly", retention: 5 },
      now - 8 * day,
      now,
    ),
    true,
  );
  assertEquals(
    BackupEngine.isDue(
      { interval: "monthly", retention: 5 },
      now - 31 * day,
      now,
    ),
    true,
  );
});

Deno.test("deleting a note does not touch historical backups", async () => {
  // Spec §14: sync is not backup.
  const key = await backupKey();
  const engine = engineFor();
  const fs = memoryFs();
  const target = new LocalBackupTarget(fs, "/backups");

  const store = new MemorySyncStore("DEVICEA");
  store.put({ id: "n1", type: "note", title: "Important", content: "keep me" });

  const first = await engine.create(key, {
    data: store.snapshot(),
    counts: { note: 1 },
  });
  await target.write(first.name, first.data);

  // The note is deleted and that deletion syncs.
  store.remove("note", "n1");
  assertEquals(store.get("note", "n1"), undefined);

  // The historical backup still holds it.
  const archived = await engine.open(key, await target.read(first.name));
  const recovered = new MemorySyncStore("DEVICEB");
  recovered.restore(
    archived.snapshot.data as {
      items: TestItem[];
      tombstones: [string, number][];
    },
  );
  assertEquals(recovered.get("note", "n1")?.content, "keep me");
});

Deno.test("unsafe backup file names are rejected", async () => {
  const fs = memoryFs();
  const target = new LocalBackupTarget(fs, "/backups");
  for (const name of ["../escape.enc", "a/b.enc", "..", ""]) {
    await assertRejects(
      () => target.read(name),
      SyncError,
      undefined,
      `expected ${JSON.stringify(name)} to be rejected`,
    );
  }
});

Deno.test("a WebDAV backup upload is verified before it counts", async () => {
  const server = new FakeWebDavServer();
  await server.start();
  try {
    const client = new WebDavClient(new FetchTransport(), {
      baseUrl: server.url,
      allowInsecureHttp: true,
      maxRetries: 0,
      delay: () => Promise.resolve(),
    });
    const target = new WebDavBackupTarget(client, "backups");
    const key = await backupKey();
    const { name, data } = await engineFor().create(key, {
      data: { items: [] },
      counts: {},
    });

    // The server silently truncates the upload.
    server.injectFault({ truncatePutTo: 5, method: "PUT" });
    const error = await assertRejects(() => target.write(name, data));
    assert(error instanceof SyncError);
    assertEquals(error.code, "corrupt-data");
  } finally {
    await server.stop();
  }
});
