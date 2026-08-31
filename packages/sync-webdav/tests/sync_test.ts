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
import { SyncError } from "../src/types.ts";
import { MemoryQueueStorage } from "../src/queue.ts";
import { FakeWebDavServer } from "./fake-server.ts";
import { bytesEqual, createDevice, testBytes, TestDevice } from "./harness.ts";
import { MemoryAttachments, MemorySyncStore } from "./memory-store.ts";

async function withServer(
  fn: (server: FakeWebDavServer) => Promise<void>,
  options: ConstructorParameters<typeof FakeWebDavServer>[0] = {},
) {
  const server = new FakeWebDavServer(options);
  await server.start();
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

function titleOf(device: TestDevice, id: string): string | undefined {
  return device.store.get("note", id)?.title;
}

Deno.test("empty remote is initialized and a second device adopts it", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    const metadata = await a.engine.connect();
    assertEquals(metadata.version, 1);
    assertEquals(metadata.protocol, "notesnook-webdav-sync");

    // protocol.json exists and leaks nothing about the user's data.
    const raw = server.getFile("/protocol.json");
    assert(raw);
    const text = new TextDecoder().decode(raw);
    assert(text.includes("notesnook-webdav-sync"));
    assert(!text.includes("Alpha"));

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    const adopted = await b.engine.connect();
    // Same repository, same generation — B must not create a second one.
    assertEquals(adopted.generation, metadata.generation);
    assertEquals(adopted.createdBy, "DEVICEA");
  });
});

Deno.test("connecting with the wrong passphrase refuses before writing", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    await a.engine.connect();

    const intruder = await createDevice({
      id: "DEVICEC",
      baseUrl: server.url,
      passphrase: "not the passphrase",
    });
    const error = await assertRejects(() => intruder.engine.connect());
    assert(error instanceof SyncError);
    assertEquals(error.code, "bad-key");

    // No journal was created for the rejected device.
    assert(!server.listPaths().some((p) => p.includes("DEVICEC")));
  });
});

Deno.test("a newer protocol version blocks unsafe writes", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    await a.engine.connect();

    const raw = JSON.parse(
      new TextDecoder().decode(server.getFile("/protocol.json")!),
    );
    raw.version = 99;
    server.setFile(
      "/protocol.json",
      new TextEncoder().encode(JSON.stringify(raw)),
    );

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    const error = await assertRejects(() => b.engine.connect());
    assert(error instanceof SyncError);
    assertEquals(error.code, "protocol-mismatch");
    assert(error.message.includes("99"));
  });
});

Deno.test("a foreign directory is not overwritten", async () => {
  await withServer(async (server) => {
    server.setFile(
      "/protocol.json",
      new TextEncoder().encode(
        JSON.stringify({ protocol: "other-app", version: 1 }),
      ),
    );
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    const error = await assertRejects(() => a.engine.connect());
    assert(error instanceof SyncError);
    assertEquals(error.code, "protocol-mismatch");
  });
});

Deno.test("note content and titles never appear in remote filenames or bodies", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    a.store.put({
      id: "n1",
      type: "note",
      title: "Nuclear Codes",
      content: "1234",
    });
    await a.engine.sync();

    for (const path of server.listPaths()) {
      assert(!path.includes("Nuclear"), `filename leaked: ${path}`);
      assert(!path.includes("1234"), `filename leaked: ${path}`);
      const body = new TextDecoder("utf-8", { fatal: false }).decode(
        server.getFile(path)!,
      );
      assert(!body.includes("Nuclear Codes"), `content leaked in ${path}`);
      assert(!body.includes("battery staple"), `passphrase leaked in ${path}`);
    }
  });
});

