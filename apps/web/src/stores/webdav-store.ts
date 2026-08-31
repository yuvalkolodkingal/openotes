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
 * State for the fork's own synchronization and backup subsystems.
 *
 * Everything here lives in the Deno runtime: the renderer owns no WebDAV
 * client, no credential store and no backup engine, it only drives the
 * `webdav.*` and `backup.*` procedures (apps/desktop/src/rpc/protocol.ts) and
 * listens to the `webdav.status`, `webdav.conflict` and `backup.completed`
 * events.
 *
 * The bridge is imported by its explicit `.desktop` path rather than through
 * the platform-swapped `../common/desktop-bridge` barrel: `desktopCall` and
 * `onDesktopEvent` only exist on the runtime half, and this fork only ever
 * builds the desktop target. Every entry point below is still a no-op when
 * `hasDesktopRuntime()` is false, so nothing throws in a plain browser.
 */

import {
  desktopCall,
  hasDesktopRuntime,
  onDesktopEvent
} from "../common/desktop-bridge/index.desktop";
import createStore from "../common/store";
import Config from "../utils/config";
import { showToast } from "../utils/toast";
import BaseStore from "./index";

/**
 * Mirrors `SyncStatus` in packages/sync-webdav/src/types.ts (and the
 * `SyncStatusType` alias re-exported from @notesnook/desktop). The runtime
 * sends this verbatim over the `webdav.status` event.
 */
export type WebDavSyncStatus =
  | { type: "synced"; at: number }
  | { type: "syncing"; progress?: { done: number; total: number } }
  | { type: "offline" }
  | { type: "pending"; count: number }
  | { type: "error"; error: string }
  | { type: "conflict"; count: number }
  | { type: "disabled" };

/**
 * Mirrors `WebDavSettings` in apps/desktop/src/native/settings.ts, plus the
 * `hasPassword` flag the handler adds. The password itself is never sent to
 * the renderer, so there is no field for it.
 */
export type WebDavConfig = {
  enabled: boolean;
  serverUrl: string;
  username: string;
  directory: string;
  intervalMinutes: number;
  syncOnStartup: boolean;
  syncAfterEdits: boolean;
  debounceSeconds: number;
  syncOnMeteredNetwork: boolean;
  syncAttachments: boolean;
  timeoutSeconds: number;
  maxRetries: number;
  allowInsecureHttp: boolean;
  storeCredentialsWithMachineKey: boolean;
  hasPassword: boolean;
};

/** Mirrors `BackupSettings` in apps/desktop/src/native/settings.ts. */
export type BackupConfig = {
  localEnabled: boolean;
  localDirectory: string;
  webdavEnabled: boolean;
  webdavDirectory: string;
  interval: "manual" | "daily" | "weekly" | "monthly";
  retention: number;
  backupBeforeRestore: boolean;
  backupBeforeMaintenance: boolean;
  lastBackupAt?: number;
};

/** Mirrors `BackupEntry` in packages/sync-webdav/src/backup.ts. */
export type BackupSnapshot = {
  name: string;
  createdAt: number;
  size?: number;
};

export type BackupTarget = "local" | "webdav";

export type TestConnectionResult = {
  ok: boolean;
  message: string;
  initialized?: boolean;
  devices?: number;
  protocolVersion?: number;
};

export type TestConnectionInput = {
  serverUrl: string;
  username: string;
  password: string;
  directory: string;
  passphrase: string;
  allowInsecureHttp: boolean;
  timeoutSeconds: number;
};

/**
 * A conflict the engine could not resolve on its own. Kept in localStorage so
 * that it survives a restart: a conflict the user never noticed is a silently
 * lost edit, which is the one outcome sync must never produce.
 */
export type SyncConflict = {
  id: string;
  /** Collection/table the conflicted item belongs to. */
  entityType: string;
  /** Best available human label; falls back to the id. */
  title: string;
  at: number;
};

const CONFLICTS_KEY = "webdav:conflicts";
const MAX_STORED_CONFLICTS = 100;

function rpc<T>(path: string, input?: unknown): Promise<T> {
  if (!hasDesktopRuntime()) {
    return Promise.reject(
      new Error("Synchronization is only available in the desktop app.")
    );
  }
  return desktopCall(path, input) as Promise<T>;
}

