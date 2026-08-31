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

/**
 * Shared types for the WebDAV synchronization protocol.
 *
 * The protocol is documented in WEBDAV.md at the repository root. In short:
 * every device appends encrypted, immutable change batches to its own
 * journal (`devices/<deviceId>/changes/<seq>.bin`); every device tracks a
 * cursor per remote device and applies unseen batches locally. No central
 * mutable database file and no cross-device file locking is required.
 */

export const PROTOCOL_NAME = "notesnook-webdav-sync";
export const PROTOCOL_VERSION = 1;

/** A single logical change to one entity. Lives *inside* an encrypted batch. */
export interface SyncRecord {
  /** Entity id (note id, notebook id, ...). */
  entityId: string;
  /** Collection/type name, e.g. "note", "notebook", "tag", "relation". */
  entityType: string;
  operation: "upsert" | "delete";
  /** Monotonic per-entity revision as known by the writing device. */
  revision: number;
  /** Milliseconds since epoch at the time the change was recorded. */
  timestamp: number;
  /**
   * The full serialized item for "upsert" operations. For "delete"
   * operations this carries the tombstone (id + deleted markers) so stale
   * devices cannot resurrect intentionally deleted items.
   */
  item?: unknown;
  /**
   * When the payload is too large to inline it is stored as a
   * content-addressed object under `objects/` and referenced here.
   */
  objectRef?: string;
}

/** The decoded (but still encrypted) representation of a journal batch file. */
export interface ChangeBatchEnvelope {
  protocolVersion: number;
  deviceId: string;
  sequence: number;
  /** Encrypted JSON of SyncRecord[] (cipher fields from @notesnook/crypto). */
  cipher: SerializedCipher;
}

/** Matches the `Cipher<"base64">` shape of @notesnook/crypto. */
export interface SerializedCipher {
  format: "base64" | "uint8array";
  alg: string;
  cipher: string | Uint8Array;
  iv: string;
  salt: string;
  length: number;
}

/** Plaintext contents of `protocol.json` at the remote root. */
export interface ProtocolMetadata {
  protocol: typeof PROTOCOL_NAME;
  version: number;
  /** Salt (base64) used to derive the sync key from the sync password. */
  salt: string;
  /**
   * A small canary payload encrypted with the sync key. Lets clients detect
   * a wrong password / wrong key before writing anything.
   */
  keyCheck: SerializedCipher;
  createdAt: number;
  createdBy: string;
  /** Generation id — bumped by "Rebuild WebDAV repository". */
  generation: string;
}

/** Plaintext-visible device registration (contents encrypted). */
export interface DeviceInfo {
  id: string;
  /** Encrypted JSON: { name, platform, appVersion, registeredAt }. */
  info: SerializedCipher;
}

/** What one device knows it has applied from every other device. */
export type CursorMap = {
  [deviceId: string]: number; // highest applied sequence
};

export interface SyncConfig {
  /** WebDAV server base URL, e.g. https://cloud.example.com/remote.php/dav/files/user/ */
  serverUrl: string;
  username: string;
  /** Remote directory (relative to serverUrl) that holds the sync repository. */
  directory: string;
  /** Milliseconds before an HTTP request is aborted. */
  requestTimeout: number;
  /** Max automatic retries for retryable failures (5xx, network). */
  maxRetries: number;
  /** Whether attachments are synchronized. */
  syncAttachments: boolean;
  /** Allow plain http:// (LAN / self-hosted only; off by default). */
  allowInsecureHttp: boolean;
}

export const DEFAULT_SYNC_CONFIG: Omit<
  SyncConfig,
  "serverUrl" | "username" | "directory"
> = {
  requestTimeout: 30_000,
  maxRetries: 3,
  syncAttachments: true,
  allowInsecureHttp: false
};

export type SyncStatus =
  | { type: "synced"; at: number }
  | { type: "syncing"; progress?: { done: number; total: number } }
  | { type: "offline" }
  | { type: "pending"; count: number }
  | { type: "error"; error: string }
  | { type: "conflict"; count: number }
  | { type: "disabled" };

/** Result of applying a single remote record to the local database. */
export type ApplyResult =
  | "applied"
  | "merged"
  | "conflicted"
  | "skipped-stale"
  | "skipped-tombstone";

/**
 * The seam between the sync engine and the local database. Implemented over
 * @notesnook/core in the app and over an in-memory store in tests.
 */
export interface SyncDataStore {
  /** Stable unique id of this device/profile. Created once, never roams. */
  getDeviceId(): Promise<string>;

  /** Collect local changes not yet written to our remote journal. */
  collectPendingChanges(): Promise<SyncRecord[]>;

  /**
   * Mark the given records as journaled remotely (they are only marked
   * *after* the remote write has been verified).
   */
  markChangesSynced(records: SyncRecord[], sequence: number): Promise<void>;

  /**
   * Apply one remote record. The implementation owns merge and conflict
   * semantics (see conflicts.ts helpers): it must never silently discard a
   * conflicting local edit and must respect tombstones.
   */
  applyRemoteRecord(record: SyncRecord): Promise<ApplyResult>;

  /** Per-remote-device cursors (highest applied sequence). */
  getCursors(): Promise<CursorMap>;
  setCursor(deviceId: string, sequence: number): Promise<void>;

  /** Highest sequence number this device has written to its own journal. */
  getLocalSequence(): Promise<number>;
  setLocalSequence(sequence: number): Promise<void>;

  /** Arbitrary durable metadata (generation id, key check cache, ...). */
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string | undefined): Promise<void>;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unauthorized"
      | "forbidden"
      | "not-found"
      | "conflict"
      | "precondition-failed"
      | "server-error"
      | "timeout"
      | "network"
      | "protocol-mismatch"
      | "bad-key"
      | "corrupt-data"
      | "insecure-url"
      | "cancelled",
    readonly status?: number
  ) {
    super(message);
    this.name = "SyncError";
  }

  get isRetryable() {
    return (
      this.code === "server-error" ||
      this.code === "timeout" ||
      this.code === "network"
    );
  }
}
