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

/**
 * The same protocol scenarios as sync_test.ts, but against a REAL WebDAV
 * server. Launched by run-integration.ts, which supplies the connection
 * details through the environment; running this file directly without them
 * fails loudly rather than skipping.
 *
 * These tests are what catch the things a hand-written test double cannot:
 * a server that normalizes hrefs differently, returns 405 instead of 412,
 * omits getcontentlength, or refuses MKCOL on an existing collection.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { WebDavClient } from "../../src/client.ts";
import { FetchTransport, toBasicAuth } from "../../src/http.ts";
import { SyncError } from "../../src/types.ts";
import { SyncCrypto } from "../../src/crypto.ts";
import { BackupEngine, RemoteBackupTarget } from "../../src/backup.ts";
import { webDavStore } from "../../src/webdav-store.ts";
import {
  bytesEqual,
  createDevice,
  masterKeyFor,
  testBytes,
} from "../harness.ts";
import { MemorySyncStore, type TestItem } from "../memory-store.ts";

const BASE_URL = Deno.env.get("WEBDAV_INTEGRATION_URL");
const USERNAME = Deno.env.get("WEBDAV_INTEGRATION_USER") || undefined;
const PASSWORD = Deno.env.get("WEBDAV_INTEGRATION_PASSWORD") || undefined;

if (!BASE_URL) {
  throw new Error(
    "WEBDAV_INTEGRATION_URL is not set. Run these through " +
      "`deno task test:webdav`, which starts a real WebDAV server first.",
  );
}

/** Every run works in its own directory so runs cannot interfere. */
let suiteCounter = 0;
function uniqueDirectory(name: string): string {
  return `openotes-it-${Date.now().toString(36)}-${suiteCounter++}-${name}`;
}

function transport() {
  return new FetchTransport(
    USERNAME
      ? {
        getBasicAuth: () =>
          Promise.resolve(toBasicAuth(USERNAME, PASSWORD ?? "")),
      }
      : undefined,
  );
}

function clientFor(directory: string) {
  return new WebDavClient(transport(), {
    baseUrl: new URL(directory + "/", BASE_URL).toString(),
    allowInsecureHttp: true,
    maxRetries: 1,
    requestTimeout: 20_000,
  });
}

async function withDirectory(
  name: string,
  fn: (directory: string, client: WebDavClient) => Promise<void>,
) {
  const directory = uniqueDirectory(name);
  const root = new WebDavClient(transport(), {
    baseUrl: BASE_URL!,
    allowInsecureHttp: true,
    requestTimeout: 20_000,
  });
  await root.mkcolRecursive(directory + "/");
  const client = clientFor(directory);
  try {
    await fn(directory, client);
  } finally {
    await root.delete(directory).catch(() => {});
  }
}

function deviceOptions(directory: string, id: string) {
  return {
    id,
    baseUrl: new URL(directory + "/", BASE_URL).toString(),
    username: USERNAME,
    password: PASSWORD,
    requestTimeout: 20_000,
    maxRetries: 1,
  };
}

Deno.test("real server: the WebDAV verb surface behaves as expected", async () => {
  await withDirectory("verbs", async (_directory, client) => {
    const options = await client.options();
    assert(
      options.dav.length > 0 || options.allow.length > 0,
      "the server advertised neither a DAV nor an Allow header",
    );

    await client.mkcolRecursive("a/b/c/");
    // MKCOL on an existing collection must be tolerated, whichever status
    // this particular server chooses to return.
    await client.mkcol("a/b/c/");

    const payload = new TextEncoder().encode("integration payload");
    await client.put("a/b/c/file.bin", payload);
    await client.verifyUpload("a/b/c/file.bin", payload.length);

    assertEquals(
      new TextDecoder().decode(await client.get("a/b/c/file.bin")),
      "integration payload",
    );

    const head = await client.head("a/b/c/file.bin");
    assertEquals(head.exists, true);

    const listed = await client.list("a/b/c/");
    const names = listed.map((entry) =>
      client.relativePath(entry).split("/").pop()
    );
    assert(names.includes("file.bin"), `listing was ${JSON.stringify(names)}`);

    await client.move("a/b/c/file.bin", "a/b/c/moved.bin");
    assertEquals(
      new TextDecoder().decode(await client.get("a/b/c/moved.bin")),
      "integration payload",
    );
    assertEquals((await client.head("a/b/c/file.bin")).exists, false);

    await client.delete("a/b/c/moved.bin");
    assertEquals(await client.exists("a/b/c/moved.bin"), false);
  });
});

