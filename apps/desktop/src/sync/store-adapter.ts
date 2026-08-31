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

import type {
  ApplyResult,
  CursorMap,
  SyncDataStore,
  SyncRecord
} from "@notesnook/sync-webdav";
import { resolveConflict, contentHashOf } from "@notesnook/sync-webdav";
import type { SettingsStore } from "../native/settings.ts";
import type { SqliteService } from "../native/sqlite.ts";
import { logger } from "../native/logger.ts";

const log = logger.scope("sync-store");

/**
 * Binds the transport-agnostic sync engine to the vault database.
 *
 * The engine knows nothing about SQLite or about Notesnook's schema; this
 * adapter is the only place that does. It reuses the dirty/tombstone
 * bookkeeping @notesnook/core already maintains:
 *
 *   - every syncable row carries `synced` (0 = has local changes) and
 *     `deleted` (tombstone), stamped by core's collections on write;
 *   - so "what changed locally" is a query, not a separate change log.
 *
 * The collection list mirrors core's SYNC_COLLECTIONS_MAP, which is the set
 * the spec requires to roam (notes, notebooks, tags, colors, relations,
 * reminders, attachments, content, settings, shortcuts, vaults).
 */

/** Table name -> the entityType used in sync records. */
export const SYNC_TABLES = [
  "notes",
  "notebooks",
  "content",
  "tags",
  "colors",
  "relations",
  "reminders",
  "attachments",
  "shortcuts",
  "settings",
  "vaults"
] as const;

export type SyncTable = (typeof SYNC_TABLES)[number];

/** Columns that are device-local and must never leave this machine. */
const LOCAL_ONLY_COLUMNS = new Set(["synced", "remote", "localOnly"]);

export interface AdapterOptions {
  sqlite: SqliteService;
  databaseHandle: string;
  settings: SettingsStore;
  /** Batch size when collecting local changes. */
  batchSize?: number;
  onConflictCopy?: (info: { table: string; id: string; title: string }) => void;
}

export class DatabaseSyncStore implements SyncDataStore {
  private readonly batchSize: number;

  constructor(private readonly options: AdapterOptions) {
    this.batchSize = options.batchSize ?? 500;
  }

  private query(sql: string, parameters: unknown[] = []) {
    return this.options.sqlite.run(
      this.options.databaseHandle,
      sql,
      parameters
    );
  }

