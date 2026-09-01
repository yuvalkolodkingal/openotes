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

import { type TextStore } from "@notesnook/sync-core";
import { emptyManifest, type Manifest, type ManifestEntry } from "./types.ts";

/**
 * Loads and saves the per-device sync manifest.
 *
 * A damaged manifest is recoverable, not fatal: losing it means every note
 * looks untracked, and the engine's untracked path adopts identical content
 * and raises a conflict only where the two sides genuinely differ. So a bad
 * read starts fresh rather than throwing, and the worst case is some redundant
 * work plus conflict copies the user can delete — never lost content.
 */
export class ManifestStore {
  private manifest?: Manifest;

  constructor(
    private readonly storage: TextStore,
    private readonly deviceId: string,
  ) {}

  async load(): Promise<Manifest> {
    if (this.manifest) return this.manifest;
    let parsed: Manifest | undefined;
    try {
      const raw = await this.storage.read();
      if (raw) {
        const candidate = JSON.parse(raw) as Manifest;
        // Only accept a shape we recognise. A future version writing a format
        // we cannot read must not be silently half-interpreted.
        if (
          candidate && candidate.version === 1 &&
          typeof candidate.notes === "object" && candidate.notes !== null
        ) {
          parsed = candidate;
        }
      }
    } catch {
      // Fall through: an unreadable manifest starts fresh.
      parsed = undefined;
    }
    this.manifest = parsed ?? emptyManifest(this.deviceId);
    return this.manifest;
  }

  async save(): Promise<void> {
    if (!this.manifest) return;
    await this.storage.write(JSON.stringify(this.manifest));
  }

  /** Entry for a note, or undefined when this device has never synced it. */
  async entry(noteId: string): Promise<ManifestEntry | undefined> {
    return (await this.load()).notes[noteId];
  }

  /** Reverse lookup: which note does this remote path belong to? */
  async noteIdForPath(path: string): Promise<string | undefined> {
    const manifest = await this.load();
    for (const entry of Object.values(manifest.notes)) {
      if (entry.remotePath === path) return entry.noteId;
    }
    return undefined;
  }

  async record(entry: ManifestEntry): Promise<void> {
    const manifest = await this.load();
    manifest.notes[entry.noteId] = entry;
  }

  async forget(noteId: string): Promise<void> {
    const manifest = await this.load();
    delete manifest.notes[noteId];
  }

  async cursor(): Promise<string | undefined> {
    return (await this.load()).cursor;
  }

  async setCursor(cursor: string | undefined): Promise<void> {
    (await this.load()).cursor = cursor;
  }

  async all(): Promise<ManifestEntry[]> {
    return Object.values((await this.load()).notes);
  }

  /**
   * Drop every entry, keeping the device id. Used when switching a remote's
   * encryption mode, which rewrites every file and invalidates every base.
   */
  async reset(): Promise<void> {
    this.manifest = emptyManifest(this.deviceId);
    await this.save();
  }
}
