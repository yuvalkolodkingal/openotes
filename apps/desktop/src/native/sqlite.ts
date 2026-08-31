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

import { Database } from "@db/sqlite";
import { join } from "@std/path";
import { appDataDir, assertInside, ensureDirSync } from "./paths.ts";
import { logger } from "./logger.ts";

/**
 * Encrypted SQLite for the Deno runtime.
 *
 * Upstream ran better-sqlite3-multiple-ciphers in the Electron main process.
 * That is a V8-internals native addon and cannot load under Deno, so this
 * uses Deno's FFI binding (@db/sqlite) against a bundled build of
 * SQLite3MultipleCiphers — the same encryption layer upstream relies on, so
 * `PRAGMA key` behaves identically and an existing Notesnook database can be
 * opened for import.
 *
 * The two FTS5 tokenizer extensions upstream uses (better_trigram and html)
 * are loadable SQLite extensions and are loaded the same way, after the
 * database is decrypted — before decryption `SELECT fts5` fails, which is
 * what the extensions need to obtain the FTS5 API.
 */

const log = logger.scope("sqlite");

export interface SqliteOptions {
  /** Absolute path, or ":memory:". */
  filePath: string;
  /** Hex-encoded database key. Omit for an unencrypted (in-memory) db. */
  password?: string;
  journalMode?: "WAL" | "MEMORY" | "DELETE";
  lockingMode?: "exclusive" | "normal";
  synchronous?: "off" | "normal" | "full";
  pageSize?: number;
  cacheSize?: number;
  tempStore?: "memory" | "file";
}

export interface QueryResult {
  rows: unknown[];
  numAffectedRows?: number;
  insertId?: number;
}

/** Where the bundled native library and extensions live at runtime. */
export function nativeDir(): string {
  const override = Deno.env.get("OPENOTES_NATIVE_DIR");
  if (override) return override;
  // In a compiled binary the assets sit next to the executable; in dev they
  // are under apps/desktop/native.
  const candidates = [
    join(dirnameOf(Deno.execPath()), "native"),
    join(Deno.cwd(), "apps", "desktop", "native"),
    join(Deno.cwd(), "native")
  ];
  for (const candidate of candidates) {
    try {
      if (Deno.statSync(candidate).isDirectory) return candidate;
    } catch {
      continue;
    }
  }
  return candidates[0];
}

function dirnameOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "." : path.slice(0, index);
}

function libraryName(): string {
  switch (Deno.build.os) {
    case "windows":
      return "sqlite3mc.dll";
    case "darwin":
      return "libsqlite3mc.dylib";
    default:
      return "libsqlite3mc.so";
  }
}

function extensionSuffix(): string {
  switch (Deno.build.os) {
    case "windows":
      return "dll";
    case "darwin":
      return "dylib";
    default:
      return "so";
  }
}

/**
 * Point @db/sqlite at the bundled encryption-capable library. Must run
 * before the first Database is constructed.
 */
export function configureNativeLibrary(): { path: string; encrypted: boolean } {
  const existing = Deno.env.get("DENO_SQLITE_PATH");
  if (existing) return { path: existing, encrypted: true };

  const path = join(nativeDir(), libraryName());
  try {
    Deno.statSync(path);
    Deno.env.set("DENO_SQLITE_PATH", path);
    log.info("Using bundled SQLite3MultipleCiphers", { path });
    return { path, encrypted: true };
  } catch {
    // Refuse to silently fall back to an unencrypted SQLite: the vault is
    // supposed to be encrypted at rest, and a silent downgrade is exactly
    // the kind of failure a user would never notice.
    throw new Error(
      `The encrypted SQLite library was not found at ${path}. ` +
        `The application cannot open an encrypted vault without it. ` +
        `Run "deno task build:native" to build it, or set ` +
        `OPENOTES_NATIVE_DIR to the directory that contains it.`
    );
  }
}

export class SqliteConnection {
  private db: Database;
  private extensionsLoaded = false;
  private initialized = false;
  private readonly encrypted: boolean;

  constructor(
    readonly id: string,
    private readonly options: SqliteOptions
  ) {
    this.encrypted = !!options.password && options.filePath !== ":memory:";
    if (options.filePath !== ":memory:") {
      ensureDirSync(dirnameOf(options.filePath));
    }
    this.db = new Database(options.filePath, { int64: true });
    if (options.password) {
      // Keying must be the first statement executed on the connection.
      this.db.exec(`PRAGMA key = "x'${options.password}'"`);
    }
  }

