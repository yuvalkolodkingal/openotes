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

import React, { useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import type { NoteSummary } from "../database.ts";
import type { SyncStatus } from "../../../../packages/sync-webdav/src/types.ts";
import { formatDate } from "../notes.ts";
import { Button } from "./widgets.tsx";
import { usePalette } from "./theme.ts";

export function describeStatus(status: SyncStatus): string {
  switch (status.type) {
    case "synced":
      return `Synced ${formatDate(status.at)}`;
    case "syncing":
      return "Syncing…";
    case "offline":
      return "Offline — changes wait here";
    case "pending":
      return `${status.count} change${status.count === 1 ? "" : "s"} waiting`;
    case "error":
      return `Sync failed: ${status.error}`;
    case "conflict":
      return `${status.count} conflict${status.count === 1 ? "" : "s"} kept as copies`;
    default:
      return "Not connected";
  }
}

export function NotesScreen(props: {
  notes: NoteSummary[];
  status: SyncStatus;
  onOpen: (id: string) => void;
  onNew: () => void;
  onSync: () => void;
  onSettings: () => void;
}) {
  const palette = usePalette();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return props.notes;
    return props.notes.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        note.headline.toLowerCase().includes(needle)
    );
  }, [props.notes, query]);

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 16,
          paddingVertical: 10,
          gap: 8
        }}
      >
        <Text style={{ color: palette.text, fontSize: 22, fontWeight: "700" }}>
          Notes
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button title="Sync" onPress={props.onSync} />
          <Button title="Settings" onPress={props.onSettings} />
        </View>
      </View>
      <Pressable onPress={props.onSync} style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Text style={{ color: props.status.type === "error" ? palette.danger : palette.muted, fontSize: 12 }}>
          {describeStatus(props.status)}
        </Text>
      </Pressable>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search"
        placeholderTextColor={palette.muted}
        style={{
          marginHorizontal: 16,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: 8,
          padding: 10,
          color: palette.text,
          backgroundColor: palette.surface
        }}
      />
      <FlatList
        data={shown}
        keyExtractor={(note) => note.id}
        ListEmptyComponent={
          <Text style={{ color: palette.muted, padding: 16 }}>
            {props.notes.length === 0
              ? "No notes yet. Sync to pull the desktop's, or write one."
              : "Nothing matches."}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => props.onOpen(item.id)}
            style={({ pressed }) => ({
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: palette.border,
              backgroundColor: pressed ? palette.surface : palette.background
            })}
          >
            <Text style={{ color: palette.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1}>
              {item.pinned ? "📌 " : ""}
              {item.favorite ? "★ " : ""}
              {item.title || "Untitled"}
            </Text>
            <Text style={{ color: palette.muted, fontSize: 13 }} numberOfLines={2}>
              {item.locked ? "Locked note — open it on the desktop." : item.headline || " "}
            </Text>
            <Text style={{ color: palette.muted, fontSize: 11, marginTop: 2 }}>
              {formatDate(item.dateEdited)}
            </Text>
          </Pressable>
        )}
      />
      <View style={{ position: "absolute", right: 16, bottom: 24 }}>
        <Button title="+ New note" kind="accent" onPress={props.onNew} />
      </View>
    </View>
  );
}
