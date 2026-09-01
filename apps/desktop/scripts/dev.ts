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
 * `deno task dev` — run the application from source.
 *
 * There is no "run" mode for `deno desktop`: the window comes from the
 * runtime, and the runtime arrives with a compiled app. So the loop is
 * compile-and-launch rather than watch-and-reload, into a cache directory
 * rather than dist/ so a development build never masquerades as a release.
 *
 * The interface is built first unless it is already there and newer than
 * its sources, because a stale ui/ is the confusing failure: the app comes
 * up, and it is yesterday's app.
 */

import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const UI_DIR = join(ROOT, "apps", "desktop", "ui");
const OUT_DIR = join(ROOT, ".dev", "openotes");

async function run(command: string, args: string[]): Promise<number> {
  const child = new Deno.Command(command, {
    args,
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }).spawn();
  return (await child.status).code;
}

async function newestMtime(directory: string): Promise<number> {
  let newest = 0;
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name === "node_modules" || entry.name === "build") continue;
    const path = join(directory, entry.name);
    const info = await Deno.stat(path);
    if (info.isDirectory) {
      newest = Math.max(newest, await newestMtime(path));
    } else {
      newest = Math.max(newest, info.mtime?.getTime() ?? 0);
    }
  }
  return newest;
}

async function interfaceIsStale(): Promise<boolean> {
  try {
    const built = (await Deno.stat(join(UI_DIR, "index.html"))).mtime
      ?.getTime();
    if (!built) return true;
    return (await newestMtime(join(ROOT, "apps", "web", "src"))) > built;
  } catch {
    return true;
  }
}

const args = Deno.args;
const skipUi = args.includes("--no-ui");

if (!skipUi && await interfaceIsStale()) {
  console.log("Building the interface (pass --no-ui to skip)...");
  const code = await run(Deno.execPath(), [
    "run",
    "-A",
    join("apps", "desktop", "scripts", "build-ui.ts"),
  ]);
  if (code !== 0) Deno.exit(code);
}

try {
  await Deno.stat(join(ROOT, "apps", "desktop", "native", "libsqlite3mc.so"));
} catch {
  // Not fatal on every platform, but the app refuses to open a vault
  // without it, and "run deno task build:native" is a better message than
  // the one the app would print.
  console.log(
    "The encrypted SQLite library is not built. Run: deno task build:native",
  );
}

console.log("Compiling the application...");
await Deno.mkdir(dirname(OUT_DIR), { recursive: true });
const compiled = await run(Deno.execPath(), [
  "desktop",
  "-A",
  "--node-modules-dir=none",
  "--exclude-unused-npm",
  "--include",
  join("apps", "desktop", "ui"),
  "--include",
  join("apps", "desktop", "native"),
  "--output",
  OUT_DIR,
  join("apps", "desktop", "main.ts"),
]);
if (compiled !== 0) Deno.exit(compiled);

console.log(`Launching ${OUT_DIR}\n`);
Deno.exit(
  await run(join(OUT_DIR, "openotes"), args.filter((a) => a !== "--no-ui")),
);
