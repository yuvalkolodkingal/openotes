/*
This file is part of the Notesnook project (https://notesnook.com/)

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

import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Connection } from "../secrets.ts";
import { Button, ErrorText, Field, Paragraph } from "./widgets.tsx";
import { usePalette } from "./theme.ts";

/**
 * Connecting the phone to the database the desktop syncs to.
 *
 * There is no account to make. The desktop's Settings → Synchronization
 * shows what to paste: for Neon the connection string, for Supabase the
 * project URL and service key. The passphrase is the same one the desktop
 * uses -- it is what decrypts the notes, and it never leaves the phone.
 */
export function SetupScreen(props: {
  onConnect: (connection: Connection, passphrase: string) => Promise<void>;
}) {
  const palette = usePalette();
  const [provider, setProvider] = useState<"neon" | "supabase">("neon");
  const [connectionString, setConnectionString] = useState("");
  const [projectUrl, setProjectUrl] = useState("");
  const [serviceKey, setServiceKey] = useState("");
  const [directory, setDirectory] = useState("Openotes");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const connect = async () => {
    setError(undefined);
    setBusy(true);
    try {
      if (!passphrase) throw new Error("Enter the sync passphrase you use on the desktop.");
      const connection: Connection =
        provider === "neon"
          ? {
              provider,
              connectionString: connectionString.trim(),
              directory: directory.trim() || "Openotes"
            }
          : {
              provider,
              projectUrl: projectUrl.trim().replace(/\/+$/, ""),
              serviceKey: serviceKey.trim(),
              directory: directory.trim() || "Openotes"
            };
      if (connection.provider === "neon" && !connection.connectionString) {
        throw new Error("Paste the Neon connection string.");
      }
      if (
        connection.provider === "supabase" &&
        (!connection.projectUrl || !connection.serviceKey)
      ) {
        throw new Error("Paste the Supabase project URL and its service key.");
      }
      await props.onConnect(connection, passphrase);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={{ padding: 20, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: palette.text, fontSize: 24, fontWeight: "700" }}>
        Openotes
      </Text>
      <Paragraph>
        Your notes sync through a database you own. Connect this phone to the
        same Neon or Supabase project as your desktop; there is no account and
        nothing here talks to anyone else.
      </Paragraph>

      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button
            title="Neon"
            kind={provider === "neon" ? "accent" : "secondary"}
            onPress={() => setProvider("neon")}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title="Supabase"
            kind={provider === "supabase" ? "accent" : "secondary"}
            onPress={() => setProvider("supabase")}
          />
        </View>
      </View>

      {provider === "neon" ? (
        <Field
          label="Connection string"
          value={connectionString}
          onChange={setConnectionString}
          secure
          placeholder="postgresql://…@….neon.tech/neondb"
          hint="Neon console → Connect → copy the connection string. The phone talks to Neon over HTTPS."
        />
      ) : (
        <>
          <Field
            label="Project URL"
            value={projectUrl}
            onChange={setProjectUrl}
            placeholder="https://xxxxxxxxxxxxxxxxxxxx.supabase.co"
            hint="Project settings → API."
          />
          <Field
            label="Service key"
            value={serviceKey}
            onChange={setServiceKey}
            secure
            hint="The service_role (or a secret) key from Project settings → API keys. The anon key cannot reach the notes table."
          />
        </>
      )}
      <Field
        label="Repository name"
        value={directory}
        onChange={setDirectory}
        hint="The same as on the desktop. Openotes unless you changed it."
      />
      <Field
        label="Sync passphrase"
        value={passphrase}
        onChange={setPassphrase}
        secure
        hint="The same passphrase as on the desktop. It decrypts the notes here and is stored in this phone's keychain."
      />
      <ErrorText error={error} />
      <Button
        title={busy ? "Checking…" : "Connect"}
        kind="accent"
        onPress={connect}
        disabled={busy}
      />
    </ScrollView>
  );
}
