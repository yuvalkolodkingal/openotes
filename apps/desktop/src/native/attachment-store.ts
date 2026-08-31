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
import { attachmentsDir, ensureDir, sanitizeSegment } from "./paths.ts";
import { logger } from "./logger.ts";

const log = logger.scope("attachments");

/**
 * Chunked attachment storage on the Deno side — the canonical location for
 * attachment content in this fork.
 *
 * Upstream kept attachment blobs in the webview's origin storage (OPFS,
 * CacheStorage or IndexedDB, via `packages/streamable-fs`). That cannot
 * work here: the runtime assigns the interface a different loopback port on
 * every launch, so the page's origin — and everything stored under it — is
 * orphaned across restarts. Attachment bytes therefore live on the
 * filesystem and the renderer reaches them through the `attachments.*` RPC
 * procedures, exactly mirroring the `IFileStorage` interface streamable-fs
 * already programs against.
 *
 * Layout, one directory per attachment hash with a two-level fan-out:
 *
 *     attachments/<aa>/<bb>/<hash>/meta.json   the streamable-fs File object
 *     attachments/<aa>/<bb>/<hash>/0, 1, ...   one file per stored chunk
 *
 * Chunk boundaries are semantic, not incidental: the renderer encrypts each
 * 512 KiB plaintext block into one XChaCha20-Poly1305 secretstream frame
 * (512 KiB + 17 bytes) and stores each frame as one chunk. Decryption feeds
 * stored chunks straight into the secretstream, so a chunk must come back
 * exactly as it was written — never merged, never re-split. Every whole-file
 * view in this class (readStream, writeStream) preserves that invariant.
 *
 * Content arrives already encrypted from the renderer's crypto worker, so
 * this layer never sees plaintext and never needs a key.
 */

/** Poly1305 tag bytes appended to every secretstream frame. */
export const SECRETSTREAM_ABYTES = 17;

/** Plaintext block size the renderer encrypts per frame (fs.ts CHUNK_SIZE). */
export const RENDERER_CHUNK_SIZE = 512 * 1024;

/** On-disk size of every non-final chunk the renderer writes. */
export const ENCRYPTED_CHUNK_SIZE = RENDERER_CHUNK_SIZE + SECRETSTREAM_ABYTES;

/** The streamable-fs `File` metadata object, stored as meta.json. */
export interface AttachmentMetadata {
  filename: string;
  size: number;
  type: string;
  additionalData?: Record<string, unknown>;
}

const META_FILE = "meta.json";
const MAX_METADATA_JSON = 256_000;

/**
 * Attachment file names are content hashes (xxhash64 hex) plus the
 * renderer's transient `<hash>-temp` names. Anything else is refused before
 * it can touch the filesystem.
 */
const FILE_NAME_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

/** Chunk indices as the renderer generates them: canonical decimal. */
const CHUNK_INDEX_PATTERN = /^(0|[1-9][0-9]{0,5})$/;

const CHUNK_INFIX = "-chunk-";

