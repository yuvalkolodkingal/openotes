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
 * So a stored copy of a *shipped* theme is replaced when it is an OLDER
 * copy of it: same id, lower version. Anything else is returned untouched.
 *
 * "Same id and same version" was the first rule, and it was too eager in
 * both directions. Nothing enforces the assumption underneath it — the
 * validator (packages/theme/src/theme-engine/validator.ts) is happy for any
 * theme to claim the id `default-dark`, so a downloaded theme that does,
 * with any version other than the exact one shipped, was silently thrown
 * away and replaced by ours on the next launch. Comparing versions in one
 * direction only fixes that: a theme claiming to be newer than ours is
 * left alone, and only a copy demonstrably older than what ships is
 * refreshed, which is the case this exists for.
 */

import { preferredTheme, ThemeDark, ThemeLight } from "@notesnook/theme";
import type { ThemeDefinition } from "@notesnook/theme";
import Config from "../utils/config";

export type ColorScheme = "light" | "dark";

export function shippedTheme(colorScheme: ColorScheme): ThemeDefinition {
  return colorScheme === "dark" ? ThemeDark : ThemeLight;
}

export function storedTheme(colorScheme: ColorScheme): ThemeDefinition {
  const shipped = shippedTheme(colorScheme);
  return preferredTheme(
    Config.get<ThemeDefinition>(`theme:${colorScheme}`, shipped),
    shipped
  );
}
