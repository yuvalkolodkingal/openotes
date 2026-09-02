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
import { Pressable, Text, TextInput, View } from "react-native";
import { usePalette } from "./theme.ts";

export function Button(props: {
  title: string;
  onPress: () => void;
  kind?: "accent" | "secondary" | "danger";
  disabled?: boolean;
}) {
  const palette = usePalette();
  const kind = props.kind ?? "secondary";
  const background =
    kind === "accent" ? palette.accent : kind === "danger" ? palette.danger : palette.surface;
  const color = kind === "secondary" ? palette.text : palette.accentText;
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({ pressed }) => ({
        backgroundColor: background,
        opacity: props.disabled ? 0.5 : pressed ? 0.8 : 1,
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 8,
        borderWidth: kind === "secondary" ? 1 : 0,
        borderColor: palette.border,
        alignItems: "center"
      })}
    >
      <Text style={{ color, fontWeight: "600" }}>{props.title}</Text>
    </Pressable>
  );
}

export function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secure?: boolean;
  hint?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const palette = usePalette();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: palette.muted, fontSize: 13 }}>{props.label}</Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChange}
        secureTextEntry={props.secure}
        placeholder={props.placeholder}
        placeholderTextColor={palette.muted}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={props.multiline}
        style={{
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: 8,
          padding: 10,
          color: palette.text,
          backgroundColor: palette.surface,
          minHeight: props.multiline ? 80 : undefined
        }}
      />
      {props.hint ? (
        <Text style={{ color: palette.muted, fontSize: 12 }}>{props.hint}</Text>
      ) : null}
    </View>
  );
}

export function Paragraph(props: { children: React.ReactNode; muted?: boolean }) {
  const palette = usePalette();
  return (
    <Text style={{ color: props.muted ? palette.muted : palette.text, lineHeight: 20 }}>
      {props.children}
    </Text>
  );
}

export function ErrorText(props: { error?: string }) {
  const palette = usePalette();
  if (!props.error) return null;
  return <Text style={{ color: palette.danger }}>{props.error}</Text>;
}