Deno.test("full multi-device scenario (spec §50)", async () => {
  await withServer(async (server) => {
    // ---- Device A: create vault, create note "Alpha", sync ----
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    a.store.put({ id: "alpha", type: "note", title: "Alpha", content: "v1" });
    const firstPush = await a.engine.sync();
    assertEquals(firstPush.uploaded, 1);

    // ---- Device B: same WebDAV, sync, verify "Alpha" arrived ----
    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    const firstPull = await b.engine.sync();
    assertEquals(firstPull.applied, 1);
    assertEquals(titleOf(b, "alpha"), "Alpha");
    assertEquals(b.store.get("note", "alpha")?.content, "v1");

    // ---- Edit Alpha on A, create Beta on B, sync both ----
    a.store.put({ id: "alpha", type: "note", title: "Alpha", content: "v2" });
    b.store.put({ id: "beta", type: "note", title: "Beta", content: "b1" });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();

    assertEquals(a.store.get("note", "beta")?.content, "b1");
    assertEquals(b.store.get("note", "alpha")?.content, "v2");

    // ---- Both edit Alpha differently while offline, then reconnect ----
    a.store.put({
      id: "alpha",
      type: "note",
      title: "Alpha",
      content: "from-A",
    });
    b.store.put({
      id: "alpha",
      type: "note",
      title: "Alpha",
      content: "from-B",
    });
    await a.engine.sync();
    await b.engine.sync(); // B pulls A's edit while holding its own

    // No content may be silently destroyed: both versions must exist on B.
    const contents = [...b.store.items.values()]
      .filter((item) => item.type === "note")
      .map((item) => item.content);
    assert(contents.includes("from-A"), "A's version was lost");
    assert(contents.includes("from-B"), "B's version was lost");
    assertEquals(b.store.conflicts.length, 1);
    assert(b.store.conflicts[0].title?.includes("Conflict from DEVICEB"));

    // The conflict copy propagates back to A, so the user sees it anywhere.
    await b.engine.sync();
    await a.engine.sync();
    const aContents = [...a.store.items.values()].map((item) => item.content);
    assert(aContents.includes("from-B"), "conflict copy did not reach A");

    // ---- Delete Beta on A, sync, verify the deletion propagates ----
    a.store.remove("note", "beta");
    await a.engine.sync();
    await b.engine.sync();
    assertEquals(b.store.get("note", "beta"), undefined);
  });
});

Deno.test("a stale device cannot resurrect a deleted note", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });

    a.store.put({ id: "n1", type: "note", title: "Doomed", content: "x" });
    await a.engine.sync();
    await b.engine.sync();
    assert(b.store.get("note", "n1"));

    // A deletes; B is offline and still holds the old copy.
    a.store.remove("note", "n1");
    await a.engine.sync();
    await b.engine.sync();
    assertEquals(b.store.get("note", "n1"), undefined);

    // A third, stale device replays its old copy at the original revision.
    const stale = await createDevice({ id: "DEVICEC", baseUrl: server.url });
    stale.store.put({
      id: "n1",
      type: "note",
      title: "Doomed",
      content: "x",
      revision: 1,
    });
    await stale.engine.sync();
    await a.engine.sync();

    assertEquals(
      a.store.get("note", "n1"),
      undefined,
      "a stale copy resurrected a deleted note",
    );
  });
});

Deno.test("out-of-order and duplicate batches are handled", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    a.store.put({ id: "n1", type: "note", title: "One", content: "1" });
    await a.engine.sync();
    a.store.put({ id: "n1", type: "note", title: "Two", content: "2" });
    await a.engine.sync();

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    await b.engine.sync();
    assertEquals(titleOf(b, "n1"), "Two");

    // Replaying the whole journal must be idempotent (duplicate records).
    await b.store.setCursor("DEVICEA", 0);
    await b.engine.sync();
    assertEquals(titleOf(b, "n1"), "Two");

    // A gap in sequence numbers (batch 2 missing) must not block batch 3.
    const c = await createDevice({ id: "DEVICEC", baseUrl: server.url });
    server.deleteFile("/devices/DEVICEA/changes/0000000001.bin");
    await c.engine.sync();
    assertEquals(titleOf(c, "n1"), "Two");
  });
});

Deno.test("a corrupt change record is skipped without wedging the sync", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    a.store.put({ id: "n1", type: "note", title: "Good", content: "1" });
    await a.engine.sync();
    a.store.put({ id: "n2", type: "note", title: "Also good", content: "2" });
    await a.engine.sync();

    // Corrupt the first batch on the server.
    server.setFile(
      "/devices/DEVICEA/changes/0000000001.bin",
      new TextEncoder().encode("{not json"),
    );

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    const result = await b.engine.sync();
    // The readable batch still applied.
    assertEquals(titleOf(b, "n2"), "Also good");
    assertEquals(b.store.get("note", "n1"), undefined);
    assert(result.applied >= 1);
  });
});

Deno.test("records are only marked synced after the remote write verifies", async () => {
  await withServer(async (server) => {
    const a = await createDevice({
      id: "DEVICEA",
      baseUrl: server.url,
      maxRetries: 0,
    });
    await a.engine.connect();
    a.store.put({ id: "n1", type: "note", title: "Pending", content: "x" });

    // The PUT of the change batch fails outright.
    server.injectFault({
      status: 500,
      method: "PUT",
      pathIncludes: "changes",
      times: 10,
    });
    await assertRejects(() => a.engine.sync());

    // The record must still be queued, and nothing marked as synced.
    assertEquals((await a.queue.peek()).length, 1);

    server.clearFaults();
    const result = await a.engine.sync();
    assertEquals(result.uploaded, 1);
    assertEquals((await a.queue.peek()).length, 0);

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    await b.engine.sync();
    assertEquals(titleOf(b, "n1"), "Pending");
  });
});

