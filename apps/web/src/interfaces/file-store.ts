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

import { IFileStorage, File } from "@notesnook/streamable-fs";
import { IndexedDBKVStore } from "./key-value";
import OriginPrivateFileStoreWorker from "./opfs.worker?worker";
import { OriginPrivateFileStoreWorkerType } from "./opfs.worker";
import { transfer, wrap } from "comlink";

export class IndexedDBFileStore implements IFileStorage {
  storage: IndexedDBKVStore;
  constructor(name: string) {
    this.storage = new IndexedDBKVStore(name, name);
  }

  clear(): Promise<void> {
    return this.storage.clear();
  }
  setMetadata(filename: string, metadata: File): Promise<void> {
    return this.storage.set(filename, metadata);
  }
  getMetadata(filename: string): Promise<File | undefined> {
    return this.storage.get(filename);
  }
  deleteMetadata(filename: string): Promise<void> {
    return this.storage.delete(filename);
  }
  writeChunk(chunkName: string, data: Uint8Array): Promise<void> {
    return this.storage.set(chunkName, data);
  }
  deleteChunk(chunkName: string): Promise<void> {
    return this.storage.delete(chunkName);
  }
  readChunk(chunkName: string): Promise<Uint8Array | undefined> {
    return this.storage.get(chunkName);
  }
  async listChunks(chunkPrefix: string): Promise<string[]> {
    const keys = await this.storage.keys();
    return keys.filter((k) =>
      (k as string).startsWith(chunkPrefix)
    ) as string[];
  }

  async chunkSize(chunkName: string): Promise<number> {
    const chunk = await this.storage.get<Uint8Array>(chunkName);
    return chunk?.length || 0;
  }

  async list(): Promise<string[]> {
    return (await this.storage.keys()) as string[];
  }
}

export class CacheStorageFileStore implements IFileStorage {
  storage: IndexedDBKVStore;
  constructor(private readonly name: string) {
    this.storage = new IndexedDBKVStore(name, name);
    console.log("USING CACHE FILE STORE!");
  }

  private getCache() {
    return window.caches.open(this.name);
  }

  async clear(): Promise<void> {
    const cache = await this.getCache();
    for (const req of await cache.keys()) {
      await cache.delete(req);
    }
    return this.storage.clear();
  }

  setMetadata(filename: string, metadata: File): Promise<void> {
    return this.storage.set(filename, metadata);
  }

  getMetadata(filename: string): Promise<File | undefined> {
    return this.storage.get(filename);
  }

  deleteMetadata(filename: string): Promise<void> {
    return this.storage.delete(filename);
  }

  async writeChunk(chunkName: string, data: Uint8Array): Promise<void> {
    const cache = await this.getCache();
    await cache.put(
      this.toURL(chunkName),
      new Response(data, {
        headers: {
          "Content-Length": data.length.toString(),
          "Content-Type": "application/encrypted-octet-stream"
        }
      })
    );
  }

  async deleteChunk(chunkName: string): Promise<void> {
    const cache = await this.getCache();
    await cache.delete(this.toURL(chunkName));
  }

  async readChunk(chunkName: string): Promise<Uint8Array | undefined> {
    const cache = await this.getCache();
    const response = await cache.match(this.toURL(chunkName));
    return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
  }

  async listChunks(chunkPrefix: string): Promise<string[]> {
    const cache = await this.getCache();
    const keys = await cache.keys();
    return keys
      .filter((k) => k.url.includes(`/${chunkPrefix}`))
      .map((r) => r.url.slice(r.url.lastIndexOf("/") + 1));
  }

  async list(): Promise<string[]> {
    const cache = await this.getCache();
    const keys = await cache.keys();
    return keys.map((r) => r.url.slice(1));
  }

  async chunkSize(chunkName: string): Promise<number> {
    const cache = await this.getCache();
    const response = await cache.match(this.toURL(chunkName));
    const length = response?.headers.get("Content-Length");
    if (length) return parseInt(length);
    return response ? (await response.arrayBuffer()).byteLength : 0;
  }

  private toURL(chunkName: string) {
    return `/${chunkName}`;
  }
}

/**
 * Attachment store backed by the desktop runtime (Openotes).
 *
 * The runtime assigns the interface a different loopback port on every
 * launch, so the page's origin — and with it OPFS, CacheStorage and
 * IndexedDB — changes between runs. Attachment content stored there is
 * orphaned on restart, which is data loss. On desktop the chunks therefore
 * live on the runtime side of the bindings, in a per-hash chunked store
 * that the WebDAV sync engine reads and writes directly.
 *
 * Chunk boundaries are preserved exactly: every chunk streamable-fs writes
 * is one encrypted secretstream frame, and the runtime stores each one as
 * its own file. Binary payloads travel base64-encoded, like every other
 * binary RPC procedure.
 */
