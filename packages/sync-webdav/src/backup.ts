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

import { SerializedKey } from "@notesnook/crypto";
import { RemoteStorage } from "@notesnook/sync-core";
import { SyncCrypto, toHex } from "./crypto.ts";
import { PATHS } from "./repository.ts";
import { SerializedCipher, SyncError } from "./types.ts";

/**
 * Backups are a *separate subsystem* from sync (spec §14): infrequent,
 * versioned, immutable snapshots for disaster recovery. Deleting a note and
 * syncing that deletion never touches historical backups.
 */

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT_VERSION;
  app: string;
  appVersion: string;
  createdAt: number;
  deviceId: string;
  /** SHA-256 of the plaintext payload, hex. */
  contentHash: string;
  /** Plaintext byte length. */
  contentLength: number;
  /** Counts per entity type, for the restore preview. */
  counts: Record<string, number>;
  /** Number of attachment blobs included. */
  attachments: number;
  encrypted: true;
}

export interface BackupFile {
  manifest: BackupManifest;
  payload: SerializedCipher;
}

export interface BackupSnapshot {
  /** Serializable logical database state. */
  data: unknown;
  counts: Record<string, number>;
  /** Attachment hash -> plaintext content. */
  attachments?: Map<string, Uint8Array>;
}

export interface BackupTarget {
  list(): Promise<BackupEntry[]>;
  read(name: string): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface BackupEntry {
  name: string;
  createdAt: number;
  size?: number;
}

export type BackupInterval = "manual" | "daily" | "weekly" | "monthly";

export interface BackupPolicy {
  interval: BackupInterval;
  /** Keep at most this many snapshots per target (0 = keep everything). */
  retention: number;
}

/** `2026-08-31T120000Z.backup.enc` */
export function backupFileName(timestamp: number): string {
  // 2026-08-31T12:00:00.000Z -> 2026-08-31T120000Z.backup.enc
  const stamp = new Date(timestamp).toISOString().slice(0, 19).replace(
    /:/g,
    "",
  );
  return `${stamp}Z.backup.enc`;
}

export function parseBackupFileName(name: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.backup\.enc$/
    .exec(name);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const time = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isFinite(time) ? time : undefined;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return toHex(new Uint8Array(digest));
}

export class BackupEngine {
  constructor(
    private readonly crypto: SyncCrypto,
    private readonly options: {
      appName: string;
      appVersion: string;
      deviceId: string;
    },
  ) {}

  /** Build an encrypted backup blob from a logical snapshot. */
  async create(
    backupKey: SerializedKey,
    snapshot: BackupSnapshot,
  ): Promise<{ name: string; data: Uint8Array; manifest: BackupManifest }> {
    const payload = {
      data: snapshot.data,
      attachments: snapshot.attachments
        ? Object.fromEntries(
          [...snapshot.attachments].map(([hash, bytes]) => [
            hash,
            base64Encode(bytes),
          ]),
        )
        : undefined,
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const createdAt = Date.now();
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT_VERSION,
      app: this.options.appName,
      appVersion: this.options.appVersion,
      createdAt,
      deviceId: this.options.deviceId,
      contentHash: await sha256Hex(plaintext),
      contentLength: plaintext.length,
      counts: snapshot.counts,
      attachments: snapshot.attachments?.size ?? 0,
      encrypted: true,
    };
    const file: BackupFile = {
      manifest,
      payload: await this.crypto.encryptBytes(backupKey, plaintext),
    };
    return {
      name: backupFileName(createdAt),
      data: new TextEncoder().encode(JSON.stringify(file)),
      manifest,
    };
  }

  /**
   * Decrypt and verify a backup blob. Integrity is checked *before* any
   * caller is allowed to restore from it.
   */
  async open(
    backupKey: SerializedKey,
    data: Uint8Array,
  ): Promise<{ manifest: BackupManifest; snapshot: BackupSnapshot }> {
    let file: BackupFile;
    try {
      file = JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new SyncError("Backup file is not valid JSON", "corrupt-data");
    }
    if (!file.manifest || !file.payload) {
      throw new SyncError(
        "Backup file is missing its manifest or payload",
        "corrupt-data",
      );
    }
    if (file.manifest.format > BACKUP_FORMAT_VERSION) {
      throw new SyncError(
        `Backup uses format version ${file.manifest.format}, which this ` +
          `version of the app cannot read.`,
        "protocol-mismatch",
      );
    }
    const plaintext = await this.crypto.decryptBytes(backupKey, file.payload);
    const hash = await sha256Hex(plaintext);
    if (hash !== file.manifest.contentHash) {
      throw new SyncError(
        "Backup integrity check failed: content hash mismatch. The file is " +
          "corrupt and was not restored.",
        "corrupt-data",
      );
    }
    if (plaintext.length !== file.manifest.contentLength) {
      throw new SyncError(
        "Backup integrity check failed: unexpected payload length",
        "corrupt-data",
      );
    }

    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    const attachments = parsed.attachments
      ? new Map<string, Uint8Array>(
        Object.entries(parsed.attachments as Record<string, string>).map(
          ([hash, b64]) => [hash, base64Decode(b64)],
        ),
      )
      : undefined;

    return {
      manifest: file.manifest,
      snapshot: {
        data: parsed.data,
        counts: file.manifest.counts,
        attachments,
      },
    };
  }