  /** Apply pragmas and load extensions once the database is readable. */
  private initialize(): void {
    if (this.initialized) return;
    const { journalMode, lockingMode, synchronous, pageSize, cacheSize, tempStore } =
      this.options;

    // page_size must be set before the first write for a new database.
    if (pageSize) this.db.exec(`PRAGMA page_size = ${pageSize}`);
    if (journalMode) this.db.exec(`PRAGMA journal_mode = ${journalMode}`);
    if (lockingMode) this.db.exec(`PRAGMA locking_mode = ${lockingMode}`);
    if (synchronous) this.db.exec(`PRAGMA synchronous = ${synchronous}`);
    if (cacheSize) this.db.exec(`PRAGMA cache_size = ${cacheSize}`);
    if (tempStore) this.db.exec(`PRAGMA temp_store = ${tempStore}`);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initialized = true;
  }

  private isReadable(): boolean {
    try {
      this.db.prepare("SELECT count(*) FROM sqlite_master").value();
      return true;
    } catch {
      return false;
    }
  }

  private loadExtensions(): void {
    if (this.extensionsLoaded) return;
    const suffix = extensionSuffix();
    const directory = nativeDir();
    try {
      this.db.enableLoadExtension = true;
      this.db.loadExtension(join(directory, `better-trigram.${suffix}`));
      this.db.loadExtension(join(directory, `fts5-html.${suffix}`));
      this.extensionsLoaded = true;
      log.debug("Loaded FTS5 tokenizer extensions", { directory });
    } catch (error) {
      log.error("Could not load FTS5 tokenizer extensions", {
        directory,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(
        `Full-text search extensions could not be loaded from ${directory}. ` +
          `Search would silently return wrong results without them.`
      );
    } finally {
      this.db.enableLoadExtension = false;
    }
  }

  run(sql: string, parameters: unknown[] = []): QueryResult {
    // The key pragma is handled at construction; the renderer must not be
    // able to re-key or read the key back out.
    if (/^\s*PRAGMA\s+(re)?key/i.test(sql)) {
      throw new Error("Re-keying is not permitted from the renderer");
    }

    if (!this.initialized) this.initialize();
    if (!this.extensionsLoaded && this.isReadable()) this.loadExtensions();

    const statement = this.db.prepare(sql);
    const params = parameters.map(normalizeParameter);
    if (statement.columnNames().length > 0) {
      return { rows: statement.all(...(params as never[])) };
    }
    const changes = statement.run(...(params as never[]));
    return {
      rows: [],
      numAffectedRows: changes,
      insertId: Number(this.db.lastInsertRowId)
    };
  }

  /** Serialize the whole database, for export/backup of the raw file. */
  export(): Uint8Array {
    if (this.options.filePath === ":memory:") {
      throw new Error("Cannot export an in-memory database");
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return Deno.readFileSync(this.options.filePath);
  }

  close(): void {
    try {
      if (this.options.journalMode === "WAL") {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    } catch {
      /* checkpoint is best effort */
    }
    this.db.close();
  }

  delete(): void {
    this.close();
    if (this.options.filePath === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        Deno.removeSync(this.options.filePath + suffix);
      } catch {
        /* the sidecar file may not exist */
      }
    }
  }

  get isEncrypted() {
    return this.encrypted;
  }
}

function normalizeParameter(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Owns every open connection. Handles are opaque strings; the renderer can
 * only reference a database it opened through a validated path.
 */
export class SqliteService {
  private readonly connections = new Map<string, SqliteConnection>();
  private nextId = 1;
  private configured = false;

  open(options: {
    filePath: string;
    password?: string;
    journalMode?: SqliteOptions["journalMode"];
    lockingMode?: SqliteOptions["lockingMode"];
    synchronous?: SqliteOptions["synchronous"];
    pageSize?: number;
    cacheSize?: number;
    tempStore?: SqliteOptions["tempStore"];
  }): string {
    if (!this.configured) {
      configureNativeLibrary();
      this.configured = true;
    }

    const filePath =
      options.filePath === ":memory:"
        ? ":memory:"
        : assertInside(
            options.filePath,
            [appDataDir()],
            "database path"
          );

    if (options.password && !/^[0-9a-fA-F]+$/.test(options.password)) {
      throw new Error("The database key must be hex encoded");
    }

    const id = `db${this.nextId++}`;
    this.connections.set(
      id,
      new SqliteConnection(id, { ...options, filePath })
    );
    log.info("Opened database", {
      id,
      encrypted: !!options.password,
      inMemory: filePath === ":memory:"
    });
    return id;
  }

  run(id: string, sql: string, parameters: unknown[]): QueryResult {
    return this.connection(id).run(sql, parameters);
  }

  export(id: string): Uint8Array {
    return this.connection(id).export();
  }

  close(id: string): void {
    this.connections.get(id)?.close();
    this.connections.delete(id);
  }

  delete(id: string): void {
    this.connections.get(id)?.delete();
    this.connections.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.connections.keys()]) this.close(id);
  }

  private connection(id: string): SqliteConnection {
    const connection = this.connections.get(id);
    if (!connection) throw new Error(`Unknown database handle: ${id}`);
    return connection;
  }
}
