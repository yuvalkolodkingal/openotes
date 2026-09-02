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
  type AttachmentSource,
  FetchTransport,
  OutgoingQueue,
  type QueueStorage,
  SyncCrypto,
  SyncEngine,
  SyncError,
  SyncScheduler,
  type SyncStatus,
  type SyncTrigger,
  toBasicAuth,
  WebDavClient,
  WebDavRemoteStorage,
} from "@notesnook/sync-webdav";
import type { SerializedKey } from "@notesnook/crypto";
import { join } from "@std/path";
import { appDataDir, ensureDir } from "../native/paths.ts";
import { logger } from "../native/logger.ts";
import {
  describeDrive,
  driveClient,
  type DriveProvider,
  driveStorage,
  driveTokenProvider,
  isDriveProvider,
  type StoredConnection,
} from "./drive-providers.ts";
import type { OAuthTokens } from "../security/oauth.ts";
import type { WebDavSettings } from "../native/settings.ts";
import type { RemoteStorage } from "@notesnook/sync-core";
import {
  isSqlProvider,
  prepareSqlDatabase,
  SQL_CREDENTIALS,
  sqlStorage,
} from "./sql-providers.ts";
import { APP_VERSION, USER_AGENT } from "../constants.ts";
import type { SettingsStore } from "../native/settings.ts";
import type { CredentialStore } from "../security/credentials.ts";
import type { AttachmentChunkStore } from "../native/attachment-store.ts";
import type { DatabaseSyncStore } from "./store-adapter.ts";

const log = logger.scope("sync");

const CREDENTIAL_KEY_PASSWORD = "webdav.password";
const CREDENTIAL_KEY_PASSPHRASE = "webdav.passphrase";

/** Where a drive's tokens and its client secret live, per provider. */
export function driveTokenKey(provider: DriveProvider): string {
  return `drive.${provider}.tokens`;
}

export function driveSecretKey(provider: DriveProvider): string {
  return `drive.${provider}.clientSecret`;
}

/** Persists the outgoing queue to the app data directory. */
class FileQueueStorage implements QueueStorage {
  constructor(private readonly path: string) {}

  async read(): Promise<string | undefined> {
    try {
      return await Deno.readTextFile(this.path);
    } catch {
      return undefined;
    }
  }

  async write(value: string): Promise<void> {
    await ensureDir(dirOf(this.path));
    const tempPath = `${this.path}.tmp`;
    await Deno.writeTextFile(tempPath, value);
    await Deno.rename(tempPath, this.path);
  }
}

/**
 * Bridges the sync engine's attachment needs to the on-disk chunk store.
 * `read` emits one chunk per stored chunk file and `write` stores one chunk
 * file per received chunk; the engine encrypts each chunk as one wire
 * frame, so the renderer's frame boundaries survive the round trip.
 */
class DiskAttachments implements AttachmentSource {
  constructor(private readonly storage: AttachmentChunkStore) {}

  exists(hash: string) {
    return this.storage.exists(hash);
  }

  read(hash: string) {
    return this.storage.readStream(hash);
  }

  write(hash: string, stream: ReadableStream<Uint8Array>) {
    return this.storage.writeStream(hash, stream);
  }
}

export interface SyncServiceOptions {
  settings: SettingsStore;
  credentials: CredentialStore;
  files: AttachmentChunkStore;
  store: DatabaseSyncStore;
  onStatus: (status: SyncStatus) => void;
  onConflict: (info: { entityId: string; entityType: string }) => void;
}

/**
 * Owns the lifecycle of WebDAV synchronization: configuration, scheduling,
 * and the single rule that a WebDAV problem must never surface as anything
 * worse than a status indicator (spec §12, §58).
 */
export class SyncService {
  private engine?: SyncEngine;
  private scheduler?: SyncScheduler;
  private queue?: OutgoingQueue;
  private periodicTimer?: ReturnType<typeof setInterval>;
  private status: SyncStatus = { type: "disabled" };
  private readonly crypto = new SyncCrypto();
  private masterKey?: SerializedKey;
  /** Releases a SQL socket when the engine is rebuilt; a no-op otherwise. */
  private closeStorage: () => Promise<void> = () => Promise.resolve();

  constructor(private readonly options: SyncServiceOptions) {}

  get currentStatus(): SyncStatus {
    return this.status;
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    this.options.onStatus(status);
  }

