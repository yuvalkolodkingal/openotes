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

import {
  APP_VERSION,
  RELEASE_BASE_URL,
  UPDATE_MANIFEST_URL,
  USER_AGENT,
} from "../constants.ts";
import { isFlatpak, isSnap } from "../native/paths.ts";
import { logger } from "../native/logger.ts";

const log = logger.scope("updater");

/**
 * Update checking against the fork's own GitHub Releases (spec §44).
 * Notesnook's update servers are never contacted.
 *
 * What this does and does not do, deliberately:
 *  - it checks, tells the user, and can open the release page;
 *  - it does NOT silently download and swap the binary. Packaged builds are
 *    updated by the package manager that installed them (apt, dnf, pacman,
 *    flatpak, the MSI), and replacing a managed binary behind the package
 *    manager's back is how you corrupt an installation.
 *  - AppImage and the portable Windows build are the two cases where an
 *    in-place update would make sense; those download to a staging path and
 *    verify the SHA-256 from the manifest before doing anything.
 */

export interface UpdateManifest {
  version: string;
  notes?: string;
  publishedAt?: string;
  assets: UpdateAsset[];
}

export interface UpdateAsset {
  platform: "windows" | "linux" | "darwin" | "android";
  arch: "x86_64" | "aarch64" | "universal";
  format: string;
  url: string;
  sha256: string;
  size?: number;
  signature?: string;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  releaseUrl: string;
  /** False for package-manager installs, which must not self-update. */
  canSelfUpdate: boolean;
  asset?: UpdateAsset;
  error?: string;
}

export type UpdaterEvent =
  | { type: "checking" }
  | { type: "available"; result: UpdateCheckResult }
  | { type: "not-available"; result: UpdateCheckResult }
  | {
    type: "download-progress";
    percent: number;
    transferred: number;
    total: number;
  }
  | { type: "downloaded"; path: string }
  | { type: "error"; message: string };

export class UpdateService {
  private latest?: UpdateCheckResult;
  private downloadedPath?: string;

  constructor(
    private readonly options: {
      stagingDir: string;
      emit: (event: UpdaterEvent) => void;
      openExternal: (url: string) => Promise<void>;
    },
  ) {}

  /** True when this build owns its own binary and may replace it. */
  get canSelfUpdate(): boolean {
    if (isFlatpak() || isSnap()) return false;
    // A distro package (deb/rpm/pacman) installs to a root-owned prefix.
    if (Deno.build.os === "linux" && !Deno.env.get("APPIMAGE")) {
      const home = Deno.env.get("HOME");
      return home !== undefined && Deno.execPath().startsWith(home);
    }
    return true;
  }