  async getDeviceId(): Promise<string> {
    const existing = this.options.settings.get("sync").deviceId;
    if (existing) return existing;
    // Base32-ish id from random bytes: filesystem- and URL-safe, and it
    // carries no information about the machine or the user.
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    let id = "";
    for (const byte of bytes) {
      id += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte % 32];
    }
    await this.options.settings.patchSync({ deviceId: id });
    return id;
  }

  collectPendingChanges(): Promise<SyncRecord[]> {
    const records: SyncRecord[] = [];
    for (const table of SYNC_TABLES) {
      if (!this.tableExists(table)) continue;
      const rows = this.query(
        `SELECT * FROM ${table} WHERE synced IS NOT 1 LIMIT ?`,
        [this.batchSize]
      ).rows as Record<string, unknown>[];

      for (const row of rows) {
        const id = String(row.id ?? "");
        if (!id) continue;
        const item = stripLocalColumns(row);
        const deleted = row.deleted === 1 || row.deleted === true;
        records.push({
          entityId: id,
          entityType: table,
          operation: deleted ? "delete" : "upsert",
          revision: revisionOf(row),
          timestamp: Number(row.dateModified ?? Date.now()),
          item: deleted
            ? { id, deleted: true, dateModified: row.dateModified }
            : item
        });
      }
    }
    log.debug("Collected local changes", { count: records.length });
    return Promise.resolve(records);
  }

  markChangesSynced(records: SyncRecord[]): Promise<void> {
    const byTable = new Map<string, { id: string; revision: number }[]>();
    for (const record of records) {
      const list = byTable.get(record.entityType) ?? [];
      list.push({ id: record.entityId, revision: record.revision });
      byTable.set(record.entityType, list);
    }

    for (const [table, items] of byTable) {
      if (!isSyncTable(table) || !this.tableExists(table)) continue;
      for (const item of items) {
        // Guard against an edit that landed while the batch was uploading:
        // only clear the dirty flag if dateModified still matches the
        // revision we actually shipped. Otherwise the row stays dirty and
        // goes out in the next cycle. (Same guard core's collector uses.)
        this.query(
          `UPDATE ${table} SET synced = 1 WHERE id = ? AND dateModified <= ?`,
          [item.id, item.revision]
        );
      }
    }
    return Promise.resolve();
  }

  applyRemoteRecord(record: SyncRecord): Promise<ApplyResult> {
    const table = record.entityType;
    if (!isSyncTable(table)) {
      log.warn("Ignoring record for an unknown collection", { table });
      return Promise.resolve("skipped-stale");
    }
    if (!this.tableExists(table)) return Promise.resolve("skipped-stale");

    const existing = this.query(`SELECT * FROM ${table} WHERE id = ?`, [
      record.entityId
    ]).rows[0] as Record<string, unknown> | undefined;

    const local = existing
      ? {
          revision: revisionOf(existing),
          dateModified: Number(existing.dateModified ?? 0),
          dirty: existing.synced !== 1,
          deleted: existing.deleted === 1 || existing.deleted === true,
          contentHash: contentHashOf(stripLocalColumns(existing))
        }
      : undefined;

    const decision = resolveConflict(record, local);

    switch (decision.action) {
      case "keep-local":
        return Promise.resolve("skipped-stale");

      case "ignore-stale-resurrect":
        log.info("Refused to resurrect a deleted item from a stale device", {
          table,
          id: record.entityId
        });
        return Promise.resolve("skipped-tombstone");

      case "apply-tombstone":
        this.applyTombstone(table, record.entityId, record.revision);
        return Promise.resolve("applied");

      case "apply-remote":
        this.upsert(table, record.item as Record<string, unknown>);
        return Promise.resolve("applied");

      case "create-conflict-copy": {
        // Both versions survive. For note content, core already models this
        // with a `conflicted` column that the editor surfaces as a
        // side-by-side resolution view, so use it rather than inventing a
        // second mechanism. For anything else, duplicate the local row.
        if (table === "content" && existing) {
          this.query(
            `UPDATE content SET conflicted = ?, synced = 0 WHERE id = ?`,
            [JSON.stringify(record.item), record.entityId]
          );
          log.info("Marked note content as conflicted", {
            id: record.entityId,
            reason: decision.reason
          });
          this.options.onConflictCopy?.({
            table,
            id: record.entityId,
            title: "note content"
          });
          return Promise.resolve("conflicted");
        }

        if (existing) {
          const copy = { ...stripLocalColumns(existing) };
          copy.id = `${record.entityId}_conflict_${Date.now().toString(36)}`;
          if (typeof copy.title === "string") {
            copy.title = `${copy.title} (conflict)`;
          }
          copy.dateModified = Date.now();
          this.upsert(table, copy, { markDirty: true });
          this.options.onConflictCopy?.({
            table,
            id: String(copy.id),
            title: String(copy.title ?? copy.id)
          });
        }
        if (record.operation !== "delete") {
          this.upsert(table, record.item as Record<string, unknown>);
        }
        return Promise.resolve("conflicted");
      }
    }
  }

  private applyTombstone(table: string, id: string, revision: number): void {
    const columns = this.columnsOf(table);
    if (columns.has("deleted")) {
      this.query(
        `INSERT INTO ${table} (id, deleted, dateModified, synced) VALUES (?, 1, ?, 1)
         ON CONFLICT(id) DO UPDATE SET deleted = 1, dateModified = ?, synced = 1`,
        [id, revision, revision]
      );
    } else {
      this.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
    }
  }

  private upsert(
    table: string,
    item: Record<string, unknown>,
    options: { markDirty?: boolean } = {}
  ): void {
    const columns = this.columnsOf(table);
    const entries = Object.entries(item).filter(
      ([key]) => columns.has(key) && !LOCAL_ONLY_COLUMNS.has(key)
    );
    if (entries.length === 0) return;

    // `synced = 1` marks the row as matching the remote, so applying a
    // remote change does not immediately echo back as a local change.
    entries.push(["synced", options.markDirty ? 0 : 1]);

    const names = entries.map(([key]) => `"${key}"`).join(", ");
    const placeholders = entries.map(() => "?").join(", ");
    const updates = entries
      .filter(([key]) => key !== "id")
      .map(([key]) => `"${key}" = excluded."${key}"`)
      .join(", ");

    this.query(
      `INSERT INTO ${table} (${names}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`,
      entries.map(([, value]) => serializeValue(value))
    );
  }

  private tableCache = new Map<string, Set<string>>();

  private columnsOf(table: string): Set<string> {
    const cached = this.tableCache.get(table);
    if (cached) return cached;
    const rows = this.query(`PRAGMA table_info("${table}")`).rows as {
      name: string;
    }[];
    const columns = new Set(rows.map((row) => row.name));
    this.tableCache.set(table, columns);
    return columns;
  }

  private tableExists(table: string): boolean {
    return this.columnsOf(table).size > 0;
  }

  getCursors(): Promise<CursorMap> {
    return Promise.resolve({ ...this.options.settings.get("sync").cursors });
  }

  async setCursor(deviceId: string, sequence: number): Promise<void> {
    const cursors = { ...this.options.settings.get("sync").cursors };
    cursors[deviceId] = sequence;
    await this.options.settings.patchSync({ cursors });
  }

  getLocalSequence(): Promise<number> {
    return Promise.resolve(this.options.settings.get("sync").localSequence);
  }

  async setLocalSequence(sequence: number): Promise<void> {
    await this.options.settings.patchSync({ localSequence: sequence });
  }

  getMeta(key: string): Promise<string | undefined> {
    return Promise.resolve(this.options.settings.get("sync").meta[key]);
  }

  async setMeta(key: string, value: string | undefined): Promise<void> {
    const meta = { ...this.options.settings.get("sync").meta };
    if (value === undefined) delete meta[key];
    else meta[key] = value;
    await this.options.settings.patchSync({ meta });
  }

  /** Every attachment hash the database still references. */
  referencedAttachmentHashes(): Set<string> {
    const hashes = new Set<string>();
    if (!this.tableExists("attachments")) return hashes;
    const rows = this.query(
      "SELECT hash FROM attachments WHERE deleted IS NOT 1"
    ).rows as { hash?: string }[];
    for (const row of rows) if (row.hash) hashes.add(row.hash);
    return hashes;
  }

  /** Full state, for rebuilding the remote repository from scratch. */
  fullState(): SyncRecord[] {
    const records: SyncRecord[] = [];
    for (const table of SYNC_TABLES) {
      if (!this.tableExists(table)) continue;
      const rows = this.query(`SELECT * FROM ${table}`).rows as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (!id) continue;
        const deleted = row.deleted === 1 || row.deleted === true;
        records.push({
          entityId: id,
          entityType: table,
          operation: deleted ? "delete" : "upsert",
          revision: revisionOf(row),
          timestamp: Number(row.dateModified ?? Date.now()),
          item: deleted
            ? { id, deleted: true, dateModified: row.dateModified }
            : stripLocalColumns(row)
        });
      }
    }
    return records;
  }
}

function isSyncTable(value: string): value is SyncTable {
  return (SYNC_TABLES as readonly string[]).includes(value);
}

/**
 * Notesnook items have no explicit revision counter; `dateModified` is the
 * monotonic per-item version core already maintains, so it serves as one.
 */
function revisionOf(row: Record<string, unknown>): number {
  const value = Number(row.dateModified ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function stripLocalColumns(
  row: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (LOCAL_ONLY_COLUMNS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function serializeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object" && !(value instanceof Uint8Array)) {
    return JSON.stringify(value);
  }
  return value;
}
