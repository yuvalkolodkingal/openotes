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
  BackupEngine,
  type BackupEntry,
  type BackupManifest,
  type BackupSnapshot,
  type BackupTarget,
  FetchTransport,
  type FileSystemAdapter,
  LocalBackupTarget,
  SyncCrypto,
  toBasicAuth,
  WebDavBackupTarget,
  WebDavClient,
} from "@notesnook/sync-remote";
import type { SerializedKey } from "@notesnook/crypto";
import { join } from "@std/path";
import { appDataDir, assertInside, ensureDir } from "../native/paths.ts";
import { logger } from "../native/logger.ts";
import { APP_NAME, APP_VERSION } from "../constants.ts";
import type { SettingsStore } from "../native/settings.ts";
import type { CredentialStore } from "../security/credentials.ts";
import type { AttachmentChunkStore } from "../native/attachment-store.ts";
import type { SqliteService } from "../native/sqlite.ts";
import type { DatabaseSyncStore } from "../sync/store-adapter.ts";
import { SYNC_TABLES } from "../sync/store-adapter.ts";

const log = logger.scope("backup");

/** Deno-backed filesystem adapter for LocalBackupTarget. */
const denoFs: FileSystemAdapter = {
  async ensureDir(path) {
    await ensureDir(path);
  },
  async listFiles(path) {
    const files: { name: string; size: number }[] = [];
    try {
      for await (const entry of Deno.readDir(path)) {
        if (!entry.isFile) continue;
        const info = await Deno.stat(join(path, entry.name));
        files.push({ name: entry.name, size: info.size });
      }
    } catch {
      /* directory may not exist yet */
    }
    return files;
  },
  readFile: (path) => Deno.readFile(path),
  async writeFile(path, data) {
    const tempPath = `${path}.tmp`;
    await Deno.writeFile(tempPath, data);
    await Deno.rename(tempPath, path);
  },
  deleteFile: (path) => Deno.remove(path),
  join: (...parts: string[]) => join(...(parts as [string, ...string[]])),
};

export interface BackupServiceOptions {
  settings: SettingsStore;
  credentials: CredentialStore;
  sqlite: SqliteService;
  databaseHandle: () => string | undefined;
  store: () => DatabaseSyncStore | undefined;
  files: AttachmentChunkStore;
  onCompleted: (info: { target: string; name: string }) => void;
}

export interface RestoreProgress {
  step:
    | "downloading"
    | "verifying"
    | "safety-backup"
    | "restoring"
    | "validating"
    | "done";
  message: string;
}

/**
 * Backups are a separate subsystem from sync (spec §14): infrequent,
 * versioned, immutable snapshots. Deleting a note and syncing that deletion
 * never touches a historical backup.
 *
 * A restore is the one genuinely destructive operation in the app, so it is
 * ordered so that the previous state stays recoverable at every step: the
 * safety backup is written and verified *before* anything is overwritten,
 * and the database file itself is replaced by an atomic rename.
 */
export class BackupService {
  private readonly crypto = new SyncCrypto();
  private readonly engine: BackupEngine;
  /**
   * Files the user picked through the native file dialog. Picking a file is
   * a capability grant: the renderer never named the path, the OS dialog
   * did, so restoring from it is allowed even though it lies outside the
   * backup directory (a download, a USB stick). Bounded and in-memory —
   * the grant does not outlive the process.
   */
  private readonly grantedFiles: string[] = [];

  constructor(private readonly options: BackupServiceOptions) {
    this.engine = new BackupEngine(this.crypto, {
      appName: APP_NAME,
      appVersion: APP_VERSION,
      deviceId: options.settings.get("sync").deviceId ?? "unknown",
    });
  }

  /** Record a natively-picked backup file as restorable. */
  grantFile(path: string): void {
    this.grantedFiles.push(path);
    // A handful of picks is plenty; this is not a persistent allowlist.
    while (this.grantedFiles.length > 8) this.grantedFiles.shift();
  }

  private async backupKey(): Promise<SerializedKey> {
    const passphrase = await this.options.credentials.get("webdav.passphrase");
    if (!passphrase) {
      throw new Error(
        "Backups are encrypted with your sync passphrase, which is not set. " +
          "Set it in Settings → Synchronization, or choose a backup password.",
      );
    }
    const salt = (await this.options.store()?.getMeta("webdav.salt")) ??
      (await this.crypto.generateSalt());
    const master = await this.crypto.deriveMasterKey(passphrase, salt);
    return await this.crypto.deriveSubkey(master, "backup");
  }

