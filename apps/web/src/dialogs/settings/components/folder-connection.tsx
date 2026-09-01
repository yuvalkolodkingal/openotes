/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited
Copyright (C) 2026 Openotes contributors

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
 * The folder sync form.
 *
 * The only secret here is the sync passphrase, and it is the same one the
 * WebDAV form asks for: it derives the key that encrypts every note before
 * it is written. Whatever keeps the folder in step — Google Drive, OneDrive,
 * Dropbox, iCloud Drive, Syncthing, a NAS — only ever sees ciphertext, and
 * that is the whole reason this provider is safe to point at a folder some
 * other company's client uploads.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Flex, Text } from "@theme-ui/components";
import Field from "../../../components/field";
import { ErrorText } from "../../../components/error-text";
import { showToast } from "../../../utils/toast";
import {
  store as webDavStore,
  useStore as useWebDavStore
} from "../../../stores/webdav-store";
import { desktopCall } from "../../../common/desktop-bridge/index.desktop";
import { WebDavStatusPill } from "../../../components/status-bar/webdav-sync-status";

export function FolderConnectionPanel() {
  const config = useWebDavStore((store) => store.config);
  const isLoaded = useWebDavStore((store) => store.isLoaded);
  const [folderPath, setFolderPath] = useState("");
  const [directory, setDirectory] = useState("Openotes");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!config) return;
    setFolderPath(config.folderPath ?? "");
    setDirectory(config.directory || "Openotes");
  }, [config]);

  const browse = useCallback(async () => {
    const picked = await desktopCall<string | null>("webdav.selectFolder");
    if (picked) setFolderPath(picked);
  }, []);

  const save = useCallback(async () => {
    setError(undefined);
    setBusy(true);
    try {
      if (!folderPath.trim()) throw new Error("Choose a folder first.");
      // The passphrase is only required the first time: after that it is in
      // the credential store and re-typing it would be a way to lock
      // yourself out by typo.
      if (!config?.enabled && !passphrase) {
        throw new Error(
          "Set a sync passphrase. It encrypts your notes before they are " +
            "written, and it is the one thing that cannot be recovered."
        );
      }
      if (passphrase) {
        await webDavStore.get().setCredentials({ passphrase });
      }
      await webDavStore.get().saveConfig({
        provider: "folder",
        folderPath: folderPath.trim(),
        directory: directory.trim() || "Openotes",
        enabled: true
      });
      setPassphrase("");
      showToast("success", "Synchronization is set up.");
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : String(problem)
      );
    } finally {
      setBusy(false);
    }
  }, [config?.enabled, directory, folderPath, passphrase]);

  if (!isLoaded) return null;

  return (
    <Flex sx={{ flexDirection: "column", gap: 1, flex: 1 }}>
      <Flex sx={{ gap: 1, alignItems: "flex-end" }}>
        <Field
          id="folder-path"
          label="Folder"
          helpText="For example the folder your drive's desktop client keeps in step."
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
          sx={{ flex: 1 }}
        />
        <Button variant="secondary" onClick={browse} disabled={busy}>
          Browse
        </Button>
      </Flex>

      <Field
        id="folder-directory"
        label="Subfolder"
        helpText="Created inside the folder above, so the repository is not scattered across your drive."
        value={directory}
        onChange={(e) => setDirectory(e.target.value)}
      />

      <Field
        id="folder-passphrase"
        label="Sync passphrase"
        type="password"
        helpText={
          config?.enabled
            ? "Already set. Type a new one only to change it — every device must use the same."
            : "What encrypts your notes. It is never written to the folder, so it cannot be recovered from it."
        }
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
      />

      {error && <ErrorText error={error} />}

      <Flex sx={{ gap: 1, alignItems: "center", mt: 1 }}>
        <Button variant="accent" onClick={save} disabled={busy}>
          {config?.enabled ? "Save" : "Set up"}
        </Button>
        <WebDavStatusPill />
      </Flex>

      <Text variant="subBody" sx={{ color: "var(--paragraph-secondary)", mt: 1 }}>
        Openotes writes encrypted files and waits; it never talks to the drive
        service itself. If the drive client is offline, changes queue up and
        appear on your other devices once it catches up.
      </Text>
    </Flex>
  );
}
