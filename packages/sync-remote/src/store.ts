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
 * What the sync protocol needs from a place to keep files.
 *
 * The engine never speaks WebDAV, or HTTP, or any provider's API: it reads,
 * writes and lists opaque encrypted blobs at slash-separated paths. This is
 * the whole surface, and it is deliberately the eleven verbs the protocol
 * actually uses and not one more — every extra verb is a thing four
 * implementations have to get right.
 *
 * THE ONE THING THAT MATTERS: `create`
 *
 * `put` overwrites. `create` must not: either the bytes it was given are the
 * sole content at that path afterwards, or it throws `precondition-failed`
 * and nothing was written. The append-only journal rests on this and on
 * nothing else, which is why it is a separate method with its own contract
 * rather than a flag on `put` that an implementation could quietly ignore —
 * which is exactly what some WebDAV servers do with `If-None-Match`.
 *
 * A backend that cannot refuse to clobber an occupied path cannot host the
 * journal, so `conditionalCreate` has no "unsupported" value. Where the
 * backend has no primitive for it (Google Drive allows two files with the
 * same name in the same folder), the store emulates it and says so, and the
 * emulation must still end in one winner and a `precondition-failed` for
 * everyone else.
 *
 * WHY ETAGS ARE NOT HERE
 *
 * Every `put` call site in repository.ts, engine.ts and backup.ts discards
 * the ETag, and `If-Match` has no call site at all. A backend with no ETag
 * story therefore loses nothing, and leaving them out of the interface stops
 * a future change quietly making them load-bearing for backends that cannot
 * provide them.
 */

import { SyncError } from "./types.ts";

/** One entry in a directory listing. Paths are relative to the store root. */
export interface RemoteEntry {
  /** Slash-separated, relative to the store root, no leading slash. */
  path: string;
  isDirectory: boolean;
  /** Bytes, when the backend reports it. */
  size?: number;
  /** Milliseconds since the epoch, when the backend reports it. */
  modifiedAt?: number;
}

export interface RemoteStoreCapabilities {
  /** Shown in the settings screen and in error messages. */
  label: string;
  /**
   * "native": the backend itself refuses to write over an occupied path.
   * "reconciled": the store emulates it — create, look again, pick a
   * deterministic winner, and make the losers fail. Both satisfy `create`'s
   * contract; the difference is only how long a duplicate can exist.
   */
  conditionalCreate: "native" | "reconciled";
  /**
   * How long a write may take to become visible to another device, in
   * milliseconds. A WebDAV server is immediately consistent and declares 0,
   * which makes every "wait before deciding something is missing" rule
   * collapse to today's behaviour. A folder synchronized by a drive client
   * is not: a batch can be absent for minutes and then appear.
   */
  propagationGraceMs: number;
  /** Whether `move` can move a whole directory in one call. */
  atomicDirectoryMove: boolean;
  /**
   * How long to wait after writing before another reader can rely on seeing
   * the whole file. Zero everywhere a write is atomic.
   */
  settleMs: number;
}

export interface PutOptions {
  contentType?: string;
}

/**
 * A place the sync engine can keep encrypted blobs. Every path is relative
 * to the store's root, uses "/" as its separator, and has no leading slash.
 * Directory paths end with "/".
 */
export interface RemoteStore {
  readonly capabilities: RemoteStoreCapabilities;

  /**
   * Check the store is reachable and usable before anything is written.
   * Throws a SyncError describing what is wrong if it is not.
   */
  connect(): Promise<void>;

  /** Immediate children of a directory. Missing directory -> []. */
  list(path: string): Promise<RemoteEntry[]>;

  exists(path: string): Promise<boolean>;

  /** Throws `not-found` when the path does not exist. */
  get(path: string): Promise<Uint8Array>;

  /** undefined rather than throwing when the path does not exist. */
  getIfExists(path: string): Promise<Uint8Array | undefined>;

  /** Write, replacing whatever is there. */
  put(path: string, body: Uint8Array, options?: PutOptions): Promise<void>;

  /**
   * Write only if nothing is there. Throws SyncError("precondition-failed")
   * if the path was taken, having written nothing.
   */
  create(path: string, body: Uint8Array, options?: PutOptions): Promise<void>;

  /** Removing something that is not there is not an error. */
  delete(path: string): Promise<void>;

  /** Move one file. */
  move(from: string, to: string): Promise<void>;

  /**
   * Move a whole subtree. Separate from `move` because a backend can have
   * an atomic directory move (a filesystem rename) or need a file-by-file
   * walk (WebDAV without MOVE), and getting that wrong writes a directory
   * listing into a file.
   */
  moveRecursive(from: string, to: string): Promise<void>;

  /** Create a directory and any missing parents. */
  makeDirectory(path: string): Promise<void>;

  /**
   * Confirm the store really holds `expectedLength` bytes at `path`.
   * The engine never marks a record synchronized before this passes.
   */
  verifyUpload(path: string, expectedLength: number): Promise<void>;

  /** A view of this store rooted at `prefix`. Used by the rebuild staging area. */
  scope(prefix: string): RemoteStore;
}

/** Reject anything that could escape the store root or confuse a backend. */
export function assertSafePath(path: string): string {
  if (path.startsWith("/")) {
    throw new SyncError(
      `Store paths are relative: ${JSON.stringify(path)}`,
      "corrupt-data",
    );
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") {
      throw new SyncError(
        `Invalid path segment in ${JSON.stringify(path)}`,
        "corrupt-data",
      );
    }
    if (segment.includes("\0")) {
      throw new SyncError(
        `Null byte in path ${JSON.stringify(path)}`,
        "corrupt-data",
      );
    }
  }
  return path;
}

export function joinPath(prefix: string, path: string): string {
  const left = prefix.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  if (!left) return right;
  if (!right) return `${left}/`;
  return `${left}/${right}`;
}

/**
 * A view of `inner` rooted at `prefix`, so the rebuild staging area can drive
 * the ordinary repository code without every store implementing it. Nothing
 * below this line knows the prefix exists.
 */
export function scopedStore(inner: RemoteStore, prefix: string): RemoteStore {
  assertSafePath(prefix);
  const to = (path: string) => joinPath(prefix, assertSafePath(path));
  const from = (path: string) => {
    const root = prefix.replace(/\/+$/, "") + "/";
    return path.startsWith(root) ? path.slice(root.length) : path;
  };

  const store: RemoteStore = {
    get capabilities() {
      return inner.capabilities;
    },
    connect: () => inner.connect(),
    async list(path) {
      const entries = await inner.list(to(path));
      return entries.map((entry) => ({ ...entry, path: from(entry.path) }));
    },
    exists: (path) => inner.exists(to(path)),
    get: (path) => inner.get(to(path)),
    getIfExists: (path) => inner.getIfExists(to(path)),
    put: (path, body, options) => inner.put(to(path), body, options),
    create: (path, body, options) => inner.create(to(path), body, options),
    delete: (path) => inner.delete(to(path)),
    move: (a, b) => inner.move(to(a), to(b)),
    moveRecursive: (a, b) => inner.moveRecursive(to(a), to(b)),
    makeDirectory: (path) => inner.makeDirectory(to(path)),
    verifyUpload: (path, length) => inner.verifyUpload(to(path), length),
    scope: (nested) => scopedStore(store, nested),
  };
  return store;
}
