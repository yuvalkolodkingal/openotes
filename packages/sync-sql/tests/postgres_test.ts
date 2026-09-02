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

import { assert, assertEquals } from "@std/assert";
import { PrefixedRemoteStorage } from "@notesnook/sync-core";
import {
  ensureSchema,
  OBJECTS_TABLE,
  schemaExists,
  SqlRemoteStorage,
} from "../src/index.ts";
import { PostgresExecutor } from "../src/postgres.ts";
import { storageContract } from "./contract.ts";

/**
 * The storage against a real Postgres.
 *
 * Runs when POSTGRES_TEST_URL names a server (CI starts one as a service
 * container; `deno task test:sql` does locally). Without it these are
 * skipped -- and `run-integration.ts --require-server` turns a skip into a
 * failure, so CI cannot mistake "no server" for "passed".
 */
const url = Deno.env.get("POSTGRES_TEST_URL");

if (!url) {
  Deno.test({
    name: "postgres: skipped (POSTGRES_TEST_URL is not set)",
    ignore: true,
    fn() {},
  });
} else {
  let counter = 0;
  const make = async () => {
    const executor = new PostgresExecutor(url);
    await ensureSchema(executor);
    // Each scenario gets its own prefix in the shared table, which is also
    // how a second repository would share a database in real use.
    const prefix = `t${Date.now().toString(36)}-${counter++}`;
    const storage = new PrefixedRemoteStorage(
      new SqlRemoteStorage(executor),
      prefix,
    );
    return {
      storage,
      cleanup: async () => {
        await executor.query(
          `DELETE FROM ${OBJECTS_TABLE} WHERE path LIKE $1`,
          [`${prefix}/%`],
        );
        await executor.close();
      },
    };
  };

  storageContract("postgres", make);

  Deno.test("postgres: the schema is idempotent and detectable", async () => {
    const executor = new PostgresExecutor(url);
    try {
      await ensureSchema(executor);
      await ensureSchema(executor);
      assert(await schemaExists(executor));
      const rls = await executor.query(
        `SELECT relrowsecurity FROM pg_class WHERE relname = $1`,
        [OBJECTS_TABLE],
      );
      assertEquals(rls.rows[0]?.relrowsecurity, true);
    } finally {
      await executor.close();
    }
  });

  Deno.test("postgres: two writers racing putNew produce exactly one winner", async () => {
    const a = new PostgresExecutor(url);
    const b = new PostgresExecutor(url);
    try {
      await ensureSchema(a);
      const prefix = `race-${Date.now().toString(36)}`;
      const sa = new PrefixedRemoteStorage(new SqlRemoteStorage(a), prefix);
      const sb = new PrefixedRemoteStorage(new SqlRemoteStorage(b), prefix);
      const body = new TextEncoder().encode("x");
      const results = await Promise.allSettled([
        sa.putNew("devices/A/changes/0000000001.bin", body),
        sb.putNew("devices/A/changes/0000000001.bin", body),
      ]);
      const won = results.filter((r) => r.status === "fulfilled").length;
      assertEquals(won, 1);
      await a.query(`DELETE FROM ${OBJECTS_TABLE} WHERE path LIKE $1`, [
        `${prefix}/%`,
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  });
}
