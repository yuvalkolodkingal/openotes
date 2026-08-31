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
 * The one build entry point for Openotes.
 *
 *   deno task build                                  host target, every format
 *   deno run -A .../build.ts --target <triple>
 *   deno run -A .../build.ts --format appimage,deb
 *   deno run -A .../build.ts --all                   every buildable target
 *
 * -------------------------------------------------------------------------
 * WHY THE BUILD LOOKS THE WAY IT DOES
 *
 * `deno desktop` emits an *application directory* — a small launcher plus a
 * large `<name>.so` / `<name>.dll` payload — and can wrap that directory into
 * an .AppImage, .deb, .rpm or .msi. It cannot put anything else into that
 * directory: `--include`d files are embedded in the payload's virtual file
 * system, reachable only through paths under the module's own virtual root.
 *
 * Openotes needs two real directories next to the executable:
 *
 *   ui/      served to the webview  (apps/desktop/main.ts:51-71)
 *   native/  SQLite3MultipleCiphers + the two FTS5 tokenizer extensions
 *            (apps/desktop/src/native/sqlite.ts:63-80)
 *
 * `native/` in particular cannot live in the virtual file system at all:
 * `sqlite3_load_extension` is a C call into SQLite that takes a path on the
 * real filesystem.
 *
 * So this script compiles the application directory, copies `ui/` and
 * `native/` into it, and then produces each format from that prepared
 * directory. Where Deno Desktop has a native packager (.AppImage, .deb, .rpm)
 * its output is used as the base and the two directories are injected into
 * it — the AppImage keeps Deno's own runtime and AppRun, the .deb keeps
 * Deno's control metadata and /usr/bin symlink, the .rpm keeps Deno's file
 * layout. Where it has none (.exe, .zip, .tar.gz) or where its output cannot
 * be reopened (.msi), the package is assembled from the prepared directory
 * with the standard tool for that format.
 *
 * The `--include` flags are still passed, so the compiled payload carries a
 * copy of the interface and the libraries even if a downstream packager
 * strips the sibling directories.
 * -------------------------------------------------------------------------
 *
 * The Linux tarball layout is a contract with `packaging/` — see
 * packaging/README.md. Both the flatpak manifest and the Arch PKGBUILD
 * unpack it, so its inner directory name, its file names and the fact that
 * the binary is never stripped are all load-bearing.
 */

import { basename, fromFileUrl, join } from "@std/path";
import { copy, emptyDir, ensureDir, exists } from "@std/fs";
import { encodeHex } from "@std/encoding/hex";
import {
  APP_ID,
  APP_IDENTIFIER,
  APP_NAME,
  APP_VERSION,
  RELEASE_BASE_URL
} from "../src/constants.ts";
import { buildUi, uiIsBuilt, UI_DIR } from "./build-ui.ts";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const DESKTOP_DIR = join(ROOT, "apps", "desktop");
const ENTRY_POINT = join(DESKTOP_DIR, "main.ts");
const NATIVE_DIR = join(DESKTOP_DIR, "native");
const ICONS_DIR = join(DESKTOP_DIR, "assets", "icons");
const PACKAGING_DIR = join(ROOT, "packaging");
const DEFAULT_OUTPUT = join(ROOT, "dist");
const WORK_DIR = join(DESKTOP_DIR, ".build");

/** Icon sizes shipped in the Linux tarball; the PKGBUILD installs all eight. */
const ICON_SIZES = [
  "16x16",
  "24x24",
  "32x32",
  "48x48",
  "64x64",
  "128x128",
  "256x256",
  "512x512"
];

export type TargetOs = "linux" | "windows";
export type TargetArch = "x86_64" | "aarch64";

export interface Target {
  triple: string;
  os: TargetOs;
  arch: TargetArch;
}

/**
 * Openotes is a Linux + Windows desktop application. Deno Desktop can also
 * target macOS, but nothing in this fork is built, signed or tested for it,
 * so those triples are deliberately not offered here.
 */
export const TARGETS: Record<string, Target> = {
  "x86_64-unknown-linux-gnu": {
    triple: "x86_64-unknown-linux-gnu",
    os: "linux",
    arch: "x86_64"
  },
  "aarch64-unknown-linux-gnu": {
    triple: "aarch64-unknown-linux-gnu",
    os: "linux",
    arch: "aarch64"
  },
  "x86_64-pc-windows-msvc": {
    triple: "x86_64-pc-windows-msvc",
    os: "windows",
    arch: "x86_64"
  },
  "aarch64-pc-windows-msvc": {
    triple: "aarch64-pc-windows-msvc",
    os: "windows",
    arch: "aarch64"
  }
};

export type Format =
  | "dir"
  | "tar.gz"
  | "zip"
  | "appimage"
  | "deb"
  | "rpm"
  | "msi"
  | "exe";

export const LINUX_FORMATS: Format[] = [
  "dir",
  "tar.gz",
  "appimage",
  "deb",
  "rpm"
];
export const WINDOWS_FORMATS: Format[] = ["dir", "zip", "msi", "exe"];

export function formatsFor(target: Target): Format[] {
  return target.os === "windows" ? WINDOWS_FORMATS : LINUX_FORMATS;
}

export function hostTriple(): string {
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  if (Deno.build.os === "windows") return `${arch}-pc-windows-msvc`;
  if (Deno.build.os === "linux") return `${arch}-unknown-linux-gnu`;
  throw new Error(
    `Openotes does not build on ${Deno.build.os}; use Linux or Windows.`
  );
}

/** The three native artifacts the app refuses to start without. */
export function nativeArtifacts(os: TargetOs): string[] {
  return os === "windows"
    ? ["sqlite3mc.dll", "better-trigram.dll", "fts5-html.dll"]
    : ["libsqlite3mc.so", "better-trigram.so", "fts5-html.so"];
}

