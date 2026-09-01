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
  PrefixedRemoteStorage,
  type PutOptions,
  type RemoteCapabilities,
  type RemoteEntry,
  type RemoteStorage,
  SyncError,
} from "../src/index.ts";

/**
 * A RemoteStorage backed by a Map, recording every path it is asked for.
 *
 * The point of these tests is the prefixing wrapper, so the inner store is
 * deliberately dumb: what matters is which paths reach it and which paths come
 * back out.
 */
class MemoryStorage implements RemoteStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly collections = new Set<string>();
  readonly seen: string[] = [];
  probes = 0;

  private record(path: string) {
    this.seen.push(path);
    return path;
  }

  probe(): Promise<void> {
    this.probes++;
    return Promise.resolve();
  }

  list(path: string): Promise<RemoteEntry[]> {
    const prefix = this.record(path).replace(/\/+$/, "");
    const out: RemoteEntry[] = [];
    for (const key of this.objects.keys()) {
      if (prefix && !key.startsWith(prefix + "/")) continue;
      // Direct children only.
      const rest = prefix ? key.slice(prefix.length + 1) : key;
      if (rest.includes("/")) continue;
      out.push({
        path: key,
        isCollection: false,
        size: this.objects.get(key)!.length,
        version: `v-${this.objects.get(key)!.length}`,
      });
    }
    for (const key of this.collections) {
      if (prefix && !key.startsWith(prefix + "/")) continue;
      const rest = prefix ? key.slice(prefix.length + 1) : key;
      if (!rest || rest.includes("/")) continue;
      out.push({ path: key, isCollection: true });
    }
    return Promise.resolve(out);
  }

  stat(path: string): Promise<RemoteEntry | undefined> {
    const body = this.objects.get(this.record(path));
    return Promise.resolve(
      body
        ? {
          path,
          isCollection: false,
          size: body.length,
          version: `v-${body.length}`,
        }
        : undefined,
    );
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(this.record(path)));
  }

  get(path: string): Promise<Uint8Array> {
    const body = this.objects.get(this.record(path));
    if (!body) return Promise.reject(new SyncError(path, "not-found", 404));
    return Promise.resolve(body);
  }

  getIfExists(path: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.objects.get(this.record(path)));
  }

  putNew(
    path: string,
    body: Uint8Array,
    _options?: PutOptions,
  ): Promise<RemoteEntry> {
    if (this.objects.has(this.record(path))) {
      return Promise.reject(
        new SyncError(`${path} exists`, "precondition-failed", 412),
      );
    }
    this.objects.set(path, body);
    return Promise.resolve({
      path,
      isCollection: false,
      size: body.length,
      version: `v-${body.length}`,
    });
  }

  putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    _options?: PutOptions,
  ): Promise<RemoteEntry> {
    const current = this.objects.get(this.record(path));
    if (expectedVersion !== undefined) {
      const actual = current ? `v-${current.length}` : undefined;
      if (actual !== expectedVersion) {
        return Promise.reject(
          new SyncError(`${path} moved on`, "precondition-failed", 412),
        );
      }
    }
    this.objects.set(path, body);
    return Promise.resolve({
      path,
      isCollection: false,
      size: body.length,
      version: `v-${body.length}`,
    });
  }

  delete(path: string): Promise<void> {
    this.objects.delete(this.record(path));
    return Promise.resolve();
  }

  move(from: string, to: string): Promise<void> {
    const body = this.objects.get(this.record(from));
    if (body) {
      this.objects.delete(from);
      this.objects.set(this.record(to), body);
    }
    return Promise.resolve();
  }

  mkdirp(path: string): Promise<void> {
    this.collections.add(this.record(path).replace(/\/+$/, ""));
    return Promise.resolve();
  }

  verifyUpload(path: string, expectedLength: number): Promise<void> {
    const body = this.objects.get(this.record(path));
    if (!body || body.length !== expectedLength) {
      return Promise.reject(new SyncError(path, "corrupt-data"));
    }
    return Promise.resolve();
  }

  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      atomicCreate: true,
      conditionalUpdate: true,
      serverSideMove: true,
    });
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);

Deno.test("prefixed writes land under the prefix", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, ".staging-abc");

  await staged.putNew("protocol.json", bytes("hello"));

  assert(inner.objects.has(".staging-abc/protocol.json"));
  assert(!inner.objects.has("protocol.json"));
});

Deno.test("paths come back without the prefix", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, ".staging-abc");

  const created = await staged.putNew("devices/one.bin", bytes("a"));
  assertEquals(created.path, "devices/one.bin");

  const stat = await staged.stat("devices/one.bin");
  assertEquals(stat?.path, "devices/one.bin");

  const entries = await staged.list("devices");
  assertEquals(entries.map((e) => e.path), ["devices/one.bin"]);
});

Deno.test("the staged view cannot see or clobber the live repository", async () => {
  const inner = new MemoryStorage();
  await inner.putNew("protocol.json", bytes("live"));

  const staged = new PrefixedRemoteStorage(inner, ".staging-abc");

  // The live object is invisible through the staged view...
  assertEquals(await staged.getIfExists("protocol.json"), undefined);
  // ...so writing the same name is a create, not a clobber.
  await staged.putNew("protocol.json", bytes("staged"));
  assertEquals(
    new TextDecoder().decode(await inner.get("protocol.json")),
    "live",
  );
});

Deno.test("create-if-absent still fails inside the prefix", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, "stage");

  await staged.putNew("a.bin", bytes("first"));
  const err = await assertRejects(
    () => staged.putNew("a.bin", bytes("second")),
    SyncError,
  );
  assertEquals(err.code, "precondition-failed");
});

Deno.test("compare-and-swap versions survive prefixing", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, "stage");

  const first = await staged.putNew("a.bin", bytes("ab"));
  // Correct version updates.
  await staged.putUpdate("a.bin", bytes("abcd"), first.version);
  // The now-stale version is rejected.
  const err = await assertRejects(
    () => staged.putUpdate("a.bin", bytes("x"), first.version),
    SyncError,
  );
  assertEquals(err.code, "precondition-failed");
});

Deno.test("move stays inside the prefix on both sides", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, "stage");

  await staged.putNew("from.bin", bytes("x"));
  await staged.move("from.bin", "to.bin");

  assert(inner.objects.has("stage/to.bin"));
  assert(!inner.objects.has("stage/from.bin"));
  assert(!inner.objects.has("to.bin"));
});

Deno.test("a trailing slash is preserved, because backends read it as intent", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, "stage");

  await staged.mkdirp("devices/");
  assert(inner.seen.includes("stage/devices/"));
});

Deno.test("an empty path addresses the prefix root, not a stray slash", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, "stage");

  await staged.list("");
  assertEquals(inner.seen[0], "stage");
});

Deno.test("probe and capabilities pass straight through", async () => {
  const inner = new MemoryStorage();
  const staged = new PrefixedRemoteStorage(inner, "stage");

  await staged.probe();
  assertEquals(inner.probes, 1);
  assertEquals((await staged.capabilities()).atomicCreate, true);
});

Deno.test("nesting two prefixes composes", async () => {
  const inner = new MemoryStorage();
  const outer = new PrefixedRemoteStorage(inner, "a");
  const nested = new PrefixedRemoteStorage(outer, "b");

  const entry = await nested.putNew("c.bin", bytes("x"));
  assert(inner.objects.has("a/b/c.bin"));
  assertEquals(entry.path, "c.bin");
});
