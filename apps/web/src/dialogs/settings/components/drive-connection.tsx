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
 * Signing in to Google Drive, Dropbox or OneDrive.
 *
 * The registration is the user's own: Openotes has no OAuth application, so
 * there is no client id to ship and nothing a provider can revoke out from
 * under everybody. It also means the app can only ever see the files it
 * created — the scopes are app-scoped, and the app is theirs.
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

type DriveSetup = {
  provider: string;
  label: string;
  scopes: string[];
  requiresClientSecret: boolean;
  loopbackHost: string;
  registrationNotes: string[];
};

export function DriveConnectionPanel() {
  const config = useWebDavStore((store) => store.config);
  const provider = config?.provider;
  const [setup, setSetup] = useState<DriveSetup>();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [directory, setDirectory] = useState("Openotes");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!provider || provider === "webdav") return;
    setClientId(config?.clientId ?? "");
    setDirectory(config?.directory || "Openotes");
    setError(undefined);
    desktopCall<DriveSetup>("webdav.driveSetup", { provider })
      .then(setSetup)
      .catch((problem) =>
        setError(problem instanceof Error ? problem.message : String(problem))
      );
  }, [config?.clientId, config?.directory, provider]);

  const connect = useCallback(async () => {
    setError(undefined);
    setBusy(true);
    try {
      if (!clientId.trim()) throw new Error("Paste the client ID first.");
      if (!config?.connected && !passphrase) {
        throw new Error(
          "Set a sync passphrase. It encrypts your notes before they are " +
            "uploaded, and it is the one thing that cannot be recovered."
        );
      }
      if (passphrase) {
        await webDavStore.get().setCredentials({ passphrase });
      }
      await webDavStore.get().saveConfig({
        provider,
        directory: directory.trim() || "Openotes"
      });
      showToast(
        "success",
        "Finish signing in in your browser, then come back here."
      );
      await desktopCall("webdav.connectDrive", {
        provider,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined
      });
      await webDavStore.get().refresh();
      setPassphrase("");
      setClientSecret("");
      showToast("success", `${setup?.label ?? "The account"} is connected.`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }, [
    clientId,
    clientSecret,
    config?.connected,
    directory,
    passphrase,
    provider,
    setup?.label
  ]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await desktopCall("webdav.disconnectDrive", { provider });
      await webDavStore.get().refresh();
      showToast("success", "Disconnected.");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  }, [provider]);

  if (!setup) {
    return error ? <ErrorText error={error} /> : null;
  }

  return (
    <Flex sx={{ flexDirection: "column", gap: 1, flex: 1 }}>
      <Text variant="subBody" sx={{ fontWeight: "bold" }}>
        Register your own app with {setup.label}
      </Text>
      <Flex as="ol" sx={{ flexDirection: "column", gap: 1, pl: 3, m: 0 }}>
        {setup.registrationNotes.map((note) => (
          <Text as="li" key={note} variant="subBody">
            {note}
          </Text>
        ))}
        <Text as="li" variant="subBody">
          Scopes: <code>{setup.scopes.join(" ")}</code>. These reach only the
          files this app creates — the rest of your drive stays invisible.
        </Text>
      </Flex>

      <Field
        id="drive-client-id"
        label="Client ID"
        value={clientId}
        onChange={(e) => setClientId(e.target.value)}
      />
      {setup.requiresClientSecret && (
        <Field
          id="drive-client-secret"
          label="Client secret"
          type="password"
          helpText="Google issues one even for a desktop app and its token endpoint requires it. Google documents it as not confidential for installed apps."
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      )}
      <Field
        id="drive-directory"
        label="Folder name"
        helpText="Created by Openotes inside the space this app is allowed to see."
        value={directory}
        onChange={(e) => setDirectory(e.target.value)}
      />
      <Field
        id="drive-passphrase"
        label="Sync passphrase"
        type="password"
        helpText={
          config?.connected
            ? "Already set. Type a new one only to change it — every device must use the same."
            : "What encrypts your notes. It never leaves this machine, so the provider cannot read them and cannot recover them."
        }
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
      />

      {error && <ErrorText error={error} />}

      <Flex sx={{ gap: 1, alignItems: "center", mt: 1 }}>
        <Button variant="accent" onClick={connect} disabled={busy}>
          {config?.connected ? "Reconnect" : "Sign in"}
        </Button>
        {config?.connected && (
          <Button variant="errorSecondary" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        )}
        <WebDavStatusPill />
      </Flex>
    </Flex>
  );
}
