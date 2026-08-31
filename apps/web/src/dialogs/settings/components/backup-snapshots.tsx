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
 * The snapshot list for one backup target.
 *
 * Snapshots are produced and read by the runtime's backup engine
 * (`backup.list` / `backup.restore`), which verifies a snapshot's content
 * hash before it touches anything and — when "back up before restore" is on —
 * takes a safety backup first. Restoring still replaces the whole database,
 * so it is gated behind an explicit, typed confirmation here.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Flex, Text } from "@theme-ui/components";
import { formatBytes, getFormattedDate } from "@notesnook/common";
import { strings } from "@notesnook/intl";
import { Loading, Refresh } from "../../../components/icons";
import { ErrorText } from "../../../components/error-text";
import { ConfirmDialog } from "../../confirm";
import { showToast } from "../../../utils/toast";
import {
  BackupSnapshot,
  BackupTarget,
  store as webDavStore,
  useStore as useWebDavStore
} from "../../../stores/webdav-store";
import { store as appStore } from "../../../stores/app-store";

/**
 * Runs a restore after an explicit confirmation. Exported so that the
 * "restore from a file" button can reuse exactly the same warning.
 */
export async function confirmAndRestore(
  target: BackupTarget | "file",
  name: string,
  label: string
) {
  const backupFirst = webDavStore.get().backupSettings?.backupBeforeRestore;
  const result = await ConfirmDialog.show({
    title: "Restore this backup?",
    message:
      `Everything currently in this vault is replaced by the contents of ` +
      `**${label}**.\n\n` +
      "- Notes, notebooks, tags and attachments created or edited since that " +
      "snapshot **will be gone**.\n" +
      (backupFirst
        ? "- A safety backup of the current state is taken first, so this can " +
          "be undone by restoring that snapshot.\n"
        : '- "Back up before restore" is off, so the current state is **not** ' +
          "saved anywhere. Turn it on first if you might want it back.\n") +
      "- If this vault syncs, the restored data is what other devices will " +
      "receive on the next sync.",
    warnings: ["This replaces the data in this vault."],
    checks: {
      accept: {
        text: "I understand my current data will be replaced",
        default: false
      }
    },
    inputs: {
      confirm: { title: 'Type "restore" to confirm', required: true }
    },
    positiveButtonText: strings.restore(),
    negativeButtonText: strings.cancel()
  });
  if (!result || !result.checks?.accept) return false;
  if (result.inputs?.confirm?.trim().toLowerCase() !== "restore") {
    showToast("error", 'Type "restore" to confirm.');
    return false;
  }

  try {
    const { counts, safetyBackup } = await webDavStore.restoreBackup(
      target,
      name
    );
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    showToast(
      "success",
      `Restored ${total} item(s).` +
        (safetyBackup
          ? ` The previous state was saved as ${safetyBackup}.`
          : "")
    );
    await appStore.get().refresh();
    return true;
  } catch (error) {
    showToast("error", error instanceof Error ? error.message : String(error));
    return false;
  }
}

export function BackupSnapshotList(props: { target: BackupTarget }) {
  const { target } = props;
  const backupSettings = useWebDavStore((store) => store.backupSettings);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const isTargetEnabled =
    target === "local"
      ? !!backupSettings?.localEnabled
      : !!backupSettings?.webdavEnabled;

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const list = await webDavStore.listBackups(target);
      setSnapshots(
        [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSnapshots([]);
    } finally {
      setIsLoading(false);
    }
  }, [target]);

  useEffect(() => {
    if (isTargetEnabled) void load();
    else setSnapshots(undefined);
  }, [isTargetEnabled, load]);

  if (!isTargetEnabled) return null;

  return (
    <Flex sx={{ flexDirection: "column", gap: 1, mt: 2, width: "100%" }}>
      <Flex sx={{ alignItems: "center", justifyContent: "space-between" }}>
        <Text variant="subBody" sx={{ fontWeight: "bold", color: "heading" }}>
          {target === "local" ? "Local snapshots" : "Snapshots on the server"}
        </Text>
        <Button
          variant="secondary"
          sx={{ p: 1, bg: "transparent" }}
          title="Refresh"
          disabled={isLoading}
          onClick={() => void load()}
          data-test-id={`backup-refresh-${target}`}
        >
          {isLoading ? <Loading size={14} /> : <Refresh size={14} />}
        </Button>
      </Flex>
      {error && <ErrorText error={error} />}
      {snapshots && snapshots.length === 0 && !error && (
        <Text variant="body" sx={{ color: "paragraph-secondary" }}>
          {strings.noBackupsFound()}
        </Text>
      )}
      {snapshots?.map((snapshot) => (
        <Flex
          key={snapshot.name}
          sx={{
            alignItems: "center",
            gap: 2,
            p: 1,
            borderRadius: "default",
            bg: "background-secondary"
          }}
          data-test-id={`backup-snapshot-${target}`}
        >
          <Flex sx={{ flexDirection: "column", flex: 1, overflow: "hidden" }}>
            <Text
              variant="body"
              sx={{
                color: "heading",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}
            >
              {snapshot.createdAt
                ? getFormattedDate(snapshot.createdAt)
                : snapshot.name}
            </Text>
            <Text variant="subBody">
              {snapshot.name}
              {typeof snapshot.size === "number"
                ? ` · ${formatBytes(snapshot.size)}`
                : ""}
            </Text>
          </Flex>
          <Button
            variant="errorSecondary"
            sx={{ flexShrink: 0 }}
            onClick={() =>
              void confirmAndRestore(target, snapshot.name, snapshot.name)
            }
            data-test-id={`backup-restore-${target}`}
          >
            {strings.restore()}
          </Button>
        </Flex>
      ))}
    </Flex>
  );
}

export function LocalBackupSnapshots() {
  return <BackupSnapshotList target="local" />;
}

export function WebDavBackupSnapshots() {
  return <BackupSnapshotList target="webdav" />;
}