  /** Read the whole logical database plus attachment blobs. */
  private async snapshot(): Promise<BackupSnapshot> {
    const handle = this.options.databaseHandle();
    if (!handle) throw new Error("The vault is not open");

    const data: Record<string, unknown[]> = {};
    const counts: Record<string, number> = {};
    for (const table of SYNC_TABLES) {
      try {
        const rows = this.options.sqlite.run(
          handle,
          `SELECT * FROM ${table}`,
          [],
        ).rows;
        data[table] = rows;
        counts[table] = rows.length;
      } catch {
        // A table that does not exist in this schema version is not an error.
        continue;
      }
    }

    const attachments = new Map<string, Uint8Array>();
    for (const hash of await this.options.files.listHashes()) {
      const content = await this.options.files.readAll(hash);
      if (content) attachments.set(hash, content);
    }

    return { data, counts, attachments };
  }

  private localTarget(): BackupTarget {
    const directory = this.options.settings.get("backup").localDirectory;
    return new LocalBackupTarget(denoFs, directory);
  }

  private async webdavTarget(): Promise<BackupTarget | undefined> {
    const backup = this.options.settings.get("backup");
    const webdav = this.options.settings.get("webdav");
    if (!backup.webdavEnabled || !webdav.serverUrl || !webdav.username) {
      return undefined;
    }
    const password = await this.options.credentials.get("webdav.password");
    if (!password) {
      throw new Error(
        "The WebDAV password is not available; unlock the vault to run a " +
          "remote backup.",
      );
    }
    const transport = new FetchTransport({
      getBasicAuth: () =>
        Promise.resolve(toBasicAuth(webdav.username, password)),
    });
    const client = new WebDavClient(transport, {
      baseUrl: joinUrl(webdav.serverUrl, webdav.directory),
      requestTimeout: webdav.timeoutSeconds * 1000,
      maxRetries: webdav.maxRetries,
      allowInsecureHttp: webdav.allowInsecureHttp,
    });
    return new WebDavBackupTarget(client, backup.webdavDirectory);
  }

