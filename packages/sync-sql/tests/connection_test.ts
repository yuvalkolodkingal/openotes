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

import { assertEquals, assertThrows } from "@std/assert";
import { SyncError } from "@notesnook/sync-core";
import {
  describeConnection,
  SCHEMA_SQL,
  supabaseProjectRef,
} from "../src/index.ts";

Deno.test("a connection string is summarised without its password", () => {
  const summary = describeConnection(
    "postgresql://owner:s3cret@ep-x-123.eu-central-1.aws.neon.tech/neondb?sslmode=require",
  );
  assertEquals(summary.host, "ep-x-123.eu-central-1.aws.neon.tech");
  assertEquals(summary.database, "neondb");
  assertEquals(summary.user, "owner");
  assertEquals(summary.hasPassword, true);
  assertEquals(summary.hosting, "neon");
  assertEquals(summary.ssl, true);
  assertEquals(JSON.stringify(summary).includes("s3cret"), false);
});

Deno.test("a local server defaults to no TLS; a remote one to TLS", () => {
  assertEquals(describeConnection("postgres://u@localhost/db").ssl, false);
  assertEquals(describeConnection("postgres://u@db.example.org/db").ssl, true);
  assertEquals(
    describeConnection("postgres://u@db.example.org/db?sslmode=disable").ssl,
    false,
  );
  assertEquals(describeConnection("postgres://u@localhost:5433/db").port, 5433);
});

Deno.test("hosting is recognised from the host name", () => {
  assertEquals(
    describeConnection(
      "postgres://u:p@db.abcdefghijklmnopqrst.supabase.co/postgres",
    ).hosting,
    "supabase",
  );
  assertEquals(
    describeConnection("postgres://u@10.0.0.2/x").hosting,
    "postgres",
  );
});

Deno.test("anything that is not a Postgres URL is refused with a hint", () => {
  assertThrows(() => describeConnection("mysql://u@h/db"), SyncError);
  assertThrows(() => describeConnection("not a url"), SyncError);
});

Deno.test("a Supabase project ref is read from the project URL only", () => {
  assertEquals(
    supabaseProjectRef("https://abcdefghijklmnopqrst.supabase.co"),
    "abcdefghijklmnopqrst",
  );
  assertEquals(supabaseProjectRef("https://example.com"), undefined);
  assertEquals(supabaseProjectRef("nonsense"), undefined);
});

Deno.test("the schema script is complete and idempotent by construction", () => {
  assertEquals(
    SCHEMA_SQL.includes("CREATE TABLE IF NOT EXISTS openotes_objects"),
    true,
  );
  assertEquals(SCHEMA_SQL.includes("ENABLE ROW LEVEL SECURITY"), true);
  assertEquals(
    SCHEMA_SQL.includes("IF NOT EXISTS openotes_objects_path_prefix"),
    true,
  );
});