  /** Apply the retention policy, oldest first. Returns deleted names. */
  async applyRetention(
    target: BackupTarget,
    retention: number,
  ): Promise<string[]> {
    if (retention <= 0) return [];
    const entries = (await target.list()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    const excess = entries.length - retention;
    if (excess <= 0) return [];
    const removed: string[] = [];
    for (const entry of entries.slice(0, excess)) {
      await target.delete(entry.name);
      removed.push(entry.name);
    }
    return removed;
  }

  /** Whether a scheduled backup is due given the last backup time. */
  static isDue(
    policy: BackupPolicy,
    lastBackupAt: number | undefined,
    now = Date.now(),
  ): boolean {
    if (policy.interval === "manual") return false;
    if (!lastBackupAt) return true;
    const day = 24 * 60 * 60 * 1000;
    const period = policy.interval === "daily"
      ? day
      : policy.interval === "weekly"
      ? 7 * day
      : 30 * day;
    return now - lastBackupAt >= period;
  }
}

/**
 * A backup file name must be a single, literal file name. The character
 * class alone is not enough: "." and ".." are made entirely of allowed
 * characters and would resolve to a directory, so they are rejected
 * explicitly rather than left to the filesystem to refuse.
 */
export function assertSafeBackupName(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    throw new SyncError(
      `Unsafe backup file name: ${JSON.stringify(name)}`,
      "corrupt-data",
    );
  }
  return name;
}

/** Backups stored in the WebDAV `backups/` directory. */
/**
 * Backups in a remote object store.
 *
 * Renamed from WebDavBackupTarget: it works against any RemoteStorage now, so
 * a name claiming WebDAV would be a lie the moment a Drive or Dropbox backend
 * is passed in.
 */
export class RemoteBackupTarget implements BackupTarget {
  constructor(
    private readonly storage: RemoteStorage,
    private readonly directory: string = PATHS.backups,
  ) {}

  private path(name: string) {
    return `${this.directory}/${assertSafeBackupName(name)}`;
  }

  async list(): Promise<BackupEntry[]> {
    const entries = await this.storage.list(this.directory + "/");
    const backups: BackupEntry[] = [];
    for (const entry of entries) {
      if (entry.isCollection) continue;
      const name = entry.path.split("/").pop();
      if (!name) continue;
      const createdAt = parseBackupFileName(name);
      if (createdAt === undefined) continue;
      backups.push({ name, createdAt, size: entry.size });
    }
    return backups.sort((a, b) => b.createdAt - a.createdAt);
  }

  async read(name: string): Promise<Uint8Array> {
    return await this.storage.get(this.path(name));
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    await this.storage.mkdirp(this.directory + "/");
    await this.storage.putUpdate(this.path(name), data);
    // A backup that is not verifiably on the server is not a backup.
    await this.storage.verifyUpload(this.path(name), data.length);
  }

  async delete(name: string): Promise<void> {
    await this.storage.delete(this.path(name));
  }
}

/** Filesystem-backed backups, driven by host-provided callbacks. */
export interface FileSystemAdapter {
  ensureDir(path: string): Promise<void>;
  listFiles(path: string): Promise<{ name: string; size: number }[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  join(...parts: string[]): string;
}

export class LocalBackupTarget implements BackupTarget {
  constructor(
    private readonly fs: FileSystemAdapter,
    private readonly directory: string,
  ) {}

  private path(name: string) {
    return this.fs.join(this.directory, assertSafeBackupName(name));
  }

  async list(): Promise<BackupEntry[]> {
    await this.fs.ensureDir(this.directory);
    const files = await this.fs.listFiles(this.directory);
    const backups: BackupEntry[] = [];
    for (const file of files) {
      const createdAt = parseBackupFileName(file.name);
      if (createdAt === undefined) continue;
      backups.push({ name: file.name, createdAt, size: file.size });
    }
    return backups.sort((a, b) => b.createdAt - a.createdAt);
  }

  async read(name: string): Promise<Uint8Array> {
    return await this.fs.readFile(this.path(name));
  }

  async write(name: string, data: Uint8Array): Promise<void> {
    await this.fs.ensureDir(this.directory);
    await this.fs.writeFile(this.path(name), data);
    const written = await this.fs.readFile(this.path(name));
    if (written.length !== data.length) {
      throw new SyncError(
        "Local backup verification failed: written size mismatch",
        "corrupt-data",
      );
    }
  }

  async delete(name: string): Promise<void> {
    await this.fs.deleteFile(this.path(name));
  }
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
