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
import { PrefixedRemoteStorage, SyncError } from "@notesnook/sync-core";
import { SupabaseRestStorage } from "../src/index.ts";
import { FakePostgrest } from "./fake-postgrest.ts";
import { storageContract } from "./contract.ts";

storageContract("supabase", () => {
  const fake = new FakePostgrest();
  const storage = new PrefixedRemoteStorage(
    new SupabaseRestStorage(fake.projectUrl, fake.key, fake.fetchFn),
    "Openotes",
  );
  return Promise.resolve({ storage, cleanup: () => Promise.resolve() });
});

Deno.test("supabase: a wrong service key is unauthorized, not a mystery", async () => {
  const fake = new FakePostgrest();
  const storage = new SupabaseRestStorage(
    fake.projectUrl,
    "nope",
    fake.fetchFn,
  );
  const error = await assertRejects(() => storage.probe(), SyncError);
  assertEquals(error.code, "unauthorized");
});

Deno.test("supabase: a project where setup never ran says so", async () => {
  const fake = new FakePostgrest();
  fake.missingTable = true;
  const storage = new SupabaseRestStorage(
    fake.projectUrl,
    fake.key,
    fake.fetchFn,
  );
  const error = await assertRejects(() => storage.probe(), SyncError);
  assertEquals(error.code, "not-found");
  assert(error.message.includes("openotes_objects"));
});

Deno.test("supabase: create-if-absent rests on the primary key, not on a read", async () => {
  const fake = new FakePostgrest();
  const storage = new SupabaseRestStorage(
    fake.projectUrl,
    fake.key,
    fake.fetchFn,
  );
  await storage.putNew("a.bin", new Uint8Array([1]));
  fake.calls.length = 0;
  await assertRejects(
    () => storage.putNew("a.bin", new Uint8Array([2])),
    SyncError,
  );
  // One POST, no GET beforehand: the refusal came from the database.
  assertEquals(fake.calls.map((c) => c.method), ["POST"]);
});

Deno.test("supabase: compare-and-swap is one PATCH filtered on the version", async () => {
  const fake = new FakePostgrest();
  const storage = new SupabaseRestStorage(
    fake.projectUrl,
    fake.key,
    fake.fetchFn,
  );
  const created = await storage.putNew("a.bin", new Uint8Array([1]));
  fake.calls.length = 0;
  await storage.putUpdate("a.bin", new Uint8Array([2]), created.version);
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0].method, "PATCH");
  assert(fake.calls[0].url.includes(`version=eq.${created.version}`));
  assert(fake.calls[0].prefer?.includes("return=representation"));
});
