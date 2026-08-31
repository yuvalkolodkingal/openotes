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

import Config from "../utils/config";
import { hashNavigate, getCurrentHash, navigate } from "../navigation";
import { db } from "./db";
import { FeatureId, FeatureResult, sanitizeFilename } from "@notesnook/common";
import { HomePage, useStore as useSettingStore } from "../stores/setting-store";
import { showToast } from "../utils/toast";
import { readFile, showFilePicker } from "../utils/file-picker";
import { logger } from "../utils/logger";
import { TaskManager } from "./task-manager";
import { EVENTS, parseInternalLink } from "@notesnook/core";
import { createWritableStream } from "./desktop-bridge";
import { FeatureDialog, FeatureKeys } from "../dialogs/feature-dialog";
import { LegacyBackupFile } from "@notesnook/core";
import { useEditorStore } from "../stores/editor-store";
import { formatDate } from "@notesnook/core";
import { BackupPasswordDialog } from "../dialogs/backup-password-dialog";
import { Cipher, SerializedKey } from "@notesnook/crypto";
import { ChunkedStream } from "../utils/streams/chunked-stream";
import { isFeatureSupported } from "../utils/feature-check";
import { strings } from "@notesnook/intl";
import { ABYTES, streamablefs } from "../interfaces/fs";
import { type ZipEntry } from "../utils/streams/unzip-stream";
import { ZipFile } from "../utils/streams/zip-stream";
import { Home } from "../components/icons";
import { MenuItem } from "@notesnook/ui";
import { TaskScheduler } from "../utils/task-scheduler";
import { path } from "@notesnook-importer/core/dist/src/utils/path";

export const CREATE_BUTTON_MAP = {
  notes: {
    title: strings.addItem("note"),
    onClick: () => useEditorStore.getState().newSession(),
    onAuxClick: () => useEditorStore.getState().addTab()
  },
  notebooks: {
    title: strings.addItem("notebook"),
    onClick: () => hashNavigate("/notebooks/create", { replace: true })
  },
  tags: {
    title: strings.addItem("tag"),
    onClick: () => hashNavigate(`/tags/create`, { replace: true })
  },
  reminders: {
    title: strings.addItem("reminder"),
    onClick: () => hashNavigate(`/reminders/create`, { replace: true })
  }
};

export async function introduceFeatures() {
  const hash = getCurrentHash().replace("#", "");
  if (!!hash || IS_TESTING) return;
  const features: FeatureKeys[] = [];
  for (const feature of features) {
    if (!Config.get(`feature:${feature}`)) {
      await FeatureDialog.show({ featureName: feature });
    }
  }
}

export const DEFAULT_CONTEXT = { colors: [], tags: [], notebook: {} };

export async function createBackup(
  options: {
    mode?: "full" | "partial";
    background?: boolean;
  } = { mode: "partial" }
) {
  const { mode, background } = options;

  const filename = sanitizeFilename(
    `${formatDate(Date.now(), {
      type: "date-time",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "24-hour"
    })}-${new Date().getSeconds()}${mode === "full" ? "-full" : ""}`,
    { replacement: "-" }
  );
  const ext = "nnbackupz";
  const filePath = `${filename}.${ext}`;

  const encoder = new TextEncoder();
  const error = await TaskManager.startTask<Error | void>({
    type: background ? "status" : "modal",
    id: "creating-backup",
    title: strings.backingUpData(mode),
    subtitle: strings.backingUpDataWait(),
    action: async (report) => {
      const { createZipStream } = await import("../utils/streams/zip-stream");
      const writeStream = await createWritableStream(filePath);
      await new ReadableStream<ZipFile>({
        start() {},
        async pull(controller) {
          // Openotes has no hosted account, and core can only encrypt a
          // backup with an account master key, so app-level exports are
          // written in plain form. Encrypted backups are produced by the
          // WebDAV backup subsystem instead.
          for await (const output of db.backup!.export({
            type: "web",
            encrypt: false,
            mode
          })) {
            if (output.type === "file") {
              const file = output;
              report({
                text: background
                  ? `Creating backup (${file.path})`
                  : `Saving file ${file.path}`
              });
              controller.enqueue({
                path: file.path,
                data: encoder.encode(file.data)
              });
            } else if (output.type === "attachment") {
              report({
                text: background
                  ? `Creating backup (${output.hash})`
                  : `Saving attachment ${output.hash}`,
                total: output.total,
                current: output.current
              });
              const handle = await streamablefs.readFile(output.hash);
              if (!handle) continue;
              controller.enqueue({
                path: output.path,
                data: handle.readable
              });
            }
          }
          controller.close();
        }
      })
        .pipeThrough(createZipStream())
        .pipeTo(writeStream);
    }
  });
  if (error) {
    showToast(
      "error",
      `${strings.backupFailed()}: ${(error as Error).message}`
    );
    console.error(error);
  } else {
    const backupDirectory = useSettingStore.getState().backupStorageLocation;
    showToast(
      "success",
      IS_DESKTOP_APP
        ? `${strings.backupSavedAt(path.join(backupDirectory, filePath))}`
        : strings.backupSuccess()
    );
    return true;
  }
  return false;
}

