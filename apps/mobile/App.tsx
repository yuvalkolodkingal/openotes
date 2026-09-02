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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, SafeAreaView, StatusBar, View } from "react-native";
import type { SyncEngine } from "../../packages/sync-webdav/src/engine.ts";
import type { SyncStatus } from "../../packages/sync-webdav/src/types.ts";
import { MobileDatabase, type NoteSummary } from "./src/database.ts";
import { headlineOf, toHtml, toMarkdown } from "./src/notes.ts";
import {
  type Connection,
  readConnection,
  readPassphrase,
  writeConnection,
  writePassphrase
} from "./src/secrets.ts";
import { buildEngine, testConnection } from "./src/sync.ts";
import { NoteScreen } from "./src/ui/NoteScreen.tsx";
import { NotesScreen } from "./src/ui/NotesScreen.tsx";
import { SetupScreen } from "./src/ui/SetupScreen.tsx";
import { SettingsScreen } from "./src/ui/SettingsScreen.tsx";
import { usePalette } from "./src/ui/theme.ts";

type Screen =
  | { name: "loading" }
  | { name: "setup" }
  | { name: "notes" }
  | { name: "note"; id: string }
  | { name: "settings" };

/**
 * The phone app. Three screens and a sync loop; everything that matters --
 * the journal protocol, the crypto, the conflict rules -- is the desktop's
 * code running here (see metro.config.js for how).
 */
export default function App() {
  const palette = usePalette();
  const database = useMemo(() => new MobileDatabase(), []);
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [connection, setConnection] = useState<Connection>();
  const [passphrase, setPassphrase] = useState<string>();
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [status, setStatus] = useState<SyncStatus>({ type: "disabled" });
  const engine = useRef<SyncEngine | undefined>(undefined);
  const syncing = useRef(false);
  const pendingSync = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  const refreshNotes = useCallback(() => {
    setNotes(database.listNotes());
  }, [database]);

  const sync = useCallback(async () => {
    if (!connection || !passphrase || syncing.current) return;
    syncing.current = true;
    try {
      engine.current ??= await buildEngine({
        connection,
        passphrase,
        database,
        onStatus: setStatus
      });
      await engine.current.sync("manual");
    } catch (problem) {
      setStatus({
        type: "error",
        error: problem instanceof Error ? problem.message : String(problem)
      });
    } finally {
      syncing.current = false;
      refreshNotes();
    }
  }, [connection, database, passphrase, refreshNotes]);

  /** Sync a little after the last edit, the way the desktop does. */
  const scheduleSync = useCallback(() => {
    if (pendingSync.current) clearTimeout(pendingSync.current);
    pendingSync.current = setTimeout(() => void sync(), 5000);
  }, [sync]);

  // Boot: read the keychain, then either set up or show the notes.
  useEffect(() => {
    (async () => {
      const [stored, secret] = await Promise.all([readConnection(), readPassphrase()]);
      if (stored && secret) {
        setConnection(stored);
        setPassphrase(secret);
        refreshNotes();
        setScreen({ name: "notes" });
      } else {
        setScreen({ name: "setup" });
      }
    })();
  }, [refreshNotes]);

  // First sync once connected, and again whenever the app comes back.
  useEffect(() => {
    if (!connection || !passphrase) return;
    void sync();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => subscription.remove();
  }, [connection, passphrase, sync]);

  const connect = useCallback(
    async (candidate: Connection, secret: string) => {
      await testConnection(candidate, secret, database);
      await writeConnection(candidate);
      await writePassphrase(secret);
      engine.current = undefined;
      setConnection(candidate);
      setPassphrase(secret);
      setScreen({ name: "notes" });
    },
    [database]
  );

  const disconnect = useCallback(() => {
    Alert.alert(
      "Disconnect this phone?",
      "The notes on this phone are removed. The database is left as it is.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            await writeConnection(undefined);
            await writePassphrase(undefined);
            database.clearAll();
            engine.current = undefined;
            setConnection(undefined);
            setPassphrase(undefined);
            setNotes([]);
            setStatus({ type: "disabled" });
            setScreen({ name: "setup" });
          }
        }
      ]
    );
  }, [database]);

  const openNote = (id: string) => setScreen({ name: "note", id });

  const newNote = () => {
    const id = database.saveNote({ title: "", html: "<p></p>", headline: "" });
    refreshNotes();
    openNote(id);
  };

  const saveNote = (id: string, title: string, markdown: string) => {
    const html = toHtml(markdown);
    database.saveNote({ id, title, html, headline: headlineOf(html) });
    refreshNotes();
    scheduleSync();
  };

  const trashNote = (id: string) => {
    Alert.alert("Move to trash?", "It can be restored on the desktop.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Trash",
        style: "destructive",
        onPress: () => {
          database.trashNote(id);
          refreshNotes();
          scheduleSync();
          setScreen({ name: "notes" });
        }
      }
    ]);
  };

  let body: React.ReactNode;
  switch (screen.name) {
    case "loading":
      body = (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={palette.accent} />
        </View>
      );
      break;
    case "setup":
      body = <SetupScreen onConnect={connect} />;
      break;
    case "notes":
      body = (
        <NotesScreen
          notes={notes}
          status={status}
          onOpen={openNote}
          onNew={newNote}
          onSync={() => void sync()}
          onSettings={() => setScreen({ name: "settings" })}
        />
      );
      break;
    case "note": {
      const note = database.getNote(screen.id);
      const content = database.contentFor(screen.id);
      body = (
        <NoteScreen
          key={screen.id}
          title={String(note?.title ?? "")}
          markdown={content && !content.locked ? toMarkdown(content.data) : ""}
          locked={content?.locked === true}
          onSave={(title, markdown) => saveNote(screen.id, title, markdown)}
          onTrash={() => trashNote(screen.id)}
          onBack={() => setScreen({ name: "notes" })}
        />
      );
      break;
    }
    case "settings":
      body = connection ? (
        <SettingsScreen
          connection={connection}
          status={status}
          noteCount={notes.length}
          onSync={() => void sync()}
          onDisconnect={disconnect}
          onBack={() => setScreen({ name: "notes" })}
        />
      ) : null;
      break;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }}>
      <StatusBar barStyle={palette.background === "#ffffff" ? "dark-content" : "light-content"} />
      {body}
    </SafeAreaView>
  );
}
