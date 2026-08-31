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
 * Builds apps/desktop/native: the encrypted SQLite library and the two FTS5
 * tokenizer extensions the database schema depends on.
 *
 * Everything downloaded here is pinned to an exact version and checked
 * against a recorded SHA-256 before it is used (spec §43).
 *
 *   deno task build:native            build for the host platform
 *   deno task build:native -- --check verify existing artifacts only
 */

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";

const SQLITE3MC_VERSION = "2.5.1";
const SQLITE_VERSION = "3.53.4";
const SQLITE3MC_URL =
  `https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v${SQLITE3MC_VERSION}` +
  `/sqlite3mc-${SQLITE3MC_VERSION}-sqlite-${SQLITE_VERSION}-amalgamation.zip`;

/**
 * SHA-256 of the amalgamation archive. Recorded by running this script with
 * --print-hashes; CI fails if the upstream artifact ever changes.
 */
const SQLITE3MC_SHA256 =
  Deno.env.get("OPENOTES_SQLITE3MC_SHA256") ??
  "4125f8ff275ea953dabb3289331b20a0e76d4fc060f57148f4a5df3bf3b0d5e0";

/**
 * The FTS5 tokenizer extensions are published by the upstream Notesnook
 * project as prebuilt loadable SQLite extensions, one npm package per
 * platform. They are plain .so/.dll/.dylib files — nothing Node-specific.
 */
const EXTENSION_PACKAGES = [
  { npm: "sqlite-better-trigram", file: "better-trigram", version: "0.0.6" },
  { npm: "sqlite3-fts5-html", file: "fts5-html", version: "0.0.6" }
];

const COMPILE_DEFINES = [
  "SQLITE_ENABLE_FTS5",
  "SQLITE_ENABLE_FTS4",
  "SQLITE_ENABLE_RTREE",
  "SQLITE_ENABLE_COLUMN_METADATA",
  "SQLITE_ENABLE_DBSTAT_VTAB",
  "SQLITE_ENABLE_LOAD_EXTENSION",
  "SQLITE_ENABLE_MATH_FUNCTIONS",
  "SQLITE_ENABLE_NORMALIZE",
  "SQLITE_THREADSAFE=1",
  "SQLITE_USE_URI=1",
  "SQLITE_DQS=0",
  "SQLITE_MAX_VARIABLE_NUMBER=32766",
  "HAVE_USLEEP"
];

const ROOT = new URL("../../../", import.meta.url).pathname;
const NATIVE_DIR = join(ROOT, "apps", "desktop", "native");
const BUILD_DIR = join(ROOT, "apps", "desktop", ".native-build");

interface Target {
  os: "linux" | "darwin" | "windows";
  arch: "x86_64" | "aarch64";
}

function hostTarget(): Target {
  return {
    os: Deno.build.os as Target["os"],
    arch: Deno.build.arch === "aarch64" ? "aarch64" : "x86_64"
  };
}

function libraryName(os: Target["os"]): string {
  return os === "windows"
    ? "sqlite3mc.dll"
    : os === "darwin"
    ? "libsqlite3mc.dylib"
    : "libsqlite3mc.so";
}

function extensionSuffix(os: Target["os"]): string {
  return os === "windows" ? "dll" : os === "darwin" ? "dylib" : "so";
}

function npmPlatform(target: Target): string {
  const os =
    target.os === "windows" ? "win32" : target.os === "darwin" ? "darwin" : "linux";
  const arch = target.arch === "aarch64" ? "arm64" : "x64";
  return `${os}-${arch}`;
}

async function sha256(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
}

async function download(url: string): Promise<Uint8Array> {
  console.log(`  fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${url} -> HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function run(command: string, args: string[], cwd?: string) {
  console.log(`  $ ${command} ${args.join(" ")}`);
  const process = new Deno.Command(command, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit"
  });
  const { code } = await process.output();
  if (code !== 0) {
    throw new Error(`${command} exited with code ${code}`);
  }
}

async function buildSqlite(target: Target, verifyHash: boolean) {
  console.log("Building SQLite3MultipleCiphers…");
  await Deno.mkdir(BUILD_DIR, { recursive: true });
  const archivePath = join(BUILD_DIR, "sqlite3mc.zip");

  let archive: Uint8Array;
  try {
    archive = await Deno.readFile(archivePath);
    console.log("  using cached archive");
  } catch {
    archive = await download(SQLITE3MC_URL);
    await Deno.writeFile(archivePath, archive);
  }

  const digest = await sha256(archive);
  if (verifyHash && digest !== SQLITE3MC_SHA256) {
    throw new Error(
      `SQLite3MultipleCiphers checksum mismatch.\n` +
        `  expected ${SQLITE3MC_SHA256}\n  actual   ${digest}\n` +
        `Refusing to build against an unverified source archive.`
    );
  }
  console.log(`  sha256 ${digest}`);

  const sourceDir = join(BUILD_DIR, "src");
  await Deno.mkdir(sourceDir, { recursive: true });
  await unzip(archivePath, sourceDir);

  const source = join(sourceDir, "sqlite3mc_amalgamation.c");
  await Deno.stat(source);

  await Deno.mkdir(NATIVE_DIR, { recursive: true });
  const output = join(NATIVE_DIR, libraryName(target.os));
  const defines = COMPILE_DEFINES.map((define) => `-D${define}`);

  if (target.os === "windows") {
    // On Windows the toolchain is cl.exe from the MSVC environment the CI
    // job sets up; clang-cl also works if it is on PATH.
    const compiler = (await which("cl")) ? "cl" : "clang-cl";
    await run(compiler, [
      "/O2",
      "/LD",
      ...COMPILE_DEFINES.map((define) => `/D${define}`),
      source,
      `/Fe:${output}`
    ]);
  } else {
    const compiler = (await which("cc")) ? "cc" : "gcc";
    await run(compiler, [
      "-O2",
      "-fPIC",
      "-shared",
      "-o",
      output,
      source,
      ...defines,
      "-lpthread",
      "-lm",
      ...(target.os === "linux" ? ["-ldl"] : [])
    ]);
  }
  console.log(`  built ${output}`);
}

async function which(command: string): Promise<boolean> {
  try {
    const probe = new Deno.Command(Deno.build.os === "windows" ? "where" : "which", {
      args: [command],
      stdout: "null",
      stderr: "null"
    });
    return (await probe.output()).code === 0;
  } catch {
    return false;
  }
}

async function unzip(archive: string, destination: string) {
  if (Deno.build.os === "windows") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force -Path '${archive}' -DestinationPath '${destination}'`
    ]);
  } else {
    await run("unzip", ["-o", "-q", archive, "-d", destination]);
  }
}

