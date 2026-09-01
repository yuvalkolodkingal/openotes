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
 * The RemoteStore over Google Drive.
 *
 * Two facts about Drive shape everything here, and both of them are
 * absences. It has no paths — see path-index.ts, which is where a path
 * becomes a file id — and it has no exclusive create: nothing in the API
 * will refuse to write a name that is taken, because Drive does not think
 * two files sharing a name in a folder is a problem at all.
 *
 * The journal rests entirely on `create` refusing to clobber, so this store
 * emulates it and declares `conditionalCreate: "reconciled"` to say so. The
 * emulation is: look before writing, write, wait for the write to become
 * visible, look again, and if someone else got there in the meantime apply
 * the same deterministic tie-break every device applies on the read path.
 * The loser deletes ITS OWN file and reports `precondition-failed`, exactly
 * as a native conditional create would have. It never deletes the winner —
 * that file is what some other device has already recorded as written, and
 * removing it would lose a journal entry that device will never send again.
 *
 * The two waits in the capabilities are the price of that. `settleMs` is
 * how long a write takes to be visible to the next read, and it is what
 * makes the look-again meaningful rather than a query against a replica
 * that has seen neither create. `propagationGraceMs` is how long a batch
 * written on another device may be missing before the engine is allowed to
 * conclude it is gone.
 */

import {
  assertSafePath,
  joinPath,
  type PutOptions,
  type RemoteEntry,
  type RemoteStore,
  type RemoteStoreCapabilities,
  scopedStore,
  SyncError,
} from "@notesnook/sync-remote";
import {
  baseName,
  normalizeDirectory,
  parentPath,
  splitPath,
} from "../path.ts";
import type { DriveStoreOptions } from "../types.ts";
import {
  DriveTransport,
  expectJson,
  expectOk,
  GOOGLE_DRIVE_LABEL,
} from "./errors.ts";
import {
  DRIVE_FILE_FIELDS,
  DRIVE_FILES_URL,
  type DriveFile,
  DrivePathIndex,
  includeFile,
  isFolder,
  parseDriveFile,
  pickWinner,
} from "./path-index.ts";
import { uploadFile } from "./upload.ts";

/** Same default as the shared HTTP client, for the metadata calls. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** What the sync protocol writes: opaque encrypted blobs. */
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export const GOOGLE_DRIVE_CAPABILITIES: RemoteStoreCapabilities = {
  label: GOOGLE_DRIVE_LABEL,
  /** Emulated — Drive has no primitive for it. See the note above. */
  conditionalCreate: "reconciled",
  /**
   * Drive is not read-your-writes across devices: a file uploaded on one
   * can take tens of seconds to appear in another's file list. Treating a
   * batch that is merely still propagating as lost would make the engine
   * skip past it and never come back, so it waits this long first.
   */
  propagationGraceMs: 30_000,
  /**
   * A file's parent is a field on the file, so relocating a folder — with
   * every descendant it has — is one PATCH. No listing is walked and there
   * is no window in which half the tree is at each end.
   */
  atomicDirectoryMove: true,
  /**
   * How long an upload takes to turn up in a query on the same account.
   * This is what the reconciliation in `create` waits out before deciding
   * it was alone.
   */
  settleMs: 2_000,
};

export interface GoogleDriveStoreOptions extends DriveStoreOptions {
  /** Injectable so tests do not spend real seconds asleep. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable so tests get a predictable jitter. */
  random?: () => number;
}

export class GoogleDriveStore implements RemoteStore {
  readonly capabilities: RemoteStoreCapabilities = GOOGLE_DRIVE_CAPABILITIES;

  private readonly transport: DriveTransport;
  private readonly index: DrivePathIndex;
  private readonly directory: string;
  private readonly requestTimeout: number;

  constructor(options: GoogleDriveStoreOptions) {
    if (options.tokens.provider !== "googledrive") {
      // The token manager owns the account, and one holding a Dropbox grant
      // would send a bearer token Google rejects with a 401 the user cannot
      // act on. Failing at construction names the real mistake.
      throw new SyncError(
        `${GOOGLE_DRIVE_LABEL} was given a ${options.tokens.provider} ` +
          `account to sign in with`,
        "corrupt-data",
      );
    }
    this.directory = normalizeDirectory(options.directory);
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.transport = new DriveTransport({
      tokens: options.tokens,
      fetch: options.fetch,
      requestTimeout: options.requestTimeout,
      maxRetries: options.maxRetries,
      delay: options.delay,
      random: options.random,
    });
    this.index = new DrivePathIndex({
      transport: this.transport,
      directory: this.directory,
      settleMs: this.capabilities.settleMs,
    });
  }

