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
import { configDir, defaultBackupDir, ensureDir } from "./paths.ts";
import { logger } from "./logger.ts";

const log = logger.scope("settings");

/**
 * Device-local settings (spec §16: these must NOT roam). Window geometry,
 * render preferences and the local backup path belong to this machine, so
 * they live in a plain JSON file here and are never fed to the sync engine.
 *
 * The WebDAV password is *not* here — it goes to the encrypted credential
 * store. This file holds only the non-secret half of the configuration.
 */

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

export interface WebDavSettings {
  enabled: boolean;
  serverUrl: string;
  username: string;
  directory: string;
  /** Minutes between automatic syncs; 0 disables periodic sync. */
  intervalMinutes: number;
  syncOnStartup: boolean;
  syncAfterEdits: boolean;
  /** Seconds to wait after the last edit before syncing. */
  debounceSeconds: number;
  syncOnMeteredNetwork: boolean;
  syncAttachments: boolean;
  timeoutSeconds: number;
  maxRetries: number;
  /** Explicit opt-in required for plain http:// (LAN / self-hosted). */
  allowInsecureHttp: boolean;
  /** Remember the WebDAV password without unlocking the vault first. */
  storeCredentialsWithMachineKey: boolean;
  /**
   * Whether a WebDAV password is stored in the credential store. A marker,
   * not a secret: the credential store itself may be locked when the
   * settings form asks, so the answer has to live somewhere readable.
   * Maintained by SyncService.setCredentials/disconnect.
   */
  passwordSaved: boolean;
}

export interface BackupSettings {
  localEnabled: boolean;
  localDirectory: string;
  webdavEnabled: boolean;
  webdavDirectory: string;
  interval: "manual" | "daily" | "weekly" | "monthly";
  retention: number;
  backupBeforeRestore: boolean;
  backupBeforeMaintenance: boolean;
  lastBackupAt?: number;
}

export interface DesktopSettings {
  autoStart: boolean;
  startMinimized: boolean;
  minimizeToSystemTray: boolean;
  closeToSystemTray: boolean;
  nativeTitlebar: boolean;
}

/**
 * Which agents the user has agreed to let Openotes launch.
 *
 * Consent is recorded against the *resolved absolute path*, not the agent id.
 * If the binary at that path is replaced, this no longer matches and the user
 * is asked again — an agent that was swapped out is not the agent they
 * approved.
 */
export interface AiSettings {
  approvedAgents: {
    agentId: string;
    resolvedPath: string;
    approvedAt: number;
  }[];
  /** Last agent the user connected, so the panel can reopen it. */
  lastAgentId?: string;
}

export interface AppSettings {
  version: 1;
  window: WindowState;
  desktop: DesktopSettings;
  webdav: WebDavSettings;
  backup: BackupSettings;
  ai: AiSettings;
  zoomFactor: number;
  theme: "light" | "dark" | "system";
  privacyMode: boolean;
  automaticUpdates: boolean;
  /** Cursor state and device id for the sync engine (device-local). */
  sync: {
    deviceId?: string;
    deviceName?: string;
    cursors: Record<string, number>;
    localSequence: number;
    meta: Record<string, string>;
  };
}

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    window: { width: 1200, height: 800, maximized: false },
    desktop: {
      autoStart: false,
      startMinimized: false,
      minimizeToSystemTray: false,
      closeToSystemTray: false,
      // The custom titlebar relies on Chromium-only
      // windowControlsOverlay/env(titlebar-area-*), which WebKitGTK does
      // not implement. A native titlebar is the portable default.
      nativeTitlebar: true,
    },
    webdav: {
      enabled: false,
      serverUrl: "",
      username: "",
      directory: "Openotes",
      intervalMinutes: 15,
      syncOnStartup: true,
      syncAfterEdits: true,
      debounceSeconds: 20,
      syncOnMeteredNetwork: false,
      syncAttachments: true,
      timeoutSeconds: 30,
      maxRetries: 3,
      allowInsecureHttp: false,
      storeCredentialsWithMachineKey: false,
      passwordSaved: false,
    },
    backup: {
      localEnabled: true,
      localDirectory: defaultBackupDir(),
      webdavEnabled: false,
      webdavDirectory: "backups",
      interval: "weekly",
      retention: 10,
      backupBeforeRestore: true,
      backupBeforeMaintenance: true,
    },
    ai: { approvedAgents: [] },
    zoomFactor: 1,
    theme: "system",
    privacyMode: false,
    automaticUpdates: true,
    sync: { cursors: {}, localSequence: 0, meta: {} },
  };
}

export class SettingsStore {
  private state: AppSettings;
  private readonly path: string;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(path: string, state: AppSettings) {
    this.path = path;
    this.state = state;
  }

  static async load(directory: string = configDir()): Promise<SettingsStore> {
    const path = join(directory, "settings.json");
    let state = defaultSettings();
    try {
      const parsed = JSON.parse(await Deno.readTextFile(path));
      state = mergeSettings(state, parsed);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // A corrupt settings file must not stop the app from opening the
        // user's notes. Keep the broken file for inspection.
        log.error("Settings file unreadable; falling back to defaults", {
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await Deno.rename(path, `${path}.corrupt-${Date.now()}`);
        } catch {
          /* best effort */
        }
      }
    }
    return new SettingsStore(path, state);
  }

  get all(): AppSettings {
    return this.state;
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.state[key];
  }

  async set<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): Promise<void> {
    this.state = { ...this.state, [key]: value };
    await this.persist();
  }

  async patch(partial: Partial<AppSettings>): Promise<void> {
    this.state = mergeSettings(this.state, partial);
    await this.persist();
  }

  async patchWebDav(partial: Partial<WebDavSettings>): Promise<void> {
    this.state = {
      ...this.state,
      webdav: { ...this.state.webdav, ...partial },
    };
    await this.persist();
  }

  async patchBackup(partial: Partial<BackupSettings>): Promise<void> {
    this.state = {
      ...this.state,
      backup: { ...this.state.backup, ...partial },
    };
    await this.persist();
  }

  async patchAi(partial: Partial<AiSettings>): Promise<void> {
    this.state = { ...this.state, ai: { ...this.state.ai, ...partial } };
    await this.persist();
  }

  async patchSync(partial: Partial<AppSettings["sync"]>): Promise<void> {
    this.state = { ...this.state, sync: { ...this.state.sync, ...partial } };
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await ensureDir(dirOf(this.path));
        const tempPath = `${this.path}.tmp`;
        await Deno.writeTextFile(tempPath, snapshot);
        await Deno.rename(tempPath, this.path);
      })
      .catch((error) => {
        log.error("Could not persist settings", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return this.writeChain;
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}

/** Deep-merge that keeps unknown keys out and never drops defaults. */
function mergeSettings(
  base: AppSettings,
  incoming: Partial<AppSettings> | Record<string, unknown>,
): AppSettings {
  const source = incoming as Record<string, unknown>;
  const merged: AppSettings = { ...base };
  for (const key of Object.keys(base) as (keyof AppSettings)[]) {
    const value = source[key as string];
    if (value === undefined) continue;
    const current = base[key];
    if (
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      (merged[key] as unknown) = {
        ...(current as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else if (typeof current === typeof value) {
      (merged[key] as unknown) = value;
    }
  }
  merged.version = 1;
  return merged;
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}