  /**
   * Build (or rebuild) the engine from current settings. Returns undefined
   * when sync is not configured — that is a normal state, not an error.
   */
  private async buildEngine(): Promise<SyncEngine | undefined> {
    const config = this.options.settings.get("webdav");
    const isWebDav = config.provider === "webdav";
    const isSql = isSqlProvider(config.provider);
    const unconfigured = isWebDav
      ? !config.serverUrl || !config.username
      : isSql
      ? !config.connected
      : !config.clientId || !config.connected;
    if (!config.enabled || unconfigured) {
      this.setStatus({ type: "disabled" });
      return undefined;
    }
    await this.closeStorage().catch(() => {});
    this.closeStorage = () => Promise.resolve();

    const password = isWebDav
      ? await this.options.credentials
        .get(CREDENTIAL_KEY_PASSWORD)
        .catch(() => undefined)
      : undefined;
    if (isWebDav && !password) {
      throw new SyncError(
        "The WebDAV password is not available. Unlock the vault, or " +
          "re-enter the password in Settings → Synchronization.",
        "unauthorized",
      );
    }

    const passphrase = await this.options.credentials.get(
      CREDENTIAL_KEY_PASSPHRASE,
    );
    if (!passphrase) {
      throw new SyncError(
        "The sync passphrase is not set. It is what encrypts your notes " +
          "before they reach the server.",
        "bad-key",
      );
    }

    const storage = isWebDav
      ? this.webDavStorage(config, password!)
      : isSql
      ? await this.sqlStorage(config)
      : await this.driveStorage(config);

    const salt = await this.resolveSalt(storage);
    this.masterKey = await this.crypto.deriveMasterKey(passphrase, salt);

    this.queue = new OutgoingQueue(
      new FileQueueStorage(join(appDataDir(), "sync-queue.json")),
    );

    const engine = new SyncEngine({
      storage,
      crypto: this.crypto,
      store: this.options.store,
      queue: this.queue,
      masterKey: this.masterKey,
      attachments: new DiskAttachments(this.options.files),
      syncAttachments: config.syncAttachments,
      deviceName: this.options.settings.get("sync").deviceName ?? hostName(),
      appVersion: APP_VERSION,
      platform: Deno.build.os,
      onStatus: (status) => this.setStatus(status),
      onConflict: (record) =>
        this.options.onConflict({
          entityId: record.entityId,
          entityType: record.entityType,
        }),
      logger: {
        debug: (message, context) => log.debug(message, context),
        info: (message, context) => log.info(message, context),
        warn: (message, context) => log.warn(message, context),
        error: (message, context) => log.error(message, context),
      },
    });

    this.engine = engine;
    return engine;
  }

  /**
   * The salt the master key is derived with.
   *
   * It lives in the remote protocol.json so that every device with the same
   * passphrase derives the same keys, and it is not a secret. The remote one
   * is therefore authoritative: a device joining a repository another device
   * created adopts its salt, rather than deriving a different key from a
   * salt of its own and failing the key check with "wrong passphrase" -- which
   * is exactly what a second device did before this. Only a repository that
   * does not exist yet gets a fresh salt, and initialization writes it.
   */
  private async resolveSalt(storage: RemoteStorage): Promise<string> {
    const store = this.options.store;
    const known = await store.getMeta("webdav.salt");
    const remote = await readRemoteSalt(storage);
    if (remote && remote !== known) {
      await store.setMeta("webdav.salt", remote);
      return remote;
    }
    if (known) return known;
    const fresh = await this.crypto.generateSalt();
    await store.setMeta("webdav.salt", fresh);
    return fresh;
  }

  /** The WebDAV path, unchanged: a client wrapped in a RemoteStorage. */
  private webDavStorage(
    config: WebDavSettings,
    password: string,
  ): RemoteStorage {
    const transport = new FetchTransport({
      getBasicAuth: () =>
        Promise.resolve(toBasicAuth(config.username, password)),
    }, (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("user-agent", USER_AGENT);
      return fetch(input, { ...init, headers });
    });
    return new WebDavRemoteStorage(
      new WebDavClient(transport, {
        baseUrl: joinUrl(config.serverUrl, config.directory),
        requestTimeout: config.timeoutSeconds * 1000,
        maxRetries: config.maxRetries,
        allowInsecureHttp: config.allowInsecureHttp,
      }),
    );
  }

  /**
   * A Postgres database -- the user's own, Neon's or Supabase's -- through
   * the secrets the connect step stored. The table is created here when the
   * transport allows it, so a database that was set up by hand needs no
   * further step.
   */
  private async sqlStorage(config: WebDavSettings): Promise<RemoteStorage> {
    const secrets = await this.sqlSecrets();
    const { storage, close } = sqlStorage(config, secrets);
    this.closeStorage = close;
    if (config.provider !== "supabase" && secrets.connectionString) {
      await prepareSqlDatabase(
        config.provider as "postgres" | "neon",
        secrets.connectionString,
        config.sqlTransport,
      );
    }
    return storage;
  }

