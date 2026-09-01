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
  contentHashOfBytes,
  type PutOptions,
  type RemoteCapabilities,
  type RemoteEntry,
  type RemoteStorage,
  SyncError,
} from "@notesnook/sync-core";

/**
 * An in-memory folder that behaves like a real object store.
 *
 * Versions change on every write, exactly as a backend's ETag or `rev` does,
 * so tests exercise the same comparisons the real providers will. Directories
 * are implied by paths rather than tracked, which is how Drive, Dropbox and
 * S3 behave and is the stricter assumption for the engine to be written
 * against.
 */
export class FolderStorage implements RemoteStorage {
  private readonly objects = new Map<
    string,
    { body: Uint8Array; version: number }
  >();
  private readonly dirs = new Set<string>();
  private counter = 0;

  /** Paths written since the last reset, for asserting "nothing happened". */
  readonly writes: string[] = [];

  /** Set to make putNew non-atomic, the way Google Drive is. */
  allowDuplicateCreate = false;

  paths(): string[] {
    return [...this.objects.keys()].sort();
  }

  probe(): Promise<void> {
    return Promise.resolve();
  }

  list(path: string): Promise<RemoteEntry[]> {
    const prefix = path.replace(/^\/+/, "").replace(/\/+$/, "");
    const out = new Map<string, RemoteEntry>();
    const consider = (key: string, isCollection: boolean) => {
      if (prefix && !key.startsWith(prefix + "/")) return;
      const rest = prefix ? key.slice(prefix.length + 1) : key;
      if (!rest) return;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        const stored = this.objects.get(key);
        out.set(key, {
          path: key,
          isCollection,
          size: stored?.body.length,
          version: stored ? `v${stored.version}` : undefined,
        });
      } else {
        // An implied intermediate directory.
        const dir = (prefix ? prefix + "/" : "") + rest.slice(0, slash);
        out.set(dir, { path: dir, isCollection: true });
      }
    };
    for (const key of this.objects.keys()) consider(key, false);
    for (const key of this.dirs) consider(key, true);
    return Promise.resolve([...out.values()]);
  }

  stat(path: string): Promise<RemoteEntry | undefined> {
    const stored = this.objects.get(path);
    return Promise.resolve(
      stored
        ? {
          path,
          isCollection: false,
          size: stored.body.length,
          version: `v${stored.version}`,
        }
        : undefined,
    );
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(path));
  }

  get(path: string): Promise<Uint8Array> {
    const stored = this.objects.get(path);
    if (!stored) {
      return Promise.reject(new SyncError(`missing ${path}`, "not-found", 404));
    }
    return Promise.resolve(stored.body);
  }

  getIfExists(path: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.objects.get(path)?.body);
  }

  putNew(
    path: string,
    body: Uint8Array,
    _options?: PutOptions,
  ): Promise<RemoteEntry> {
    if (this.objects.has(path) && !this.allowDuplicateCreate) {
      return Promise.reject(
        new SyncError(`${path} exists`, "precondition-failed", 412),
      );
    }
    return this.write(path, body);
  }

  putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    _options?: PutOptions,
  ): Promise<RemoteEntry> {
    if (expectedVersion !== undefined) {
      const stored = this.objects.get(path);
      const actual = stored ? `v${stored.version}` : undefined;
      if (actual !== expectedVersion) {
        return Promise.reject(
          new SyncError(`${path} moved on`, "precondition-failed", 412),
        );
      }
    }
    return this.write(path, body);
  }

  private write(path: string, body: Uint8Array): Promise<RemoteEntry> {
    this.counter++;
    this.objects.set(path, { body, version: this.counter });
    this.writes.push(path);
    return Promise.resolve({
      path,
      isCollection: false,
      size: body.length,
      version: `v${this.counter}`,
    });
  }

  delete(path: string): Promise<void> {
    this.objects.delete(path);
    return Promise.resolve();
  }

  move(from: string, to: string): Promise<void> {
    const stored = this.objects.get(from);
    if (stored) {
      this.objects.delete(from);
      this.counter++;
      this.objects.set(to, { body: stored.body, version: this.counter });
    }
    return Promise.resolve();
  }

  mkdirp(path: string): Promise<void> {
    this.dirs.add(path.replace(/\/+$/, ""));
    return Promise.resolve();
  }

  verifyUpload(path: string, expectedLength: number): Promise<void> {
    const stored = this.objects.get(path);
    if (!stored || stored.body.length !== expectedLength) {
      return Promise.reject(
        new SyncError(`verification failed for ${path}`, "corrupt-data"),
      );
    }
    return Promise.resolve();
  }

  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      atomicCreate: !this.allowDuplicateCreate,
      conditionalUpdate: true,
      serverSideMove: true,
    });
  }

  /** Content hash of a stored object, for assertions. */
  hashOf(path: string): string | undefined {
    const stored = this.objects.get(path);
    return stored ? contentHashOfBytes(stored.body) : undefined;
  }
}
