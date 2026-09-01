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
 * Builds the React user interface that the Deno host serves to the webview.
 *
 * The bundle itself is produced by Vite, and Vite is executed by Deno through
 * its npm compatibility layer — `apps/web/node_modules/vite/bin/vite.js` is a
 * plain Node program and Deno runs it directly. No separate Node installation
 * is required for that step (spec §6).
 *
 * The one part that still belongs to the npm toolchain is the monorepo
 * prebuild: `apps/web` depends on nine sibling packages through `file:`
 * specifiers, and those are compiled by the repository's own task runner
 * (`scripts/execute.ts`, which shells out to `npm run <task>` per package).
 * That is a build-time-only dependency, exactly as recorded in
 * PORTING_NOTES.md §11.1. When neither `node` nor `npm` is on PATH this
 * script installs Deno-backed shims for both so the prebuild still runs
 * without a system Node.
 *
 *   deno task build:ui                  build, reusing anything already built
 *   deno run -A .../build-ui.ts --force rebuild from scratch
 *   deno run -A .../build-ui.ts --check report what would be built, do nothing
 *
 * Output: `apps/desktop/ui/`, which is the first place
 * `apps/desktop/main.ts:resolveUiRoot()` looks after `OPENOTES_UI_ROOT`.
 */

import { fromFileUrl, join } from "@std/path";
import { copy, emptyDir, exists } from "@std/fs";

export const ROOT = fromFileUrl(new URL("../../../", import.meta.url));

/**
 * The repo's build scripts are TypeScript, which Node 22 runs directly. None
 * of those packages declare "type": "module", so Node parses each file as
 * CommonJS, fails, and re-parses as ESM -- printing a warning every time.
 * Suppressing that one code keeps the build output readable and leaves every
 * other warning intact.
 */
const WARNING_FLAG = "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON";
export const WEB_DIR = join(ROOT, "apps", "web");
export const WEB_BUILD_DIR = join(WEB_DIR, "build");
export const UI_DIR = join(ROOT, "apps", "desktop", "ui");

/** npm version used when npm has to be provided by Deno. Pinned (spec §43). */
const NPM_VERSION = "10.9.2";

const isWindows = Deno.build.os === "windows";

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Return the exit code instead of throwing on failure. */
  tolerant?: boolean;
}

