/*
This file is part of the Notesnook project (https://notesnook.com/)

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

import * as SQLite from "expo-sqlite";
import type {
  ApplyResult,
  CursorMap,
  SyncDataStore,
  SyncRecord
} from "../../../packages/sync-webdav/src/types.ts";
import {
  contentHashOf,
  resolveConflict
} from "../../../packages/sync-webdav/src/conflicts.ts";
import type { TextStore } from "@notesnook/sync-core";
import { newDeviceId, newId } from "./ids.ts";

/**
 * The phone's copy of the vault, and the seam the sync engine writes through.
 *
 * ONE TABLE OF JSON
 *
 * The desktop keeps Notesnook's schema -- a table per collection with every
 * column core knows. The phone does not run core; it keeps each synced item
 * as the JSON the desktop put in the journal, keyed by collection and id,
 * with the few columns the screens query pulled out beside it. So a record
 * for a collection this app never displays (reminders, shortcuts, vaults)
 * is still stored and still relayed faithfully; nothing is dropped because
 * the phone did not understand it.
 *
 * The sync bookkeeping is the desktop's: `synced` is 0 while an item has
 * local edits, `deleted` is the tombstone, `dateModified` is the revision.
 * Conflict decisions come from the same resolveConflict the desktop uses.
 */

export interface StoredItem {
  collection: string;
  id: string;
  item: Record<string, unknown>;
  dateModified: number;
  deleted: boolean;
  synced: boolean;
}

export interface NoteSummary {
  id: string;
  title: string;
  headline: string;
  dateEdited: number;
  pinned: boolean;
  favorite: boolean;
  locked: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  dateModified INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  synced INTEGER NOT NULL DEFAULT 1,
  itemType TEXT,
  noteId TEXT,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS items_note ON items (collection, noteId);
CREATE INDEX IF NOT EXISTS items_dirty ON items (synced);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export class MobileDatabase implements SyncDataStore {
  private readonly db: SQLite.SQLiteDatabase;

  constructor(name = "openotes.db") {
    this.db = SQLite.openDatabaseSync(name);
    this.db.execSync("PRAGMA journal_mode = WAL");
    this.db.execSync(SCHEMA);
  }

  // ------------------------------------------------------------ key/value

  getValue(key: string): string | undefined {
    const row = this.db.getFirstSync<{ value: string | null }>(
      "SELECT value FROM kv WHERE key = ?",
      [key]
    );
    return row?.value ?? undefined;
  }

  setValue(key: string, value: string | undefined): void {
    if (value === undefined) {
      this.db.runSync("DELETE FROM kv WHERE key = ?", [key]);
    } else {
      this.db.runSync(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value]
      );
    }
  }

  /** A TextStore over one key, for the engine's outgoing queue. */
  textStore(key: string): TextStore {
    return {
      read: () => Promise.resolve(this.getValue(key)),
      write: (value) => {
        this.setValue(key, value);
        return Promise.resolve();
      }
    };
  }

  // ---------------------------------------------------------------- items

  private readItem(collection: string, id: string): StoredItem | undefined {
    const row = this.db.getFirstSync<{
      data: string;
      dateModified: number;
      deleted: number;
      synced: number;
    }>(
      "SELECT data, dateModified, deleted, synced FROM items WHERE collection = ? AND id = ?",
      [collection, id]
    );
    if (!row) return undefined;
    return {
      collection,
      id,
      item: JSON.parse(row.data),
      dateModified: row.dateModified,
      deleted: row.deleted === 1,
      synced: row.synced === 1
    };
  }

  private writeItem(
    collection: string,
    item: Record<string, unknown>,
    options: { deleted?: boolean; synced: boolean }
  ): void {
    const id = String(item.id);
    const dateModified = Number(item.dateModified ?? Date.now());
    this.db.runSync(
      `INSERT INTO items (collection, id, data, dateModified, deleted, synced, itemType, noteId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(collection, id) DO UPDATE SET
         data = excluded.data, dateModified = excluded.dateModified,
         deleted = excluded.deleted, synced = excluded.synced,
         itemType = excluded.itemType, noteId = excluded.noteId`,
      [
        collection,
        id,
        JSON.stringify(item),
        dateModified,
        options.deleted || item.deleted === true ? 1 : 0,
        options.synced ? 1 : 0,
        typeof item.type === "string" ? item.type : null,
        typeof item.noteId === "string" ? item.noteId : null
      ]
    );
  }

