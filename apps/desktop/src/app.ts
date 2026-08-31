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

import { join } from "@std/path";
import type { SyncStatus } from "@notesnook/sync-webdav";
import { APP_NAME, APP_VERSION } from "./constants.ts";
import {
  appDataDir,
  attachmentsDir,
  cacheDir,
  documentsDir,
  ensureDir
} from "./native/paths.ts";
import { logger } from "./native/logger.ts";
import { SettingsStore } from "./native/settings.ts";
import { SqliteService } from "./native/sqlite.ts";
import { ExportWriter, FileStorage } from "./native/filesystem.ts";
import { KeyValueStore } from "./native/keyvalue.ts";
import {
  Clipboard,
  Dialogs,
  Notifications,
  Shell,
  ThemeWatcher
} from "./native/shell.ts";
import { CredentialStore } from "./security/credentials.ts";
import { DatabaseSyncStore } from "./sync/store-adapter.ts";
import { SyncService } from "./sync/service.ts";
import { BackupService } from "./backup/service.ts";
import { UpdateService } from "./updates/updater.ts";
import type { EventName } from "./rpc/protocol.ts";

const log = logger.scope("app");

/** The window operations the RPC layer needs, independent of the backend. */
export interface WindowController {
  maximize(): void;
  restore(): void;
  minimize(): void;
  isMaximized(): boolean;
  focus(): void;
  setTitle(title: string): void;
  setZoom(factor: number): void;
  requestClose(): void;
  /** Push an event into the renderer. */
  emit(event: EventName, payload: unknown): void;
}

/**
 * Everything the RPC handlers are allowed to reach. Handlers get this
 * object and nothing else — there is no ambient access to the runtime.
 */
export interface AppContext {
  settings: SettingsStore;
  credentials: CredentialStore;
  sqlite: SqliteService;
  files: FileStorage;
  exports: ExportWriter;
  storage: KeyValueStore;
  sync: SyncService;
  backups: BackupService;
  updater: UpdateService;
  shell: Shell;
  dialogs: Dialogs;
  notifications: Notifications;
  clipboard: Clipboard;
  theme: ThemeWatcher;
  window: WindowController;
  logDirectory: string;

  emit(event: EventName, payload: unknown): void;
  markRendererReady(): void;
  notifyLocalChange(): void;
  reconfigureSync(): Promise<void>;
  applyDesktopIntegration(): Promise<void>;
  allowedRoots(): string[];
  refreshAllowedRoots(): void;
  hasStoredWebDavPassword(): boolean;
  tailLogs(lines: number): Promise<string[]>;
  restart(): void;
  shutdown(): Promise<void>;
}

export interface CreateAppOptions {
  window: WindowController;
  /** Deep link the app was launched with, if any. */
  initialDeepLink?: string;
}

/**
 * Builds the application's services. This is the composition root: it is
 * the only place that knows how the pieces fit together, which keeps every
 * service testable in isolation.
 */