/** `Openotes-1.0.0-linux-x86_64.AppImage` and friends (spec §2). */
export function artifactName(
  target: Target,
  format: Format,
  version: string
): string {
  const base = `${APP_NAME}-${version}-${target.os}-${target.arch}`;
  switch (format) {
    case "dir":
      return base;
    case "tar.gz":
      return `${base}.tar.gz`;
    case "zip":
      return `${base}.zip`;
    case "appimage":
      return `${base}.AppImage`;
    case "deb":
      return `${base}.deb`;
    case "rpm":
      return `${base}.rpm`;
    case "msi":
      return `${base}.msi`;
    case "exe":
      return `${base}.exe`;
  }
}

/**
 * The directory *inside* the archives. Lowercase, because
 * packaging/arch/PKGBUILD resolves it as `${pkgname}-${pkgver}-linux-x86_64`.
 */
export function payloadDirName(target: Target, version: string): string {
  return `${APP_ID}-${version}-${target.os}-${target.arch}`;
}

/** The launcher's file name, which also names its payload library. */
function binaryBaseName(target: Target): string {
  // Linux packages call the command `openotes` (packaging/linux/openotes.desktop
  // has `Exec=openotes`), Windows convention is the capitalised product name.
  return target.os === "windows" ? APP_NAME : APP_ID;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {}
): Promise<void> {
  if (!options.quiet) console.log(`  $ ${command} ${args.join(" ")}`);
  const { code } = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdout: "inherit",
    stderr: "inherit"
  }).output();
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${code}`);
  }
}

async function capture(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<RunResult> {
  const output = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    stdout: "piped",
    stderr: "piped"
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr)
  };
}

async function which(command: string): Promise<boolean> {
  try {
    const probe = new Deno.Command(
      Deno.build.os === "windows" ? "where" : "which",
      { args: [command], stdout: "null", stderr: "null" }
    );
    return (await probe.output()).code === 0;
  } catch {
    return false;
  }
}

async function requireTool(command: string, why: string) {
  if (await which(command)) return;
  throw new Error(
    `"${command}" is not on PATH and is required to ${why}.\n` +
      `Install it (Debian/Ubuntu: apt-get install ${toolPackage(command)}) ` +
      `or drop this format from --format.`
  );
}

function toolPackage(command: string): string {
  switch (command) {
    case "mksquashfs":
      return "squashfs-tools";
    case "rpmbuild":
      return "rpm";
    case "dpkg-deb":
      return "dpkg";
    case "makensis":
      return "nsis";
    case "wixl":
      return "wixl";
    case "cpio":
      return "cpio";
    default:
      return command;
  }
}

// ---------------------------------------------------------------------------
// native libraries and the user interface
// ---------------------------------------------------------------------------

/**
 * Makes sure `apps/desktop/native` holds the three libraries for `target`.
 *
 * `build-native.ts` compiles SQLite3MultipleCiphers with the host toolchain,
 * so it can only produce artifacts for the host operating system. A Windows
 * build therefore needs the `.dll`s handed to it — in CI they come from the
 * Windows job as an artifact (see .github/workflows/build.yml).
 */
async function ensureNative(target: Target, nativeDir: string, skip: boolean) {
  const required = nativeArtifacts(target.os);
  const missing: string[] = [];
  for (const name of required) {
    if (!(await exists(join(nativeDir, name)))) missing.push(name);
  }

  if (missing.length === 0) {
    console.log(`Native libraries present for ${target.os} in ${nativeDir}`);
    return;
  }
  if (skip) {
    throw new Error(
      `--skip-native was passed but ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } missing from ${nativeDir}.`
    );
  }
  if (target.os !== Deno.build.os) {
    throw new Error(
      `Missing ${missing.join(", ")} in ${nativeDir}.\n` +
        `They have to be built on ${target.os} — apps/desktop/scripts/` +
        `build-native.ts compiles with the host toolchain — and then placed ` +
        `here with --native-dir. CI does this by passing the Windows job's ` +
        `artifact to the Linux packaging job.`
    );
  }

  console.log(`Building native libraries (${missing.join(", ")} missing)…`);
  await run(Deno.execPath(), [
    "run",
    "-A",
    join(DESKTOP_DIR, "scripts", "build-native.ts")
  ], { cwd: ROOT });

  for (const name of required) {
    if (!(await exists(join(nativeDir, name)))) {
      throw new Error(
        `build-native.ts finished but ${name} is still missing from ${nativeDir}`
      );
    }
  }
}