  async connect(): Promise<void> {
    // Everything remembered belongs to the previous session's view of the
    // account, and a reconnect is exactly when the folder may have been
    // renamed, deleted or replaced from another device.
    this.index.clear();
    // Resolving — and, the first time, creating — the repository folder is
    // the cheapest request that proves all of the things that can be wrong
    // at once: the refresh token still works, the Drive API is enabled for
    // the user's own OAuth client, the drive.file scope was granted, and
    // the configured directory is usable.
    await this.index.ensureDirectory("");
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const action = `list ${this.locate(path)}`;
    const folderId = await this.index.directoryId(path);
    // The contract: a directory that is not there lists as empty.
    if (folderId === undefined) return [];
    const prefix = splitPath(path).join("/");

    const byName = new Map<string, DriveFile[]>();
    for (const child of await this.index.listChildren(folderId, action)) {
      // A Drive name may contain a slash, which the store's path language
      // has no way to spell: passing it through would invent a directory
      // level that nothing can resolve afterwards. Nothing this store
      // writes has one, so such a file was put there by hand.
      if (child.name.length === 0 || child.name.includes("/")) continue;
      const bucket = byName.get(child.name);
      if (bucket) bucket.push(child);
      else byName.set(child.name, [child]);
    }

    const entries: RemoteEntry[] = [];
    for (const [name, candidates] of byName) {
      // One entry per name, chosen the same way `get` and `create` choose:
      // reporting both halves of an unreconciled duplicate would hand the
      // engine two records at one path.
      const winner = pickWinner(candidates);
      if (!winner) continue;
      const childPath = joinPath(prefix, name);
      this.index.remember(childPath, winner);
      entries.push(toRemoteEntry(childPath, winner));
    }
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    // Refreshed rather than cached: a remembered id only proves the file
    // was there when we last looked, and every caller of exists() is about
    // to act on the answer — the rebuild moves a whole generation on it.
    return (await this.index.resolve(path, { refresh: true })) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const body = await this.getIfExists(path);
    if (body === undefined) {
      throw new SyncError(
        `${this.locate(path)} is not in ${GOOGLE_DRIVE_LABEL}`,
        "not-found",
      );
    }
    return body;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const action = `read ${this.locate(path)}`;
    try {
      return await this.withFile(path, async (file) => {
        if (isFolder(file)) throw this.folderInTheWay(path, action);
        const url = new URL(
          `${DRIVE_FILES_URL}/${encodeURIComponent(file.id)}`,
        );
        url.searchParams.set("alt", "media");
        const response = await this.transport.request(
          { url: url.toString() },
          action,
        );
        if (response.status === 404) {
          throw new SyncError(
            `Could not ${action}: it is not there`,
            "not-found",
          );
        }
        return expectOk(response, action).body;
      });
    } catch (error) {
      // Deleted between the lookup and the read — by another device, or by
      // the user in the Drive web UI. "Not there" is the answer this method
      // is defined to give as undefined rather than as a failure.
      if (error instanceof SyncError && error.code === "not-found") {
        return undefined;
      }
      throw error;
    }
  }

  async put(
    path: string,
    body: Uint8Array,
    options: PutOptions = {},
  ): Promise<void> {
    const action = `write ${this.locate(path)}`;
    const name = this.fileName(path, action);
    const parentId = await this.index.ensureDirectory(parentPath(path));
    const replaced = await this.withFile(path, (file) => {
      if (isFolder(file)) throw this.folderInTheWay(path, action);
      // Replacing the content of the file that already holds this path,
      // rather than adding a second one beside it — which is what a plain
      // create would do here, and what would fork the path in two.
      return this.upload(action, { fileId: file.id, name, body, options });
    });
    const file = replaced ??
      await this.upload(action, { parentId, name, body, options });
    this.index.remember(path, file);
  }

  async create(
    path: string,
    body: Uint8Array,
    options: PutOptions = {},
  ): Promise<void> {
    const action = `create ${this.locate(path)}`;
    const name = this.fileName(path, action);
    const parentId = await this.index.ensureDirectory(parentPath(path));

    // The pre-check. It is not the guarantee — two devices can both pass it
    // in the same second — but it is what makes the ordinary case, a
    // journal entry that is already there, cost one query and write nothing
    // at all.
    const before = await this.index.findByName(parentId, name, action);
    const existing = pickWinner(before);
    if (existing) {
      this.index.remember(path, existing);
      throw this.alreadyTaken(path);
    }

    const created = await this.upload(action, {
      parentId,
      name,
      body,
      options,
    });

    // Let the write become visible before asking who else wrote one.
    // Without the wait the query can be answered by a replica that has seen
    // neither create, and both devices conclude they were alone — which is
    // the fork this whole method exists to prevent.
    await this.transport.sleep(this.capabilities.settleMs);
    const after = includeFile(
      await this.index.findByName(parentId, name, action),
      // Ours is added when the listing has not caught up with it, so a
      // half-propagated answer cannot make us think the other device's file
      // is the only one and delete ours for nothing.
      created,
    );
    const winner = pickWinner(after) ?? created;
    if (winner.id === created.id) {
      this.index.remember(path, created);
      return;
    }

    // We lost. Delete OUR file — never the winner, which another device has
    // already recorded as written — and report the path as taken, which is
    // what a native conditional create would have said before writing
    // anything. The caller takes the next sequence number and tries again.
    this.index.forget(path);
    await this.index.deleteFile(
      created.id,
      `remove our duplicate of ${this.locate(path)}`,
    );
    throw this.alreadyTaken(path);
  }