export async function selectBackupFile() {
  const [file] = await showFilePicker({
    acceptedFileTypes: ".nnbackup,.nnbackupz"
  });
  if (!file) return;
  return file;
}

export async function importBackup() {
  const backupFile = await selectBackupFile();
  if (!backupFile) return false;
  await restoreBackupFile(backupFile);
  return true;
}

export async function restoreBackupFile(backupFile: File) {
  const isLegacy = !backupFile.name.endsWith(".nnbackupz");

  if (isLegacy) {
    const backup = JSON.parse(await readFile(backupFile));

    if (backup.data.iv && backup.data.salt) {
      await BackupPasswordDialog.show({
        validate: async ({ password, key }) => {
          if (!password && !key) return false;
          const error = await restoreWithProgress(backup, password, key);
          return !error;
        }
      });
    } else {
      await restoreWithProgress(backup);
    }
    await db.initCollections();
  } else {
    const { createUnzipIterator } = await import(
      "../utils/streams/unzip-stream"
    );

    const error = await TaskManager.startTask<Error | void>({
      title: strings.restoringBackup(),
      subtitle: strings.restoringBackupDesc(),
      type: "modal",
      action: async (report) => {
        let cachedPassword: string | undefined = undefined;
        let cachedKey: string | undefined = undefined;
        // const { read, totalFiles } = await Reader(backupFile);
        const entries: ZipEntry[] = [];
        const attachments: ZipEntry[] = [];
        let attachmentsKey: SerializedKey | Cipher<"base64"> | undefined;
        let filesProcessed = 0;

        let isValid = false;
        for await (const entry of createUnzipIterator(backupFile)) {
          if (entry.name === ".nnbackup") {
            isValid = true;
            continue;
          }
          if (entry.name === "attachments/.attachments_key")
            attachmentsKey = JSON.parse(await entry.text()) as
              | SerializedKey
              | Cipher<"base64">;
          else if (entry.name.startsWith("attachments/"))
            attachments.push(entry);
          else if (!entry.name.startsWith("attachments/")) entries.push(entry);
        }
        if (!isValid)
          console.warn(
            "The backup file does not contain the verification .nnbackup file."
          );

        await db.transaction(async () => {
          for (const entry of entries) {
            const backup = JSON.parse(await entry.text());
            if (backup.encrypted) {
              if (!cachedPassword && !cachedKey) {
                const result = await BackupPasswordDialog.show({
                  validate: async ({ password, key: encryptionKey }) => {
                    if (!password && !encryptionKey) return false;
                    await db.backup?.import(backup, {
                      password,
                      encryptionKey,
                      attachmentsKey
                    });
                    cachedPassword = password;
                    cachedKey = encryptionKey;
                    return true;
                  }
                });
                if (!result) break;
              } else
                await db.backup?.import(backup, {
                  password: cachedPassword,
                  encryptionKey: cachedKey,
                  attachmentsKey
                });
            } else {
              await db.backup?.import(backup, { attachmentsKey });
            }

            report({
              text: `Processed ${entry.name}`,
              current: filesProcessed++,
              total: entries.length
            });
          }
        });
        await db.initCollections();

        let current = 0;
        for (const entry of attachments) {
          const hash = entry.name.replace("attachments/", "");

          report({
            text: `Importing attachment ${hash}`,
            total: attachments.length,
            current: current++
          });

          const attachment = await db.attachments.attachment(hash);
          if (!attachment) continue;

          await streamablefs.deleteFile(attachment.hash);
          const handle = await streamablefs.createFile(
            attachment.hash,
            attachment.size,
            attachment.mimeType
          );
          await entry
            .stream()
            .pipeThrough(
              new ChunkedStream(
                attachment.chunkSize + ABYTES,
                isFeatureSupported("opfs") ? "copy" : "nocopy"
              )
            )
            .pipeTo(handle.writeable);
        }
      }
    });
    if (error) {
      console.error(error);
      showToast("error", `${strings.restoreFailed()}: ${error.message}`);
    } else {
      showToast("success", strings.backupRestored());
    }
  }
}