async function ensureUi(skip: boolean, force: boolean) {
  if (await uiIsBuilt()) {
    if (!force) {
      console.log(`User interface present at ${UI_DIR}`);
      return;
    }
  } else if (skip) {
    throw new Error(
      `--skip-ui was passed but there is no built interface at ${UI_DIR}. ` +
        `Run "deno task build:ui" first.`
    );
  }
  if (skip) return;
  await buildUi({ force });
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

function iconFor(target: Target): string {
  return target.os === "windows"
    ? join(ICONS_DIR, "app.ico")
    : join(ICONS_DIR, "512x512.png");
}

interface CompileOptions {
  target: Target;
  /** Full output path; the extension decides what Deno Desktop produces. */
  output: string;
  nativeStage: string;
}

async function denoDesktop({ target, output, nativeStage }: CompileOptions) {
  await ensureDir(join(output, ".."));
  await run(Deno.execPath(), [
    "desktop",
    "-A",
    // Managed npm, and only the packages the module graph actually reaches.
    // Without these two the compiler embeds every local node_modules tree it
    // can see — 437 MB of build-time-only npm packages for a graph that needs
    // two — because `nodeModulesDir: "auto"` in deno.json makes them part of
    // the workspace. Measured on this repository: 445 MB payload without,
    // 85 MB with.
    "--node-modules-dir=none",
    "--exclude-unused-npm",
    "--target",
    target.triple,
    "--icon",
    iconFor(target),
    // Embedded copies of both resource trees. They are not how the running
    // app finds them (see the header comment) but they keep the payload
    // self-describing and survive any packager that drops sibling files.
    "--include",
    UI_DIR,
    "--include",
    nativeStage,
    "--output",
    output,
    ENTRY_POINT
  ], { cwd: ROOT });
}

// ---------------------------------------------------------------------------
// the prepared payload directory
// ---------------------------------------------------------------------------

interface Prepared {
  /** `<work>/payload/<openotes-1.0.0-linux-x86_64>` */
  directory: string;
  /** Its parent, for `tar -C`. */
  parent: string;
  /** Name of the launcher inside it. */
  binary: string;
}

/**
 * Compiles the application directory and fills it out into the layout that
 * packaging/README.md documents.
 */
async function preparePayload(
  target: Target,
  version: string,
  nativeStage: string
): Promise<Prepared> {
  const base = binaryBaseName(target);
  const appParent = join(WORK_DIR, target.triple, "app");
  await emptyDir(appParent);
  console.log(`\nCompiling the application directory for ${target.triple}…`);
  await denoDesktop({ target, output: join(appParent, base), nativeStage });

  const appDir = join(appParent, base);
  const payloadParent = join(WORK_DIR, target.triple, "payload");
  const payloadDir = join(payloadParent, payloadDirName(target, version));
  await emptyDir(payloadParent);
  await copy(appDir, payloadDir);

  await addResources(payloadDir, target, nativeStage);

  const binary = target.os === "windows" ? `${base}.exe` : base;
  if (!(await exists(join(payloadDir, binary)))) {
    throw new Error(
      `deno desktop did not produce ${binary} in ${payloadDir}. ` +
        `Contents: ${
          (await Array.fromAsync(Deno.readDir(payloadDir)))
            .map((entry) => entry.name)
            .join(", ")
        }`
    );
  }
  return { directory: payloadDir, parent: payloadParent, binary };
}

/** `ui/`, `native/`, icons, desktop entry, man page, licences. */
async function addResources(
  destination: string,
  target: Target,
  nativeStage: string
) {
  const overwrite = { overwrite: true };
  await copy(UI_DIR, join(destination, "ui"), overwrite);
  await copy(nativeStage, join(destination, "native"), overwrite);

  await copy(join(ROOT, "LICENSE"), join(destination, "LICENSE"), overwrite);
  if (await exists(join(ROOT, "UPSTREAM.md"))) {
    await copy(
      join(ROOT, "UPSTREAM.md"),
      join(destination, "UPSTREAM.md"),
      overwrite
    );
  }

  if (target.os === "linux") {
    const icons = join(destination, "icons");
    await ensureDir(icons);
    for (const size of ICON_SIZES) {
      await copy(
        join(ICONS_DIR, `${size}.png`),
        join(icons, `${size}.png`),
        overwrite
      );
    }
    const desktopEntry = join(PACKAGING_DIR, "linux", `${APP_ID}.desktop`);
    const manPage = join(PACKAGING_DIR, "linux", `${APP_ID}.1`);
    if (await exists(desktopEntry)) {
      await copy(desktopEntry, join(destination, `${APP_ID}.desktop`), overwrite);
    }
    if (await exists(manPage)) {
      await copy(manPage, join(destination, `${APP_ID}.1`), overwrite);
    }
  }
  // Windows needs no extra icon copy: deno desktop already drops the --icon
  // file into the application directory as AppIcon.ico.
}

/** Copies only the artifacts belonging to `target` into a staging directory. */
async function stageNative(target: Target, source: string): Promise<string> {
  const stage = join(WORK_DIR, target.triple, "native");
  await emptyDir(stage);
  for (const name of nativeArtifacts(target.os)) {
    await copy(join(source, name), join(stage, name));
  }
  return stage;
}

// ---------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------

async function produceDir(prepared: Prepared, output: string) {
  await emptyDir(output);
  for await (const entry of Deno.readDir(prepared.directory)) {
    await copy(
      join(prepared.directory, entry.name),
      join(output, entry.name),
      { overwrite: true }
    );
  }
  console.log(`  -> ${output}`);
}

async function produceTarGz(prepared: Prepared, output: string) {
  await requireTool("tar", "create the Linux tarball");
  const inner = basename(prepared.directory);
  const args = ["-czf", output, "-C", prepared.parent];
  // Reproducible ownership. Only GNU tar understands these; the Windows and
  // macOS bsdtar does not, and does not need to since this is a Linux format.
  if (Deno.build.os === "linux") args.push("--owner=0", "--group=0");
  args.push(inner);
  await run("tar", args);
  console.log(`  -> ${output}`);
}

async function produceZip(prepared: Prepared, output: string) {
  const inner = basename(prepared.directory);
  if (await which("zip")) {
    await run("zip", ["-r", "-q", "-9", output, inner], {
      cwd: prepared.parent
    });
  } else if (Deno.build.os === "windows") {
    await run("powershell", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Force -Path '${
        join(prepared.parent, inner)
      }' -DestinationPath '${output}'`
    ]);
  } else {
    throw new Error(
      `Neither "zip" nor PowerShell is available to build ${output}.`
    );
  }
  console.log(`  -> ${output}`);
}

/**
 * AppImage.
 *
 * Deno Desktop builds one; it just cannot contain `ui/` or `native/`. So the
 * squashfs image is unpacked, the two directories are added, the image is
 * rebuilt with the compression and block size the original used, and Deno's
 * own AppImage runtime — the bytes before the squashfs superblock — is put
 * back in front of it.
 */
