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

import React, { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { Button } from "./widgets.tsx";
import { usePalette } from "./theme.ts";

/**
 * One note, as Markdown. Saving is automatic and debounced, the way the
 * desktop editor saves; Back saves whatever is pending first.
 */
export function NoteScreen(props: {
  title: string;
  markdown: string;
  locked: boolean;
  onSave: (title: string, markdown: string) => void;
  onTrash: () => void;
  onBack: () => void;
}) {
  const palette = usePalette();
  const [title, setTitle] = useState(props.title);
  const [body, setBody] = useState(props.markdown);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (dirty.current) {
      dirty.current = false;
      props.onSave(title, body);
    }
  };

  useEffect(() => {
    if (!dirty.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body]);

  const edit = (setter: (value: string) => void) => (value: string) => {
    dirty.current = true;
    setter(value);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 12,
          gap: 8
        }}
      >
        <Button
          title="← Back"
          onPress={() => {
            flush();
            props.onBack();
          }}
        />
        {!props.locked ? <Button title="Trash" kind="danger" onPress={props.onTrash} /> : null}
      </View>
      {props.locked ? (
        <Text style={{ color: palette.muted, padding: 16 }}>
          This note is in the vault. It is encrypted with the vault password,
          which this phone does not have; open it on the desktop.
        </Text>
      ) : (
        <>
          <TextInput
            value={title}
            onChangeText={edit(setTitle)}
            placeholder="Title"
            placeholderTextColor={palette.muted}
            style={{
              color: palette.text,
              fontSize: 22,
              fontWeight: "700",
              paddingHorizontal: 16,
              paddingVertical: 8
            }}
          />
          <TextInput
            value={body}
            onChangeText={edit(setBody)}
            placeholder="Write in Markdown…"
            placeholderTextColor={palette.muted}
            multiline
            textAlignVertical="top"
            autoCapitalize="sentences"
            style={{
              flex: 1,
              color: palette.text,
              fontSize: 16,
              lineHeight: 24,
              paddingHorizontal: 16,
              paddingBottom: 24
            }}
          />
        </>
      )}
    </KeyboardAvoidingView>
  );
}
