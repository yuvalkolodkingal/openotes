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
 * The seam between a synchronization engine and whatever holds the bytes.
 *
 * WHY THIS SHAPE, AND NOT WEBDAV'S
 *
 * The first backend was WebDAV, and its verbs leaked everywhere: PROPFIND,
 * MKCOL and MOVE were the vocabulary the engine spoke. None of those exist on
 * Google Drive, Dropbox or OneDrive, which address objects by id or by path
 * and express "list" as a paginated query. So this interface is shaped like an
 * object store, and each backend maps its own protocol onto it.
 *
 * TWO PRIMITIVES CARRY THE CORRECTNESS ARGUMENT
 *
 * `putNew` is create-if-absent and `putUpdate` is compare-and-swap. Every
 * safety property the engines rely on — an immutable journal entry that a
 * second writer cannot clobber, a note file that a stale device cannot
 * overwrite — reduces to one of those two. Backends differ in how well they
 * can honour them, which is why `capabilities()` exists and is not decoration:
 *
 *   Dropbox   files/upload mode=add + autorename:false, and mode=update:<rev>
 *   OneDrive  @microsoft.graph.conflictBehavior=fail, and If-Match: <eTag>
 *   WebDAV    If-None-Match:* plus an existence probe, and If-Match: <etag>
 *   Drive     neither — duplicate names are legal and v3 dropped conditional
 *             update, so both are emulated read-then-write and can race
 *
 * A caller that needs a hard guarantee must check `capabilities()` rather than
 * assume, and degrade to conflict copies where the guarantee is unavailable.
 *
 * PATHS
 *
 * Every path is relative to the repository root, uses forward slashes, and
 * never begins with one. Backends that address objects by id keep their own
 * path-to-id map; callers never see an id.
 */

/** One object or collection in a remote store. */
export interface RemoteEntry {
  /** Repository-relative path, e.g. "devices/abc/changes/0000000001.bin". */
  path: string;
  isCollection: boolean;
  /** Size in bytes, when the backend reports one. */
  size?: number;
  /**
   * Opaque per-object version: a WebDAV ETag, a Dropbox `rev`, a Graph `eTag`,
   * a Drive `headRevisionId`. Compared for equality only — never parsed, never
   * ordered, never assumed to be a hash.
   */
  version?: string;
  /** Whatever timestamp the backend reported, unparsed. */
  modifiedAt?: string;
}

/** What a backend can actually guarantee. See the note above. */
export interface RemoteCapabilities {
  /**
   * `putNew` is enforced by the backend rather than emulated with a
   * read-then-write. False on Google Drive, where two writers can both create
   * a file with the same name.
   */
  atomicCreate: boolean;
  /** `putUpdate` can reject a stale write using `expectedVersion`. */
  conditionalUpdate: boolean;
  /** `move` is a server-side rename rather than copy-then-delete. */
  serverSideMove: boolean;
}

export interface PutOptions {
  contentType?: string;
}

export interface RemoteStorage {
  /**
   * Verify the remote is reachable and the credentials work, without writing
   * anything.
   *
   * Separate from `capabilities()`, which is static metadata: this one makes a
   * real request and is what "Test connection" calls and what a sync cycle
   * runs before touching data, so an expired token surfaces as a clear
   * unauthorized error rather than as a confusing mid-sync failure.
   *
   * WebDAV sends OPTIONS; Drive calls about.get; Dropbox
   * users/get_current_account; Graph GET /me/drive.
   */
  probe(): Promise<void>;

  /**
   * Direct children of `path`. Returns repository-relative paths, so callers
   * never need a second call to convert an href back into a path — that
   * conversion was a WebDAV wart and does not belong in the interface.
   * A missing collection lists as empty rather than throwing.
   */
  list(path: string): Promise<RemoteEntry[]>;

  /** Metadata for one object, or undefined when it does not exist. */
  stat(path: string): Promise<RemoteEntry | undefined>;

  exists(path: string): Promise<boolean>;

  /** Throws SyncError("not-found") when the object is absent. */
  get(path: string): Promise<Uint8Array>;

  /** Returns undefined instead of throwing when the object is absent. */
  getIfExists(path: string): Promise<Uint8Array | undefined>;

  /**
   * Create an object that must not already exist.
   *
   * Throws SyncError("precondition-failed") when it does. Callers treat that
   * as "someone else got there first" and advance rather than retrying the
   * same path — see the journal's next-free-sequence walk.
   */
  putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry>;

  /**
   * Overwrite an object. When `expectedVersion` is given the write must fail
   * with SyncError("precondition-failed") if the remote version has moved on;
   * when it is omitted the write is unconditional.
   */
  putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry>;

  /** Deleting something already absent succeeds. */
  delete(path: string): Promise<void>;

  move(from: string, to: string, overwrite?: boolean): Promise<void>;

  /** Create a collection and any missing parents. Idempotent. */
  mkdirp(path: string): Promise<void>;

  /**
   * Confirm the stored object is the length just written.
   *
   * Not paranoia: a truncated upload that reports success is the failure this
   * catches, and the integration suite has already found a server that
   * accepts a conditional header and ignores it.
   */
  verifyUpload(path: string, expectedLength: number): Promise<void>;

  capabilities(): Promise<RemoteCapabilities>;
}

/** One change reported by a provider's delta feed. */
export interface RemoteChange {
  path: string;
  type: "created" | "modified" | "deleted";
  entry?: RemoteEntry;
}

/**
 * Provider-native change detection, where the backend offers it: Drive's
 * `changes.list` start page token, Dropbox's `list_folder/continue` cursor,
 * Graph's `delta` link. A backend without one (plain WebDAV) simply does not
 * implement this, and its engine falls back to listing.
 *
 * Cursors are opaque strings and must be persisted verbatim.
 */
export interface DeltaSource {
  startCursor(): Promise<string>;
  changesSince(
    cursor: string,
  ): Promise<{ changes: RemoteChange[]; cursor: string }>;
}

export function hasDeltaSource(
  storage: RemoteStorage,
): storage is RemoteStorage & DeltaSource {
  const candidate = storage as Partial<DeltaSource>;
  return typeof candidate.startCursor === "function" &&
    typeof candidate.changesSince === "function";
}