async function produceAppImage(
  target: Target,
  nativeStage: string,
  output: string
) {
  await requireTool("mksquashfs", "repack the AppImage");
  const work = join(WORK_DIR, target.triple, "appimage");
  await emptyDir(work);
  const staged = join(work, `${APP_ID}.AppImage`);

  console.log("\nBuilding the AppImage with deno desktop…");
  await denoDesktop({ target, output: staged, nativeStage });
  await Deno.chmod(staged, 0o755);

  const offsetResult = await capture(staged, ["--appimage-offset"]);
  if (offsetResult.code !== 0) {
    throw new Error(
      `Could not read the AppImage payload offset: ${offsetResult.stderr.trim()}`
    );
  }
  const offset = Number.parseInt(offsetResult.stdout.trim(), 10);
  if (!Number.isInteger(offset) || offset <= 0) {
    throw new Error(`Nonsensical AppImage offset: ${offsetResult.stdout}`);
  }

  const { compressor, blockSize } = await readSquashfsSuperblock(staged, offset);
  console.log(
    `  runtime is ${offset} bytes; squashfs uses ${compressor} with ` +
      `${blockSize}-byte blocks`
  );

  const extracted = join(work, "squashfs-root");
  await emptyDir(extracted);
  await run(staged, ["--appimage-extract"], { cwd: work });

  // addResources overwrites the generated `openotes.desktop` (which says
  // `Name=openotes`) with packaging/linux/openotes.desktop, which says
  // `Name=Openotes`, claims the openotes:// scheme and sets the WM class.
  await addResources(extracted, target, nativeStage);

  const image = join(work, "payload.squashfs");
  await run("mksquashfs", [
    extracted,
    image,
    "-root-owned",
    "-noappend",
    "-no-progress",
    "-comp",
    compressor,
    "-b",
    String(blockSize)
  ]);

  const runtime = (await Deno.readFile(staged)).subarray(0, offset);
  const squashfs = await Deno.readFile(image);
  const combined = new Uint8Array(runtime.length + squashfs.length);
  combined.set(runtime, 0);
  combined.set(squashfs, runtime.length);
  await Deno.writeFile(output, combined);
  await Deno.chmod(output, 0o755);
  console.log(`  -> ${output}`);
}

const SQUASHFS_COMPRESSORS: Record<number, string> = {
  1: "gzip",
  2: "lzma",
  3: "lzo",
  4: "xz",
  5: "lz4",
  6: "zstd"
};

async function readSquashfsSuperblock(
  path: string,
  offset: number
): Promise<{ compressor: string; blockSize: number }> {
  using file = await Deno.open(path, { read: true });
  await file.seek(offset, Deno.SeekMode.Start);
  const header = new Uint8Array(24);
  let read = 0;
  while (read < header.length) {
    const chunk = await file.read(header.subarray(read));
    if (chunk === null) break;
    read += chunk;
  }
  const view = new DataView(header.buffer);
  const magic = String.fromCharCode(...header.subarray(0, 4));
  if (magic !== "hsqs") {
    throw new Error(
      `No squashfs image at offset ${offset} of ${path} (magic "${magic}")`
    );
  }
  const blockSize = view.getUint32(12, true);
  const compressorId = view.getUint16(20, true);
  const compressor = SQUASHFS_COMPRESSORS[compressorId];
  if (!compressor) {
    throw new Error(`Unknown squashfs compressor id ${compressorId}`);
  }
  return { compressor, blockSize };
}

/**
 * .deb — Deno Desktop's package, unpacked, filled out and rebuilt.
 *
 * Deno's control file carries a generic maintainer, description and licence,
 * so those fields are rewritten to Openotes'. The dependency list it computes
 * is kept and WebKitGTK is added: the window is an OS webview, and on Linux
 * that is libwebkit2gtk, which the launcher dlopens at startup.
 */
async function produceDeb(
  target: Target,
  prepared: Prepared,
  nativeStage: string,
  version: string,
  output: string
) {
  await requireTool("dpkg-deb", "build the .deb");
  const work = join(WORK_DIR, target.triple, "deb");
  await emptyDir(work);
  const staged = join(work, `${APP_ID}.deb`);

  console.log("\nBuilding the .deb with deno desktop…");
  await denoDesktop({ target, output: staged, nativeStage });

  const tree = join(work, "tree");
  await run("dpkg-deb", ["-R", staged, tree]);

  const libDir = join(tree, "usr", "lib", APP_ID);
  if (!(await exists(libDir))) {
    throw new Error(
      `Expected deno desktop's .deb to install into /usr/lib/${APP_ID}; it did not.`
    );
  }
  await addResources(libDir, target, nativeStage);
  await installSharedLinuxFiles(tree, prepared);
  await rewriteDebianControl(join(tree, "DEBIAN", "control"), version, target);

  await run("dpkg-deb", ["--build", "--root-owner-group", tree, output]);
  console.log(`  -> ${output}`);
}

/** Man page, licences and the eight icon sizes, shared by .deb and .rpm. */
async function installSharedLinuxFiles(tree: string, prepared: Prepared) {
  const manDir = join(tree, "usr", "share", "man", "man1");
  const manPage = join(prepared.directory, `${APP_ID}.1`);
  if (await exists(manPage)) {
    await ensureDir(manDir);
    await copy(manPage, join(manDir, `${APP_ID}.1`), { overwrite: true });
  }

  const docDir = join(tree, "usr", "share", "doc", APP_ID);
  await ensureDir(docDir);
  await copy(join(ROOT, "LICENSE"), join(docDir, "copyright"), {
    overwrite: true
  });
  if (await exists(join(ROOT, "UPSTREAM.md"))) {
    await copy(join(ROOT, "UPSTREAM.md"), join(docDir, "UPSTREAM.md"), {
      overwrite: true
    });
  }

  for (const size of ICON_SIZES) {
    const target = join(
      tree,
      "usr",
      "share",
      "icons",
      "hicolor",
      size,
      "apps",
      `${APP_ID}.png`
    );
    await ensureDir(join(target, ".."));
    await copy(join(ICONS_DIR, `${size}.png`), target, { overwrite: true });
  }

  const applications = join(tree, "usr", "share", "applications");
  const sharedEntry = join(PACKAGING_DIR, "linux", `${APP_ID}.desktop`);
  if (await exists(sharedEntry)) {
    await ensureDir(applications);
    await copy(sharedEntry, join(applications, `${APP_ID}.desktop`), {
      overwrite: true
    });
  }
}

