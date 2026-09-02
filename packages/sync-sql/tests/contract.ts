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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { type RemoteStorage, SyncError } from "@notesnook/sync-core";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * What every backend in this package has to do, run against whichever one
 * the caller constructs. The same scenarios run against a real Postgres (in
 * the integration suite) and against the fakes, so a fake that drifts from
 * the real thing fails here rather than in a user's sync.
 */
export function storageContract(
  name: string,
  make: () => Promise<{ storage: RemoteStorage; cleanup(): Promise<void> }>,
) {
  const test = (title: string, body: (s: RemoteStorage) => Promise<void>) =>
    Deno.test(`${name}: ${title}`, async () => {
      const { storage, cleanup } = await make();
      try {
        await body(storage);
      } finally {
        await cleanup();
      }
    });

  test("both primitives are real, not emulated", async (s) => {
    const caps = await s.capabilities();
    assert(caps.atomicCreate);
    assert(caps.conditionalUpdate);
  });

  test("putNew creates once and refuses a second time", async (s) => {
    const first = await s.putNew("protocol.json", bytes("{}"));
    assert(first.version);
    const error = await assertRejects(
      () => s.putNew("protocol.json", bytes("{}")),
      SyncError,
    );
    assertEquals(error.code, "precondition-failed");
    assertEquals(text(await s.get("protocol.json")), "{}");
  });

  test("putUpdate with the right version succeeds and moves the version", async (s) => {
    const created = await s.putNew("a.bin", bytes("one"));
    const updated = await s.putUpdate("a.bin", bytes("two"), created.version);
    assert(updated.version !== created.version);
    assertEquals(text(await s.get("a.bin")), "two");
    assertEquals((await s.stat("a.bin"))?.version, updated.version);
  });

  test("putUpdate with a stale version is refused and changes nothing", async (s) => {
    const created = await s.putNew("a.bin", bytes("one"));
    await s.putUpdate("a.bin", bytes("two"), created.version);
    const error = await assertRejects(
      () => s.putUpdate("a.bin", bytes("three"), created.version),
      SyncError,
    );
    assertEquals(error.code, "precondition-failed");
    assertEquals(text(await s.get("a.bin")), "two");
  });

  test("putUpdate without a version overwrites, creating if absent", async (s) => {
    await s.putUpdate("fresh.bin", bytes("x"));
    assertEquals(text(await s.get("fresh.bin")), "x");
    await s.putUpdate("fresh.bin", bytes("yy"));
    assertEquals(text(await s.get("fresh.bin")), "yy");
    assertEquals((await s.stat("fresh.bin"))?.size, 2);
  });

  test("binary content survives a round trip byte for byte", async (s) => {
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
    await s.putNew("objects/blob.bin", payload);
    assertEquals(await s.get("objects/blob.bin"), payload);
    await s.verifyUpload("objects/blob.bin", payload.length);
    await assertRejects(
      () => s.verifyUpload("objects/blob.bin", payload.length + 1),
      SyncError,
    );
  });

  test("a missing object is not-found, and getIfExists says undefined", async (s) => {
    const error = await assertRejects(() => s.get("nope.bin"), SyncError);
    assertEquals(error.code, "not-found");
    assertEquals(await s.getIfExists("nope.bin"), undefined);
    assertEquals(await s.stat("nope.bin"), undefined);
    assertEquals(await s.exists("nope.bin"), false);
  });

  test("listing groups paths into children and implied collections", async (s) => {
    await s.putNew("devices/A/device.json", bytes("a"));
    await s.putNew("devices/A/changes/0000000001.bin", bytes("1"));
    await s.putNew("devices/B/device.json", bytes("b"));
    await s.putNew("protocol.json", bytes("p"));

    const root = await s.list("");
    assertEquals(
      root.map((e) => `${e.path}${e.isCollection ? "/" : ""}`).sort(),
      ["devices/", "protocol.json"],
    );
    const devices = await s.list("devices");
    assertEquals(
      devices.map((e) => e.path).sort(),
      ["devices/A", "devices/B"],
    );
    assert(devices.every((e) => e.isCollection));
    const changes = await s.list("devices/A/changes/");
    assertEquals(changes.length, 1);
    assertEquals(changes[0].path, "devices/A/changes/0000000001.bin");
    assertEquals(changes[0].isCollection, false);
    assertEquals(changes[0].size, 1);
    assert(changes[0].version);

    assertEquals(await s.list("devices/C"), []);
    assertEquals((await s.stat("devices/A"))?.isCollection, true);
  });

  test("a path with an underscore does not match as a wildcard", async (s) => {
    await s.putNew("objects/a_b.bin", bytes("1"));
    await s.putNew("objects/axb.bin", bytes("2"));
    assertEquals((await s.list("objects")).length, 2);
    assertEquals(await s.list("objects/a_b"), []);
    await s.delete("objects/a_b");
    assertEquals((await s.list("objects")).length, 2);
  });

  test("deleting an absent object succeeds; deleting a collection empties it", async (s) => {
    await s.delete("never-there.bin");
    await s.putNew("backups/1.enc", bytes("1"));
    await s.putNew("backups/2.enc", bytes("2"));
    await s.delete("backups");
    assertEquals(await s.list("backups"), []);
    assertEquals(await s.exists("backups/1.enc"), false);
  });

  test("move renames an object and a whole collection", async (s) => {
    await s.putNew("staging/protocol.json", bytes("p"));
    await s.putNew("staging/devices/A/device.json", bytes("a"));
    await s.putNew("live/old.bin", bytes("old"));

    await s.move("staging/protocol.json", "live/protocol.json");
    assertEquals(text(await s.get("live/protocol.json")), "p");
    assertEquals(await s.exists("staging/protocol.json"), false);

    await s.move("staging/devices", "live/devices");
    assertEquals(text(await s.get("live/devices/A/device.json")), "a");
    assertEquals(await s.list("staging"), []);

    const error = await assertRejects(
      () => s.move("live/protocol.json", "live/old.bin", false),
      SyncError,
    );
    assertEquals(error.code, "precondition-failed");
    await s.move("live/protocol.json", "live/old.bin", true);
    assertEquals(text(await s.get("live/old.bin")), "p");
  });

  test("mkdirp is accepted and probe passes against a set-up store", async (s) => {
    await s.mkdirp("devices/X/changes");
    await s.probe();
  });
}