export async function run(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<number> {
  console.log(`  $ ${command} ${args.join(" ")}`);
  const process = new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await process.output();
  if (code !== 0 && !options.tolerant) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
  return code;
}

export async function which(command: string): Promise<boolean> {
  try {
    const probe = new Deno.Command(isWindows ? "where" : "which", {
      args: [command],
      stdout: "null",
      stderr: "null",
    });
    return (await probe.output()).code === 0;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

/**
 * `node` and `npm`, backed by Deno when the machine has neither.
 *
 * `scripts/execute.ts` spawns `npm run <task>` for each package, and npm in
 * turn spawns `node`, so both names have to resolve. Deno can execute either:
 * a Node program is `deno run -A <file>`, and npm itself is an npm package.
 */
async function ensureNodeToolchain(): Promise<string | undefined> {
  const haveNode = await which("node");
  const haveNpm = await which("npm");
  if (haveNode && haveNpm) return undefined;

  const shimDir = join(ROOT, "apps", "desktop", ".node-shim");
  await Deno.mkdir(shimDir, { recursive: true });
  const denoPath = Deno.execPath();

  if (isWindows) {
    if (!haveNode) {
      await Deno.writeTextFile(
        join(shimDir, "node.cmd"),
        `@echo off\r\n"${denoPath}" run -A --node-modules-dir=manual %*\r\n`,
      );
    }
    if (!haveNpm) {
      await Deno.writeTextFile(
        join(shimDir, "npm.cmd"),
        `@echo off\r\n"${denoPath}" run -A npm:npm@${NPM_VERSION} %*\r\n`,
      );
    }
  } else {
    if (!haveNode) {
      const shim = join(shimDir, "node");
      await Deno.writeTextFile(
        shim,
        `#!/bin/sh\nexec "${denoPath}" run -A --node-modules-dir=manual "$@"\n`,
      );
      await Deno.chmod(shim, 0o755);
    }
    if (!haveNpm) {
      const shim = join(shimDir, "npm");
      await Deno.writeTextFile(
        shim,
        `#!/bin/sh\nexec "${denoPath}" run -A npm:npm@${NPM_VERSION} "$@"\n`,
      );
      await Deno.chmod(shim, 0o755);
    }
  }

  console.log(
    `  installed Deno-backed shims for ${
      [!haveNode && "node", !haveNpm && "npm"].filter(Boolean).join(" and ")
    } in ${shimDir}`,
  );
  return shimDir;
}

function withShim(shimDir: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  if (shimDir) {
    const separator = isWindows ? ";" : ":";
    env.PATH = `${shimDir}${separator}${Deno.env.get("PATH") ?? ""}`;
  }
  return env;
}

/** The `file:` workspace dependencies of apps/web, resolved to directories. */
export async function workspaceDependencies(): Promise<
  { name: string; directory: string }[]
> {
  const manifest = await readJson(join(WEB_DIR, "package.json"));
  const dependencies = {
    ...(manifest.dependencies as Record<string, string> | undefined),
    ...(manifest.devDependencies as Record<string, string> | undefined),
  };
  const resolved: { name: string; directory: string }[] = [];
  for (const [name, specifier] of Object.entries(dependencies ?? {})) {
    if (typeof specifier !== "string" || !specifier.startsWith("file:")) {
      continue;
    }
    resolved.push({
      name,
      directory: join(WEB_DIR, specifier.slice("file:".length)),
    });
  }
  return resolved;
}

/**
 * A workspace package counts as built when the entry points its package.json
 * advertises actually exist. That is exactly what Vite's resolver checks, and
 * it is what fails first on a fresh clone.
 */
async function isLibraryBuilt(directory: string): Promise<boolean> {
  let manifest: Record<string, unknown>;
  try {
    manifest = await readJson(join(directory, "package.json"));
  } catch {
    return false;
  }
  const entries = [manifest.main, manifest.module].filter(
    (entry): entry is string => typeof entry === "string",
  );
  // A package with no compiled entry (source-only, resolved through exports)
  // has nothing to build.
  if (entries.length === 0) return true;
  for (const entry of entries) {
    if (!(await exists(join(directory, entry)))) return false;
  }
  return true;
}

async function buildWorkspaceLibraries(force: boolean) {
  const dependencies = await workspaceDependencies();
  const unbuilt: { name: string; directory: string }[] = [];
  for (const dependency of dependencies) {
    if (force || !(await isLibraryBuilt(dependency.directory))) {
      unbuilt.push(dependency);
    }
  }

  if (unbuilt.length === 0) {
    console.log("Workspace libraries are already built.");
    return;
  }

  console.log(
    `Building ${unbuilt.length} workspace ${
      unbuilt.length === 1 ? "library" : "libraries"
    }: ${unbuilt.map((dependency) => dependency.name).join(", ")}`,
  );

  // After this call `node` and `npm` both resolve, either natively or through
  // the Deno-backed shims added to PATH.
  const shimDir = await ensureNodeToolchain();
  const env = withShim(shimDir);
  const executor = join(ROOT, "scripts", "execute.ts");

  for (const dependency of unbuilt) {
    // `scripts/execute.ts <package>:build` resolves that package's own
    // `file:` dependencies first, so the order here does not matter and
    // already-built packages are skipped through .taskcache.
    const shortName = dependency.name.replace(/^@[^/]+\//, "");
    await run("node", [WARNING_FLAG, executor, `${shortName}:build`], {
      cwd: ROOT,
      env,
    });
  }
}

const VITE_ENTRY = join(WEB_DIR, "node_modules", "vite", "bin", "vite.js");

/**
 * Installs the npm dependencies if they are not there yet.
 *
 * CONTRIBUTING.md promises that Deno and a C compiler are all a contributor
 * needs, so this has to be able to bootstrap the npm side itself rather than
 * telling the reader to go and run something. `scripts/bootstrap.ts` is the
 * repository's own installer — it understands the `file:` package layout and
 * the postinstall whitelist — and the root `npm ci` provides the packages
 * that script itself imports.
 */
async function ensureNpmDependencies(shimDir: string | undefined) {
  if (await exists(VITE_ENTRY)) return;

  console.log("Installing npm dependencies (first run)…");
  const env = withShim(shimDir);
  if (!(await exists(join(ROOT, "node_modules", "listr2")))) {
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: ROOT, env });
  }
  await run(
    "node",
    [WARNING_FLAG, join(ROOT, "scripts", "bootstrap.ts"), "--scope=web"],
    {
      cwd: ROOT,
      env,
    },
  );

  if (!(await exists(VITE_ENTRY))) {
    throw new Error(
      `Installed the workspace but Vite is still missing from ${VITE_ENTRY}.`,
    );
  }
}

/** Runs Vite through Deno, with the desktop code paths switched on. */
async function buildBundle() {
  const viteEntry = VITE_ENTRY;
  if (!(await exists(viteEntry))) {
    throw new Error(
      `Vite is not installed at ${viteEntry}. Run "npm ci" in the repository ` +
        `root (or "deno run -A npm:npm@${NPM_VERSION} ci") and try again.`,
    );
  }

  console.log("Building the web bundle (PLATFORM=desktop)…");
  await run(
    Deno.execPath(),
    ["run", "-A", "--node-modules-dir=manual", viteEntry, "build"],
    {
      cwd: WEB_DIR,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        // vite.config.ts branches on this: esnext target, no service worker,
        // and the /desktop-bridge + /sqlite aliases point at index.desktop.
        PLATFORM: "desktop",
        NODE_ENV: "production",
      },
    },
  );
}

async function publishToUiRoot() {
  const indexHtml = join(WEB_BUILD_DIR, "index.html");
  if (!(await exists(indexHtml))) {
    throw new Error(
      `Vite reported success but ${indexHtml} does not exist. Refusing to ` +
        `publish an empty user interface.`,
    );
  }
  console.log(`Publishing ${WEB_BUILD_DIR} -> ${UI_DIR}`);
  await emptyDir(UI_DIR);
  await copy(WEB_BUILD_DIR, UI_DIR, { overwrite: true });
}

/** Total size of the published UI, for the build log. */
async function directorySize(directory: string): Promise<number> {
  let total = 0;
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) total += await directorySize(path);
    else total += (await Deno.stat(path)).size;
  }
  return total;
}

