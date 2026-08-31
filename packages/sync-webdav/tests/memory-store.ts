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

import {
  ApplyResult,
  CursorMap,
  SyncDataStore,
  SyncRecord,
} from "../src/types.ts";
import {
  conflictTitle,
  contentHashOf,
  LocalItemState,
  resolveConflict,
} from "../src/conflicts.ts";
import { AttachmentSource } from "../src/engine.ts";

export interface TestItem {
  id: string;
  type: string;
  title?: string;
  content?: string;
  hash?: string;
  revision: number;
  dateModified: number;
  deleted?: boolean;
  /** Set on conflict copies so tests can assert both versions survived. */
  conflictOf?: string;
}

/**
 * A minimal SyncDataStore over plain maps. It implements the same conflict
 * policy the desktop adapter implements against @notesnook/core, so the
 * multi-device scenarios in the spec can be exercised without a database.
 */
export class MemorySyncStore implements SyncDataStore {
  readonly items = new Map<string, TestItem>();
  readonly tombstones = new Map<string, number>();
  readonly conflicts: TestItem[] = [];
  private readonly dirty = new Set<string>();
  private cursors: CursorMap = {};
  private localSequence = 0;
  private readonly meta = new Map<string, string>();

  constructor(
    readonly deviceId: string,
    readonly deviceName = deviceId,
  ) {}

  getDeviceId(): Promise<string> {
    return Promise.resolve(this.deviceId);
  }

  // ---- local mutation helpers (what the UI would call) ----

  put(
    item: Omit<TestItem, "revision" | "dateModified"> & {
      revision?: number;
      dateModified?: number;
    },
  ): TestItem {
    const key = itemKey(item.type, item.id);
    const existing = this.items.get(key);
    const stored: TestItem = {
      ...item,
      revision: item.revision ?? (existing ? existing.revision + 1 : 1),
      dateModified: item.dateModified ?? Date.now(),
    };
    this.items.set(key, stored);
    this.dirty.add(key);
    return stored;
  }

  remove(type: string, id: string): void {
    const key = itemKey(type, id);
    const existing = this.items.get(key);
    this.items.delete(key);
    this.tombstones.set(key, (existing?.revision ?? 0) + 1);
    this.dirty.add(key);
  }

  get(type: string, id: string): TestItem | undefined {
    return this.items.get(itemKey(type, id));
  }

  /** Logical snapshot used by the backup tests. */
  snapshot(): { items: TestItem[]; tombstones: [string, number][] } {
    return {
      items: [...this.items.values()],
      tombstones: [...this.tombstones.entries()],
    };
  }

  restore(snapshot: {
    items: TestItem[];
    tombstones: [string, number][];
  }): void {
    this.items.clear();
    this.tombstones.clear();
    for (const item of snapshot.items) {
      this.items.set(itemKey(item.type, item.id), item);
    }
    for (const [key, revision] of snapshot.tombstones) {
      this.tombstones.set(key, revision);
    }
  }

  // ---- SyncDataStore ----

  collectPendingChanges(): Promise<SyncRecord[]> {
    const records: SyncRecord[] = [];
    for (const key of this.dirty) {
      const [entityType, entityId] = splitKey(key);
      const item = this.items.get(key);
      if (item) {
        records.push({
          entityId,
          entityType,
          operation: "upsert",
          revision: item.revision,
          timestamp: item.dateModified,
          item,
        });
      } else {
        records.push({
          entityId,
          entityType,
          operation: "delete",
          revision: this.tombstones.get(key) ?? 1,
          timestamp: Date.now(),
          item: { id: entityId, type: entityType, deleted: true },
        });
      }
    }
    return Promise.resolve(records);
  }

  markChangesSynced(records: SyncRecord[]): Promise<void> {
    for (const record of records) {
      const key = itemKey(record.entityType, record.entityId);
      const item = this.items.get(key);
      // Only clear the dirty flag when the item has not been modified since
      // the record was collected, mirroring core's push-timestamp guard.
      if (!item || item.revision === record.revision) this.dirty.delete(key);
    }
    return Promise.resolve();
  }