async function rewriteDebianControl(
  path: string,
  version: string,
  target: Target
) {
  const original = await Deno.readTextFile(path);
  const fields = new Map<string, string>();
  let lastKey = "";
  for (const line of original.split("\n")) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && lastKey) {
      fields.set(lastKey, `${fields.get(lastKey)}\n${line}`);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    lastKey = line.slice(0, separator);
    fields.set(lastKey, line.slice(separator + 1).trim());
  }

  const existingDepends = (fields.get("Depends") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const depends = new Set(existingDepends);
  // The webview itself. Alternatives so the package installs on releases that
  // still ship the libsoup2 build of WebKitGTK.
  depends.add("libwebkit2gtk-4.1-0 | libwebkit2gtk-4.0-37");
  depends.add("libgtk-3-0");

  fields.set("Package", APP_ID);
  fields.set("Version", version);
  fields.set("Architecture", target.arch === "aarch64" ? "arm64" : "amd64");
  fields.set("Maintainer", `Openotes contributors <${RELEASE_BASE_URL}>`);
  fields.set("Homepage", RELEASE_BASE_URL);
  fields.set("Section", "utils");
  fields.set("Priority", "optional");
  fields.set("Depends", [...depends].join(", "));
  fields.set(
    "Description",
    `Offline-first, end-to-end-encrypted notes with WebDAV sync\n` +
      ` ${APP_NAME} is a desktop fork of Notesnook with no account, no\n` +
      ` subscription and no cloud service. Notes are stored locally in an\n` +
      ` encrypted SQLite database and synchronised through any WebDAV server.`
  );

  const order = [
    "Package",
    "Version",
    "Architecture",
    "Maintainer",
    "Installed-Size",
    "Depends",
    "Section",
    "Priority",
    "Homepage",
    "Description"
  ];
  const lines: string[] = [];
  for (const key of order) {
    const value = fields.get(key);
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  for (const [key, value] of fields) {
    if (!order.includes(key)) lines.push(`${key}: ${value}`);
  }
  await Deno.writeTextFile(path, `${lines.join("\n")}\n`);
}

/**
 * .rpm — Deno Desktop's package, unpacked and rebuilt with `rpmbuild`.
 *
 * An RPM cannot be edited in place the way an ar archive can, so the payload
 * is extracted, the two directories are added, and a spec is generated over
 * the resulting tree. Every RPM post-install brp script is disabled: the
 * default set strips ELF binaries, and stripping a `deno desktop` launcher
 * discards the payload appended after its sections.
 */
async function produceRpm(
  target: Target,
  prepared: Prepared,
  nativeStage: string,
  version: string,
  output: string
) {
  await requireTool("rpmbuild", "build the .rpm");
  await requireTool("cpio", "unpack deno desktop's .rpm");
  const work = join(WORK_DIR, target.triple, "rpm");
  await emptyDir(work);
  const staged = join(work, `${APP_ID}.rpm`);

  console.log("\nBuilding the .rpm with deno desktop…");
  await denoDesktop({ target, output: staged, nativeStage });

  const tree = join(work, "tree");
  await ensureDir(tree);
  await run("sh", [
    "-c",
    `rpm2cpio "${staged}" | cpio -idm --quiet --no-absolute-filenames`
  ], { cwd: tree });

  const libDir = join(tree, "usr", "lib", APP_ID);
  if (!(await exists(libDir))) {
    throw new Error(
      `Expected deno desktop's .rpm to install into /usr/lib/${APP_ID}; it did not.`
    );
  }
  await addResources(libDir, target, nativeStage);
  await installSharedLinuxFiles(tree, prepared);

  const topDir = join(work, "rpmbuild");
  for (const sub of ["BUILD", "RPMS", "SOURCES", "SPECS", "BUILDROOT"]) {
    await ensureDir(join(topDir, sub));
  }
  const specPath = join(topDir, "SPECS", `${APP_ID}.spec`);
  await Deno.writeTextFile(
    specPath,
    await renderRpmSpec(tree, version, target)
  );

  await run("rpmbuild", [
    "-bb",
    "--define",
    `_topdir ${topDir}`,
    "--define",
    `_openotes_tree ${tree}`,
    "--target",
    target.arch === "aarch64" ? "aarch64" : "x86_64",
    specPath
  ]);

  const rpmDir = join(topDir, "RPMS", target.arch === "aarch64" ? "aarch64" : "x86_64");
  let produced: string | undefined;
  for await (const entry of Deno.readDir(rpmDir)) {
    if (entry.isFile && entry.name.endsWith(".rpm")) {
      produced = join(rpmDir, entry.name);
    }
  }
  if (!produced) throw new Error(`rpmbuild produced nothing in ${rpmDir}`);
  await copy(produced, output, { overwrite: true });
  console.log(`  -> ${output}`);
}

async function renderRpmSpec(
  tree: string,
  version: string,
  target: Target
): Promise<string> {
  const files: string[] = [];
  const directories: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for await (const entry of Deno.readDir(directory)) {
      const absolute = join(directory, entry.name);
      const posix = `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        // /usr/share/man and friends belong to the filesystem package; only
        // claim directories the application owns outright.
        if (posix.startsWith(`/usr/lib/${APP_ID}`)) directories.push(posix);
        await walk(absolute, posix);
      } else {
        files.push(posix);
      }
    }
  };
  await walk(tree, "");

  const fileList = [
    ...directories.sort().map((entry) => `%dir "${entry}"`),
    ...files.sort().map((entry) => `"${entry}"`)
  ].join("\n");

  return `# Generated by apps/desktop/scripts/build.ts — do not edit by hand.
# The payload is deno desktop's own .rpm, unpacked and extended with the ui/
# and native/ directories the application resolves next to its executable.

# Every default post-install step is off. __os_install_post strips ELF
# binaries, and a stripped "deno desktop" launcher loses the payload appended
# after its sections: it starts and then cannot find its own code.
%global __os_install_post %{nil}
%global __brp_strip %{nil}
%global __brp_strip_static_archive %{nil}
%global __brp_strip_comment_note %{nil}
%global debug_package %{nil}
%define _build_id_links none
# The binary is self-contained apart from the webview; let the explicit
# Requires below speak instead of the automatic ELF scanner.
AutoReqProv: no

Name:           ${APP_ID}
Version:        ${version}
Release:        1
Summary:        Offline-first, end-to-end-encrypted notes with WebDAV sync
License:        GPL-3.0-or-later
URL:            ${RELEASE_BASE_URL}
BuildArch:      ${target.arch === "aarch64" ? "aarch64" : "x86_64"}
Requires:       webkit2gtk4.1
Requires:       gtk3
Requires:       hicolor-icon-theme

%description
${APP_NAME} is a desktop fork of Notesnook with no account, no subscription and
no cloud service. Notes are stored locally in an encrypted SQLite database and
synchronised through any WebDAV server. Backups are encrypted and can be
written locally or to the same WebDAV server.

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}
cp -a %{_openotes_tree}/. %{buildroot}/

%files
${fileList}
`;
}

/**
 * .msi.
 *
 * Deno Desktop can emit an .msi, but an .msi is a compound document with a
 * pre-built cabinet inside: there is no way to add `ui/` and `native/` to one
 * after the fact. So the installer is authored here instead, from the same
 * prepared directory every other format uses, and compiled with `wixl`
 * (GNOME msitools) or, on Windows, WiX v3's candle/light.
 */
async function produceMsi(
  target: Target,
  prepared: Prepared,
  version: string,
  output: string
) {
  const work = join(WORK_DIR, target.triple, "msi");
  await emptyDir(work);
  const wxsPath = join(work, `${APP_ID}.wxs`);
  await Deno.writeTextFile(
    wxsPath,
    await renderWxs(prepared, version, target)
  );

  if (await which("wixl")) {
    await run("wixl", [
      "-v",
      "--arch",
      target.arch === "aarch64" ? "arm64" : "x64",
      "-o",
      output,
      wxsPath
    ]);
  } else if ((await which("candle")) && (await which("light"))) {
    const wixobj = join(work, `${APP_ID}.wixobj`);
    await run("candle", [
      "-arch",
      target.arch === "aarch64" ? "arm64" : "x64",
      "-out",
      wixobj,
      wxsPath
    ]);
    await run("light", ["-out", output, wixobj]);
  } else {
    throw new Error(
      `Building an .msi needs "wixl" (Debian/Ubuntu: apt-get install wixl) ` +
        `or the WiX v3 toolset ("candle" and "light") on PATH. Neither was ` +
        `found.`
    );
  }
  console.log(`  -> ${output}`);
}

/** RFC 4122 name-based (version 5) UUID, so component GUIDs are stable. */
async function uuid5(name: string): Promise<string> {
  // The standard "URL" namespace, 6ba7b811-9dad-11d1-80b4-00c04fd430c8.
  const namespace = Uint8Array.from([
    0x6b,
    0xa7,
    0xb8,
    0x11,
    0x9d,
    0xad,
    0x11,
    0xd1,
    0x80,
    0xb4,
    0x00,
    0xc0,
    0x4f,
    0xd4,
    0x30,
    0xc8
  ]);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespace.length + nameBytes.length);
  input.set(namespace, 0);
  input.set(nameBytes, namespace.length);
  const buffer = new ArrayBuffer(input.byteLength);
  new Uint8Array(buffer).set(input);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", buffer));
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = encodeHex(bytes);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  ).toUpperCase();
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * A WiX v3 source document over the prepared directory.
 *
 * One component per directory rather than per file: the interface bundle is
 * a few hundred files and a component each would make the document enormous
 * for no benefit — nothing here is ever patched or installed selectively.
 */
async function renderWxs(
  prepared: Prepared,
  version: string,
  target: Target
): Promise<string> {
  const componentRefs: string[] = [];
  let directoryCounter = 0;
  let componentCounter = 0;
  let fileCounter = 0;

  const renderDirectory = async (
    absolute: string,
    relative: string,
    indent: string
  ): Promise<string> => {
    const entries = (await Array.fromAsync(Deno.readDir(absolute))).sort((
      a,
      b
    ) => (a.name < b.name ? -1 : 1));
    const files = entries.filter((entry) => entry.isFile);
    const directories = entries.filter((entry) => entry.isDirectory);
    const chunks: string[] = [];

    if (files.length > 0) {
      const componentId = `cmp${componentCounter++}`;
      const guid = await uuid5(`component:${relative || "."}`);
      componentRefs.push(componentId);
      chunks.push(
        `${indent}<Component Id="${componentId}" Guid="{${guid}}" Win64="yes">`
      );
      let first = true;
      for (const entry of files) {
        const source = join(absolute, entry.name);
        chunks.push(
          `${indent}  <File Id="fil${fileCounter++}" Name="${
            xmlEscape(entry.name)
          }" Source="${xmlEscape(source)}"${first ? ' KeyPath="yes"' : ""} />`
        );
        first = false;
      }
      chunks.push(`${indent}</Component>`);
    }

    for (const entry of directories) {
      const id = `dir${directoryCounter++}`;
      chunks.push(
        `${indent}<Directory Id="${id}" Name="${xmlEscape(entry.name)}">`
      );
      chunks.push(
        await renderDirectory(
          join(absolute, entry.name),
          `${relative}/${entry.name}`,
          `${indent}  `
        )
      );
      chunks.push(`${indent}</Directory>`);
    }

    return chunks.join("\n");
  };

  const body = await renderDirectory(prepared.directory, "", "          ");
  const upgradeCode = await uuid5(`upgrade:${APP_IDENTIFIER}`);
  const shortcutGuid = await uuid5(`component:start-menu`);
  const registryGuid = await uuid5(`component:url-scheme`);
  componentRefs.push("cmpStartMenu", "cmpUrlScheme");

  // MSI ProductVersion only understands three numeric fields.
  const productVersion = version.split("-")[0];

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/desktop/scripts/build.ts — do not edit by hand. -->
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*"
           Name="${xmlEscape(APP_NAME)}"
           Language="1033"
           Version="${productVersion}"
           Manufacturer="Openotes contributors"
           UpgradeCode="{${upgradeCode}}">
    <Package InstallerVersion="200"
             Compressed="yes"
             InstallScope="perMachine"
             Platform="${target.arch === "aarch64" ? "arm64" : "x64"}"
             Description="${xmlEscape(APP_NAME)} ${version}"
             Comments="Offline-first, end-to-end-encrypted notes with WebDAV sync" />
    <Media Id="1" Cabinet="${APP_ID}.cab" EmbedCab="yes" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="${xmlEscape(APP_NAME)}">