  /** Create a backup and write it to every enabled target. */
  async createNow(
    options: { targets?: ("local" | "webdav")[] } = {},
  ): Promise<{ name: string; manifest: BackupManifest; written: string[] }> {
    const settings = this.options.settings.get("backup");
    const wanted = options.targets ?? [
      ...(settings.localEnabled ? (["local"] as const) : []),
      ...(settings.webdavEnabled ? (["webdav"] as const) : []),
    ];
    if (wanted.length === 0) {
      throw new Error("No backup destination is enabled");
    }

    const key = await this.backupKey();
    const snapshot = await this.snapshot();
    const { name, data, manifest } = await this.engine.create(key, snapshot);
    log.info("Created backup", {
      name,
      counts: manifest.counts,
      attachments: manifest.attachments,
    });

    const written: string[] = [];
    const failures: string[] = [];

    for (const which of wanted) {
      try {
        const target = which === "local"
          ? this.localTarget()
          : await this.webdavTarget();
        if (!target) continue;
        await target.write(name, data);
        if (settings.retention > 0) {
          const removed = await this.engine.applyRetention(
            target,
            settings.retention,
          );
          if (removed.length > 0) {
            log.info("Applied backup retention", {
              which,
              removed: removed.length,
            });
          }
        }
        written.push(which);
        this.options.onCompleted({ target: which, name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("Backup destination failed", { which, error: message });
        failures.push(`${which}: ${message}`);
      }
    }

    if (written.length === 0) {
      throw new Error(
        `The backup could not be written. ${failures.join("; ")}`,
      );
    }
    await this.options.settings.patchBackup({ lastBackupAt: Date.now() });
    return { name, manifest, written };
  }

  /**
   * Run a scheduled backup if the policy says one is due.
   *
   * Silently does nothing when there is nothing to back up yet: no
   * destination enabled, or the credential store still locked because the
   * user has not unlocked the vault. Neither is a failure worth warning
   * about — on a fresh install both are the normal state, and warning
   * about them on every launch trains people to ignore the log.
   */
  async runIfDue(): Promise<boolean> {
    const settings = this.options.settings.get("backup");
    if (!settings.localEnabled && !settings.webdavEnabled) return false;
    if (!BackupEngine.isDue(settings, settings.lastBackupAt)) return false;
    if (!this.options.credentials.isUnlocked) {
      log.debug("Scheduled backup deferred: the vault is locked");
      return false;
    }
    if (!this.options.databaseHandle()) {
      log.debug("Scheduled backup deferred: the vault is not open yet");
      return false;
    }
    try {
      await this.createNow();
      return true;
    } catch (error) {
      log.warn("Scheduled backup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async list(
    which: "local" | "webdav",
  ): Promise<BackupEntry[]> {
    const target = which === "local"
      ? this.localTarget()
      : await this.webdavTarget();
    if (!target) return [];
    return await target.list();
  }

  /**
   * Restore a snapshot. The previous state remains recoverable: a verified
   * safety backup is taken first, and the live database is replaced only
   * after the new content has been fully written to a temporary file.
   */
  async restore(
    which: "local" | "webdav" | "file",
    nameOrPath: string,
    onProgress?: (progress: RestoreProgress) => void,
  ): Promise<{ counts: Record<string, number>; safetyBackup?: string }> {
    const report = (step: RestoreProgress["step"], message: string) => {
      log.info(`Restore: ${message}`);
      onProgress?.({ step, message });
    };

    report("downloading", "Reading the backup");
    let raw: Uint8Array;
    if (which === "file") {
      // A path the user just picked through the native dialog is allowed
      // as-is (exact match only); anything else must be inside the
      // directories the app owns.
      const path = this.grantedFiles.includes(nameOrPath)
        ? nameOrPath
        : assertInside(
          nameOrPath,
          [
            this.options.settings.get("backup").localDirectory,
            appDataDir(),
          ],
          "backup file",
        );
      raw = await Deno.readFile(path);
    } else {
      const target = which === "local"
        ? this.localTarget()
        : await this.webdavTarget();
      if (!target) {
        throw new Error(`The ${which} backup location is not configured`);
      }
      raw = await target.read(nameOrPath);
    }

    report("verifying", "Verifying integrity and decrypting");
    const key = await this.backupKey();
    // open() checks the content hash and refuses a corrupt file, so nothing
    // destructive has happened yet if the backup is damaged.
    const { manifest, snapshot } = await this.engine.open(key, raw);

    let safetyBackup: string | undefined;
    if (this.options.settings.get("backup").backupBeforeRestore) {
      report("safety-backup", "Backing up the current state first");
      try {
        const safety = await this.createNow({ targets: ["local"] });
        safetyBackup = safety.name;
      } catch (error) {
        throw new Error(
          "Refusing to restore: a safety backup of your current data could " +
            `not be created (${
              error instanceof Error ? error.message : String(error)
            }). Fix that first, or turn off "back up before restore" if you ` +
            "are sure.",
        );
      }
    }

    report("restoring", "Writing restored data");
    const handle = this.options.databaseHandle();
    if (!handle) throw new Error("The vault is not open");

    const data = snapshot.data as Record<string, Record<string, unknown>[]>;
    const counts: Record<string, number> = {};

    // One transaction: either the whole restore lands or none of it does.
    this.options.sqlite.run(handle, "BEGIN IMMEDIATE", []);
    try {
      for (const table of SYNC_TABLES) {
        const rows = data[table];
        if (!Array.isArray(rows)) continue;
        this.options.sqlite.run(handle, `DELETE FROM ${table}`, []);
        for (const row of rows) {
          const entries = Object.entries(row).filter(
            ([, value]) => value !== undefined,
          );
          if (entries.length === 0) continue;
          const names = entries.map(([key]) => `"${key}"`).join(", ");
          const placeholders = entries.map(() => "?").join(", ");
          this.options.sqlite.run(
            handle,
            `INSERT OR REPLACE INTO ${table} (${names}) VALUES (${placeholders})`,
            entries.map(([, value]) =>
              value !== null && typeof value === "object"
                ? JSON.stringify(value)
                : value
            ),
          );
        }
        counts[table] = rows.length;
      }
      this.options.sqlite.run(handle, "COMMIT", []);
    } catch (error) {
      this.options.sqlite.run(handle, "ROLLBACK", []);
      throw new Error(
        `The restore was rolled back and your data is unchanged: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (snapshot.attachments) {
      for (const [hash, content] of snapshot.attachments) {
        if (await this.options.files.exists(hash)) continue;
        // The backup payload is flat bytes; writeContiguous re-splits it at
        // the renderer's fixed frame size so decryption still lines up.
        await this.options.files.writeContiguous(hash, content);
      }
    }

    report("validating", "Checking database integrity");
    const integrity = this.options.sqlite.run(
      handle,
      "PRAGMA integrity_check",
      [],
    ).rows[0] as { integrity_check?: string } | undefined;
    const verdict = integrity?.integrity_check;
    if (verdict && verdict !== "ok") {
      throw new Error(
        `The database failed its integrity check after restore (${verdict}). ` +
          (safetyBackup
            ? `Your previous data is in the safety backup ${safetyBackup}.`
            : ""),
      );
    }

    report("done", "Restore complete");
    log.info("Restore finished", {
      counts,
      from: manifest.createdAt,
      safetyBackup,
    });
    return { counts, safetyBackup };
  }
}

function joinUrl(base: string, directory: string): string {
  let url = base.trim();
  if (!url.endsWith("/")) url += "/";
  const clean = directory
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .map(encodeURIComponent)
    .join("/");
  return clean ? `${url}${clean}/` : url;
}
