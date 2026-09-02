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

/**
 * Reading the permission manifest out of deno.json.
 *
 * Shared because more than one test asks the same question of it, and because
 * `JSON.parse` is the wrong tool: Deno accepts JSONC here, and the permission
 * lists carry comments explaining why individual entries exist -- which is
 * exactly where that explanation belongs.
 */

export interface PermissionManifest {
  env: string[];
  run: string[];
}

/** Strip // and /* *\/ comments without disturbing anything inside a string. */
export function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      // A backslash escapes the next character, including a quote.
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

export async function readPermissionManifest(): Promise<PermissionManifest> {
  const source = await Deno.readTextFile(
    new URL("../../../deno.json", import.meta.url),
  );
  const parsed = JSON.parse(stripJsonComments(source)) as {
    permissions?: { app?: Partial<PermissionManifest> };
  };
  const app = parsed.permissions?.app ?? {};
  return { env: app.env ?? [], run: app.run ?? [] };
}