${body}
          <Component Id="cmpUrlScheme" Guid="{${registryGuid}}" Win64="yes">
            <!-- openotes:// deep links, the scheme apps/desktop/src/constants.ts
                 declares and main.ts parses off the command line. -->
            <RegistryValue Root="HKLM" Key="Software\\Classes\\${APP_ID}"
                           Value="URL:${xmlEscape(APP_NAME)} Protocol"
                           Type="string" KeyPath="yes" />
            <RegistryValue Root="HKLM" Key="Software\\Classes\\${APP_ID}"
                           Name="URL Protocol" Value="" Type="string" />
            <RegistryValue Root="HKLM"
                           Key="Software\\Classes\\${APP_ID}\\shell\\open\\command"
                           Value="&quot;[INSTALLDIR]${prepared.binary}&quot; &quot;%1&quot;"
                           Type="string" />
          </Component>
        </Directory>
      </Directory>

      <Directory Id="ProgramMenuFolder">
        <Directory Id="ApplicationProgramsFolder" Name="${xmlEscape(APP_NAME)}">
          <Component Id="cmpStartMenu" Guid="{${shortcutGuid}}" Win64="yes">
            <Shortcut Id="ApplicationStartMenuShortcut"
                      Name="${xmlEscape(APP_NAME)}"
                      Target="[INSTALLDIR]${prepared.binary}"
                      WorkingDirectory="INSTALLDIR" />
            <RemoveFolder Id="RemoveApplicationProgramsFolder" On="uninstall" />
            <RegistryValue Root="HKCU" Key="Software\\${xmlEscape(APP_NAME)}"
                           Name="installed" Type="integer" Value="1"
                           KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="Complete" Title="${xmlEscape(APP_NAME)}" Level="1">