  private async sqlSecrets() {
    const credentials = this.options.credentials;
    return {
      connectionString: await credentials
        .get(SQL_CREDENTIALS.connectionString)
        .catch(() => undefined),
      supabaseServiceKey: await credentials
        .get(SQL_CREDENTIALS.supabaseServiceKey)
        .catch(() => undefined),
    };
  }

  /**
   * Prove a SQL connection works and the passphrase opens whatever is there,
   * writing nothing. The connect step runs this before it saves anything,
   * and "Test connection" runs it on demand.
   */
  async testSqlConnection(candidate: {
    provider: "postgres" | "neon" | "supabase";
    connectionString?: string;
    supabaseUrl?: string;
    supabaseServiceKey?: string;
    directory: string;
    sqlTransport: "socket" | "http";
    passphrase?: string;
    timeoutSeconds?: number;
  }): Promise<{
    ok: boolean;
    message: string;
    initialized?: boolean;
    devices?: number;
    protocolVersion?: number;
  }> {
    let close: () => Promise<void> = () => Promise.resolve();
    try {
      const passphrase = candidate.passphrase ||
        (await this.options.credentials
          .get(CREDENTIAL_KEY_PASSPHRASE)
          .catch(() => undefined));
      if (!passphrase) {
        throw new SyncError(
          "Set a sync passphrase first. It is what encrypts your notes " +
            "before they reach the database.",
          "bad-key",
        );
      }
      if (candidate.provider !== "supabase" && candidate.connectionString) {
        await prepareSqlDatabase(
          candidate.provider,
          candidate.connectionString,
          candidate.sqlTransport,
        );
      }
      const built = sqlStorage({
        provider: candidate.provider,
        directory: candidate.directory,
        sqlTransport: candidate.sqlTransport,
        supabaseUrl: candidate.supabaseUrl ?? "",
        timeoutSeconds: candidate.timeoutSeconds ?? 30,
      }, {
        connectionString: candidate.connectionString,
        supabaseServiceKey: candidate.supabaseServiceKey,
      });
      close = built.close;

      const salt = (await readRemoteSalt(built.storage)) ??
        (await this.options.store.getMeta("webdav.salt")) ??
        (await this.crypto.generateSalt());
      const masterKey = await this.crypto.deriveMasterKey(passphrase, salt);
      const probe = new SyncEngine({
        storage: built.storage,
        crypto: this.crypto,
        store: this.options.store,
        queue: new OutgoingQueue(
          new FileQueueStorage(join(appDataDir(), "sync-queue.probe.json")),
        ),
        masterKey,
        syncAttachments: false,
      });
      const result = await probe.testConnection();
      return {
        ok: true,
        initialized: result.initialized,
        devices: result.devices,
        protocolVersion: result.protocolVersion,
        message: result.initialized
          ? `Connected. The database holds a repository at protocol version ` +
            `${result.protocolVersion} with ${result.devices} device(s) registered.`
          : "Connected. The table is ready and will be set up on the first sync.",
      };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    } finally {
      await close().catch(() => {});
    }
  }

  /** Forget a SQL provider's secrets and stop syncing. */
  async disconnectSql(): Promise<void> {
    this.stop();
    await this.closeStorage().catch(() => {});
    this.closeStorage = () => Promise.resolve();
    for (
      const key of [
        SQL_CREDENTIALS.connectionString,
        SQL_CREDENTIALS.supabaseServiceKey,
      ]
    ) {
      await this.options.credentials.set(key, undefined);
    }
    await this.options.settings.patchWebDav({
      enabled: false,
      connected: false,
      sqlHost: "",
      sqlDatabase: "",
      sqlUser: "",
      supabaseUrl: "",
      sqlProvenance: undefined,
    });
    this.engine = undefined;
    await this.resetRemoteState();
    this.setStatus({ type: "disabled" });
  }