  /** Record a local change: the item is stored dirty and picked up by sync. */
  saveLocal(collection: string, item: Record<string, unknown>): void {
    this.writeItem(collection, item, { synced: false });
  }

  // ------------------------------------------------------------- the notes

  listNotes(): NoteSummary[] {
    const rows = this.db.getAllSync<{ id: string; data: string }>(
      "SELECT id, data FROM items WHERE collection = 'notes' AND deleted = 0 AND itemType = 'note' ORDER BY dateModified DESC"
    );
    const notes: NoteSummary[] = [];
    for (const row of rows) {
      const note = JSON.parse(row.data) as Record<string, unknown>;
      notes.push({
        id: row.id,
        title: String(note.title ?? "Untitled"),
        headline: String(note.headline ?? ""),
        dateEdited: Number(note.dateEdited ?? note.dateModified ?? 0),
        pinned: note.pinned === true || note.pinned === 1,
        favorite: note.favorite === true || note.favorite === 1,
        locked: this.contentFor(row.id)?.locked === true
      });
    }
    return notes.sort((a, b) =>
      a.pinned === b.pinned ? b.dateEdited - a.dateEdited : a.pinned ? -1 : 1
    );
  }

  getNote(id: string): Record<string, unknown> | undefined {
    return this.readItem("notes", id)?.item;
  }

  /** The content row for a note: `{ data, locked }` or nothing yet. */
  contentFor(noteId: string): { id: string; data: string; locked: boolean } | undefined {
    const row = this.db.getFirstSync<{ id: string; data: string }>(
      "SELECT id, data FROM items WHERE collection = 'content' AND noteId = ? AND deleted = 0 ORDER BY dateModified DESC LIMIT 1",
      [noteId]
    );
    if (!row) return undefined;
    const content = JSON.parse(row.data) as Record<string, unknown>;
    const locked = content.locked === true || content.locked === 1;
    return {
      id: row.id,
      data: locked ? "" : String(content.data ?? ""),
      locked
    };
  }

  /**
   * Create or update a note from the editor. The shapes are the ones the
   * desktop's tables have columns for, so the same items open there.
   */
  saveNote(input: {
    id?: string;
    title: string;
    html: string;
    headline: string;
  }): string {
    const now = Date.now();
    const existing = input.id ? this.getNote(input.id) : undefined;
    const noteId = input.id ?? newId(now);
    const content = input.id ? this.contentFor(input.id) : undefined;
    const contentId = content?.id ?? newId(now);

    this.saveLocal("content", {
      ...(content ? this.readItem("content", content.id)?.item : {}),
      id: contentId,
      type: "tiptap",
      noteId,
      data: input.html,
      locked: false,
      localOnly: false,
      dateCreated: existing ? undefined : now,
      dateEdited: now,
      dateModified: now,
      deleted: false
    });
    this.saveLocal("notes", {
      ...(existing ?? {}),
      id: noteId,
      type: "note",
      title: input.title,
      headline: input.headline,
      contentId,
      pinned: existing?.pinned ?? false,
      favorite: existing?.favorite ?? false,
      localOnly: false,
      conflicted: false,
      readonly: false,
      dateCreated: existing?.dateCreated ?? now,
      dateEdited: now,
      dateModified: now,
      dateDeleted: null,
      itemType: null,
      deletedBy: null,
      deleted: false
    });
    return noteId;
  }

  /** Move a note to the trash, the way the desktop does: it is not deleted. */
  trashNote(id: string): void {
    const note = this.getNote(id);
    if (!note) return;
    const now = Date.now();
    this.saveLocal("notes", {
      ...note,
      type: "trash",
      itemType: "note",
      dateDeleted: now,
      dateModified: now,
      deletedBy: "user"
    });
  }

  /** Everything, for wiping the phone's copy when disconnecting. */
  clearAll(): void {
    this.db.execSync("DELETE FROM items; DELETE FROM kv;");
  }

  // ---------------------------------------------------------- SyncDataStore

  getDeviceId(): Promise<string> {
    let id = this.getValue("deviceId");
    if (!id) {
      id = newDeviceId();
      this.setValue("deviceId", id);
    }
    return Promise.resolve(id);
  }

