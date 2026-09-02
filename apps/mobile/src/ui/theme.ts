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

import { useColorScheme } from "react-native";

export interface Palette {
  background: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  danger: string;
}

const LIGHT: Palette = {
  background: "#ffffff",
  surface: "#f5f5f7",
  border: "#e2e2e6",
  text: "#111114",
  muted: "#6b6b75",
  accent: "#008837",
  accentText: "#ffffff",
  danger: "#c0392b"
};

const DARK: Palette = {
  background: "#0f0f12",
  surface: "#1a1a1f",
  border: "#2a2a31",
  text: "#f1f1f4",
  muted: "#9a9aa5",
  accent: "#3fbf6b",
  accentText: "#0f0f12",
  danger: "#e06c5c"
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? DARK : LIGHT;
}
