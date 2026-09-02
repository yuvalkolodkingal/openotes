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

import type { SqlExecutor } from "./executor.ts";

/**
 * The one table. Its name is fixed so that every client -- the desktop, the
 * phone, a person with psql -- agrees on it without configuration; more than
 * one repository in a database is a path prefix, not a second table.
 */
export const OBJECTS_TABLE = "openotes_objects";

/**
 * Idempotent, and every statement is separately idempotent too, so a
 * transport that cannot batch (PostgREST) or a run that dies half-way leaves
 * nothing to repair.
 *
 * `path` is the primary key: that single constraint is what makes
 * create-if-absent atomic. `version` is rewritten on every write and compared
 * for equality only. Row-level security is turned on with no policies, so
 * on Supabase the anon key -- which is public by design -- can neither read
 * nor write the table; only the service key can, and that is the one the
 * clients hold.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${OBJECTS_TABLE} (
    path text PRIMARY KEY,
    body bytea NOT NULL,
    version text NOT NULL,
    size integer NOT NULL,
    content_type text,
    modified_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Prefix listings (`path LIKE 'devices/%'`) need a pattern-aware index;
  // the primary key's default collation may not serve LIKE.
  `CREATE INDEX IF NOT EXISTS ${OBJECTS_TABLE}_path_prefix
    ON ${OBJECTS_TABLE} (path text_pattern_ops)`,
  `ALTER TABLE ${OBJECTS_TABLE} ENABLE ROW LEVEL SECURITY`,
];

/** The schema as one script, for a console or a management API. */
export const SCHEMA_SQL = SCHEMA_STATEMENTS.map((s) => `${s};`).join("\n");

/** Create the table if it is missing. Safe to call on every connection. */
export async function ensureSchema(executor: SqlExecutor): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await executor.query(statement);
  }
}

/** Whether the table exists, without creating it. */
export async function schemaExists(executor: SqlExecutor): Promise<boolean> {
  const result = await executor.query(
    `SELECT to_regclass($1)::text AS name`,
    [OBJECTS_TABLE],
  );
  return typeof result.rows[0]?.name === "string";
}