  applyRemoteRecord(record: SyncRecord): Promise<ApplyResult> {
    const key = itemKey(record.entityType, record.entityId);
    const local = this.items.get(key);
    const tombstoneRevision = this.tombstones.get(key);

    const state: LocalItemState | undefined =
      local || tombstoneRevision !== undefined
        ? {
          revision: local?.revision ?? tombstoneRevision ?? 0,
          dateModified: local?.dateModified ?? 0,
          dirty: this.dirty.has(key),
          deleted: !local && tombstoneRevision !== undefined,
          contentHash: local ? contentHashOf(local) : undefined,
        }
        : undefined;

    const decision = resolveConflict(record, state);
    switch (decision.action) {
      case "apply-remote": {
        this.items.set(key, record.item as TestItem);
        this.tombstones.delete(key);
        this.dirty.delete(key);
        return Promise.resolve("applied");
      }
      case "apply-tombstone": {
        this.items.delete(key);
        this.tombstones.set(key, record.revision);
        this.dirty.delete(key);
        return Promise.resolve("applied");
      }
      case "keep-local":
        return Promise.resolve("skipped-stale");
      case "ignore-stale-resurrect":
        return Promise.resolve("skipped-tombstone");
      case "create-conflict-copy": {
        // Both versions survive: the remote version becomes the item, the
        // local version is preserved as a conflict copy the user can see.
        const remote = record.item as TestItem;
        if (local) {
          const copy: TestItem = {
            ...local,
            id: `${local.id}-conflict-${this.deviceId}`,
            title: conflictTitle(
              local.title ?? local.id,
              this.deviceName,
              Date.now(),
            ),
            conflictOf: local.id,
            revision: 1,
          };
          this.items.set(itemKey(copy.type, copy.id), copy);
          this.conflicts.push(copy);
          this.dirty.add(itemKey(copy.type, copy.id));
        }
        if (record.operation === "delete") {
          // Deleted remotely while edited locally: keep the local edit and
          // let the user decide; do not honour the delete.
          return Promise.resolve("conflicted");
        }
        this.items.set(key, remote);
        this.dirty.delete(key);
        return Promise.resolve("conflicted");
      }
    }
  }

  getCursors(): Promise<CursorMap> {
    return Promise.resolve({ ...this.cursors });
  }

  setCursor(deviceId: string, sequence: number): Promise<void> {
    this.cursors[deviceId] = sequence;
    return Promise.resolve();
  }

  getLocalSequence(): Promise<number> {
    return Promise.resolve(this.localSequence);
  }

  setLocalSequence(sequence: number): Promise<void> {
    this.localSequence = sequence;
    return Promise.resolve();
  }

  getMeta(key: string): Promise<string | undefined> {
    return Promise.resolve(this.meta.get(key));
  }

  setMeta(key: string, value: string | undefined): Promise<void> {
    if (value === undefined) this.meta.delete(key);
    else this.meta.set(key, value);
    return Promise.resolve();
  }
}

/** In-memory attachment storage implementing AttachmentSource. */
export class MemoryAttachments implements AttachmentSource {
  readonly blobs = new Map<string, Uint8Array>();
  /**
   * Per-attachment chunk lists, as stored locally or as received from the
   * engine. Chunk boundaries are semantic (one secretstream frame per
   * chunk), so tests assert on these — not only on the joined bytes.
   */
  readonly chunks = new Map<string, Uint8Array[]>();

  add(hash: string, data: Uint8Array): void {
    this.blobs.set(hash, data);
  }

  /** Store explicit chunks, the way the real chunk store holds frames. */
  addChunks(hash: string, chunks: Uint8Array[]): void {
    this.chunks.set(hash, chunks.map((chunk) => chunk.slice()));
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.blobs.set(hash, out);
  }

  exists(hash: string): Promise<boolean> {
    return Promise.resolve(this.blobs.has(hash));
  }

  read(hash: string): Promise<ReadableStream<Uint8Array> | undefined> {
    const data = this.blobs.get(hash);
    if (!data) return Promise.resolve(undefined);
    const stored = this.chunks.get(hash);
    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (stored) {
            // One emitted chunk per stored chunk, like the real store.
            for (const chunk of stored) controller.enqueue(chunk);
          } else {
            // Emit in several chunks so streaming paths are exercised.
            const size = Math.max(1, Math.ceil(data.length / 3));
            for (let offset = 0; offset < data.length; offset += size) {
              controller.enqueue(data.subarray(offset, offset + size));
            }
          }
          controller.close();
        },
      }),
    );
  }

  async write(hash: string, stream: ReadableStream<Uint8Array>): Promise<void> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    this.chunks.set(hash, chunks);
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    this.blobs.set(hash, out);
  }
}

export function itemKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(":");
  return [key.slice(0, index), key.slice(index + 1)];
}