export interface BuildUiOptions {
  force?: boolean;
  skipLibraries?: boolean;
}

/** Builds the UI and publishes it to apps/desktop/ui. */
export async function buildUi(options: BuildUiOptions = {}): Promise<string> {
  await ensureNpmDependencies(await ensureNodeToolchain());
  if (!options.skipLibraries) await buildWorkspaceLibraries(!!options.force);
  await buildBundle();
  await publishToUiRoot();
  const bytes = await directorySize(UI_DIR);
  console.log(
    `User interface ready: ${UI_DIR} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`,
  );
  return UI_DIR;
}

/** True when a usable UI is already published. */
export async function uiIsBuilt(): Promise<boolean> {
  return await exists(join(UI_DIR, "index.html"));
}

function usage() {
  console.log(
    `Usage: deno run -A apps/desktop/scripts/build-ui.ts [options]

  --force             rebuild the workspace libraries even if they look built
  --skip-libraries    go straight to Vite (libraries must already be built)
  --check             report whether a build is needed and exit
  -h, --help          show this message`,
  );
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  if (args.has("-h") || args.has("--help")) {
    usage();
  } else if (args.has("--check")) {
    const built = await uiIsBuilt();
    console.log(
      built
        ? `Built user interface present at ${UI_DIR}`
        : `No user interface at ${UI_DIR} — run "deno task build:ui"`,
    );
    Deno.exit(built ? 0 : 1);
  } else {
    await buildUi({
      force: args.has("--force"),
      skipLibraries: args.has("--skip-libraries"),
    });
  }
}
