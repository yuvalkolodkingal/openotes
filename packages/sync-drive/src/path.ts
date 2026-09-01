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
 * Taking a RemoteStore path apart, the same way in all three adapters.
 *
 * The store interface speaks one path language — slash-separated, relative
 * to the store root, no leading slash, directories written with a trailing
 * one — and each provider speaks its own: Drive walks a chain of folder ids
 * by name, Graph builds `/root:/a/b:`, Dropbox wants `/a/b`. Every adapter
 * therefore splits, takes a parent, or takes a name, and each of those is
 * an opportunity to disagree about "a/b/" versus "a/b".
 *
 * Every helper here runs the path through sync-remote's `assertSafePath`
 * first, so a ".." that some later refactor lets through the engine is
 * rejected in all three adapters at once rather than escaping the sync
 * folder in whichever one forgot to check.
 */

import { assertSafePath } from "@notesnook/sync-remote";

/**
 * The non-empty segments of a path. A trailing slash contributes nothing,
 * so "a/b" and "a/b/" split identically — the distinction between a file
 * and a directory is the caller's, not the path's.
 */
export function splitPath(path: string): string[] {
  assertSafePath(path);
  return path.split("/").filter((segment) => segment.length > 0);
}

/** True for the store's directory spelling. The root ("") is not one. */
export function isDirectoryPath(path: string): boolean {
  return path.endsWith("/");
}

/**
 * Everything above the last segment, without a trailing slash; "" when the
 * path sits at the store root. Pass it through `directoryPath` before
 * handing it to `makeDirectory`.
 */
export function parentPath(path: string): string {
  return splitPath(path).slice(0, -1).join("/");
}

/** The last segment: the file or folder name. "" for the root itself. */
export function baseName(path: string): string {
  const segments = splitPath(path);
  return segments.length === 0 ? "" : segments[segments.length - 1];
}

/**
 * The directory spelling of a path: exactly one trailing slash, no leading
 * one, no empty segments. The root stays "" rather than becoming "/",
 * because a leading slash is what `assertSafePath` rejects.
 */
export function directoryPath(path: string): string {
  const segments = splitPath(path);
  return segments.length === 0 ? "" : `${segments.join("/")}/`;
}

/**
 * Clean up the repository directory the user typed in Settings: "/Openotes",
 * "Openotes/", "Apps//Openotes" and " Openotes " all become "Openotes" (or
 * "Apps/Openotes"). Returns "" for a directory that names the account root.
 *
 * The trimming happens before the safety check so that a leading slash —
 * which is how most people write a folder path, and which `assertSafePath`
 * refuses — is corrected rather than thrown at the user, while ".." still
 * is not.
 */
export function normalizeDirectory(directory: string): string {
  const cleaned = directory
    .trim()
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
  assertSafePath(cleaned);
  return cleaned;
}

/**
 * Percent-encode each segment for use inside a request URL, leaving the
 * separators alone. `encodeURIComponent` escapes "/" itself, so encoding a
 * whole path in one call turns "a/b" into a single filename — which is how
 * a device journal ends up as one oddly named file at the root.
 */
export function encodePath(path: string): string {
  return splitPath(path).map(encodeURIComponent).join("/");
}
