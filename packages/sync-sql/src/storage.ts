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

import {
  type PutOptions,
  type RemoteCapabilities,
  type RemoteEntry,
  type RemoteStorage,
  SyncError,
} from "@notesnook/sync-core";
import { fromByteaValue, type SqlExecutor, type SqlValue } from "./executor.ts";
import { OBJECTS_TABLE } from "./schema.ts";

const T = OBJECTS_TABLE;

/**
 * The object store, over one table.
 *
 * Every guarantee is one statement, because the executor promises no
 * transactions:
 *
 *   putNew     INSERT … ON CONFLICT (path) DO NOTHING RETURNING version
 *              No row back means someone else got there first. The primary
 *              key decides, not a read that a second writer can race.
 *   putUpdate  UPDATE … WHERE path = $1 AND version = $expected RETURNING
 *              No row back means the version moved on (or the object went
 *              away -- both are "not what you thought", both refuse).
 *
 * Directories do not exist. A listing groups the paths under a prefix into
 * direct children and implied collections, which is how every object store
 * behaves and the stricter assumption for an engine to be written against.
 */
export class SqlRemoteStorage implements RemoteStorage {
  constructor(
    private readonly executor: SqlExecutor,
    private readonly options: { newVersion?: () => string } = {},
  ) {}

  private version(): string {
    return this.options.newVersion?.() ?? crypto.randomUUID();
  }

  async probe(): Promise<void> {
    // A real statement against the real table: credentials, reachability
    // and "was setup run" all surface here rather than mid-sync.
    try {
      await this.executor.query(`SELECT 1 FROM ${T} LIMIT 1`);
    } catch (error) {
      throw asSyncError(error, "The database refused the connection");
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const prefix = normalise(path);
    const like = prefix ? `${escapeLike(prefix)}/%` : "%";
    const result = await this.run(
      `SELECT path, size, version, modified_at FROM ${T}
       WHERE path LIKE $1 ESCAPE '\\'`,
      [like],
    );

    const out = new Map<string, RemoteEntry>();
    for (const row of result.rows) {
      const full = String(row.path);
      const rest = prefix ? full.slice(prefix.length + 1) : full;
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        out.set(full, {
          path: full,
          isCollection: false,
          size: Number(row.size),
          version: String(row.version),
          modifiedAt: row.modified_at === undefined || row.modified_at === null
            ? undefined
            : String(row.modified_at),
        });
      } else {
        const dir = (prefix ? `${prefix}/` : "") + rest.slice(0, slash);
        if (!out.has(dir)) out.set(dir, { path: dir, isCollection: true });
      }
    }
    return [...out.values()];
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const key = normalise(path);
    const result = await this.run(
      `SELECT path, size, version, modified_at FROM ${T} WHERE path = $1`,
      [key],
    );
    const row = result.rows[0];
    if (row) {
      return {
        path: key,
        isCollection: false,
        size: Number(row.size),
        version: String(row.version),
        modifiedAt: row.modified_at === undefined || row.modified_at === null
          ? undefined
          : String(row.modified_at),
      };
    }
    // An implied collection: something lives under it.
    const children = await this.run(
      `SELECT 1 FROM ${T} WHERE path LIKE $1 ESCAPE '\\' LIMIT 1`,
      [`${escapeLike(key)}/%`],
    );
    return children.rows.length > 0
      ? { path: key, isCollection: true }
      : undefined;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const bytes = await this.getIfExists(path);
    if (!bytes) {
      throw new SyncError(`${path} is not in the database`, "not-found", 404);
    }
    return bytes;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const result = await this.run(
      `SELECT body FROM ${T} WHERE path = $1`,
      [normalise(path)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    try {
      return fromByteaValue(row.body);
    } catch (error) {
      throw new SyncError(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
        "corrupt-data",
      );
    }
  }

  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const key = normalise(path);
    const version = this.version();
    const result = await this.run(
      `INSERT INTO ${T} (path, body, version, size, content_type)
       VALUES ($1, $2::bytea, $3, $4::integer, $5)
       ON CONFLICT (path) DO NOTHING
       RETURNING version`,
      [
        key,
        body,
        version,
        body.length,
        options?.contentType ?? null,
      ],
    );
    if (result.rows.length === 0) {
      throw new SyncError(
        `${path} already exists`,
        "precondition-failed",
        412,
      );
    }
    return { path: key, isCollection: false, size: body.length, version };
  }

  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const key = normalise(path);
    const version = this.version();
    const contentType = options?.contentType ?? null;

    if (expectedVersion !== undefined) {
      const result = await this.run(
        `UPDATE ${T}
         SET body = $2::bytea, version = $3, size = $4::integer,
             content_type = $5, modified_at = now()
         WHERE path = $1 AND version = $6
         RETURNING version`,
        [
          key,
          body,
          version,
          body.length,
          contentType,
          expectedVersion,
        ],
      );
      if (result.rows.length === 0) {
        throw new SyncError(
          `${path} was changed by another device`,
          "precondition-failed",
          412,
        );
      }
    } else {
      await this.run(
        `INSERT INTO ${T} (path, body, version, size, content_type)
         VALUES ($1, $2::bytea, $3, $4::integer, $5)
         ON CONFLICT (path) DO UPDATE
         SET body = EXCLUDED.body, version = EXCLUDED.version,
             size = EXCLUDED.size, content_type = EXCLUDED.content_type,
             modified_at = now()`,
        [key, body, version, body.length, contentType],
      );
    }
    return { path: key, isCollection: false, size: body.length, version };
  }

