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

import { appDataDir, assertInside, ensureDir } from "./paths.ts";
import { logger } from "./logger.ts";

const log = logger.scope("fs");

// Attachment content lives in its own chunked store — see
// native/attachment-store.ts. This module keeps the streamed writes to
// user-chosen locations (exports, backups).

/**
 * Streaming writes to a user-chosen export/backup location.
 *
 * Every path is validated against the directories the user actually picked
 * — the renderer names a file, it never names a location.
 */
export class ExportWriter {
  private readonly writes = new Map<
    string,
    { file: Deno.FsFile; path: string }
  >();
  private nextHandle = 1;

  constructor(private allowedRoots: string[]) {}

  setAllowedRoots(roots: string[]): void {
    this.allowedRoots = roots.filter(Boolean);
  }

  async open(filePath: string): Promise<string> {
    const resolved = assertInside(
      filePath,
      this.allowedRoots.length > 0 ? this.allowedRoots : [appDataDir()],
      "export path",
    );
    await ensureDir(dirOf(resolved));
    const file = await Deno.open(resolved, {
      create: true,
      write: true,
      truncate: true,
    });
    const handle = `x${this.nextHandle++}`;
    this.writes.set(handle, { file, path: resolved });
    log.debug("Opened export file", { handle });
    return handle;
  }

  async write(handle: string, chunk: Uint8Array): Promise<void> {
    const pending = this.writes.get(handle);
    if (!pending) throw new Error(`Unknown export handle: ${handle}`);
    let offset = 0;
    while (offset < chunk.length) {
      offset += await pending.file.write(chunk.subarray(offset));
    }
  }

  async close(handle: string): Promise<string | undefined> {
    const pending = this.writes.get(handle);
    if (!pending) return undefined;
    try {
      await pending.file.sync();
    } catch {
      /* best effort */
    }
    pending.file.close();
    this.writes.delete(handle);
    return pending.path;
  }

  closeAll(): void {
    for (const [handle] of this.writes) void this.close(handle);
  }
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}
