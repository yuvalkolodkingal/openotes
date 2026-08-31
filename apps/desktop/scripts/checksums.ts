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
 * Writes (or verifies) a SHA256SUMS file over a directory of release
 * artifacts, in the format `sha256sum` itself produces and consumes:
 *
 *     <64 hex characters><two spaces><file name>
 *
 * Two spaces is the "text mode" separator; a space followed by `*` would mean
 * binary mode. GNU coreutils accepts either, and the two-space form is what
 * release pages show, so that is what is written here — a user can run
 * `sha256sum -c SHA256SUMS` against the downloaded files without editing
 * anything.
 *
 *   deno task checksums                       hash ./dist
 *   deno run -A .../checksums.ts dist         hash a directory
 *   deno run -A .../checksums.ts dist --check verify an existing SHA256SUMS
 */

import { basename, join, resolve } from "@std/path";
import { encodeHex } from "@std/encoding/hex";

export const CHECKSUM_FILE = "SHA256SUMS";

/** Never hashed into the manifest: the manifest itself and its signature. */
const EXCLUDED = new Set([
  CHECKSUM_FILE,
  `${CHECKSUM_FILE}.asc`,
  `${CHECKSUM_FILE}.sig`,
  ".DS_Store",
]);

/**
 * SHA-256 of a file, as lowercase hex.
 *
 * `crypto.subtle.digest` is one-shot, so the file is read into memory first.
 * Release artifacts top out at a few hundred megabytes, which is well inside
 * what any machine that just compiled the app can hold, and this keeps the
 * script free of extra dependencies.
 */
export async function sha256File(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
  );
}

/** Every regular file directly inside `directory`, sorted by name. */
export async function artifactNames(directory: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    if (EXCLUDED.has(entry.name)) continue;
    names.push(entry.name);
  }
  // Byte-wise sort so the manifest is reproducible regardless of locale.
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface ChecksumEntry {
  name: string;
  digest: string;
}

/** Hashes every artifact in `directory`, printing each line as it goes. */
export async function checksumDirectory(
  directory: string,
): Promise<ChecksumEntry[]> {
  const entries: ChecksumEntry[] = [];
  for (const name of await artifactNames(directory)) {
    const digest = await sha256File(join(directory, name));
    entries.push({ name, digest });
    console.log(`${digest}  ${name}`);
  }
  return entries;
}

export function formatChecksums(entries: ChecksumEntry[]): string {
  return `${
    entries.map((entry) => `${entry.digest}  ${entry.name}`).join("\n")
  }\n`;
}

/** Parses a SHA256SUMS file. Accepts both the text and binary separators. */
export function parseChecksums(contents: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) throw new Error(`Malformed checksum line: ${line}`);
    entries.push({ digest: match[1].toLowerCase(), name: match[2] });
  }
  return entries;
}

/** Returns the number of problems found. */
export async function verifyDirectory(directory: string): Promise<number> {
  const manifest = join(directory, CHECKSUM_FILE);
  const expected = parseChecksums(await Deno.readTextFile(manifest));
  let failures = 0;

  for (const entry of expected) {
    let actual: string;
    try {
      actual = await sha256File(join(directory, entry.name));
    } catch {
      console.log(`${entry.name}: MISSING`);
      failures++;
      continue;
    }
    if (actual === entry.digest) console.log(`${entry.name}: OK`);
    else {
      console.log(`${entry.name}: FAILED`);
      failures++;
    }
  }

  const listed = new Set(expected.map((entry) => entry.name));
  for (const name of await artifactNames(directory)) {
    if (!listed.has(name)) {
      console.log(`${name}: NOT LISTED in ${CHECKSUM_FILE}`);
      failures++;
    }
  }

  if (failures > 0) {
    console.error(
      `\n${failures} checksum ${
        failures === 1 ? "problem" : "problems"
      } in ${directory}`,
    );
  } else {
    console.log(`\nAll ${expected.length} checksums match.`);
  }
  return failures;
}

function usage() {
  console.log(
    `Usage: deno run -A apps/desktop/scripts/checksums.ts [directory] [options]

  directory        directory of artifacts to hash (default: dist)
  --output <file>  write somewhere other than <directory>/${CHECKSUM_FILE}
  --check          verify an existing ${CHECKSUM_FILE} instead of writing one
  -h, --help       show this message`,
  );
}

if (import.meta.main) {
  const positional: string[] = [];
  let output: string | undefined;
  let check = false;
  let help = false;

  for (let index = 0; index < Deno.args.length; index++) {
    const argument = Deno.args[index];
    // `deno task <name> -- --flag` forwards the separator verbatim.
    if (argument === "--") continue;
    if (argument === "--check") check = true;
    else if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "--output") output = Deno.args[++index];
    else if (argument.startsWith("--output=")) {
      output = argument.slice("--output=".length);
    } else if (argument.startsWith("-")) {
      console.error(`Unknown option: ${argument}`);
      Deno.exit(2);
    } else positional.push(argument);
  }

  if (help) {
    usage();
  } else {
    const directory = resolve(positional[0] ?? "dist");
    let readable = false;
    try {
      readable = (await Deno.stat(directory)).isDirectory;
    } catch (error) {
      console.error(
        `Cannot read ${directory}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      Deno.exit(1);
    }
    if (!readable) {
      console.error(`${directory} is not a directory`);
      Deno.exit(1);
    }

    if (check) {
      Deno.exit((await verifyDirectory(directory)) === 0 ? 0 : 1);
    }

    const entries = await checksumDirectory(directory);
    if (entries.length === 0) {
      console.error(`No artifacts found in ${directory}`);
      Deno.exit(1);
    }
    const target = output ? resolve(output) : join(directory, CHECKSUM_FILE);
    await Deno.writeTextFile(target, formatChecksums(entries));
    console.log(
      `\nWrote ${entries.length} ${
        entries.length === 1 ? "checksum" : "checksums"
      } to ${target} (${basename(target)})`,
    );
  }
}