Deno.test("queued changes survive a restart", async () => {
  await withServer(async (server) => {
    const storage = new MemoryQueueStorage();
    const store = new MemorySyncStore("DEVICEA");

    const first = await createDevice({
      id: "DEVICEA",
      baseUrl: server.url,
      store,
      queueStorage: storage,
      maxRetries: 0,
    });
    await first.engine.connect();
    store.put({ id: "n1", type: "note", title: "Survives", content: "x" });
    server.injectFault({
      status: 503,
      method: "PUT",
      pathIncludes: "changes",
      times: 10,
    });
    await assertRejects(() => first.engine.sync());
    await first.queue.flush();

    // "Restart": brand new engine and queue object over the same storage.
    server.clearFaults();
    const restarted = await createDevice({
      id: "DEVICEA",
      baseUrl: server.url,
      store,
      queueStorage: storage,
    });
    assertEquals((await restarted.queue.peek()).length, 1);
    await restarted.engine.sync();

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    await b.engine.sync();
    assertEquals(titleOf(b, "n1"), "Survives");
  });
});

Deno.test("a taken journal sequence advances instead of overwriting", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    a.store.put({ id: "n1", type: "note", title: "First", content: "1" });
    await a.engine.sync();

    // Simulate a crash after upload but before the cursor was persisted.
    await a.store.setLocalSequence(0);
    a.store.put({ id: "n2", type: "note", title: "Second", content: "2" });
    await a.engine.sync();

    // Both batches must exist; the first was not clobbered.
    assert(server.getFile("/devices/DEVICEA/changes/0000000001.bin"));
    assert(server.getFile("/devices/DEVICEA/changes/0000000002.bin"));

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    await b.engine.sync();
    assertEquals(titleOf(b, "n1"), "First");
    assertEquals(titleOf(b, "n2"), "Second");
  });
});

Deno.test("attachments sync end to end, encrypted and deduplicated", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    const content = testBytes(300_000, 7);
    const hash = "attachmenthash1";
    a.attachments.add(hash, content);
    await a.queue.enqueueAttachment(hash);
    a.store.put({ id: "att1", type: "attachment", hash, title: "photo.png" });

    const pushed = await a.engine.sync();
    assertEquals(pushed.attachmentsUploaded, 1);

    // The stored blob must not be the plaintext.
    const stored = server.getFile(`/attachments/${hash}.bin`);
    assert(stored);
    assert(!bytesEqual(stored, content), "attachment stored in plaintext");

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    const pulled = await b.engine.sync();
    assertEquals(pulled.attachmentsDownloaded, 1);
    const roundTripped = b.attachments.blobs.get(hash);
    assert(roundTripped);
    assert(bytesEqual(roundTripped, content), "attachment content changed");

    // Re-uploading the same hash from a third device deduplicates.
    const c = await createDevice({ id: "DEVICEC", baseUrl: server.url });
    c.attachments.add(hash, content);
    await c.queue.enqueueAttachment(hash);
    const before = server.listPaths().filter((p) =>
      p.startsWith("/attachments/")
    ).length;
    await c.engine.sync();
    const after =
      server.listPaths().filter((p) => p.startsWith("/attachments/")).length;
    assertEquals(after, before);
  });
});

Deno.test("attachment chunk boundaries survive upload and download", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    // Frame-shaped chunks, the way the renderer stores them: fixed-size
    // secretstream frames plus a shorter final one. Each stored chunk must
    // come back as exactly one chunk on the downloading device, or the
    // renderer's decryption stream would fail.
    const frames = [
      testBytes(64 * 1024 + 17, 1),
      testBytes(64 * 1024 + 17, 2),
      testBytes(1000 + 17, 3),
    ];
    const hash = "framedattachment1";
    a.attachments.addChunks(hash, frames);
    await a.queue.enqueueAttachment(hash);
    a.store.put({ id: "att2", type: "attachment", hash, title: "framed.bin" });
    await a.engine.sync();

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    await b.engine.sync();
    const received = b.attachments.chunks.get(hash);
    assert(received, "attachment was not downloaded");
    assertEquals(
      received.map((chunk) => chunk.length),
      frames.map((chunk) => chunk.length),
      "chunk boundaries changed in transit",
    );
    for (let i = 0; i < frames.length; i++) {
      assert(bytesEqual(received[i], frames[i]), `chunk ${i} differs`);
    }
  });
});