  async delete(path: string): Promise<void> {
    const action = `delete ${this.locate(path)}`;
    // Resolved fresh, never from the cache: a remembered id that another
    // device has already deleted answers 404, which delete() is required to
    // treat as success — and the file actually holding the path would
    // quietly survive.
    const resolved = await this.index.resolve(path, { refresh: true });
    if (resolved === undefined) return;
    if (isFolder(resolved.file)) {
      await this.assertEmptyFolder(resolved.file, action);
    }
    await this.index.deleteFile(resolved.file.id, action);
    this.index.forget(path);
  }

  async move(from: string, to: string): Promise<void> {
    const action = `move ${this.locate(from)} to ${this.locate(to)}`;
    const name = this.fileName(to, action);
    const resolved = await this.index.resolve(from, { refresh: true });
    if (resolved === undefined) {
      throw new SyncError(
        `Could not ${action}: the source is not in ${GOOGLE_DRIVE_LABEL}`,
        "not-found",
      );
    }
    const parentId = await this.index.ensureDirectory(parentPath(to));

    // WebDAV's MOVE with Overwrite: T, which is the behaviour the engine's
    // rebuild expects. Drive would otherwise keep both files under the one
    // name and leave the tie-break to decide which of them a reader sees,
    // and for a rebuild that means half the account reading the retired
    // generation.
    const occupant = await this.index.resolve(to, { refresh: true });
    if (occupant && occupant.file.id !== resolved.file.id) {
      if (isFolder(occupant.file)) {
        await this.assertEmptyFolder(occupant.file, action);
      }
      await this.index.deleteFile(occupant.file.id, action);
      this.index.forgetSubtree(to);
    }

    const url = new URL(
      `${DRIVE_FILES_URL}/${encodeURIComponent(resolved.file.id)}`,
    );
    url.searchParams.set("fields", DRIVE_FILE_FIELDS);
    const parents = resolved.file.parents ?? [];
    if (!parents.includes(parentId)) {
      url.searchParams.set("addParents", parentId);
      // A Drive file has exactly one parent, and adding a second without
      // naming the one to drop is refused — the file would stay where it
      // was while the request reported success.
      if (parents.length > 0) {
        url.searchParams.set("removeParents", parents.join(","));
      }
    }
    const response = await this.transport.request({
      url: url.toString(),
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name }),
    }, action);
    const moved = parseDriveFile(expectJson(response, action), action);

    // One parent change carries every descendant with it, so every path
    // remembered under either end now names something that has moved.
    this.index.forgetSubtree(from);
    this.index.forgetSubtree(to);
    this.index.remember(to, moved);
  }

  /**
   * The same single call as `move`: a folder is a file, its parent is a
   * field, and changing that field relocates the entire subtree at once.
   * That is what `atomicDirectoryMove: true` promises, and it is why this
   * store never walks a tree — a walk is where a directory move turns into
   * a directory listing written into a file.
   */
  moveRecursive(from: string, to: string): Promise<void> {
    return this.move(from, to);
  }

  async makeDirectory(path: string): Promise<void> {
    await this.index.ensureDirectory(path);
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    // Refreshed on purpose. This is the check that decides whether a record
    // may be marked synchronized, so it has to be Drive's current answer
    // and not the response we cached when we wrote it. Re-resolving also
    // re-runs the duplicate tie-break, so the size compared is the size of
    // the file every other device will actually read.
    const resolved = await this.index.resolve(path, { refresh: true });
    if (resolved === undefined) {
      throw new SyncError(
        `Upload verification failed: ${this.locate(path)} is not in ` +
          `${GOOGLE_DRIVE_LABEL}`,
        "corrupt-data",
      );
    }
    const size = resolved.file.size;
    if (size === undefined) {
      throw new SyncError(
        `Upload verification failed: ${GOOGLE_DRIVE_LABEL} reported no ` +
          `size for ${this.locate(path)}`,
        "corrupt-data",
      );
    }
    if (size !== expectedLength) {
      throw new SyncError(
        `Upload verification failed: ${this.locate(path)} holds ${size} ` +
          `bytes, expected ${expectedLength}`,
        "corrupt-data",
      );
    }
  }

  scope(prefix: string): RemoteStore {
    return scopedStore(this, prefix);
  }

  /**
   * Run `operation` against the file at `path`, re-resolving once when the
   * id came from the cache and Drive says it is gone.
   *
   * Another device can delete and recreate a path between two syncs — that
   * is what every reconciliation does — and without this, every later
   * request against the remembered id answers 404 for the rest of the
   * session. Undefined means there is nothing at the path at all.
   */
  private async withFile<T>(
    path: string,
    operation: (file: DriveFile) => Promise<T>,
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = await this.index.resolve(path, {
        refresh: attempt > 0,
      });
      if (resolved === undefined) return undefined;
      try {
        return await operation(resolved.file);
      } catch (error) {
        const stale = resolved.fromCache && error instanceof SyncError &&
          error.code === "not-found";
        // A freshly resolved id that answers 404 really is gone; only a
        // remembered one earns a second look.
        if (!stale) throw error;
        this.index.forget(path);
      }
    }
    return undefined;
  }

  private async upload(
    action: string,
    request: {
      name: string;
      body: Uint8Array;
      options: PutOptions;
      fileId?: string;
      parentId?: string;
    },
  ): Promise<DriveFile> {
    try {
      return await uploadFile({
        transport: this.transport,
        name: request.name,
        body: request.body,
        contentType: request.options.contentType ?? DEFAULT_CONTENT_TYPE,
        fileId: request.fileId,
        parentId: request.parentId,
        requestTimeout: this.requestTimeout,
        action,
      });
    } catch (error) {
      // A 404 from an upload means a folder id this session remembered
      // names a folder that is no longer there: another device rebuilt the
      // repository, or the user moved the folder to the Drive trash.
      // Dropping the index makes the next attempt walk — and recreate — the
      // whole chain instead of failing this way until the app restarts.
      if (error instanceof SyncError && error.code === "not-found") {
        this.index.clear();
      }
      throw error;
    }
  }

  /**
   * Deleting a folder in Drive takes everything under it with it, and the
   * protocol only ever deletes single files. A path bug that named a
   * directory would otherwise wipe out a device's whole journal in one
   * call, so a folder with anything in it is refused instead.
   */
  private async assertEmptyFolder(
    folder: DriveFile,
    action: string,
  ): Promise<void> {
    const children = await this.index.listChildren(folder.id, action);
    if (children.length === 0) return;
    throw new SyncError(
      `Refusing to ${action}: it is a folder holding ${children.length} ` +
        `items, and deleting a folder in ${GOOGLE_DRIVE_LABEL} deletes ` +
        `everything inside it.`,
      "conflict",
    );
  }

  private fileName(path: string, action: string): string {
    const name = baseName(path);
    if (name === "") {
      throw new SyncError(
        `Could not ${action}: ${JSON.stringify(path)} names the sync ` +
          `folder itself, not a file in it`,
        "corrupt-data",
      );
    }
    return name;
  }

  private folderInTheWay(path: string, action: string): SyncError {
    return new SyncError(
      `Could not ${action}: ${this.locate(path)} is a folder, not a file`,
      "corrupt-data",
    );
  }

  private alreadyTaken(path: string): SyncError {
    return new SyncError(
      `${this.locate(path)} already exists in ${GOOGLE_DRIVE_LABEL}`,
      "precondition-failed",
    );
  }

  /** How a store path is spelled in the user's Drive, for messages. */
  private locate(path: string): string {
    const clean = splitPath(assertSafePath(path)).join("/");
    if (this.directory === "") return clean === "" ? "the account root" : clean;
    return clean === "" ? this.directory : `${this.directory}/${clean}`;
  }
}

/** For call sites that want a RemoteStore without naming the class. */
export function googleDriveStore(
  options: GoogleDriveStoreOptions,
): RemoteStore {
  return new GoogleDriveStore(options);
}

function toRemoteEntry(path: string, file: DriveFile): RemoteEntry {
  const modified = file.modifiedTime ? Date.parse(file.modifiedTime) : NaN;
  return {
    path,
    isDirectory: isFolder(file),
    size: isFolder(file) ? undefined : file.size,
    // Left unset rather than defaulted to the epoch when Drive does not
    // report it: a caller that deletes by age would read 1970 as "very old"
    // and prune a file that was written a minute ago.
    modifiedAt: Number.isFinite(modified) ? modified : undefined,
  };
}