  /**
   * A drive, through the OAuth connection the user made in settings. The
   * provider only ever sees what the WebDAV server would: the same encrypted
   * journal under keyed-digest filenames.
   */
  private async driveStorage(config: WebDavSettings): Promise<RemoteStorage> {
    if (!isDriveProvider(config.provider)) {
      throw new SyncError(
        `Unknown synchronization provider: ${config.provider}`,
        "corrupt-data",
      );
    }
    const description = describeDrive(config.provider);
    const clientSecret = description.requiresClientSecret
      ? await this.options.credentials
        .get(driveSecretKey(config.provider))
        .catch(() => undefined)
      : undefined;
    if (description.requiresClientSecret && !clientSecret) {
      throw new SyncError(
        `${description.label} needs the client secret from your own OAuth ` +
          `registration, and it is not available. Unlock the vault, or sign ` +
          `in again in Settings → Synchronization.`,
        "unauthorized",
      );
    }

    const client = driveClient(config.provider, {
      clientId: config.clientId,
      clientSecret,
    });
    const tokens = driveTokenProvider({
      client,
      connection: this.driveConnection(config.provider),
    });
    return driveStorage(config.provider, tokens, config.directory);
  }

  /** The saved tokens for one provider, in the encrypted credential store. */
  private driveConnection(provider: DriveProvider): StoredConnection {
    const key = driveTokenKey(provider);
    const credentials = this.options.credentials;
    return {
      async read() {
        const raw = await credentials.get(key).catch(() => undefined);
        if (!raw) return undefined;
        try {
          return JSON.parse(raw) as OAuthTokens;
        } catch {
          return undefined;
        }
      },
      write: (tokens) => credentials.set(key, JSON.stringify(tokens)),
      clear: () => credentials.set(key, undefined),
    };
  }

  /** Store the WebDAV password and sync passphrase, encrypted. */
  async setCredentials(options: {
    password?: string;
    passphrase?: string;
  }): Promise<void> {
    if (options.password !== undefined) {
      await this.options.credentials.set(
        CREDENTIAL_KEY_PASSWORD,
        options.password,
      );
      // The marker the settings form reads: it cannot ask the credential
      // store directly because that store may be locked.
      await this.options.settings.patchWebDav({ passwordSaved: true });
    }
    if (options.passphrase !== undefined) {
      await this.options.credentials.set(
        CREDENTIAL_KEY_PASSPHRASE,
        options.passphrase,
      );
    }
    // Force a rebuild so the next cycle picks up the new credentials.
    this.engine = undefined;
  }

  /**
   * Validate a configuration without saving it or writing to the server.
   * Used by the "Test connection" button.
   */
  async testConnection(candidate: {
    serverUrl: string;
    username: string;
    password: string;
    directory: string;
    passphrase: string;
    allowInsecureHttp?: boolean;
    timeoutSeconds?: number;
  }): Promise<{
    ok: boolean;
    message: string;
    initialized?: boolean;
    devices?: number;
    protocolVersion?: number;
  }> {
    try {
      const transport = new FetchTransport({
        getBasicAuth: () =>
          Promise.resolve(toBasicAuth(candidate.username, candidate.password)),
      });
      const client = new WebDavClient(transport, {
        baseUrl: joinUrl(candidate.serverUrl, candidate.directory),
        requestTimeout: (candidate.timeoutSeconds ?? 30) * 1000,
        maxRetries: 1,
        allowInsecureHttp: candidate.allowInsecureHttp ?? false,
      });

      const storage = new WebDavRemoteStorage(client);
      const salt = (await readRemoteSalt(storage)) ??
        (await this.options.store.getMeta("webdav.salt")) ??
        (await this.crypto.generateSalt());
      const masterKey = await this.crypto.deriveMasterKey(
        candidate.passphrase,
        salt,
      );

      const probe = new SyncEngine({
        storage,
        crypto: this.crypto,
        store: this.options.store,
        queue: new OutgoingQueue(
          new FileQueueStorage(join(appDataDir(), "sync-queue.probe.json")),
        ),
        masterKey,
        syncAttachments: false,
      });

      const result = await probe.testConnection();
      return {
        ok: true,
        initialized: result.initialized,
        devices: result.devices,
        protocolVersion: result.protocolVersion,
        message: result.initialized
          ? `Connected. The remote repository uses protocol version ` +
            `${result.protocolVersion} and has ${result.devices} device(s) registered.`
          : "Connected. The remote directory is empty and will be set up on the first sync.",
      };
    } catch (error) {
      return { ok: false, message: describeError(error) };
    }
  }

