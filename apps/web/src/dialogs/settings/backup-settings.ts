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
 * Settings → Backup & export: the encrypted backup subsystem.
 *
 * Backups are deliberately *not* sync. Sync propagates every change,
 * deletions included; a backup is an immutable, encrypted, integrity-checked
 * snapshot that a later deletion cannot reach. The engine lives in the Deno
 * runtime (packages/sync-webdav/src/backup.ts, driven by
 * apps/desktop/src/backup/service.ts) and is reached only through the
 * `backup.*` procedures.
 *
 * The portable `.nnbackupz` export/import in backup-export-settings.ts is a
 * different thing again: a file you can carry to another app. Both live in
 * this section, under separate headers.
 */

import { SettingsGroup } from "./types";
import {
  BackupTarget,
  store as webDavStore,
  useStore as useWebDavStore
} from "../../stores/webdav-store";
import { showToast } from "../../utils/toast";
import { getFormattedDate } from "@notesnook/common";
import { strings } from "@notesnook/intl";
import {
  LocalBackupSnapshots,
  WebDavBackupSnapshots,
  confirmAndRestore
} from "./components/backup-snapshots";

const onBackupChange = (listener: (state: unknown, prev: unknown) => void) =>
  useWebDavStore.subscribe((s) => s.backupSettings, listener);

const onBackupOrSyncChange = (
  listener: (state: unknown, prev: unknown) => void
) =>
  useWebDavStore.subscribe(
    (s) => [s.backupSettings, s.config] as const,
    listener,
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] }
  );

async function run(action: () => Promise<unknown>, success?: string) {
  try {
    await action();
    if (success) showToast("success", success);
  } catch (error) {
    showToast("error", error instanceof Error ? error.message : String(error));
  }
}

function enabledTargets(): BackupTarget[] {
  const settings = webDavStore.get().backupSettings;
  const targets: BackupTarget[] = [];
  if (settings?.localEnabled) targets.push("local");
  if (settings?.webdavEnabled) targets.push("webdav");
  return targets;
}

async function createBackup(targets?: BackupTarget[]) {
  const wanted = targets ?? enabledTargets();
  if (wanted.length === 0) {
    showToast(
      "error",
      "Turn on local or WebDAV backups first — there is nowhere to write to."
    );
    return;
  }
  await run(async () => {
    const result = await webDavStore.createBackup(wanted);
    showToast(
      "success",
      `Backed up to ${result.written.join(", ")} as ${result.name}.`
    );
  });
}