  async delete(path: string): Promise<void> {
    const key = normalise(path);
    // A collection is its contents; deleting something absent succeeds.
    await this.run(
      `DELETE FROM ${T} WHERE path = $1 OR path LIKE $2 ESCAPE '\\'`,
      [key, `${escapeLike(key)}/%`],
    );
  }

  async move(from: string, to: string, overwrite = true): Promise<void> {
    const source = normalise(from);
    const target = normalise(to);
    if (!overwrite && (await this.exists(target))) {
      throw new SyncError(`${to} already exists`, "precondition-failed", 412);
    }
    // Two statements rather than one transaction, by design of the executor.
    // The delete is what an overwrite means; if the rename then fails, the
    // source is intact and the caller retries -- nothing is lost.
    if (overwrite) await this.delete(target);
    const moved = await this.run(
      `UPDATE ${T} SET path = $2 WHERE path = $1`,
      [source, target],
    );
    if (moved.rowCount > 0) return;
    // A collection: rename every path under it.
    const children = await this.run(
      `UPDATE ${T}
       SET path = $2 || substr(path, length($1) + 1)
       WHERE path LIKE $3 ESCAPE '\\'`,
      [source, target, `${escapeLike(source)}/%`],
    );
    if (children.rowCount === 0) {
      throw new SyncError(`${from} is not in the database`, "not-found", 404);
    }
  }

  mkdirp(_path: string): Promise<void> {
    // Directories are implied by the paths under them.
    return Promise.resolve();
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const entry = await this.stat(path);
    if (!entry || entry.isCollection) {
      throw new SyncError(
        `${path} is missing after upload`,
        "server-error",
      );
    }
    if (entry.size !== expectedLength) {
      throw new SyncError(
        `${path} holds ${entry.size} bytes but ${expectedLength} were written`,
        "server-error",
      );
    }
  }

  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      atomicCreate: true,
      conditionalUpdate: true,
      serverSideMove: true,
    });
  }

  // Bytes are handed to the executor as bytes: a socket driver serialises
  // them for the bytea type itself, and an HTTP transport writes the `\x`
  // text form. Doing that here for both produced a text literal that the
  // driver then encoded a second time, storing the characters "\x70"
  // instead of the byte 0x70.
  private async run(sql: string, params: SqlValue[]) {
    try {
      return await this.executor.query(sql, params);
    } catch (error) {
      throw asSyncError(error, "The database query failed");
    }
  }
}

function normalise(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** `%` and `_` are wildcards in LIKE; a path may legitimately contain `_`. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function asSyncError(error: unknown, context: string): SyncError {
  if (error instanceof SyncError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("password authentication failed") ||
    lower.includes("authentication") || lower.includes("jwt") ||
    lower.includes("unauthorized") || lower.includes("permission denied")
  ) {
    return new SyncError(`${context}: ${message}`, "unauthorized");
  }
  if (lower.includes("does not exist") && lower.includes("relation")) {
    return new SyncError(
      `${context}: the ${OBJECTS_TABLE} table is missing. Run the setup ` +
        `step for this database again.`,
      "not-found",
    );
  }
  if (
    lower.includes("timeout") || lower.includes("timed out")
  ) {
    return new SyncError(`${context}: ${message}`, "timeout");
  }
  if (
    lower.includes("econnrefused") || lower.includes("enotfound") ||
    lower.includes("network") || lower.includes("fetch") ||
    lower.includes("connection")
  ) {
    return new SyncError(`${context}: ${message}`, "network");
  }
  return new SyncError(`${context}: ${message}`, "server-error");
}
