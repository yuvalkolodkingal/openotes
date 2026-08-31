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

import { SyncRecord } from "./types.ts";

/**
 * Persistent outgoing queue (spec §58). Local edits are queued the moment
 * they happen; a WebDAV outage only delays the upload. The queue survives
 * restarts because it is written through a storage callback the host
 * provides (the desktop app persists it to the app data directory).
 */

export interface QueueStorage {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

export class MemoryQueueStorage implements QueueStorage {
  private value?: string;
  read() {
    return Promise.resolve(this.value);
  }
  write(value: string) {
    this.value = value;
    return Promise.resolve();
  }
}

interface QueueState {
  version: 1;
  records: SyncRecord[];
  /** Attachment hashes waiting to be uploaded. */
  attachments: string[];
  /** Attachment hashes waiting to be downloaded. */
  downloads: string[];
  failures: number;
  lastError?: string;
}

/**
 * Returns a *fresh* state object. This must never be a shared constant that
 * gets spread — a spread copies the array references, so two queues (two
 * vault profiles in one process, or two devices in a test) would silently
 * share one records array.
 */
function emptyState(): QueueState {
  return {
    version: 1,
    records: [],
    attachments: [],
    downloads: [],
    failures: 0
  };
}

export class OutgoingQueue {
  private state: QueueState = emptyState();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly storage: QueueStorage) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.storage.read();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as QueueState;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.records)) {
          this.state = {
            version: 1,
            records: [...parsed.records],
            attachments: [...(parsed.attachments ?? [])],
            downloads: [...(parsed.downloads ?? [])],
            failures: parsed.failures ?? 0,
            lastError: parsed.lastError
          };
        }
      } catch {
        // A corrupt queue file must not block the app; start clean but keep
        // the failure count so the UI can surface that something was lost.
        this.state = {
          ...emptyState(),
          failures: 1,
          lastError: "queue file corrupt"
        };
      }
    }
    this.loaded = true;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    this.writeChain = this.writeChain
      .then(() => this.storage.write(snapshot))
      .catch(() => {
        /* persisting the queue must never throw into the editor */
      });
    return this.writeChain;
  }

  /** Queue records, collapsing repeated edits of the same entity. */
  async enqueue(records: SyncRecord[]): Promise<void> {
    await this.load();
    for (const record of records) {
      const index = this.state.records.findIndex(
        (existing) =>
          existing.entityId === record.entityId &&
          existing.entityType === record.entityType
      );
      if (index >= 0) {
        const existing = this.state.records[index];
        // A delete always supersedes a pending upsert; otherwise the newer
        // revision wins so repeated typing collapses to one record.
        if (
          record.operation === "delete" ||
          record.revision >= existing.revision
        ) {
          this.state.records[index] = record;
        }
      } else {
        this.state.records.push(record);
      }
    }
    await this.persist();
  }

  async enqueueAttachment(hash: string): Promise<void> {
    await this.load();
    if (!this.state.attachments.includes(hash)) {
      this.state.attachments.push(hash);
      await this.persist();
    }
  }

  async enqueueDownload(hash: string): Promise<void> {
    await this.load();
    if (!this.state.downloads.includes(hash)) {
      this.state.downloads.push(hash);
      await this.persist();
    }
  }

  async peek(): Promise<SyncRecord[]> {
    await this.load();
    return [...this.state.records];
  }

  async pendingAttachments(): Promise<string[]> {
    await this.load();
    return [...this.state.attachments];
  }

  async pendingDownloads(): Promise<string[]> {
    await this.load();
    return [...this.state.downloads];
  }

  async size(): Promise<number> {
    await this.load();
    return (
      this.state.records.length +
      this.state.attachments.length +
      this.state.downloads.length
    );
  }

  /**
   * Remove records that were confirmed uploaded. Records queued *after* the
   * batch was snapshotted stay in the queue, so a concurrent edit is never
   * dropped.
   */
  async acknowledge(records: SyncRecord[]): Promise<void> {
    await this.load();
    const acknowledged = new Set(
      records.map((r) => `${r.entityType}:${r.entityId}:${r.revision}`)
    );
    this.state.records = this.state.records.filter(
      (r) => !acknowledged.has(`${r.entityType}:${r.entityId}:${r.revision}`)
    );
    this.state.failures = 0;
    this.state.lastError = undefined;
    await this.persist();
  }

  async acknowledgeAttachment(hash: string): Promise<void> {
    await this.load();
    this.state.attachments = this.state.attachments.filter((h) => h !== hash);
    await this.persist();
  }

  async acknowledgeDownload(hash: string): Promise<void> {
    await this.load();
    this.state.downloads = this.state.downloads.filter((h) => h !== hash);
    await this.persist();
  }

  async recordFailure(error: string): Promise<void> {
    await this.load();
    this.state.failures += 1;
    this.state.lastError = error;
    await this.persist();
  }

  async stats(): Promise<{ failures: number; lastError?: string }> {
    await this.load();
    return { failures: this.state.failures, lastError: this.state.lastError };
  }

  /** Wait for all pending writes to hit storage (used on shutdown). */
  async flush(): Promise<void> {
    await this.writeChain;
  }
}

/**
 * Debouncer that guarantees a trailing run and never overlaps executions
 * (spec §24: "Never start two sync cycles simultaneously for the same vault").
 */
export class SyncScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private rerunRequested = false;
  private lastRun = 0;

  constructor(
    private readonly run: (trigger: SyncTrigger) => Promise<void>,
    private readonly options: {
      debounceMs: number;
      minIntervalMs: number;
      onError?: (error: unknown) => void;
    }
  ) {}

  /** Schedule a debounced sync after local changes. */
  schedule(trigger: SyncTrigger = "change"): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.trigger(trigger);
    }, this.options.debounceMs);
  }

  /** Run now (manual "Sync now", startup sync, shutdown sync). */
  async trigger(trigger: SyncTrigger): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    const since = Date.now() - this.lastRun;
    if (
      trigger === "change" &&
      this.lastRun > 0 &&
      since < this.options.minIntervalMs
    ) {
      this.schedule(trigger);
      return;
    }

    this.running = true;
    try {
      await this.run(trigger);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.running = false;
      this.lastRun = Date.now();
      if (this.rerunRequested) {
        this.rerunRequested = false;
        this.schedule("change");
      }
    }
  }

  get isRunning() {
    return this.running;
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export type SyncTrigger =
  | "manual"
  | "startup"
  | "periodic"
  | "change"
  | "shutdown"
  | "network-restored";