export function assertAttachmentName(name: string): string {
  if (
    typeof name !== "string" ||
    !FILE_NAME_PATTERN.test(name) ||
    sanitizeSegment(name) !== name
  ) {
    throw new Error(`Invalid attachment name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Parse a streamable-fs chunk key (`<filename>-chunk-<index>`). The split is
 * on the *last* `-chunk-` so a filename containing the infix still parses.
 */
export function parseChunkName(
  chunkName: string,
): { filename: string; index: number } {
  if (typeof chunkName !== "string" || chunkName.length > 200) {
    throw new Error("Invalid chunk name");
  }
  const at = chunkName.lastIndexOf(CHUNK_INFIX);
  if (at <= 0) {
    throw new Error(`Invalid chunk name: ${JSON.stringify(chunkName)}`);
  }
  const filename = assertAttachmentName(chunkName.slice(0, at));
  const indexText = chunkName.slice(at + CHUNK_INFIX.length);
  if (!CHUNK_INDEX_PATTERN.test(indexText)) {
    throw new Error(`Invalid chunk index: ${JSON.stringify(indexText)}`);
  }
  return { filename, index: Number(indexText) };
}

export class AttachmentChunkStore {
  constructor(private readonly root: string = attachmentsDir()) {}

  private dirFor(filename: string): string {
    const safe = assertAttachmentName(filename);
    // Two-level fan-out keeps directories small on big vaults.
    return join(this.root, safe.slice(0, 2), safe.slice(2, 4), safe);
  }

  private chunkPath(chunkName: string): string {
    const { filename, index } = parseChunkName(chunkName);
    return join(this.dirFor(filename), String(index));
  }

  // ------------------------------------------------------------------
  // IFileStorage operations (driven by the renderer over RPC)
  // ------------------------------------------------------------------

  async setMetadata(
    filename: string,
    metadata: AttachmentMetadata,
  ): Promise<void> {
    const directory = this.dirFor(filename);
    const record: AttachmentMetadata = {
      // The name in the metadata is forced to the validated name so a
      // mismatched payload cannot alias another attachment.
      filename,
      size: Number.isFinite(metadata.size) ? Number(metadata.size) : 0,
      type: typeof metadata.type === "string"
        ? metadata.type.slice(0, 256)
        : "application/octet-stream",
      ...(metadata.additionalData !== undefined
        ? { additionalData: metadata.additionalData }
        : {}),
    };
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_METADATA_JSON) {
      throw new Error("Attachment metadata is too large");
    }
    await ensureDir(directory);
    await atomicWrite(
      join(directory, META_FILE),
      new TextEncoder().encode(serialized),
    );
  }

  async getMetadata(
    filename: string,
  ): Promise<AttachmentMetadata | undefined> {
    try {
      const raw = await Deno.readTextFile(
        join(this.dirFor(filename), META_FILE),
      );
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return undefined;
      return parsed as AttachmentMetadata;
    } catch {
      return undefined;
    }
  }

  async deleteMetadata(filename: string): Promise<void> {
    const directory = this.dirFor(filename);
    await Deno.remove(join(directory, META_FILE)).catch(() => {});
    await this.pruneIfEmpty(directory);
  }

  async writeChunk(chunkName: string, data: Uint8Array): Promise<void> {
    const path = this.chunkPath(chunkName);
    await ensureDir(dirOf(path));
    await atomicWrite(path, data);
  }

  async readChunk(chunkName: string): Promise<Uint8Array | undefined> {
    try {
      return await Deno.readFile(this.chunkPath(chunkName));
    } catch {
      return undefined;
    }
  }

  async deleteChunk(chunkName: string): Promise<void> {
    const path = this.chunkPath(chunkName);
    await Deno.remove(path).catch(() => {});
    await this.pruneIfEmpty(dirOf(path));
  }

  async chunkSize(chunkName: string): Promise<number> {
    try {
      return (await Deno.stat(this.chunkPath(chunkName))).size;
    } catch {
      return 0;
    }
  }

  async listChunks(chunkPrefix: string): Promise<string[]> {
    if (
      typeof chunkPrefix !== "string" || !chunkPrefix.endsWith(CHUNK_INFIX)
    ) {
      throw new Error(`Invalid chunk prefix: ${JSON.stringify(chunkPrefix)}`);
    }
    const filename = assertAttachmentName(
      chunkPrefix.slice(0, -CHUNK_INFIX.length),
    );
    const indexes = await this.chunkIndexes(filename);
    return indexes.map((index) => `${filename}${CHUNK_INFIX}${index}`);
  }

  /**
   * Every stored key: each attachment's metadata name plus its chunk keys —
   * the same view the browser-side stores return from their key spaces.
   */
  async list(): Promise<string[]> {
    const keys: string[] = [];
    for await (const { filename, directory } of this.attachmentDirs()) {
      if (await fileExists(join(directory, META_FILE))) keys.push(filename);
      for (const index of await this.chunkIndexes(filename)) {
        keys.push(`${filename}${CHUNK_INFIX}${index}`);
      }
    }
    return keys;
  }

  /** Remove every stored attachment. */
  async clear(): Promise<void> {
    await Deno.remove(this.root, { recursive: true }).catch(() => {});
    await ensureDir(this.root);
  }

  /** Remove one attachment wholesale: metadata and every chunk. */
  async deleteFile(filename: string): Promise<boolean> {
    try {
      await Deno.remove(this.dirFor(filename), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Whole-file views (driven by sync and backups)
  // ------------------------------------------------------------------

  /** True when the attachment has committed metadata. */
  async exists(filename: string): Promise<boolean> {
    try {
      return await fileExists(join(this.dirFor(filename), META_FILE));
    } catch {
      return false;
    }
  }

  /** Total stored (encrypted) bytes across all chunks. */
  async size(filename: string): Promise<number> {
    const directory = this.dirFor(filename);
    let total = 0;
    for (const index of await this.chunkIndexes(filename)) {
      try {
        total += (await Deno.stat(join(directory, String(index)))).size;
      } catch {
        // A chunk deleted mid-scan simply does not count.
      }
    }
    return total;
  }

  /** All chunks concatenated. Used by backups, whose format is flat bytes. */
  async readAll(filename: string): Promise<Uint8Array | undefined> {
    const stream = await this.readStream(filename);
    if (!stream) return undefined;
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const part of stream) {
      parts.push(part);
      total += part.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  /**
   * Stream the attachment, one emitted chunk per stored chunk file in
   * numeric order. The sync engine encrypts each emitted chunk as one wire
   * frame, so this is what keeps chunk boundaries intact end to end.
   */
  async readStream(
    filename: string,
  ): Promise<ReadableStream<Uint8Array> | undefined> {
    if (!(await this.exists(filename))) return undefined;
    const directory = this.dirFor(filename);
    const indexes = await this.chunkIndexes(filename);
    let at = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (at >= indexes.length) {
          controller.close();
          return;
        }
        const data = await Deno.readFile(
          join(directory, String(indexes[at++])),
        );
        controller.enqueue(data);
      },
    });
  }

  /**
   * Persist a downloaded attachment: each incoming stream chunk becomes one
   * chunk file, and meta.json is written last as the commit point — a crash
   * mid-write leaves a directory without metadata, which cleanupPartials
   * removes on the next launch.
   */
  async writeStream(
    filename: string,
    stream: ReadableStream<Uint8Array>,
    type = "application/octet-stream",
  ): Promise<void> {
    const directory = this.dirFor(filename);
    // Start from a clean slate so stale chunks from an earlier, larger
    // version can never be read back as part of this one.
    await Deno.remove(directory, { recursive: true }).catch(() => {});
    await ensureDir(directory);

    const reader = stream.getReader();
    let index = 0;
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.length === 0) continue;
        await atomicWrite(join(directory, String(index)), value);
        total += value.length;
        index++;
      }
      // The renderer's integrity check expects `size` to be the plaintext
      // length; every stored chunk is one secretstream frame carrying
      // SECRETSTREAM_ABYTES of authentication overhead.
      await this.setMetadata(filename, {
        filename,
        size: Math.max(0, total - index * SECRETSTREAM_ABYTES),
        type,
      });
    } catch (error) {
      await Deno.remove(directory, { recursive: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Persist contiguous attachment bytes (a backup payload) by re-splitting
   * them at the renderer's fixed frame size. This is deterministic, not
   * arbitrary: every non-final frame the renderer produces is exactly
   * ENCRYPTED_CHUNK_SIZE bytes, and upstream's own download path rebuilds
   * frames from a contiguous blob the same way (fs.ts, ChunkedStream).
   */
  writeContiguous(
    filename: string,
    data: Uint8Array,
    type = "application/octet-stream",
  ): Promise<void> {
    return this.writeStream(
      filename,
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (
            let offset = 0;
            offset < data.length;
            offset += ENCRYPTED_CHUNK_SIZE
          ) {
            controller.enqueue(
              data.subarray(offset, offset + ENCRYPTED_CHUNK_SIZE),
            );
          }
          controller.close();
        },
      }),
      type,
    );
  }

  /** Every committed attachment hash. */
  async listHashes(): Promise<string[]> {
    const hashes: string[] = [];
    for await (const { filename, directory } of this.attachmentDirs()) {
      if (await fileExists(join(directory, META_FILE))) hashes.push(filename);
    }
    return hashes;
  }

  /**
   * Remove debris left by a crash: `.part` temp files everywhere, and
   * attachment directories that never reached their meta.json commit point
   * for writes the runtime performed itself. Directories *with* metadata
   * are kept even when chunks are missing — the renderer wrote metadata
   * first and detects incomplete content through its own size check.
   */
  async cleanupPartials(): Promise<number> {
    let removed = 0;
    for await (const { directory } of this.attachmentDirs()) {
      const hasMeta = await fileExists(join(directory, META_FILE));
      const hasChunks = (await namedEntries(directory)).some((name) =>
        CHUNK_INDEX_PATTERN.test(name)
      );
      if (!hasMeta && hasChunks) {
        await Deno.remove(directory, { recursive: true }).catch(() => {});
        removed++;
        continue;
      }
      for (const name of await namedEntries(directory)) {
        if (name.endsWith(".part")) {
          await Deno.remove(join(directory, name)).catch(() => {});
          removed++;
        }
      }
    }
    if (removed > 0) {
      log.info("Removed interrupted attachment writes", { removed });
    }
    return removed;
  }

  // ------------------------------------------------------------------
  // internals
  // ------------------------------------------------------------------

  private async chunkIndexes(filename: string): Promise<number[]> {
    const indexes: number[] = [];
    try {
      for await (const entry of Deno.readDir(this.dirFor(filename))) {
        if (entry.isFile && CHUNK_INDEX_PATTERN.test(entry.name)) {
          indexes.push(Number(entry.name));
        }
      }
    } catch {
      /* the attachment may not exist */
    }
    return indexes.sort((a, b) => a - b);
  }

  private async *attachmentDirs(): AsyncGenerator<
    { filename: string; directory: string }
  > {
    try {
      for await (const first of Deno.readDir(this.root)) {
        if (!first.isDirectory) continue;
        for await (
          const second of Deno.readDir(join(this.root, first.name))
        ) {
          if (!second.isDirectory) continue;
          const parent = join(this.root, first.name, second.name);
          for await (const entry of Deno.readDir(parent)) {
            if (!entry.isDirectory) continue;
            if (!FILE_NAME_PATTERN.test(entry.name)) continue;
            yield {
              filename: entry.name,
              directory: join(parent, entry.name),
            };
          }
        }
      }
    } catch {
      /* the root may not exist yet */
    }
  }

  private async pruneIfEmpty(directory: string): Promise<void> {
    // Non-recursive on purpose: succeeds only when nothing is left.
    await Deno.remove(directory).catch(() => {});
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

async function namedEntries(directory: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile) names.push(entry.name);
    }
  } catch {
    /* nothing to list */
  }
  return names;
}

/** Write via a temp file and rename, so a torn write is never observable. */
async function atomicWrite(path: string, data: Uint8Array): Promise<void> {
  const tempPath = `${path}.part`;
  const file = await Deno.open(tempPath, {
    create: true,
    write: true,
    truncate: true,
  });
  try {
    let offset = 0;
    while (offset < data.length) {
      offset += await file.write(data.subarray(offset));
    }
    try {
      await file.sync();
    } catch {
      /* sync is best effort on some filesystems */
    }
  } finally {
    file.close();
  }
  await Deno.rename(tempPath, path);
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}