Deno.test("real server: reading a missing resource is a not-found error", async () => {
  await withDirectory("missing", async (_directory, client) => {
    const error = await assertRejects(() => client.get("does/not/exist.bin"));
    assert(error instanceof SyncError);
    assertEquals(error.code, "not-found");
    assertEquals(await client.getIfExists("does/not/exist.bin"), undefined);
    assertEquals(await client.list("does/not/exist/"), []);
  });
});

Deno.test("real server: bad credentials are rejected", async () => {
  if (!USERNAME) {
    console.log("  (server has no authentication configured; nothing to test)");
    return;
  }
  const client = new WebDavClient(
    new FetchTransport({
      getBasicAuth: () =>
        Promise.resolve(toBasicAuth(USERNAME, "definitely-not-the-password")),
    }),
    { baseUrl: BASE_URL!, allowInsecureHttp: true, maxRetries: 0 },
  );
  const error = await assertRejects(() => client.propfind("", 0));
  assert(error instanceof SyncError);
  assertEquals(error.code, "unauthorized");
});

Deno.test("real server: conditional PUT is honoured or safely emulated", async () => {
  await withDirectory("conditional", async (_directory, client) => {
    await client.put("once.bin", "first", { ifNoneMatch: true });
    try {
      await client.put("once.bin", "second", { ifNoneMatch: true });
      // A server that ignores If-None-Match is allowed to exist; the sync
      // engine's sequence-advance logic covers that case. Record which
      // behaviour we saw so a regression here is visible in the log.
      console.log("  note: this server ignores If-None-Match");
    } catch (error) {
      assert(error instanceof SyncError);
      assertEquals(error.code, "precondition-failed");
      assertEquals(
        new TextDecoder().decode(await client.get("once.bin")),
        "first",
      );
    }
  });
});

Deno.test("real server: full two-device sync scenario (spec §50)", async () => {
  await withDirectory("multidevice", async (directory) => {
    const a = await createDevice(deviceOptions(directory, "DEVICEA"));
    a.store.put({ id: "alpha", type: "note", title: "Alpha", content: "v1" });
    await a.engine.sync();

    const b = await createDevice(deviceOptions(directory, "DEVICEB"));
    await b.engine.sync();
    assertEquals(b.store.get("note", "alpha")?.content, "v1");

    // Concurrent edits on both sides.
    a.store.put({
      id: "alpha",
      type: "note",
      title: "Alpha",
      content: "from-A",
    });
    b.store.put({ id: "beta", type: "note", title: "Beta", content: "b1" });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    assertEquals(a.store.get("note", "beta")?.content, "b1");
    assertEquals(b.store.get("note", "alpha")?.content, "from-A");

    // Divergent offline edits: neither may be lost.
    a.store.put({
      id: "alpha",
      type: "note",
      title: "Alpha",
      content: "A-again",
    });
    b.store.put({
      id: "alpha",
      type: "note",
      title: "Alpha",
      content: "B-again",
    });
    await a.engine.sync();
    await b.engine.sync();

    const contents = [...b.store.items.values()].map((item) => item.content);
    assert(contents.includes("A-again"), "device A's edit was lost");
    assert(contents.includes("B-again"), "device B's edit was lost");

    // Deletion propagates.
    a.store.remove("note", "beta");
    await a.engine.sync();
    await b.engine.sync();
    assertEquals(b.store.get("note", "beta"), undefined);
  });
});

Deno.test("real server: attachments round-trip encrypted", async () => {
  await withDirectory("attachments", async (directory) => {
    const a = await createDevice(deviceOptions(directory, "DEVICEA"));
    const content = testBytes(400_000, 21);
    a.attachments.add("bigattachment", content);
    await a.queue.enqueueAttachment("bigattachment");
    a.store.put({
      id: "att1",
      type: "attachment",
      hash: "bigattachment",
      title: "big.bin",
    });
    const pushed = await a.engine.sync();
    assertEquals(pushed.attachmentsUploaded, 1);

    const b = await createDevice(deviceOptions(directory, "DEVICEB"));
    const pulled = await b.engine.sync();
    assertEquals(pulled.attachmentsDownloaded, 1);

    const received = b.attachments.blobs.get("bigattachment");
    assert(received);
    assert(
      bytesEqual(received, content),
      "attachment content changed in transit",
    );

    // What the server actually holds must not be the plaintext.
    const raw = await b.client.get("attachments/bigattachment.bin");
    assert(!bytesEqual(raw, content), "attachment was stored in plaintext");
  });
});