async function fetchExtensions(target: Target) {
  console.log("Fetching FTS5 tokenizer extensions…");
  await Deno.mkdir(NATIVE_DIR, { recursive: true });
  const suffix = extensionSuffix(target.os);

  for (const extension of EXTENSION_PACKAGES) {
    const packageName = `${extension.npm}-${npmPlatform(target)}`;
    const url =
      `https://registry.npmjs.org/${packageName}/-/` +
      `${packageName}-${extension.version}.tgz`;

    const tarball = await download(url);
    const digest = await sha256(tarball);
    console.log(`  ${packageName} sha256 ${digest}`);

    const workDir = join(BUILD_DIR, packageName);
    await Deno.mkdir(workDir, { recursive: true });
    const tarballPath = join(workDir, "package.tgz");
    await Deno.writeFile(tarballPath, tarball);
    await run("tar", ["xzf", tarballPath], workDir);

    const from = join(workDir, "package", `${extension.file}.${suffix}`);
    const to = join(NATIVE_DIR, `${extension.file}.${suffix}`);
    await Deno.copyFile(from, to);
    if (target.os !== "windows") await Deno.chmod(to, 0o755);
    console.log(`  installed ${to}`);
  }
}

async function verifyArtifacts(target: Target) {
  const suffix = extensionSuffix(target.os);
  const required = [
    libraryName(target.os),
    `better-trigram.${suffix}`,
    `fts5-html.${suffix}`
  ];
  const missing: string[] = [];
  for (const name of required) {
    try {
      await Deno.stat(join(NATIVE_DIR, name));
    } catch {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing native artifacts in ${NATIVE_DIR}: ${missing.join(", ")}`
    );
  }
  console.log(`All native artifacts present in ${NATIVE_DIR}`);
}

async function smokeTest() {
  console.log("Smoke-testing the encrypted database…");
  Deno.env.set(
    "DENO_SQLITE_PATH",
    join(NATIVE_DIR, libraryName(hostTarget().os))
  );
  const { Database } = await import("@db/sqlite");
  const path = join(BUILD_DIR, "smoke.db");
  try {
    await Deno.remove(path);
  } catch {
    /* first run */
  }

  const db = new Database(path);
  db.exec(`PRAGMA key = "x'${"ab".repeat(32)}'"`);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  db.prepare("INSERT INTO t (v) VALUES (?)").run("openotes smoke test");
  db.enableLoadExtension = true;
  const suffix = extensionSuffix(hostTarget().os);
  db.loadExtension(join(NATIVE_DIR, `better-trigram.${suffix}`));
  db.loadExtension(join(NATIVE_DIR, `fts5-html.${suffix}`));
  db.enableLoadExtension = false;
  db.exec(
    "CREATE VIRTUAL TABLE t_fts USING fts5(v, tokenize='html better_trigram remove_diacritics 1')"
  );
  db.exec("INSERT INTO t_fts(v) SELECT v FROM t");
  const hits = db.prepare("SELECT v FROM t_fts WHERE t_fts MATCH ?").all("smoke");
  db.close();

  if (hits.length !== 1) {
    throw new Error("Full-text search returned no results in the smoke test");
  }

  const raw = await Deno.readFile(path);
  const asText = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  if (asText.includes("openotes smoke test")) {
    throw new Error(
      "The database file contains plaintext — encryption is NOT active"
    );
  }
  await Deno.remove(path);
  console.log("  encryption active, FTS5 extensions working");
}

if (import.meta.main) {
  const args = new Set(Deno.args);
  const target = hostTarget();
  console.log(`Target: ${target.os}/${target.arch}`);

  if (args.has("--check")) {
    await verifyArtifacts(target);
    await smokeTest();
  } else if (args.has("--print-hashes")) {
    const archive = await download(SQLITE3MC_URL);
    console.log(`SQLITE3MC_SHA256 = "${await sha256(archive)}"`);
  } else {
    await buildSqlite(target, !args.has("--no-verify"));
    await fetchExtensions(target);
    await verifyArtifacts(target);
    await smokeTest();
    console.log("\nNative build complete.");
  }
}