export const EncryptedBackupSettings: SettingsGroup[] = [
  {
    key: "backup-schedule",
    section: "backup-export",
    header: strings.backups(),
    isHidden: () => !IS_DESKTOP_APP,
    onRender: () => {
      void webDavStore.refresh().catch(() => {
        /* individual rows fall back to their defaults */
      });
    },
    onStateChange: onBackupChange,
    settings: [
      {
        key: "encrypted-backup-now",
        title: strings.backupNow(),
        description: () => {
          const lastBackupAt = webDavStore.get().backupSettings?.lastBackupAt;
          return (
            "Write an encrypted snapshot to every destination that is turned " +
            "on below. The snapshot is verified after it is written." +
            (lastBackupAt
              ? `\n\nLast backup: ${getFormattedDate(lastBackupAt)}.`
              : "")
          );
        },
        keywords: ["backup", "snapshot", "now", "manual"],
        onStateChange: onBackupChange,
        components: [
          {
            type: "button",
            title: strings.backupNow(),
            variant: "secondary",
            action: () => createBackup()
          }
        ]
      },
      {
        key: "encrypted-backup-interval",
        title: "Backup interval",
        description:
          "How often a snapshot is taken automatically. The app catches up on " +
          "a missed backup the next time it starts.",
        keywords: ["interval", "schedule", "automatic", "daily", "weekly"],
        onStateChange: onBackupChange,
        components: [
          {
            type: "dropdown",
            options: [
              { value: "manual", title: "Only when I ask" },
              { value: "daily", title: strings.daily() },
              { value: "weekly", title: strings.weekly() },
              { value: "monthly", title: strings.monthly() }
            ],
            selectedOption: () =>
              webDavStore.get().backupSettings?.interval ?? "weekly",
            onSelectionChanged: (value) =>
              run(() =>
                webDavStore.saveBackupSettings({
                  interval: value as "manual" | "daily" | "weekly" | "monthly"
                })
              )
          }
        ]
      },
      {
        key: "encrypted-backup-retention",
        title: "Snapshots to keep",
        description:
          "Older snapshots beyond this count are deleted from each " +
          "destination after a new one is written. Set 0 to keep every " +
          "snapshot forever.",
        keywords: ["retention", "keep", "prune", "cleanup"],
        onStateChange: onBackupChange,
        components: [
          {
            type: "input",
            inputType: "number",
            min: 0,
            max: 1000,
            defaultValue: () =>
              webDavStore.get().backupSettings?.retention ?? 10,
            onChange: (value) =>
              void run(() =>
                webDavStore.saveBackupSettings({ retention: value })
              )
          }
        ]
      },
      {
        key: "encrypted-backup-before-restore",
        title: "Back up before restoring",
        description:
          "Take a snapshot of the current state before a restore overwrites " +
          "it, so a restore can itself be undone. Strongly recommended.",
        keywords: ["safety", "before restore", "undo"],
        onStateChange: onBackupChange,
        components: [
          {
            type: "toggle",
            isToggled: () =>
              !!webDavStore.get().backupSettings?.backupBeforeRestore,
            toggle: () =>
              run(() =>
                webDavStore.saveBackupSettings({
                  backupBeforeRestore:
                    !webDavStore.get().backupSettings?.backupBeforeRestore
                })
              )
          }
        ]
      },
      {
        key: "encrypted-backup-before-maintenance",
        title: "Back up before destructive maintenance",
        description:
          "Take a snapshot before an operation that rewrites the database — " +
          "a vacuum, a migration or a repository rebuild.",
        keywords: ["maintenance", "vacuum", "migration", "rebuild"],
        onStateChange: onBackupChange,
        components: [
          {
            type: "toggle",
            isToggled: () =>
              !!webDavStore.get().backupSettings?.backupBeforeMaintenance,
            toggle: () =>
              run(() =>
                webDavStore.saveBackupSettings({
                  backupBeforeMaintenance:
                    !webDavStore.get().backupSettings?.backupBeforeMaintenance
                })
              )
          }
        ]
      },
      {
        key: "encrypted-backup-restore-file",
        title: "Restore from a backup file",
        description:
          "Pick an encrypted snapshot from disk — for example one copied from " +
          "another machine — and restore it.",
        keywords: ["restore", "import", "file", "snapshot"],
        components: [
          {
            type: "button",
            title: strings.restore(),
            variant: "errorSecondary",
            action: async () => {
              const path = await webDavStore.pickBackupFile();
              if (!path) return;
              await confirmAndRestore("file", path, path);
            }
          }
        ]
      }
    ]
  },
  {
    key: "backup-local",
    section: "backup-export",
    header: "Local backups",
    isHidden: () => !IS_DESKTOP_APP,
    onStateChange: onBackupChange,
    settings: [
      {
        key: "local-backups-enabled",
        title: "Back up to this computer",
        description:
          "Write snapshots to a folder on this machine. A local backup is the " +
          "one that still works when the server does not.",
        keywords: ["local", "disk", "folder", "offline"],
        onStateChange: onBackupChange,
        components: [
          {
            type: "toggle",
            isToggled: () => !!webDavStore.get().backupSettings?.localEnabled,
            toggle: () =>
              run(() =>
                webDavStore.saveBackupSettings({
                  localEnabled: !webDavStore.get().backupSettings?.localEnabled
                })
              )
          }
        ]
      },
      {
        key: "local-backup-directory",
        title: "Backup folder",
        description: () =>
          webDavStore.get().backupSettings?.localDirectory ||
          "No folder chosen yet.",
        keywords: ["directory", "path", "folder", "location"],
        isHidden: () => !webDavStore.get().backupSettings?.localEnabled,
        onStateChange: onBackupChange,
        components: [
          {
            type: "button",
            title: strings.select(),
            variant: "secondary",
            action: () =>
              run(async () => {
                const directory = await webDavStore.selectLocalDirectory();
                if (directory)
                  showToast("success", `Backups will be written to ${directory}.`);
              })
          }
        ]
      },
      {
        key: "local-backup-snapshots",
        title: "Snapshots on this computer",
        description:
          "Every snapshot kept in the backup folder, newest first. Restoring " +
          "one replaces the current contents of this vault.",
        keywords: ["snapshots", "restore", "history", "local"],
        isHidden: () => !webDavStore.get().backupSettings?.localEnabled,
        onStateChange: onBackupChange,
        components: [{ type: "custom", component: LocalBackupSnapshots }]
      }
    ]
  },
  {
    key: "backup-webdav",
    section: "backup-export",
    header: "WebDAV backups",
    isHidden: () => !IS_DESKTOP_APP,
    onStateChange: onBackupOrSyncChange,
    settings: [
      {
        key: "webdav-backups-enabled",
        title: "Back up to the WebDAV server",
        // The whole group hides until a WebDAV server is configured: remote
        // backups reuse that server and its stored credentials.
        description:
          "Write the same encrypted snapshots to your WebDAV server, in a " +
          "directory of their own. They are separate from the sync " +
          "repository: deleting a note and syncing that deletion never " +
          "touches a snapshot.",
        keywords: ["webdav", "remote", "offsite", "server"],
        isHidden: () => !webDavStore.get().config?.serverUrl,
        onStateChange: onBackupOrSyncChange,
        components: [
          {
            type: "toggle",
            isToggled: () => !!webDavStore.get().backupSettings?.webdavEnabled,
            toggle: () =>
              run(() =>
                webDavStore.saveBackupSettings({
                  webdavEnabled:
                    !webDavStore.get().backupSettings?.webdavEnabled
                })
              )
          }
        ]
      },
      {
        key: "webdav-backup-directory",
        title: "Remote backup directory",
        description:
          "Folder on the WebDAV server that holds the snapshots, relative to " +
          "the server URL configured for sync.",
        keywords: ["directory", "remote folder", "path"],
        isHidden: () => !webDavStore.get().backupSettings?.webdavEnabled,
        onStateChange: onBackupOrSyncChange,
        components: [
          {
            type: "input",
            inputType: "text",
            defaultValue: () =>
              webDavStore.get().backupSettings?.webdavDirectory ?? "backups",
            onChange: (value) => {
              const directory = value.trim();
              if (!directory) return;
              void run(() =>
                webDavStore.saveBackupSettings({ webdavDirectory: directory })
              );
            }
          }
        ]
      },
      {
        key: "webdav-backup-snapshots",
        title: "Snapshots on the server",
        description:
          "Every snapshot in the remote backup directory, newest first. " +
          "Restoring one downloads it, verifies it and replaces the current " +
          "contents of this vault.",
        keywords: ["snapshots", "restore", "history", "remote", "webdav"],
        isHidden: () => !webDavStore.get().backupSettings?.webdavEnabled,
        onStateChange: onBackupOrSyncChange,
        components: [{ type: "custom", component: WebDavBackupSnapshots }]
      }
    ]
  }
];