  /** Start scheduling: startup sync, periodic sync, debounced edits. */
  start(): void {
    const config = this.options.settings.get("webdav");
    if (!config.enabled) {
      this.setStatus({ type: "disabled" });
      return;
    }

    this.scheduler = new SyncScheduler(
      (trigger) => this.runCycle(trigger),
      {
        debounceMs: Math.max(1000, config.debounceSeconds * 1000),
        minIntervalMs: 5000,
        onError: (error) =>
          log.warn("Scheduled sync failed", { error: describeError(error) }),
      },
    );

    if (config.intervalMinutes > 0) {
      this.periodicTimer = setInterval(
        () => void this.scheduler?.trigger("periodic"),
        config.intervalMinutes * 60_000,
      );
    }

    if (config.syncOnStartup) {
      // Never block startup on the network.
      void this.scheduler.trigger("startup");
    }
  }

  /** Called when the vault changes locally. */
  notifyLocalChange(): void {
    const config = this.options.settings.get("webdav");
    if (!config.enabled || !config.syncAfterEdits) return;
    this.scheduler?.schedule("change");
  }

  syncNow(): Promise<void> {
    if (!this.scheduler) {
      return this.runCycle("manual");
    }
    return this.scheduler.trigger("manual");
  }

  /**
   * Fetch one attachment's content from the remote repository on demand.
   * Returns false when sync is not configured or the remote does not have
   * the content; the caller treats that as "not available yet", not an
   * error.
   */
  async fetchAttachment(hash: string): Promise<boolean> {
    const engine = this.engine ?? (await this.buildEngine());
    if (!engine) return false;
    return await engine.fetchAttachment(hash);
  }

  private async runCycle(trigger: SyncTrigger): Promise<void> {
    try {
      const engine = this.engine ?? (await this.buildEngine());
      if (!engine) return;
      await engine.sync(trigger);
    } catch (error) {
      // A sync failure is a status, never a crash (spec §58).
      const message = describeError(error);
      log.warn("Sync cycle failed", { trigger, error: message });
      if (
        error instanceof SyncError &&
        (error.code === "network" || error.code === "timeout")
      ) {
        this.setStatus({ type: "offline" });
      } else {
        this.setStatus({ type: "error", error: message });
      }
    }
  }

  /** Forget every remote cursor so the next sync re-reads all journals. */
  async resetRemoteState(): Promise<void> {
    await this.options.settings.patchSync({
      cursors: {},
      localSequence: 0,
      meta: {},
    });
    this.engine = undefined;
    log.info("Sync cursors reset");
  }

  /** Rebuild the remote repository from local state (spec §59). */
  async rebuildRemote(): Promise<string> {
    const engine = this.engine ?? (await this.buildEngine());
    if (!engine) {
      throw new SyncError("Synchronization is not configured", "cancelled");
    }
    const fullState = this.options.store.fullState();
    log.info("Rebuilding remote repository", { records: fullState.length });
    return await engine.rebuildRemote(fullState);
  }

  /** Drop stored credentials and stop syncing. */
  async disconnect(): Promise<void> {
    this.stop();
    await this.options.credentials.set(CREDENTIAL_KEY_PASSWORD, undefined);
    await this.options.credentials.set(CREDENTIAL_KEY_PASSPHRASE, undefined);
    await this.options.settings.patchWebDav({
      enabled: false,
      passwordSaved: false,
    });
    await this.resetRemoteState();
    this.setStatus({ type: "disabled" });
  }

  /** Best-effort final sync before the app exits. */
  async syncBeforeShutdown(timeoutMs = 5000): Promise<void> {
    const config = this.options.settings.get("webdav");
    if (!config.enabled) return;
    const pending = await this.queue?.size();
    if (!pending) return;
    log.info("Syncing pending changes before shutdown", { pending });
    await Promise.race([
      this.runCycle("shutdown"),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    await this.queue?.flush();
  }

  /** Number of changes waiting to reach the server. */
  async pendingCount(): Promise<number> {
    return (await this.queue?.size()) ?? 0;
  }

  stop(): void {
    if (this.periodicTimer !== undefined) clearInterval(this.periodicTimer);
    this.periodicTimer = undefined;
    this.scheduler?.cancel();
    this.scheduler = undefined;
  }
}

/**
 * The salt recorded in a remote repository's protocol.json, or undefined
 * when there is no repository yet. Anything unreadable is left to the
 * engine to report properly; this only answers "which salt".
 */
export async function readRemoteSalt(
  storage: RemoteStorage,
): Promise<string | undefined> {
  try {
    const raw = await storage.getIfExists("protocol.json");
    if (!raw) return undefined;
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as {
      salt?: unknown;
    };
    return typeof parsed.salt === "string" && parsed.salt
      ? parsed.salt
      : undefined;
  } catch {
    return undefined;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof SyncError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
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

function hostName(): string {
  try {
    return Deno.hostname();
  } catch {
    return `${Deno.build.os} device`;
  }
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}
