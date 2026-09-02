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
 * Writes latest.json — the update manifest the application fetches from
 * <releases>/latest/download/latest.json (see src/updates/updater.ts).
 *
 * Reads the artifact directory and its SHA256SUMS (which the release job
 * has already written and verified), so the hashes in the manifest are the
 * ones that were actually checked, not recomputed values that could drift.
 *
 *   deno run -A apps/desktop/scripts/update-manifest.ts <dist-dir> <version> [notes-file]
 */

import { join } from "@std/path";

interface UpdateAsset {
  platform: "windows" | "linux" | "darwin" | "android";
  /** "universal" for an APK that carries every ABI. */
  arch: "x86_64" | "aarch64" | "universal";
  format: string;
  url: string;
  sha256: string;
  size: number;
}

/** Artifact name -> platform/arch/format, per the release naming scheme. */
function classify(
  name: string,
): Omit<UpdateAsset, "url" | "sha256" | "size"> | undefined {
  const patterns: [RegExp, UpdateAsset["platform"], string][] = [
    [/^Openotes-.+-windows-(x86_64|aarch64)\.exe$/, "windows", "exe"],
    [/^Openotes-.+-windows-(x86_64|aarch64)\.msi$/, "windows", "msi"],
    [/^Openotes-.+-windows-(x86_64|aarch64)\.zip$/, "windows", "zip"],
    [/^Openotes-.+-linux-(x86_64|aarch64)\.AppImage$/, "linux", "AppImage"],
    [/^Openotes-.+-linux-(x86_64|aarch64)\.deb$/, "linux", "deb"],
    [/^Openotes-.+-linux-(x86_64|aarch64)\.rpm$/, "linux", "rpm"],
    [/^Openotes-.+-linux-(x86_64|aarch64)\.tar\.gz$/, "linux", "tar.gz"],
    [/^Openotes-.+-(x86_64|aarch64)\.flatpak$/, "linux", "flatpak"],
    [/^openotes-.+-(x86_64|aarch64)\.pkg\.tar\.zst$/, "linux", "pkg.tar.zst"],
  ];
  for (const [pattern, platform, format] of patterns) {
    const match = pattern.exec(name);
    if (match) {
      return { platform, arch: match[1] as UpdateAsset["arch"], format };
    }
  }
  // The phone app: one APK for every ABI. Listed so a download page built
  // from the manifest sees it; the desktop updater filters by its own
  // platform and never picks it.
  if (/^Openotes-.+-android\.apk$/.test(name)) {
    return { platform: "android", arch: "universal", format: "apk" };
  }
  return undefined;
}

async function main() {
  const [distDir, version, notesFile] = Deno.args;
  if (!distDir || !version) {
    console.error(
      "Usage: update-manifest.ts <dist-dir> <version> [notes-file]",
    );
    Deno.exit(2);
  }

  // Hashes come from the SHA256SUMS that was already verified, so the
  // manifest cannot disagree with the published checksums.
  const sums = new Map<string, string>();
  const sumsText = await Deno.readTextFile(join(distDir, "SHA256SUMS"));
  for (const line of sumsText.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  if (sums.size === 0) {
    console.error(`No entries found in ${join(distDir, "SHA256SUMS")}`);
    Deno.exit(1);
  }

  const tag = version.startsWith("v") ? version : `v${version}`;
  const cleanVersion = version.replace(/^v/, "");
  const repository = Deno.env.get("GITHUB_REPOSITORY") ??
    "yuvalkolodkingal/notesnook";
  const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;

  const assets: UpdateAsset[] = [];
  for await (const entry of Deno.readDir(distDir)) {
    if (!entry.isFile) continue;
    const kind = classify(entry.name);
    if (!kind) continue;
    const sha256 = sums.get(entry.name);
    if (!sha256) {
      console.error(
        `Refusing to publish: ${entry.name} is in ${distDir} but has no ` +
          `entry in SHA256SUMS.`,
      );
      Deno.exit(1);
    }
    const stat = await Deno.stat(join(distDir, entry.name));
    assets.push({
      ...kind,
      url: `${baseUrl}/${encodeURIComponent(entry.name)}`,
      sha256,
      size: stat.size,
    });
  }

  if (assets.length === 0) {
    console.error(`No release artifacts recognised in ${distDir}`);
    Deno.exit(1);
  }

  let notes: string | undefined;
  if (notesFile) {
    try {
      notes = await Deno.readTextFile(notesFile);
    } catch {
      /* release notes are optional */
    }
  }

  const manifest = {
    version: cleanVersion,
    publishedAt: new Date().toISOString(),
    notes,
    assets: assets.sort((a, b) =>
      `${a.platform}/${a.arch}/${a.format}`.localeCompare(
        `${b.platform}/${b.arch}/${b.format}`,
      )
    ),
  };

  const target = join(distDir, "latest.json");
  await Deno.writeTextFile(target, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `Wrote ${target} with ${assets.length} asset(s) for version ${cleanVersion}`,
  );
}

if (import.meta.main) await main();