/** Normalizes the two payload shapes the runtime emits for a conflict. */
function toConflict(payload: unknown): SyncConflict | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  const id =
    typeof record.entityId === "string"
      ? record.entityId
      : typeof record.id === "string"
      ? record.id
      : undefined;
  if (!id) return undefined;
  const entityType =
    typeof record.entityType === "string"
      ? record.entityType
      : typeof record.table === "string"
      ? record.table
      : "item";
  const title = typeof record.title === "string" ? record.title : id;
  return { id, entityType, title, at: Date.now() };
}

function readStoredConflicts(): SyncConflict[] {
  const stored = Config.get<SyncConflict[]>(CONFLICTS_KEY, []);
  return Array.isArray(stored) ? stored : [];
}

class WebDavStore extends BaseStore<WebDavStore> {
  status: WebDavSyncStatus = { type: "disabled" };
  pending = 0;
  config?: WebDavConfig;
  backupSettings?: BackupConfig;
  conflicts: SyncConflict[] = readStoredConflicts();
  /** True while an explicit user action (sync, backup, restore) is running. */
  isBusy = false;
  /** Set once the first status/config load has come back. */
  isLoaded = false;

  // ---------------------------------------------------------------- loading

  refresh = async () => {
    // isLoaded means "we are done trying", not "it worked": the forms wait on
    // it, and a spinner that never resolves is worse than an empty form.
    try {
      if (!hasDesktopRuntime()) return;
      const [config, backupSettings] = await Promise.all([
        rpc<WebDavConfig>("webdav.getConfig"),
        rpc<BackupConfig>("backup.getSettings")
      ]);
      this.set((state) => {
        state.config = config;
        state.backupSettings = backupSettings;
      });
      await this.refreshStatus();
    } finally {
      this.set((state) => {
        state.isLoaded = true;
      });
    }
  };

  refreshStatus = async () => {
    if (!hasDesktopRuntime()) return;
    const { status, pending } = await rpc<{
      status: WebDavSyncStatus;
      pending: number;
    }>("webdav.status");
    this.set((state) => {
      state.status = status;
      state.pending = pending;
    });
  };

  /** Applied when the runtime pushes a new status. */
  setStatus = (status: WebDavSyncStatus) => {
    this.set((state) => {
      state.status = status;
      if (status.type === "pending") state.pending = status.count;
      else if (status.type === "synced") state.pending = 0;
    });
  };

  // ----------------------------------------------------------- webdav config

  saveConfig = async (patch: Partial<Omit<WebDavConfig, "hasPassword">>) => {
    const config = await rpc<WebDavConfig>("webdav.setConfig", patch);
    this.set((state) => {
      state.config = config;
    });
    await this.refreshStatus();
    return config;
  };

  /**
   * Hands the password and/or the sync passphrase to the runtime's credential
   * store. Neither ever comes back out.
   */
  setCredentials = async (credentials: {
    password?: string;
    passphrase?: string;
  }) => {
    await rpc<{ ok: true }>("webdav.setPassphrase", credentials);
    // hasPassword may have flipped.
    const config = await rpc<WebDavConfig>("webdav.getConfig");
    this.set((state) => {
      state.config = config;
    });
  };

  testConnection = (input: TestConnectionInput) =>
    rpc<TestConnectionResult>("webdav.testConnection", input);

  connect = async () => {
    const status = await this.withBusy(() =>
      rpc<WebDavSyncStatus>("webdav.connect")
    );
    this.setStatus(status);
    const config = await rpc<WebDavConfig>("webdav.getConfig");
    this.set((state) => {
      state.config = config;
    });
    return status;
  };

  disconnect = async () => {
    const status = await this.withBusy(() =>
      rpc<WebDavSyncStatus>("webdav.disconnect")
    );
    this.setStatus(status);
    const config = await rpc<WebDavConfig>("webdav.getConfig");
    this.set((state) => {
      state.config = config;
    });
    return status;
  };

  syncNow = async () => {
    const status = await this.withBusy(() =>
      rpc<WebDavSyncStatus>("webdav.syncNow")
    );
    this.setStatus(status);
    return status;
  };

  resetRemoteState = async () => {
    await this.withBusy(() => rpc<{ ok: true }>("webdav.resetRemoteState"));
    await this.refreshStatus();
  };

  /**
   * Requires the literal confirmation the handler checks for. The generation
   * is the engine's identifier for the new repository (`<deviceId>-<n>`, see
   * `newGeneration` in packages/sync-webdav), not a counter.
   */
  rebuildRemote = async () => {
    const result = await this.withBusy(() =>
      rpc<{ generation: string }>("webdav.rebuildRemote", {
        confirm: "rebuild"
      })
    );
    await this.refreshStatus();
    return result;
  };