${componentRefs.map((id) => `      <ComponentRef Id="${id}" />`).join("\n")}
    </Feature>
  </Product>
</Wix>
`;
}

/**
 * .exe — an NSIS installer, which is what upstream shipped for Windows and
 * what Deno Desktop has no equivalent of. Built with `makensis`, which runs
 * on Linux as well as Windows, so the Windows installers can be produced by
 * the same job that cross-compiles the binaries.
 */
async function produceExe(
  target: Target,
  prepared: Prepared,
  version: string,
  output: string
) {
  await requireTool("makensis", "build the Windows installer");
  const work = join(WORK_DIR, target.triple, "nsis");
  await emptyDir(work);
  const script = join(work, `${APP_ID}.nsi`);
  await Deno.writeTextFile(script, renderNsis(prepared, version, output));
  await run("makensis", ["-V2", script]);
  console.log(`  -> ${output}`);
}

function renderNsis(
  prepared: Prepared,
  version: string,
  output: string
): string {
  // makensis accepts forward slashes on every platform it runs on.
  const payload = prepared.directory.replaceAll("\\", "/");
  const licensePath = join(prepared.directory, "LICENSE").replaceAll("\\", "/");
  const iconPath = join(ICONS_DIR, "app.ico").replaceAll("\\", "/");
  const uninstallKey =
    `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_NAME}`;
  const numericVersion = `${version.split("-")[0]}.0`;

  return `; Generated by apps/desktop/scripts/build.ts — do not edit by hand.
Unicode true
!include "MUI2.nsh"

Name "${APP_NAME} ${version}"
OutFile "${output.replaceAll("\\", "/")}"
; Per-user by default: no elevation prompt, and the app never needs to write
; into its own installation directory (everything lives under %APPDATA%).
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\\Programs\\${APP_NAME}"
InstallDirRegKey HKCU "Software\\${APP_NAME}" "InstallDir"
SetCompressor /SOLID lzma

VIProductVersion "${numericVersion}"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "ProductVersion" "${version}"
VIAddVersionKey "FileVersion" "${version}"
VIAddVersionKey "CompanyName" "Openotes contributors"
VIAddVersionKey "LegalCopyright" "GPL-3.0-or-later"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"

!define MUI_ABORTWARNING
!define MUI_ICON "${iconPath}"
!define MUI_UNICON "${iconPath}"
!insertmacro MUI_PAGE_LICENSE "${licensePath}"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "${APP_NAME}" SecMain
  SetOutPath "$INSTDIR"
  File /r "${payload}/*"

  WriteRegStr HKCU "Software\\${APP_NAME}" "InstallDir" "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\\${APP_NAME}\\${APP_NAME}.lnk" \\
    "$INSTDIR\\${prepared.binary}"

  ; openotes:// deep links.
  WriteRegStr HKCU "Software\\Classes\\${APP_ID}" "" "URL:${APP_NAME} Protocol"
  WriteRegStr HKCU "Software\\Classes\\${APP_ID}" "URL Protocol" ""
  WriteRegStr HKCU "Software\\Classes\\${APP_ID}\\shell\\open\\command" "" \\
    '"$INSTDIR\\${prepared.binary}" "%1"'

  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "${uninstallKey}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${uninstallKey}" "DisplayVersion" "${version}"
  WriteRegStr HKCU "${uninstallKey}" "Publisher" "Openotes contributors"
  WriteRegStr HKCU "${uninstallKey}" "DisplayIcon" "$INSTDIR\\${prepared.binary}"
  WriteRegStr HKCU "${uninstallKey}" "UninstallString" "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "${uninstallKey}" "URLInfoAbout" "${RELEASE_BASE_URL}"
  WriteRegDWORD HKCU "${uninstallKey}" "NoModify" 1
  WriteRegDWORD HKCU "${uninstallKey}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\\${APP_NAME}\\${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\\${APP_NAME}"
  ; The notes database lives in %APPDATA%, never here, so removing the
  ; installation directory cannot take a user's data with it.
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Classes\\${APP_ID}"
  DeleteRegKey HKCU "${uninstallKey}"
  DeleteRegKey /ifempty HKCU "Software\\${APP_NAME}"