Deno.test("real server: nothing readable is written to the server", async () => {
  await withDirectory("privacy", async (directory, client) => {
    const a = await createDevice(deviceOptions(directory, "DEVICEA"));
    a.store.put({
      id: "secret",
      type: "note",
      title: "Bank details",
      content: "account 12345678",
    });
    await a.engine.sync();

    const walk = async (path: string): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await client.list(path)) {
        const relative = client.relativePath(entry);
        if (entry.isCollection) found.push(...(await walk(relative + "/")));
        else found.push(relative);
      }
      return found;
    };

    const files = await walk("");
    assert(files.length > 0, "nothing was uploaded");
    for (const file of files) {
      assert(!file.includes("Bank"), `filename leaked content: ${file}`);
      const body = new TextDecoder("utf-8", { fatal: false }).decode(
        await client.get(file),
      );
      assert(!body.includes("Bank details"), `content leaked in ${file}`);
      assert(!body.includes("12345678"), `content leaked in ${file}`);
    }
  });
});

Deno.test("real server: backup upload, download and restore", async () => {
  await withDirectory("backup", async (_directory, client) => {
    const crypto_ = new SyncCrypto();
    const master = await masterKeyFor();
    const key = await crypto_.deriveSubkey(master, "backup");
    const engine = new BackupEngine(crypto_, {
      appName: "Openotes",
      appVersion: "1.0.0-test",
      deviceId: "DEVICEA",
    });

    const store = new MemorySyncStore("DEVICEA");
    for (let index = 1; index <= 10; index++) {
      store.put({
        id: `n${index}`,
        type: "note",
        title: `Note ${index}`,
        content: `body ${index}`,
      });
    }

    const target = new RemoteBackupTarget(webDavStore(client), "backups");
    const { name, data } = await engine.create(key, {
      data: store.snapshot(),
      counts: { note: 10 },
      attachments: new Map([["att", testBytes(10_000, 5)]]),
    });
    await target.write(name, data);

    const listed = await target.list();
    assertEquals(listed.length, 1);

    const downloaded = await target.read(listed[0].name);
    const { snapshot } = await engine.open(key, downloaded);
    const restored = new MemorySyncStore("DEVICEB");
    restored.restore(
      snapshot.data as { items: TestItem[]; tombstones: [string, number][] },
    );
    assertEquals(restored.items.size, 10);
    assertEquals(restored.get("note", "n7")?.content, "body 7");
    assert(snapshot.attachments?.has("att"));

    await target.delete(listed[0].name);
    assertEquals((await target.list()).length, 0);
  });
});

Deno.test("real server: a second sync with no changes uploads nothing", async () => {
  await withDirectory("noop", async (directory, client) => {
    const a = await createDevice(deviceOptions(directory, "DEVICEA"));
    a.store.put({ id: "n1", type: "note", title: "One", content: "1" });
    await a.engine.sync();

    const before = (await client.list("devices/DEVICEA/changes/")).length;
    const second = await a.engine.sync();
    assertEquals(second.uploaded, 0);
    const after = (await client.list("devices/DEVICEA/changes/")).length;
    assertEquals(after, before, "an empty sync wrote a journal entry");
  });
});

Deno.test("real server: an existing journal entry is never overwritten", async () => {
  // Some servers accept If-None-Match and ignore it (dufs does). The engine
  // must still refuse to clobber an immutable journal entry, so this checks
  // the behaviour rather than the header.
  await withDirectory("immutable", async (directory, client) => {
    const a = await createDevice(deviceOptions(directory, "DEVICEA"));
    a.store.put({ id: "n1", type: "note", title: "First", content: "1" });
    await a.engine.sync();
    const first = await client.get("devices/DEVICEA/changes/0000000001.bin");

    // Simulate a crash that lost the persisted sequence number.
    await a.store.setLocalSequence(0);
    a.store.put({ id: "n2", type: "note", title: "Second", content: "2" });
    await a.engine.sync();

    const stillFirst = await client.get(
      "devices/DEVICEA/changes/0000000001.bin",
    );
    assert(
      bytesEqual(first, stillFirst),
      "the first journal entry was overwritten",
    );
    assert(
      await client.exists("devices/DEVICEA/changes/0000000002.bin"),
      "the engine did not advance to a free sequence",
    );

    const b = await createDevice(deviceOptions(directory, "DEVICEB"));
    await b.engine.sync();
    assertEquals(b.store.get("note", "n1")?.title, "First");
    assertEquals(b.store.get("note", "n2")?.title, "Second");
  });
});