  // ----------------------------------------------------------------- backups

  saveBackupSettings = async (patch: Partial<BackupConfig>) => {
    const backupSettings = await rpc<BackupConfig>("backup.setSettings", patch);
    this.set((state) => {
      state.backupSettings = backupSettings;
    });
    return backupSettings;
  };

  createBackup = (targets?: BackupTarget[]) =>
    this.withBusy(async () => {
      const result = await rpc<{
        name: string;
        written: string[];
        counts: Record<string, number>;
        attachments: number;
      }>("backup.createNow", targets ? { targets } : undefined);
      await this.reloadBackupSettings();
      return result;
    });

  listBackups = (target: BackupTarget) =>
    rpc<BackupSnapshot[]>("backup.list", { target });

  restoreBackup = (target: BackupTarget | "file", name: string) =>
    this.withBusy(() =>
      rpc<{ counts: Record<string, number>; safetyBackup?: string }>(
        "backup.restore",
        { target, name, confirm: "restore" }
      )
    );

  selectLocalDirectory = async () => {
    const directory = await rpc<string | undefined>(
      "backup.selectLocalDirectory"
    );
    if (directory) await this.reloadBackupSettings();
    return directory;
  };

  pickBackupFile = () => rpc<string | undefined>("backup.importFile");

  private reloadBackupSettings = async () => {
    const backupSettings = await rpc<BackupConfig>("backup.getSettings");
    this.set((state) => {
      state.backupSettings = backupSettings;
    });
  };

  // --------------------------------------------------------------- conflicts

  // The list is computed outside the state recipe so that what reaches
  // localStorage is plain data rather than a draft proxy.
  private setConflicts = (conflicts: SyncConflict[]) => {
    this.set((state) => {
      state.conflicts = conflicts;
    });
    Config.set(CONFLICTS_KEY, conflicts);
  };

  addConflict = (conflict: SyncConflict) => {
    this.setConflicts(
      [
        conflict,
        ...this.get().conflicts.filter((c) => c.id !== conflict.id)
      ].slice(0, MAX_STORED_CONFLICTS)
    );
  };

  dismissConflict = (id: string) => {
    this.setConflicts(this.get().conflicts.filter((c) => c.id !== id));
  };

  clearConflicts = () => {
    this.setConflicts([]);
  };

  // ----------------------------------------------------------------- helpers

  private withBusy = async <T>(action: () => Promise<T>): Promise<T> => {
    this.set((state) => {
      state.isBusy = true;
    });
    try {
      return await action();
    } finally {
      this.set((state) => {
        state.isBusy = false;
      });
    }
  };
}

const [useStore, store] = createStore<WebDavStore>(
  (set, get) => new WebDavStore(set, get)
);

/**
 * Wires the runtime's push events onto the store. Called once at module load
 * so that a conflict raised by a background sync is recorded even if no
 * settings panel has ever been opened.
 */
let attached = false;
function attachRuntimeListeners() {
  if (attached || !hasDesktopRuntime()) return;
  attached = true;

  onDesktopEvent("webdav.status", (payload) => {
    if (payload && typeof payload === "object" && "type" in payload) {
      store.setStatus(payload as WebDavSyncStatus);
    }
  });

  onDesktopEvent("webdav.conflict", (payload) => {
    const conflict = toConflict(payload);
    if (!conflict) return;
    store.addConflict(conflict);
    // Both halves matter: the toast so the conflict cannot pass unnoticed,
    // the stored list so it can still be found tomorrow.
    showToast(
      "warn",
      `Sync conflict: both copies of "${conflict.title}" were kept.`,
      [
        {
          text: "Review",
          type: "accent",
          onClick: () => void openConflictsDialog()
        }
      ],
      10000
    );
  });

  onDesktopEvent("backup.completed", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const info = payload as Record<string, unknown>;
    // The runtime reuses this event for restore progress; only the
    // completion shape (target + name) is worth a notification.
    if (typeof info.target === "string" && typeof info.name === "string") {
      void store.refresh();
    }
  });

  void store.refresh().catch((error) => {
    console.error("Could not load the synchronization settings:", error);
  });
}

/**
 * Imported lazily so that this store does not pull the whole dialog stack
 * (and with it the settings dialog) into every bundle that only wants the
 * sync status.
 */
async function openConflictsDialog() {
  const { SyncConflictsDialog } = await import(
    "../dialogs/sync-conflicts-dialog"
  );
  await SyncConflictsDialog.show({});
}

attachRuntimeListeners();

export { useStore, store, openConflictsDialog };
