/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

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

import { join, normalize, resolve, isAbsolute } from "@std/path";
import { APP_ID, APP_NAME } from "../constants.ts";

/**
 * Application directories, and the path validation every renderer-supplied
 * path must pass. The renderer can name a file, but it can never reach
 * outside the directories the user has actually chosen.
 */

function homeDir(): string {
  const home =
    Deno.env.get("HOME") ??
    Deno.env.get("USERPROFILE") ??
    (Deno.build.os === "windows" ? "C:\\Users\\Default" : "/tmp");
  return home;
}

/** Per-OS application data directory. Portable mode overrides it. */
export function appDataDir(): string {
  const override = Deno.env.get("OPENOTES_DATA_DIR");
  if (override) return resolve(override);

  if (isPortable()) {
    return join(dirname(Deno.execPath()), "data");
  }

  switch (Deno.build.os) {
    case "windows": {
      const appData = Deno.env.get("APPDATA") ?? join(homeDir(), "AppData", "Roaming");
      return join(appData, APP_NAME);
    }
    case "darwin":
      return join(homeDir(), "Library", "Application Support", APP_NAME);
    default: {
      const xdg = Deno.env.get("XDG_DATA_HOME") ?? join(homeDir(), ".local", "share");
      return join(xdg, APP_ID);
    }
  }
}

export function configDir(): string {
  if (Deno.build.os === "linux") {
    const xdg = Deno.env.get("XDG_CONFIG_HOME") ?? join(homeDir(), ".config");
    return join(xdg, APP_ID);
  }
  return appDataDir();
}

export function cacheDir(): string {
  if (Deno.build.os === "linux") {
    const xdg = Deno.env.get("XDG_CACHE_HOME") ?? join(homeDir(), ".cache");
    return join(xdg, APP_ID);
  }
  return join(appDataDir(), "cache");
}

export function logDir(): string {
  return join(cacheDir(), "logs");
}

export function attachmentsDir(): string {
  return join(appDataDir(), "attachments");
}

export function databasePath(profile = "default"): string {
  return join(appDataDir(), "profiles", sanitizeSegment(profile), "notesnook.db");
}

export function defaultBackupDir(): string {
  return join(documentsDir(), APP_NAME, "backups");
}

export function documentsDir(): string {
  const xdgDocuments = Deno.env.get("XDG_DOCUMENTS_DIR");
  if (xdgDocuments) return xdgDocuments;
  return join(homeDir(), "Documents");
}

/** True when running from an AppImage. */
export function isAppImage(): boolean {
  return !!Deno.env.get("APPIMAGE");
}

export function isFlatpak(): boolean {
  return !!Deno.env.get("FLATPAK_ID");
}

export function isSnap(): boolean {
  return !!Deno.env.get("SNAP");
}

/** Portable Windows/Linux builds keep their data next to the executable. */
export function isPortable(): boolean {
  return Deno.env.get("OPENOTES_PORTABLE") === "1";
}

export function dirname(path: string): string {
  const normalized = normalize(path);
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\")
  );
  return index <= 0 ? normalized : normalized.slice(0, index);
}

/** Strip anything that could traverse or confuse a filesystem. */
export function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return "_";
  return cleaned.slice(0, 128);
}

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathAccessError";
  }
}

/**
 * Resolve `candidate` and assert it stays inside one of `allowedRoots`.
 *
 * Every path that arrives from the renderer goes through this. Symlinks are
 * resolved when the target exists so a link cannot be used to step outside
 * an allowed root.
 */
export function assertInside(
  candidate: string,
  allowedRoots: string[],
  what = "path"
): string {
  if (!candidate || typeof candidate !== "string") {
    throw new PathAccessError(`Invalid ${what}`);
  }
  if (candidate.includes("\0")) {
    throw new PathAccessError(`Invalid ${what}: contains a null byte`);
  }

  const resolved = realPathIfExists(
    isAbsolute(candidate) ? resolve(candidate) : resolve(allowedRoots[0], candidate)
  );

  for (const root of allowedRoots) {
    const resolvedRoot = realPathIfExists(resolve(root));
    if (resolved === resolvedRoot || resolved.startsWith(withSep(resolvedRoot))) {
      return resolved;
    }
  }
  throw new PathAccessError(
    `Access denied: ${what} is outside the directories this app may use`
  );
}

function withSep(path: string): string {
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  return path.endsWith(sep) ? path : path + sep;
}

function realPathIfExists(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    // The path (or its parent) may not exist yet — resolve the deepest
    // existing ancestor so a symlinked parent still cannot escape.
    const parent = dirname(path);
    if (parent === path) return path;
    try {
      const realParent = Deno.realPathSync(parent);
      return join(realParent, path.slice(parent.length + 1));
    } catch {
      return path;
    }
  }
}

export async function ensureDir(path: string): Promise<string> {
  await Deno.mkdir(path, { recursive: true });
  return path;
}

export function ensureDirSync(path: string): string {
  Deno.mkdirSync(path, { recursive: true });
  return path;
}
