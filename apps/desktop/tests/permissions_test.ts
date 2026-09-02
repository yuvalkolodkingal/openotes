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

import { assert } from "@std/assert";
import { join } from "@std/path";
import { readPermissionManifest } from "./manifest.ts";

/**
 * Does the manifest actually cover what the code does?
 *
 * This exists because it did not, and nothing noticed. Two separate features
 * shipped reading things the manifest does not grant:
 *
 *  - `which()` reads PATH, which was never listed. Under the manifest that
 *    throws NotCapable, and finding an agent fails outright.
 *  - system-theme detection runs `gsettings`, `defaults` and `reg`, none of
 *    which were listed, so every probe failed and a dark desktop got a light
 *    window.
 *
 * Neither showed up in development, because `deno task dev` runs with -A.
 * A test is the only thing that reads the manifest the way the shipped
 * application would.
 */

const ROOT = new URL("../../../", import.meta.url).pathname;

/** Application code — not build scripts, which legitimately run with -A. */
const SCANNED = [
  "apps/desktop/main.ts",
  "apps/desktop/src",
  "packages/acp/src",
  "packages/sync-core/src",
  "packages/sync-files/src",
  "packages/sync-webdav/src",
];

async function* sourceFiles(path: string): AsyncGenerator<string> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch {
    return;
  }
  if (info.isFile) {
    if (path.endsWith(".ts") && !path.endsWith(".d.ts")) yield path;
    return;
  }
  for await (const entry of Deno.readDir(path)) {
    yield* sourceFiles(join(path, entry.name));
  }
}

/**
 * Literal arguments to a call, e.g. `Deno.env.get("PATH")` -> "PATH".
 *
 * Only literals: a variable cannot be checked statically, and the places that
 * pass one (the agent launcher) are covered by their own allowlist test.
 */
function literalArguments(source: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
}

/**
 * Commands spawned through a local wrapper rather than directly.
 *
 * Without this the check has a hole shaped exactly like the bug it exists to
 * catch: `detectSystemTheme` does not call `new Deno.Command("gsettings")`, it
 * calls a local `probe(command, args)` helper, so the command name is a
 * parameter and no literal appears at the spawn site. One level of
 * indirection is resolved here -- find functions that spawn whatever their
 * first parameter is, then read the literals passed to those functions.
 */
function wrappedSpawns(source: string): Set<string> {
  const found = new Set<string>();

  // `function probe(command: string, ...)` whose body spawns `command`.
  const declaration =
    /function\s+(\w+)\s*\(\s*(\w+)\s*:[^)]*\)[^{]*\{/g;
  const wrappers = new Set<string>();
  for (const match of source.matchAll(declaration)) {
    const [, name, parameter] = match;
    const body = source.slice(match.index ?? 0);
    const end = body.indexOf("\n}");
    const scope = end === -1 ? body : body.slice(0, end);
    if (new RegExp(`new Deno\\.Command\\(\\s*${parameter}\\b`).test(scope)) {
      wrappers.add(name);
    }
  }

  for (const name of wrappers) {
    const call = new RegExp(`\\b${name}\\(\\s*"([^"]+)"`, "g");
    for (const match of source.matchAll(call)) found.add(match[1]);
  }
  return found;
}

Deno.test("every environment variable the application reads is granted", async () => {
  const manifest = await readPermissionManifest();
  const granted = new Set(manifest.env);
  const missing: string[] = [];

  for (const dir of SCANNED) {
    for await (const file of sourceFiles(join(ROOT, dir))) {
      const source = await Deno.readTextFile(file);
      const read = literalArguments(
        source,
        /Deno\.env\.get\(\s*"([^"]+)"\s*\)/g,
      );
      for (const name of read) {
        if (!granted.has(name)) {
          missing.push(`${file.replace(ROOT, "")} reads ${name}`);
        }
      }
    }
  }

  assert(
    missing.length === 0,
    `deno.json permissions.app.env does not grant:\n  ${
      missing.join("\n  ")
    }\nReading an ungranted variable throws NotCapable at runtime.`,
  );
});

Deno.test("every program the application runs is permitted", async () => {
  const manifest = await readPermissionManifest();
  const allowed = new Set(manifest.run);
  const missing: string[] = [];

  for (const dir of SCANNED) {
    for await (const file of sourceFiles(join(ROOT, dir))) {
      const source = await Deno.readTextFile(file);
      const spawned = literalArguments(
        source,
        /new Deno\.Command\(\s*"([^"]+)"/g,
      );
      for (const command of wrappedSpawns(source)) spawned.add(command);
      for (const command of spawned) {
        if (!allowed.has(command)) {
          missing.push(`${file.replace(ROOT, "")} runs ${command}`);
        }
      }
    }
  }

  assert(
    missing.length === 0,
    `deno.json permissions.app.run does not allow:\n  ${
      missing.join("\n  ")
    }`,
  );
});