async function restoreWithProgress(
  backup: LegacyBackupFile,
  password?: string,
  key?: string
) {
  return await TaskManager.startTask<Error | void>({
    title: strings.restoringBackup(),
    subtitle: strings.restoringBackupDesc(),
    type: "modal",
    action: (report) => {
      db.eventManager.subscribe(
        EVENTS.migrationProgress,
        ({
          collection,
          total,
          current
        }: {
          collection: string;
          total: number;
          current: number;
        }) => {
          report({
            text: strings.restoringCollection(collection),
            current,
            total
          });
        }
      );

      report({ text: strings.restoring() });
      return restore(backup, password, key);
    }
  });
}

async function restore(
  backup: LegacyBackupFile,
  password?: string,
  encryptionKey?: string
) {
  try {
    await db.backup?.import(backup, { password, encryptionKey });
    showToast("success", strings.backupRestored());
  } catch (e) {
    logger.error(e as Error, "Could not restore the backup");
    showToast(
      "error",
      `${strings.backupFailed()}: ${(e as Error).message || e}`
    );
  }
}

export function createSetDefaultHomepageMenuItem(
  id: string,
  type: HomePage["type"],
  availability: FeatureResult<"customHomepage">
) {
  const homepage = useSettingStore.getState().homepage;
  return {
    key: "set-as-homepage",
    type: "button",
    title: strings.setAsHomepage(),
    isChecked: homepage?.id === id && homepage?.type === type,
    premium: !availability.isAllowed,
    onClick: withFeatureCheck(availability, async () => {
      if (homepage?.id === id && homepage?.type === type)
        useSettingStore.getState().setHomepage();
      else {
        useSettingStore.getState().setHomepage({ id, type });
      }
    }),
    icon: Home.path
  } as MenuItem;
}

/**
 * Openotes is local-only: every feature is unlocked and every limit is
 * unmetered (see `@notesnook/common`'s `is-feature-available`), so there is
 * nothing left to gate. `checkFeature` and `withFeatureCheck` are kept
 * because the call sites all over the UI are written around them, but they
 * no longer consult a plan or open an upgrade dialog.
 */
export async function checkFeature<TId extends FeatureId>(
  _idOrFeature: TId | FeatureResult<TId>,
  _options: { value?: number; type?: "toast" | "dialog" } = {}
): Promise<boolean> {
  return true;
}

export function withFeatureCheck<TId extends FeatureId>(
  _idOrFeature: TId | FeatureResult<TId> | undefined,
  callback: (...args: any[]) => Promise<void> | void
) {
  return async (...args: any[]) => {
    await callback(...args);
  };
}

export async function scheduleExpiredNotesDeletion() {
  await db.notes.deleteExpiredNotes();
  await TaskScheduler.stop("delete-expired-notes");
  TaskScheduler.register("delete-expired-notes", "0 0 * * *", async () => {
    await db.notes.deleteExpiredNotes();
  });
}

export async function handleInternalLink(url: string, openInNewTab?: boolean) {
  const link = parseInternalLink(url);
  if (!link) return;
  if (link.type === "note") {
    await useEditorStore.getState().openSession(link.id, {
      activeBlockId: link.params?.blockId || undefined,
      openInNewTab
    });
  } else if (link.type === "notebook") {
    navigate(`/notebooks/${link.id}`);
  } else if (link.type === "tag") {
    navigate(`/tags/${link.id}`);
  } else if (link.type === "color") {
    navigate(`/colors/${link.id}`);
  }
}

export function truncateString(str: string, maxLength = 100) {
  return str.length > maxLength ? str.substring(0, maxLength) + "..." : str;
}
