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
 * Reading back the applied theme, without freezing it at install time.
 *
 * Applying a theme stores the whole ThemeDefinition — every colour of every
 * scope — under `theme:light` / `theme:dark`, and start-up reads that back.
 * That is right for a theme the user chose, and wrong for the two shipped
 * with the app: an installation that has ever set a colour scheme would keep
 * whatever the defaults looked like on the day it was installed, so shipping
 * a fix to the default dark theme would reach nobody.
 *
 * So a stored copy of a *shipped* theme is only used while its version
 * matches the shipped one. Anything else — a downloaded theme, a theme the
 * user edited — has a different id and is returned untouched.
 */

import { ThemeDark, ThemeLight } from "@notesnook/theme";
import type { ThemeDefinition } from "@notesnook/theme";
import Config from "../utils/config";

export type ColorScheme = "light" | "dark";

export function shippedTheme(colorScheme: ColorScheme): ThemeDefinition {
  return colorScheme === "dark" ? ThemeDark : ThemeLight;
}

export function storedTheme(colorScheme: ColorScheme): ThemeDefinition {
  const shipped = shippedTheme(colorScheme);
  const stored = Config.get<ThemeDefinition>(`theme:${colorScheme}`, shipped);
  if (!stored || stored.id !== shipped.id) return stored ?? shipped;
  return stored.version === shipped.version ? stored : shipped;
}
