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
 * A SQL database as a sync backend.
 *
 * One table holds the repository: a path, the bytes, and a version that
 * changes on every write. That is enough for both primitives every engine
 * relies on to be *real* rather than emulated -- a primary key makes
 * create-if-absent atomic, and `UPDATE … WHERE version = $expected` is
 * compare-and-swap -- which puts a plain Postgres database in the same class
 * as Dropbox and S3, and above WebDAV, as a place to keep notes.
 *
 * Three ways in, one storage:
 *
 *   - `SqlRemoteStorage` over any `SqlExecutor`. `PostgresExecutor` (in
 *     ./postgres.ts, desktop only: it opens a socket) speaks to any Postgres;
 *     `NeonHttpExecutor` speaks Neon's SQL-over-HTTP endpoint with nothing
 *     but fetch, so it also runs on a phone.
 *   - `SupabaseRestStorage` speaks Supabase's PostgREST API directly, again
 *     with nothing but fetch. The table is the same one.
 *
 * Nothing here knows about notes, keys or the journal format. The bytes are
 * whatever the engine hands over -- encrypted, in every configuration that
 * ships -- so the database sees ciphertext under opaque paths, exactly as a
 * WebDAV server would.
 */

export * from "./executor.ts";
export * from "./schema.ts";
export * from "./storage.ts";
export * from "./neon.ts";
export * from "./supabase.ts";
export * from "./connection.ts";