export class DesktopFileStore implements IFileStorage {
  private async call(path: string, input?: unknown): Promise<unknown> {
    const bindings = (
      globalThis as {
        bindings?: {
          rpc(request: { path: string; input?: unknown }): Promise<
            | { ok: true; result: unknown }
            | { ok: false; error: { message: string } }
          >;
        };
      }
    ).bindings;
    if (!bindings) throw new Error("The desktop runtime is not available");
    const response = await bindings.rpc({ path, input });
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }

  async clear(): Promise<void> {
    await this.call("attachments.clear", { confirm: "clear" });
  }

  async setMetadata(filename: string, metadata: File): Promise<void> {
    await this.call("attachments.setMetadata", { filename, metadata });
  }

  async getMetadata(filename: string): Promise<File | undefined> {
    const result = await this.call("attachments.getMetadata", { filename });
    return result ? (result as File) : undefined;
  }

  async deleteMetadata(filename: string): Promise<void> {
    await this.call("attachments.deleteMetadata", { filename });
  }

  async writeChunk(chunkName: string, data: Uint8Array): Promise<void> {
    await this.call("attachments.writeChunk", {
      chunkName,
      data: bytesToBase64(data)
    });
  }

  async deleteChunk(chunkName: string): Promise<void> {
    await this.call("attachments.deleteChunk", { chunkName });
  }

  async readChunk(chunkName: string): Promise<Uint8Array | undefined> {
    const result = await this.call("attachments.readChunk", { chunkName });
    return typeof result === "string" ? base64ToBytes(result) : undefined;
  }

  async chunkSize(chunkName: string): Promise<number> {
    const result = await this.call("attachments.chunkSize", { chunkName });
    return typeof result === "number" ? result : 0;
  }

  async listChunks(chunkPrefix: string): Promise<string[]> {
    const result = await this.call("attachments.listChunks", { chunkPrefix });
    return Array.isArray(result) ? (result as string[]) : [];
  }

  async list(): Promise<string[]> {
    const result = await this.call("attachments.list");
    return Array.isArray(result) ? (result as string[]) : [];
  }

  /**
   * Remove one attachment wholesale — metadata and every chunk in a single
   * round trip, instead of one RPC call per chunk. Not part of
   * IFileStorage; used by the desktop paths in interfaces/fs.ts.
   */
  async deleteFile(filename: string): Promise<boolean> {
    return (await this.call("attachments.deleteFile", { filename })) === true;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

export class OriginPrivateFileSystem implements IFileStorage {
  private readonly worker = wrap<OriginPrivateFileStoreWorkerType>(
    new OriginPrivateFileStoreWorker()
  );
  private created = false;
  constructor(private readonly name: string) {
    console.log("using origin private file store");
  }
  private async create() {
    if (this.created) return;
    await this.worker.create(this.name, this.name);
    this.created = true;
  }
  async clear(): Promise<void> {
    await this.create();
    await this.worker.clear(this.name);
  }
  async setMetadata(filename: string, metadata: File): Promise<void> {
    await this.create();
    await this.worker.setMetadata(this.name, filename, metadata);
  }
  async getMetadata(filename: string): Promise<File | undefined> {
    await this.create();
    return this.worker.getMetadata(this.name, filename);
  }
  async deleteMetadata(filename: string): Promise<void> {
    await this.create();
    return this.worker.deleteMetadata(this.name, filename);
  }
  async writeChunk(chunkName: string, data: Uint8Array): Promise<void> {
    await this.create();
    return this.worker.writeChunk(
      this.name,
      chunkName,
      transfer(data.buffer, [data.buffer])
    );
  }
  async deleteChunk(chunkName: string): Promise<void> {
    await this.create();
    return this.worker.deleteChunk(this.name, chunkName);
  }
  async readChunk(chunkName: string): Promise<Uint8Array | undefined> {
    await this.create();
    return this.worker.readChunk(this.name, chunkName);
  }
  async listChunks(chunkPrefix: string): Promise<string[]> {
    await this.create();
    return (await this.worker.listChunks(this.name, chunkPrefix)) || [];
  }
  async chunkSize(chunkName: string): Promise<number> {
    await this.create();
    return await this.worker.chunkSize(this.name, chunkName);
  }
  async list(): Promise<string[]> {
    await this.create();
    return (await this.worker.list(this.name)) || [];
  }
}
