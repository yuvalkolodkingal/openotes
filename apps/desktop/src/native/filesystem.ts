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

import { join } from "@std/path";
import {
  appDataDir,
  assertInside,
  attachmentsDir,
  ensureDir,
  sanitizeSegment,
} from "./paths.ts";
import { logger } from "./logger.ts";

const log = logger.scope("fs");

/**
 * Attachment storage on the Deno side.
 *
 * Upstream kept attachment blobs in the webview's OPFS. Moving them to the
 * filesystem here does two things the spec asks for: privileged I/O lives
 * on the Deno side rather than in the renderer (§9, §28), and user data
 * stops depending on the webview keeping its origin storage (§12) — a
 * cleared webview profile no longer means lost attachments.
 *
 * Content arrives already encrypted from the renderer's crypto worker, the
 * same way it is encrypted before upload, so this layer never sees
 * plaintext and never needs a key.
 */

/** A chunked, resumable write. Chunks land in a temp file first. */
interface PendingWrite {
  file: Deno.FsFile;
  tempPath: string;
  finalPath: string;
  written: number;
}

export class FileStorage {
  private readonly writes = new Map<string, PendingWrite>();
  private nextHandle = 1;

  constructor(private readonly root: string = attachmentsDir()) {}

  private pathFor(hash: string): string {
    const safe = sanitizeSegment(hash);
    if (safe !== hash || hash.length < 4) {
      throw new Error(`Invalid attachment hash: ${hash}`);
    }
    // Two-level fan-out keeps directories small on big vaults.
    return join(this.root, safe.slice(0, 2), safe.slice(2, 4), safe);
  }

  async exists(hash: string): Promise<boolean> {
    try {
      await Deno.stat(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  async size(hash: string): Promise<number | undefined> {
    try {
      return (await Deno.stat(this.pathFor(hash))).size;
    } catch {
      return undefined;
    }
  }

  /** Open a streaming write. Returns a handle for writeChunk/finishWrite. */
  async beginWrite(hash: string): Promise<string> {
    const finalPath = this.pathFor(hash);
    await ensureDir(dirOf(finalPath));
    const tempPath = `${finalPath}.part`;
    const file = await Deno.open(tempPath, {
      create: true,
      write: true,
      truncate: true,
    });
    const handle = `w${this.nextHandle++}`;
    this.writes.set(handle, { file, tempPath, finalPath, written: 0 });
    return handle;
  }

  async writeChunk(handle: string, chunk: Uint8Array): Promise<number> {
    const pending = this.writes.get(handle);
    if (!pending) throw new Error(`Unknown write handle: ${handle}`);
    let offset = 0;
    while (offset < chunk.length) {
      offset += await pending.file.write(chunk.subarray(offset));
    }
    pending.written += chunk.length;
    return pending.written;
  }

  /**
   * Atomically publish the written content. The rename is what makes a
   * half-written attachment impossible to observe as complete.
   */
  async finishWrite(handle: string): Promise<number> {
    const pending = this.writes.get(handle);
    if (!pending) throw new Error(`Unknown write handle: ${handle}`);
    try {
      await pending.file.sync();
    } catch {
      /* sync is best effort on some filesystems */
    }
    pending.file.close();
    await Deno.rename(pending.tempPath, pending.finalPath);
    this.writes.delete(handle);
    return pending.written;
  }

  async abortWrite(handle: string): Promise<void> {
    const pending = this.writes.get(handle);
    if (!pending) return;
    try {
      pending.file.close();
    } catch {
      /* already closed */
    }
    try {
      await Deno.remove(pending.tempPath);
    } catch {
      /* nothing to clean up */
    }
    this.writes.delete(handle);
  }

  async readAll(hash: string): Promise<Uint8Array | undefined> {
    try {
      return await Deno.readFile(this.pathFor(hash));
    } catch {
      return undefined;
    }
  }

  async readStream(
    hash: string,
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    try {
      const file = await Deno.open(this.pathFor(hash), { read: true });
      return file.readable;
    } catch {
      return undefined;
    }
  }

  async writeStream(
    hash: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    const handle = await this.beginWrite(hash);
    try {
      const reader = stream.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await this.writeChunk(handle, value);
      }
      await this.finishWrite(handle);
    } catch (error) {
      await this.abortWrite(handle);
      throw error;
    }
  }

  async delete(hash: string): Promise<boolean> {
    try {
      await Deno.remove(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  /** Every stored hash. Used to compute what the remote still needs. */
  async list(): Promise<string[]> {
    const hashes: string[] = [];
    try {
      for await (const first of Deno.readDir(this.root)) {
        if (!first.isDirectory) continue;
        for await (const second of Deno.readDir(join(this.root, first.name))) {
          if (!second.isDirectory) continue;
          for await (
            const entry of Deno.readDir(
              join(this.root, first.name, second.name),
            )
          ) {
            if (entry.isFile && !entry.name.endsWith(".part")) {
              hashes.push(entry.name);
            }
          }
        }
      }
    } catch {
      /* the directory may not exist yet */
    }
    return hashes;
  }

  async totalSize(): Promise<number> {
    let total = 0;
    for (const hash of await this.list()) {
      total += (await this.size(hash)) ?? 0;
    }
    return total;
  }

  /** Remove interrupted writes left behind by a crash. */
  async cleanupPartials(): Promise<number> {
    let removed = 0;
    const walk = async (directory: string) => {
      try {
        for await (const entry of Deno.readDir(directory)) {
          const path = join(directory, entry.name);
          if (entry.isDirectory) await walk(path);
          else if (entry.name.endsWith(".part")) {
            await Deno.remove(path).catch(() => {});
            removed++;
          }
        }
      } catch {
        /* nothing to walk */
      }
    };
    await walk(this.root);
    if (removed > 0) {
      log.info("Removed interrupted attachment writes", { removed });
    }
    return removed;
  }

  closeAll(): void {
    for (const handle of [...this.writes.keys()]) {
      void this.abortWrite(handle);
    }
  }
}

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
