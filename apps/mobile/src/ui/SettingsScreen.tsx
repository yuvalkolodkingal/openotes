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

import React from "react";
import { ScrollView, Text, View } from "react-native";
import type { Connection } from "../secrets.ts";
import type { SyncStatus } from "../../../../packages/sync-webdav/src/types.ts";
import { APP_VERSION } from "../sync.ts";
import { describeStatus } from "./NotesScreen.tsx";
import { Button, Paragraph } from "./widgets.tsx";
import { usePalette } from "./theme.ts";

function describeConnection(connection: Connection): string {
  if (connection.provider === "neon") {
    try {
      const url = new URL(connection.connectionString);
      return `Neon — ${url.hostname}${url.pathname}`;
    } catch {
      return "Neon";
    }
  }
  return `Supabase — ${connection.projectUrl}`;
}

export function SettingsScreen(props: {
  connection: Connection;
  status: SyncStatus;
  noteCount: number;
  onSync: () => void;
  onDisconnect: () => void;
  onBack: () => void;
}) {
  const palette = usePalette();
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: palette.text, fontSize: 22, fontWeight: "700" }}>Settings</Text>
        <Button title="← Back" onPress={props.onBack} />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ color: palette.muted, fontSize: 13 }}>Connected to</Text>
        <Paragraph>{describeConnection(props.connection)}</Paragraph>
        <Paragraph muted>Repository “{props.connection.directory}”</Paragraph>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ color: palette.muted, fontSize: 13 }}>Sync</Text>
        <Paragraph>{describeStatus(props.status)}</Paragraph>
        <Paragraph muted>
          {props.noteCount} note{props.noteCount === 1 ? "" : "s"} on this phone.
          Attachments are not synced to phones.
        </Paragraph>
        <Button title="Sync now" onPress={props.onSync} />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={{ color: palette.muted, fontSize: 13 }}>Disconnect</Text>
        <Paragraph muted>
          Forgets the connection and the passphrase and removes every note from
          this phone. The database is left untouched.
        </Paragraph>
        <Button title="Disconnect and wipe this phone" kind="danger" onPress={props.onDisconnect} />
      </View>
      <Paragraph muted>Openotes mobile {APP_VERSION}</Paragraph>
    </ScrollView>
  );
}