  collectPendingChanges(): Promise<SyncRecord[]> {
    const rows = this.db.getAllSync<{
      collection: string;
      id: string;
      data: string;
      dateModified: number;
      deleted: number;
    }>(
      "SELECT collection, id, data, dateModified, deleted FROM items WHERE synced = 0 LIMIT 500"
    );
    return Promise.resolve(
      rows.map((row) => {
        const item = JSON.parse(row.data) as Record<string, unknown>;
        const deleted = row.deleted === 1;
        return {
          entityId: row.id,
          entityType: row.collection,
          operation: deleted ? "delete" : "upsert",
          revision: row.dateModified,
          timestamp: row.dateModified,
          item: deleted
            ? { id: row.id, deleted: true, dateModified: row.dateModified }
            : item
        } satisfies SyncRecord;
      })
    );
  }

  markChangesSynced(records: SyncRecord[]): Promise<void> {
    for (const record of records) {
      this.db.runSync(
        "UPDATE items SET synced = 1 WHERE collection = ? AND id = ? AND dateModified <= ?",
        [record.entityType, record.entityId, record.revision]
      );
    }
    return Promise.resolve();
  }

  applyRemoteRecord(record: SyncRecord): Promise<ApplyResult> {
    const existing = this.readItem(record.entityType, record.entityId);
    const local = existing
      ? {
          revision: existing.dateModified,
          dateModified: existing.dateModified,
          dirty: !existing.synced,
          deleted: existing.deleted,
          contentHash: contentHashOf(existing.item)
        }
      : undefined;
    const decision = resolveConflict(record, local);

    switch (decision.action) {
      case "keep-local":
        return Promise.resolve("skipped-stale");
      case "ignore-stale-resurrect":
        return Promise.resolve("skipped-tombstone");
      case "apply-tombstone":
        this.writeItem(
          record.entityType,
          {
            ...(existing?.item ?? {}),
            id: record.entityId,
            deleted: true,
            dateModified: record.revision
          },
          { deleted: true, synced: true }
        );
        return Promise.resolve("applied");
      case "apply-remote":
        this.writeItem(record.entityType, record.item as Record<string, unknown>, {
          synced: true
        });
        return Promise.resolve("applied");
      case "create-conflict-copy": {
        // Never discard content. The local version becomes a copy the user
        // can see, and the remote one takes the item's place, so both
        // devices converge on the same item while nothing is lost.
        if (existing && !existing.deleted) {
          const copyId = `${record.entityId}_conflict_${Date.now().toString(36)}`;
          const copy: Record<string, unknown> = {
            ...existing.item,
            id: copyId,
            dateModified: Date.now()
          };
          if (typeof copy.title === "string") copy.title = `${copy.title} (conflict)`;
          if (record.entityType === "content") {
            // Content is only reachable through a note; give the copy one.
            const noteId = String(existing.item.noteId ?? "");
            const note = noteId ? this.getNote(noteId) : undefined;
            if (note) {
              const copyNoteId = `${noteId}_conflict_${Date.now().toString(36)}`;
              copy.noteId = copyNoteId;
              this.saveLocal("notes", {
                ...note,
                id: copyNoteId,
                title: `${String(note.title ?? "Untitled")} (conflict)`,
                contentId: copyId,
                dateModified: Date.now()
              });
            }
          }
          this.saveLocal(record.entityType, copy);
        }
        if (record.operation !== "delete") {
          this.writeItem(record.entityType, record.item as Record<string, unknown>, {
            synced: true
          });
        }
        return Promise.resolve("conflicted");
      }
    }
  }

  getCursors(): Promise<CursorMap> {
    const raw = this.getValue("cursors");
    return Promise.resolve(raw ? (JSON.parse(raw) as CursorMap) : {});
  }

  async setCursor(deviceId: string, sequence: number): Promise<void> {
    const cursors = await this.getCursors();
    cursors[deviceId] = sequence;
    this.setValue("cursors", JSON.stringify(cursors));
  }

  getLocalSequence(): Promise<number> {
    return Promise.resolve(Number(this.getValue("localSequence") ?? 0));
  }

  setLocalSequence(sequence: number): Promise<void> {
    this.setValue("localSequence", String(sequence));
    return Promise.resolve();
  }

  getMeta(key: string): Promise<string | undefined> {
    return Promise.resolve(this.getValue(`meta:${key}`));
  }

  setMeta(key: string, value: string | undefined): Promise<void> {
    this.setValue(`meta:${key}`, value);
    return Promise.resolve();
  }
}