  async check(): Promise<UpdateCheckResult> {
    this.options.emit({ type: "checking" });
    const base: UpdateCheckResult = {
      updateAvailable: false,
      currentVersion: APP_VERSION,
      releaseUrl: RELEASE_BASE_URL,
      canSelfUpdate: this.canSelfUpdate,
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(UPDATE_MANIFEST_URL, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`Update endpoint returned HTTP ${response.status}`);
      }
      const manifest = (await response.json()) as UpdateManifest;
      if (!manifest?.version || !Array.isArray(manifest.assets)) {
        throw new Error("The update manifest is malformed");
      }

      const newer = compareVersions(manifest.version, APP_VERSION) > 0;
      const asset = this.pickAsset(manifest);
      const result: UpdateCheckResult = {
        ...base,
        updateAvailable: newer,
        latestVersion: manifest.version,
        notes: manifest.notes,
        asset,
      };
      this.latest = result;
      log.info("Update check finished", {
        latest: manifest.version,
        current: APP_VERSION,
        updateAvailable: newer,
      });
      this.options.emit({
        type: newer ? "available" : "not-available",
        result,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Update check failed", { error: message });
      const result = { ...base, error: message };
      this.options.emit({ type: "error", message });
      return result;
    }
  }

  private pickAsset(manifest: UpdateManifest): UpdateAsset | undefined {
    const platform = Deno.build.os === "windows"
      ? "windows"
      : Deno.build.os === "darwin"
      ? "darwin"
      : "linux";
    const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
    const preferredFormat = platform === "windows"
      ? Deno.env.get("OPENOTES_PORTABLE") === "1" ? "exe" : "msi"
      : Deno.env.get("APPIMAGE")
      ? "AppImage"
      : "tar.gz";

    const candidates = manifest.assets.filter(
      (asset) => asset.platform === platform && asset.arch === arch,
    );
    return (
      candidates.find((asset) => asset.format === preferredFormat) ??
        candidates[0]
    );
  }

  /**
   * Download the update to a staging path and verify its SHA-256 against
   * the manifest. Nothing is executed or installed here.
   */
  async download(): Promise<{ path: string }> {
    const result = this.latest ?? (await this.check());
    if (!result.updateAvailable || !result.asset) {
      throw new Error("There is no update to download");
    }
    if (!this.canSelfUpdate) {
      throw new Error(
        "This installation is managed by your package manager. Update " +
          "Openotes through it instead.",
      );
    }

    const asset = result.asset;
    await Deno.mkdir(this.options.stagingDir, { recursive: true });
    const target =
      `${this.options.stagingDir}/openotes-${result.latestVersion}.${asset.format}`;

    log.info("Downloading update", { version: result.latestVersion });
    const response = await fetch(asset.url, {
      headers: { "user-agent": USER_AGENT },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed with HTTP ${response.status}`);
    }

    const total = Number(
      response.headers.get("content-length") ?? asset.size ?? 0,
    );
    const file = await Deno.open(target, {
      create: true,
      write: true,
      truncate: true,
    });
    const digest = await streamToFileWithDigest(
      response.body,
      file,
      total,
      (transferred) =>
        this.options.emit({
          type: "download-progress",
          transferred,
          total,
          percent: total > 0 ? Math.round((transferred / total) * 100) : 0,
        }),
    );
    file.close();

    if (digest !== asset.sha256.toLowerCase()) {
      await Deno.remove(target).catch(() => {});
      throw new Error(
        "The downloaded update failed its checksum check and was deleted. " +
          "Nothing was installed.",
      );
    }

    this.downloadedPath = target;
    log.info("Update downloaded and verified", { path: target });
    this.options.emit({ type: "downloaded", path: target });
    return { path: target };
  }

  /**
   * Hand the verified download to the user. Installing over a running
   * binary is the packaging system's job, so this opens the file (or the
   * release page) rather than pretending to install it.
   */
  async install(): Promise<{ opened: string }> {
    const path = this.downloadedPath;
    if (!path) {
      await this.options.openExternal(RELEASE_BASE_URL);
      return { opened: RELEASE_BASE_URL };
    }
    await this.options.openExternal(`file://${path}`);
    return { opened: path };
  }
}

async function streamToFileWithDigest(
  body: ReadableStream<Uint8Array>,
  file: Deno.FsFile,
  _total: number,
  onProgress: (transferred: number) => void,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let transferred = 0;
  let lastReport = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    let offset = 0;
    while (offset < value.length) {
      offset += await file.write(value.subarray(offset));
    }
    chunks.push(value);
    transferred += value.length;
    if (transferred - lastReport > 1_000_000) {
      lastReport = transferred;
      onProgress(transferred);
    }
  }
  onProgress(transferred);

  const combined = new Uint8Array(transferred);
  let position = 0;
  for (const chunk of chunks) {
    combined.set(chunk, position);
    position += chunk.length;
  }
  const buffer = new ArrayBuffer(combined.byteLength);
  new Uint8Array(buffer).set(combined);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  let hex = "";
  for (const byte of hash) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Semver comparison; returns >0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((part) => parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  // A release beats a prerelease of the same version.
  const aPre = a.includes("-");
  const bPre = b.includes("-");
  if (aPre !== bPre) return aPre ? -1 : 1;
  return 0;
}