SectionEnd
`;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export interface BuildOptions {
  targets: Target[];
  formats?: Format[];
  version?: string;
  outputDirectory?: string;
  nativeDirectory?: string;
  skipUi?: boolean;
  skipNative?: boolean;
  rebuildUi?: boolean;
  keepWork?: boolean;
}

export async function build(options: BuildOptions): Promise<string[]> {
  const version = options.version ?? APP_VERSION;
  const outputDirectory = options.outputDirectory ?? DEFAULT_OUTPUT;
  const nativeDirectory = options.nativeDirectory ?? NATIVE_DIR;
  await ensureDir(outputDirectory);

  const produced: string[] = [];

  for (const target of options.targets) {
    const formats = (options.formats ?? formatsFor(target)).filter(
      (format) => formatsFor(target).includes(format)
    );
    if (formats.length === 0) {
      throw new Error(
        `None of the requested formats can be built for ${target.triple}. ` +
          `Valid formats: ${formatsFor(target).join(", ")}`
      );
    }

    console.log(
      `\n=== ${APP_NAME} ${version} — ${target.triple} — ${
        formats.join(", ")
      } ===`
    );

    await ensureNative(target, nativeDirectory, !!options.skipNative);
    await ensureUi(!!options.skipUi, !!options.rebuildUi);

    const nativeStage = await stageNative(target, nativeDirectory);
    const prepared = await preparePayload(target, version, nativeStage);

    for (const format of formats) {
      const output = join(outputDirectory, artifactName(target, format, version));
      console.log(`\nProducing ${basename(output)}…`);
      switch (format) {
        case "dir":
          await produceDir(prepared, output);
          break;
        case "tar.gz":
          await produceTarGz(prepared, output);
          break;
        case "zip":
          await produceZip(prepared, output);
          break;
        case "appimage":
          await produceAppImage(target, nativeStage, output);
          break;
        case "deb":
          await produceDeb(target, prepared, nativeStage, version, output);
          break;
        case "rpm":
          await produceRpm(target, prepared, nativeStage, version, output);
          break;
        case "msi":
          await produceMsi(target, prepared, version, output);
          break;
        case "exe":
          await produceExe(target, prepared, version, output);
          break;
      }
      produced.push(output);
    }
  }

  if (!options.keepWork) {
    await Deno.remove(WORK_DIR, { recursive: true }).catch(() => {});
  }

  console.log(`\nBuilt ${produced.length} artifact(s) in ${outputDirectory}:`);
  for (const artifact of produced) console.log(`  ${basename(artifact)}`);
  return produced;
}

function parseFormats(value: string): Format[] {
  const known = new Set<string>([...LINUX_FORMATS, ...WINDOWS_FORMATS]);
  const formats: Format[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    const normalised = name === "targz" || name === "tgz" ? "tar.gz" : name;
    if (!known.has(normalised)) {
      throw new Error(
        `Unknown format "${raw}". Valid formats: ${[...known].join(", ")}`
      );
    }
    formats.push(normalised as Format);
  }
  return formats;
}

function usage() {
  console.log(
    `Usage: deno run -A apps/desktop/scripts/build.ts [options]

  --target <triple>   one of:
${Object.keys(TARGETS).map((triple) => `                        ${triple}`).join("\n")}
                      (default: the host triple; may be repeated)
  --format <list>     comma separated; default is every format for the target
                        linux:   ${LINUX_FORMATS.join(", ")}
                        windows: ${WINDOWS_FORMATS.join(", ")}
  --all               build every target this machine can produce
  --version <v>       override the version in the artifact names
  --output <dir>      where the artifacts go (default: dist/)
  --native-dir <dir>  where the native libraries are (default:
                      apps/desktop/native)
  --skip-ui           do not build the interface; fail if it is missing
  --rebuild-ui        rebuild the interface even if one is present
  --skip-native       do not build the native libraries; fail if missing
  --keep-work         keep apps/desktop/.build for inspection
  -h, --help          show this message`
  );
}

if (import.meta.main) {
  const targets: Target[] = [];
  let formats: Format[] | undefined;
  let version: string | undefined;
  let outputDirectory: string | undefined;
  let nativeDirectory: string | undefined;
  let all = false;
  let skipUi = false;
  let rebuildUi = false;
  let skipNative = false;
  let keepWork = false;
  let help = false;

  try {
    for (let index = 0; index < Deno.args.length; index++) {
      const argument = Deno.args[index];
      const value = () => {
        const next = Deno.args[++index];
        if (next === undefined) throw new Error(`${argument} needs a value`);
        return next;
      };
      switch (argument) {
        case "--target": {
          const triple = value();
          const target = TARGETS[triple];
          if (!target) {
            throw new Error(
              `Unknown target "${triple}". Valid targets: ${
                Object.keys(TARGETS).join(", ")
              }`
            );
          }
          targets.push(target);
          break;
        }
        case "--format":
          formats = [...(formats ?? []), ...parseFormats(value())];
          break;
        case "--version":
          version = value();
          break;
        case "--output":
          outputDirectory = value();
          break;
        case "--native-dir":
          nativeDirectory = value();
          break;
        case "--all":
          all = true;
          break;
        case "--skip-ui":
          skipUi = true;
          break;
        case "--rebuild-ui":
          rebuildUi = true;
          break;
        case "--skip-native":
          skipNative = true;
          break;
        case "--keep-work":
          keepWork = true;
          break;
        case "-h":
        case "--help":
          help = true;
          break;
        default:
          throw new Error(`Unknown option: ${argument}`);
      }
    }

    if (help) {
      usage();
    } else {
      if (all && targets.length === 0) {
        // Cross-compiling the binary always works; the packaging tools do
        // not. Only offer the targets whose formats this host can finish.
        const host = TARGETS[hostTriple()];
        targets.push(host);
        for (const target of Object.values(TARGETS)) {
          if (target.triple !== host.triple && target.arch === host.arch) {
            targets.push(target);
          }
        }
      }
      if (targets.length === 0) targets.push(TARGETS[hostTriple()]);
      await build({
        targets,
        formats,
        version,
        outputDirectory,
        nativeDirectory,
        skipUi,
        rebuildUi,
        skipNative,
        keepWork
      });
    }
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
}