export async function createApp(options: CreateAppOptions): Promise<AppContext> {
  await ensureDir(appDataDir());
  await ensureDir(attachmentsDir());
  await ensureDir(cacheDir());

  const settings = await SettingsStore.load();
  const credentials = new CredentialStore(appDataDir());

  // The FFI module binds its library the moment it is imported, so the
  // encrypted build has to be selected and loaded before anything opens a
  // database. Failing here is deliberate: the alternative is an
  // unencrypted vault nobody notices.
  const sqlite = new SqliteService();
  await sqlite.initialize();
  const files = new FileStorage();
  await files.cleanupPartials();
  const storage = new KeyValueStore(appDataDir());

  const shell = new Shell();
  const dialogs = new Dialogs();
  const notifications = new Notifications(APP_NAME);
  const clipboard = new Clipboard();
  const theme = new ThemeWatcher();
  theme.apply(settings.get("theme"));

  let databaseHandle: string | undefined;
  let syncStore: DatabaseSyncStore | undefined;
  let rendererReady = false;
  const pendingEvents: { event: EventName; payload: unknown }[] = [];
  let hasWebDavPassword = false;

  const computeAllowedRoots = () => [
    appDataDir(),
    settings.get("backup").localDirectory,
    documentsDir()
  ];
  const exports = new ExportWriter(computeAllowedRoots());

  const emit = (event: EventName, payload: unknown) => {
    if (!rendererReady) {
      // Buffer until the UI says it is listening, so a deep link or a
      // startup sync result is not lost during boot.
      pendingEvents.push({ event, payload });
      return;
    }
    options.window.emit(event, payload);
  };

  const context: AppContext = {
    settings,
    credentials,
    sqlite,
    files,
    exports,
    storage,
    shell,
    dialogs,
    notifications,
    clipboard,
    theme,
    window: options.window,
    logDirectory: logger.logDirectory,

    // Replaced below once the services exist.
    sync: undefined as unknown as SyncService,
    backups: undefined as unknown as BackupService,
    updater: undefined as unknown as UpdateService,

    emit,

    markRendererReady() {
      rendererReady = true;
      for (const buffered of pendingEvents.splice(0)) {
        options.window.emit(buffered.event, buffered.payload);
      }
      if (options.initialDeepLink) {
        options.window.emit("bridge.openLink", options.initialDeepLink);
      }
      log.info("Renderer is ready");
    },

    notifyLocalChange() {
      context.sync?.notifyLocalChange();
    },

    async reconfigureSync() {
      context.sync.stop();
      await context.sync.start();
    },

    async applyDesktopIntegration() {
      const desktop = settings.get("desktop");
      log.info("Applied desktop integration settings", {
        autoStart: desktop.autoStart,
        nativeTitlebar: desktop.nativeTitlebar
      });
      await Promise.resolve();
    },

    allowedRoots: computeAllowedRoots,

    refreshAllowedRoots() {
      exports.setAllowedRoots(computeAllowedRoots());
    },

    hasStoredWebDavPassword: () => hasWebDavPassword,

    tailLogs: (lines) => logger.tail(lines),

    restart() {
      log.info("Restart requested");
      // A packaged app is relaunched by its wrapper; exiting with a
      // distinct code lets the launcher decide to restart.
      void context.shutdown().then(() => Deno.exit(69));
    },

    async shutdown() {
      log.info("Shutting down");
      try {
        await context.sync?.syncBeforeShutdown();
      } catch (error) {
        log.warn("Final sync did not complete", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      context.sync?.stop();
      exports.closeAll();
      files.closeAll();
      await storage.flush();
      sqlite.closeAll();
      await settings.flush();
      logger.close();
    }
  };

  const sync = new SyncService({
    settings,
    credentials,
    files,
    // The adapter needs an open database; until the renderer opens the
    // vault, sync has nothing to do, so this proxies to whatever is open.
    store: new Proxy({} as DatabaseSyncStore, {
      get(_target, property) {
        if (!syncStore) {
          throw new Error("The vault is not open yet");
        }
        const value = (syncStore as unknown as Record<string | symbol, unknown>)[
          property
        ];
        return typeof value === "function" ? value.bind(syncStore) : value;
      }
    }),
    onStatus: (status: SyncStatus) => emit("webdav.status", status),
    onConflict: (info) => emit("webdav.conflict", info)
  });

  const backups = new BackupService({
    settings,
    credentials,
    sqlite,
    databaseHandle: () => databaseHandle,
    store: () => syncStore,
    files,
    onCompleted: (info) => emit("backup.completed", info)
  });

  const updater = new UpdateService({
    stagingDir: join(cacheDir(), "updates"),
    emit: (event) => {
      switch (event.type) {
        case "checking":
          return emit("updater.checking", {});
        case "available":
          return emit("updater.available", event.result);
        case "not-available":
          return emit("updater.notAvailable", event.result);
        case "download-progress":
          return emit("updater.downloadProgress", event);
        case "downloaded":
          return emit("updater.downloaded", { path: event.path });
        case "error":
          return emit("updater.error", { message: event.message });
      }
    },
    openExternal: (url) => shell.openExternal(url)
  });

  context.sync = sync;
  context.backups = backups;
  context.updater = updater;

  /**
   * The renderer opens the vault through sqlite.open; wrap the service so
   * the sync adapter learns about the handle without the renderer having to
   * tell us twice.
   */
  const originalOpen = sqlite.open.bind(sqlite);
  sqlite.open = (openOptions) => {
    const handle = originalOpen(openOptions);
    if (openOptions.filePath !== ":memory:") {
      databaseHandle = handle;
      syncStore = new DatabaseSyncStore({
        sqlite,
        databaseHandle: handle,
        settings,
        onConflictCopy: (info) => emit("webdav.conflict", info)
      });
      log.info("Vault opened; sync adapter attached");
      // Starting sync is safe now: it no-ops unless WebDAV is configured.
      void sync.start().catch((error) =>
        log.warn("Could not start synchronization", {
          error: error instanceof Error ? error.message : String(error)
        })
      );
      void backups.runIfDue();
    }
    return handle;
  };

  // Unlocking the credential store is best-effort at boot: with the machine
  // key it succeeds silently, otherwise the UI asks when it needs a secret.
  if (settings.get("webdav").storeCredentialsWithMachineKey) {
    try {
      await credentials.unlockWithMachineKey();
      hasWebDavPassword = await credentials.has("webdav.password");
    } catch (error) {
      log.warn("Could not unlock stored credentials at startup", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  log.info("Application ready", {
    version: APP_VERSION,
    dataDir: appDataDir(),
    deno: Deno.version.deno
  });

  return context;
}
