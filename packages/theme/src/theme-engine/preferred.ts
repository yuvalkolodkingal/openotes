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
 * Which theme to use at start-up: the one this installation stored, or the
 * one that ships with the app.
 *
 * Applying a theme persists the whole definition — every colour of every
 * scope — and start-up reads that back. That is right for a theme the user
 * chose, and wrong for the two shipped with the app: an installation that
 * has ever set a colour scheme would keep whatever the defaults looked like
 * on the day it was installed, so a fix to the default dark theme would
 * reach nobody.
 *
 * So an older copy of a shipped theme is replaced by the shipped one. Only
 * an older copy: nothing reserves the id `default-dark` — `validateTheme`
 * is happy for any theme to claim it — so treating "not exactly our
 * version" as "stale copy of ours" would silently throw away a theme
 * someone installed, on every launch.
 *
 * Kept dependency-free, and separate from utils.ts, so it can be tested
 * directly rather than through a bundler.
 */

/** The two fields the decision actually turns on. */
export interface VersionedTheme {
  id: string;
  version: number;
}

export function preferredTheme<T extends VersionedTheme>(
  stored: T | undefined,
  shipped: T
): T {
  if (!stored) return shipped;
  if (stored.id !== shipped.id) return stored;
  // A version that is not a number says nothing about which is older, so
  // keep what is stored rather than overwrite on a guess.
  if (typeof stored.version !== "number") return stored;
  if (typeof shipped.version !== "number") return stored;
  return stored.version < shipped.version ? shipped : stored;
}