Deno.test("fetchAttachment pulls one attachment on demand", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    const frames = [testBytes(2048, 5), testBytes(700, 6)];
    const hash = "ondemandattachment1";
    a.attachments.addChunks(hash, frames);
    await a.queue.enqueueAttachment(hash);
    await a.engine.sync();

    // B never synced the record; it asks for exactly this attachment.
    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    assertEquals(await b.engine.fetchAttachment(hash), true);
    const received = b.attachments.chunks.get(hash);
    assert(received);
    assertEquals(
      received.map((chunk) => chunk.length),
      frames.map((chunk) => chunk.length),
    );

    // Already present: answered locally without another download.
    assertEquals(await b.engine.fetchAttachment(hash), true);

    // Not on the server either: "not available", not an error.
    assertEquals(await b.engine.fetchAttachment("missingattachment1"), false);
  });
});

Deno.test("large payloads spill into content-addressed objects", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    const big = "x".repeat(400_000);
    a.store.put({ id: "n1", type: "note", title: "Big", content: big });
    await a.engine.sync();

    const objects = server.listPaths().filter((p) => p.startsWith("/objects/"));
    assertEquals(objects.length, 1);

    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    await b.engine.sync();
    assertEquals(b.store.get("note", "n1")?.content, big);
  });
});

Deno.test("two sync cycles never run concurrently for one vault", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    a.store.put({ id: "n1", type: "note", title: "One", content: "1" });
    const first = a.engine.sync();
    const error = await assertRejects(() => a.engine.sync());
    assert(error instanceof SyncError);
    assertEquals(error.code, "conflict");
    await first;
  });
});

Deno.test("attachment sync can be turned off", async () => {
  await withServer(async (server) => {
    const a = await createDevice({
      id: "DEVICEA",
      baseUrl: server.url,
      syncAttachments: false,
      attachments: new MemoryAttachments(),
    });
    a.attachments.add("h1", testBytes(1000));
    await a.queue.enqueueAttachment("h1");
    a.store.put({ id: "att1", type: "attachment", hash: "h1" });
    const result = await a.engine.sync();
    assertEquals(result.attachmentsUploaded, 0);
    assertEquals(
      server.listPaths().filter((p) => p.startsWith("/attachments/")).length,
      0,
    );
    // The metadata record still syncs so other devices know it exists.
    assertEquals(result.uploaded, 1);
  });
});

Deno.test("rebuilding the remote keeps the old data until the new one verifies", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    a.store.put({ id: "n1", type: "note", title: "Keep me", content: "1" });
    a.store.put({ id: "n2", type: "note", title: "Me too", content: "2" });
    await a.engine.sync();
    const originalGeneration = (await a.engine.connect()).generation;

    const fullState = await a.store.collectPendingChanges().then(() =>
      [...a.store.items.values()].map((item) => ({
        entityId: item.id,
        entityType: item.type,
        operation: "upsert" as const,
        revision: item.revision,
        timestamp: item.dateModified,
        item,
      }))
    );

    const generation = await a.engine.rebuildRemote(fullState);
    assert(generation !== originalGeneration);

    // A fresh device sees the rebuilt state.
    const b = await createDevice({ id: "DEVICEB", baseUrl: server.url });
    await b.engine.sync();
    assertEquals(titleOf(b, "n1"), "Keep me");
    assertEquals(titleOf(b, "n2"), "Me too");

    // The previous generation is retired, not destroyed.
    assert(server.listPaths().some((p) => p.includes(".retired-")));
  });
});

Deno.test("unreferenced remote attachments are only pruned after retention", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    await a.engine.connect();
    a.attachments.add("keepme", testBytes(100));
    a.attachments.add("orphan", testBytes(100));
    await a.queue.enqueueAttachment("keepme");
    await a.queue.enqueueAttachment("orphan");
    await a.engine.sync();

    // With the default conservative retention nothing recent is removed.
    assertEquals(await a.engine.pruneAttachments(new Set(["keepme"])), 0);
    assert(server.getFile("/attachments/orphan.bin"));

    // With a zero retention window the unreferenced object goes.
    assertEquals(await a.engine.pruneAttachments(new Set(["keepme"]), 0), 1);
    assertEquals(server.getFile("/attachments/orphan.bin"), undefined);
    assert(server.getFile("/attachments/keepme.bin"));
  });
});

Deno.test("test connection reports status without initializing", async () => {
  await withServer(async (server) => {
    const a = await createDevice({ id: "DEVICEA", baseUrl: server.url });
    const empty = await a.engine.testConnection();
    assertEquals(empty.initialized, false);
    assertEquals(server.listPaths().length, 0);

    await a.engine.connect();
    const ready = await a.engine.testConnection();
    assertEquals(ready.initialized, true);
    assertEquals(ready.protocolVersion, 1);
    assertEquals(ready.devices, 1);
  });
});
