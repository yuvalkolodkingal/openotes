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
 * The RemoteStore over Dropbox, through the API v2.
 *
 * EVERYTHING IS UNDER THE APP FOLDER. The registration in
 * oauth/endpoints.ts asks for an App-folder app, so the account Dropbox
 * shows this token is a folder of its own and every path the API takes is
 * already relative to it. The rest of the user's Dropbox is invisible here,
 * which is the point: a bug in a path cannot reach their documents. The
 * folder is created when the user authorizes the app, so it is always
 * there before the first request.
 *
 * THE PATH RULES ARE THE WHOLE ADDRESSING STORY. A Dropbox path is the
 * store path with a leading slash and no trailing one, and the root of the
 * app folder is the empty string — not "/", which the API rejects. Nothing
 * is percent-encoded: the path travels in a JSON body or in a header, never
 * in the URL, which is why this adapter has no equivalent of the sibling
 * adapters' `encodePath`. Dropbox is also case-insensitive and
 * case-preserving, so "A.bin" and "a.bin" are one file; the protocol never
 * distinguishes two paths by case alone, and a listing gives back the name
 * as it was written.
 *
 * TWO HOSTS. RPC routes (metadata, listings, moves) are JSON in and JSON
 * out on api.dropboxapi.com; content routes (upload, download) put the
 * argument in the `Dropbox-API-Arg` header and the file in the body, on
 * content.dropboxapi.com. Sending either shape to the other host is a 400,
 * so which host a route lives on is part of calling it.
 *
 * `create` IS A REAL ATOMIC CREATE. An upload with mode "add",
 * `autorename: false` and `strict_conflict: true` makes the service itself
 * refuse an occupied path and answer 409 `path/conflict`, having written
 * nothing. That is why the capabilities below say "native" and why nothing
 * here emulates exclusivity — the append-only journal rests on exactly
 * this.
 *
 * WHY THERE IS STILL A PROPAGATION GRACE. A read of a path Dropbox has just
 * written is consistent, but `list_folder` is served from an index that
 * lags, and the user's own desktop client may be a second writer into the
 * same folder. The journal reader decides a batch is lost from a listing,
 * so declaring zero here would make it skip past a batch that is merely
 * young — permanently.
 */

import {
  assertSafePath,
  joinPath,
  type RemoteEntry,
  type RemoteStore,
  type RemoteStoreCapabilities,
  scopedStore,
  SyncError,
} from "@notesnook/sync-remote";
import {
  AuthorizedFetch,
  type AuthorizedResponse,
} from "../http/authorized-fetch.ts";
import { normalizeDirectory, parentPath, splitPath } from "../path.ts";
import type { DriveStoreOptions } from "../types.ts";
import {
  asRecord,
  DROPBOX_LABEL,
  dropboxError,
  dropboxJson,
  hasTag,
  isNotFound,
} from "./errors.ts";
import { apiArg, type DropboxRequester, uploadFile } from "./upload.ts";

export const DROPBOX_API_URL = "https://api.dropboxapi.com";
export const DROPBOX_CONTENT_URL = "https://content.dropboxapi.com";

/** Dropbox's own maximum for one listing page; fewer would mean more pages. */
const LIST_PAGE_SIZE = 2000;

/** See "WHY THERE IS STILL A PROPAGATION GRACE" above. */
const LISTING_PROPAGATION_GRACE_MS = 15_000;

/**
 * How long a write receipt is worth trusting. Long enough that a caller
 * doing a little work between the write and its `verifyUpload` still hits
 * it, short enough that it cannot outlive the sync cycle that produced it
 * and describe a path another device has since overwritten.
 */
const WRITE_RECEIPT_TTL_MS = 10_000;

/** AuthorizedFetch's own default; only used to scale a large upload. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export const DROPBOX_CAPABILITIES: RemoteStoreCapabilities = {
  label: DROPBOX_LABEL,
  /** mode "add" with strict_conflict: the service refuses the write. */
  conditionalCreate: "native",
  propagationGraceMs: LISTING_PROPAGATION_GRACE_MS,
  /** One files/move_v2 relocates a folder and everything beneath it. */
  atomicDirectoryMove: true,
  /**
   * An upload commits as one revision: until it does, the old file (or
   * nothing) is what a reader sees, so there is no window in which a
   * partial file is visible and nothing to wait out.
   */
  settleMs: 0,
};

export interface DropboxStoreOptions extends DriveStoreOptions {
  /**
   * Overrides the client built from `tokens`. Adapter tests inject one
   * that answers without a network; the desktop app leaves it unset.
   */
  http?: DropboxRequester;
  /** Overrides the API roots, so a test can point the store at a fake. */
  apiUrl?: string;
  contentUrl?: string;
  /**
   * Overridable so an adapter test can walk the upload-session path with a
   * few bytes instead of the 140 MB the real threshold needs.
   */
  sessionThreshold?: number;
  sessionChunkSize?: number;
  /** Injected by tests to make the write receipt's expiry deterministic. */
  now?: () => number;
}

/** What a finished write knows, and `verifyUpload` can use instead of asking. */
interface WriteReceipt {
  /** Store-relative, as the caller spelled it. */
  path: string;
  /** Dropbox's own size, already checked against the bytes that were sent. */
  size: number;
  at: number;
}

export class DropboxStore implements RemoteStore {
  readonly capabilities: RemoteStoreCapabilities = DROPBOX_CAPABILITIES;

  private readonly http: DropboxRequester;
  private readonly apiUrl: string;
  private readonly contentUrl: string;
  /** The repository root inside the app folder; "" for the folder itself. */
  private readonly directory: string;
  private readonly requestTimeout: number;
  private readonly sessionThreshold?: number;
  private readonly sessionChunkSize?: number;
  private readonly now: () => number;

  /**
   * The most recent write, and only that one. A single slot is enough
   * because the engine verifies each write before starting the next, and it
   * means the invalidation rule is "anything that changes a path clears
   * it" rather than a table that has to be kept honest per path.
   */
  private receipt?: WriteReceipt;

  constructor(options: DropboxStoreOptions) {
    this.directory = normalizeDirectory(options.directory);
    this.apiUrl = trimSlashes(options.apiUrl ?? DROPBOX_API_URL);
    this.contentUrl = trimSlashes(options.contentUrl ?? DROPBOX_CONTENT_URL);
    this.requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sessionThreshold = options.sessionThreshold;
    this.sessionChunkSize = options.sessionChunkSize;
    this.now = options.now ?? Date.now;
    this.http = options.http ?? new AuthorizedFetch({
      tokens: options.tokens,
      fetch: options.fetch,
      requestTimeout: options.requestTimeout,
      maxRetries: options.maxRetries,
    });
  }

  async connect(): Promise<void> {
    // A one-entry listing rather than a metadata read: the app folder root
    // has no metadata entry of its own — get_metadata rejects the empty
    // path — and this proves in one request that the token is accepted and
    // that the folder is reachable.
    const response = await this.rpc("files/list_folder", {
      path: this.apiPath(""),
      recursive: false,
      limit: 1,
    });
    // The configured directory does not exist until this store creates it,
    // so a first run against a fresh account answers not_found here and is
    // not a failure.
    if (response.status !== 200 && !isNotFound(response)) {
      throw dropboxError(response, `open the ${DROPBOX_LABEL} app folder`);
    }
    // What turns "reachable" into "usable", which is what the interface
    // asks for: a read proves the token is accepted, and only a write
    // proves the app was granted files.content.write. It also means every
    // later path has its root in place, so a first sync does not depend on
    // the order the repository happens to create things in.
    await this.makeDirectory("");
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const prefix = path.replace(/\/+$/, "");
    const entries: RemoteEntry[] = [];
    let response = await this.rpc("files/list_folder", {
      path: this.apiPath(path),
      recursive: false,
      include_deleted: false,
      limit: LIST_PAGE_SIZE,
    });
    // The interface asks for an empty listing rather than a failure: the
    // engine lists directories a fresh repository has not created yet.
    if (isNotFound(response)) return [];

    let cursor: string | undefined;
    for (;;) {
      if (response.status !== 200) {
        throw dropboxError(response, `list ${describePath(path)}`);
      }
      const page = dropboxJson(response, `list ${describePath(path)}`);
      const values = page.entries;
      if (!Array.isArray(values)) {
        throw new SyncError(
          `${DROPBOX_LABEL} answered a listing of ${describePath(path)} ` +
            `with no entries array`,
          "corrupt-data",
          response.status,
        );
      }
      for (const value of values) {
        const entry = toRemoteEntry(prefix, value);
        if (entry) entries.push(entry);
      }

      if (page.has_more !== true) return entries;
      const next = page.cursor;
      if (typeof next !== "string" || next.length === 0) {
        throw new SyncError(
          `${DROPBOX_LABEL} said the listing of ${describePath(path)} has ` +
            `more pages but gave no cursor`,
          "corrupt-data",
          response.status,
        );
      }
      // A cursor that comes back unchanged is a service bug, and following
      // it would list the same children until the process ran out of
      // memory.
      if (next === cursor) {
        throw new SyncError(
          `${DROPBOX_LABEL} returned a listing page of ` +
            `${describePath(path)} that repeats itself`,
          "corrupt-data",
          response.status,
        );
      }
      cursor = next;
      response = await this.rpc("files/list_folder/continue", { cursor });
    }
  }

  async exists(path: string): Promise<boolean> {
    const target = this.apiPath(path);
    // The app folder has no metadata entry of its own and is created with
    // the authorization, so it is always there. Asking about it would be a
    // malformed_path error rather than an answer.
    if (target === "") return true;
    const response = await this.rpc("files/get_metadata", { path: target });
    if (response.status === 200) return true;
    if (isNotFound(response)) return false;
    throw dropboxError(response, `check ${path}`);
  }

  async get(path: string): Promise<Uint8Array> {
    const body = await this.getIfExists(path);
    if (body === undefined) {
      throw new SyncError(
        `${path} is not in the ${DROPBOX_LABEL} sync folder`,
        "not-found",
        409,
      );
    }
    return body;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const response = await this.http.request({
      url: `${this.contentUrl}/2/files/download`,
      method: "POST",
      // Deliberately no Content-Type and no body: the download route
      // rejects a request that carries either ("unexpected Content-Type
      // header"), which is why this does not go through the RPC helper.
      headers: { "Dropbox-API-Arg": apiArg({ path: this.apiPath(path) }) },
    });
    if (isNotFound(response)) return undefined;
    if (response.status !== 200) throw dropboxError(response, `read ${path}`);
    return response.body;
  }

  /**
   * `PutOptions.contentType` is not taken, here or in `create`: a Dropbox
   * file stores no content type of its own — the API derives one from the
   * extension when something downloads it — so accepting the option would
   * promise something the backend cannot keep.
   */
  put(path: string, body: Uint8Array): Promise<void> {
    return this.upload(path, body, "overwrite");
  }

  create(path: string, body: Uint8Array): Promise<void> {
    return this.upload(path, body, "add");
  }

  async delete(path: string): Promise<void> {
    // delete_v2 on a folder takes everything under it, so a path that
    // resolves to the repository root would take the repository with it.
    // Nothing in the protocol deletes the root; a caller that arrives here
    // with one has a bug, and carrying it out is unrecoverable.
    if (splitPath(path).length === 0) {
      throw new SyncError(
        `Refusing to delete the ${DROPBOX_LABEL} sync folder itself`,
        "corrupt-data",
      );
    }
    const response = await this.rpc("files/delete_v2", {
      path: this.apiPath(path),
    });
    this.receipt = undefined;
    // not_found is the state the caller asked for, not a failure.
    if (response.status === 200 || isNotFound(response)) return;
    throw dropboxError(response, `delete ${path}`);
  }

  move(from: string, to: string): Promise<void> {
    return this.relocate(from, to);
  }

  /**
   * The same move_v2 as `move`. Dropbox relocates a folder and its whole
   * subtree in one request — which is what `atomicDirectoryMove` claims —
   * so there is no walk to do here and no window in which half the tree is
   * at the destination.
   */
  moveRecursive(from: string, to: string): Promise<void> {
    return this.relocate(from, to);
  }

  /**
   * Walked against the app folder rather than the store root, because the
   * configured repository directory is itself a folder that has to exist.
   * Walking only the store-relative part would create the first subfolder
   * inside a parent that is not there yet on the first device to sync into
   * a fresh account, and nothing else ever creates it.
   *
   * One request per segment. create_folder_v2's error union has no way to
   * say "the parent is missing", so a single call for the whole path would
   * depend on undocumented behaviour; the walk is correct either way, and
   * costs nothing after the first run because a folder that is already
   * there answers immediately.
   */
  async makeDirectory(path: string): Promise<void> {
    let parent = "";
    for (const segment of splitPath(this.remotePath(path))) {
      parent = parent === "" ? segment : `${parent}/${segment}`;
      await this.makeOneDirectory(parent);
    }
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const receipt = this.receipt;
    if (
      receipt?.path === path &&
      this.now() - receipt.at < WRITE_RECEIPT_TTL_MS
    ) {
      // The write response is Dropbox's own statement of what it stored,
      // and the upload already checked its content_hash against the bytes
      // that were sent — a stronger answer than the size a fresh metadata
      // read would give, and one request cheaper on the path every journal
      // batch takes.
      if (receipt.size === expectedLength) return;
      throw new SyncError(
        `Upload verification failed: ${DROPBOX_LABEL} stored ` +
          `${receipt.size} bytes at ${path}, expected ${expectedLength}`,
        "corrupt-data",
      );
    }

    const response = await this.rpc("files/get_metadata", {
      path: this.apiPath(path),
    });
    if (isNotFound(response)) {
      throw new SyncError(
        `Upload verification failed: ${path} is not in the ` +
          `${DROPBOX_LABEL} sync folder`,
        "corrupt-data",
        response.status,
      );
    }
    if (response.status !== 200) throw dropboxError(response, `verify ${path}`);

    const size = dropboxJson(response, `verify ${path}`).size;
    if (typeof size !== "number") {
      // A folder, which has no size, is the likely cause: something took
      // the path this file was meant to occupy.
      throw new SyncError(
        `Upload verification failed: ${DROPBOX_LABEL} did not report a ` +
          `size for ${path}`,
        "corrupt-data",
        response.status,
      );
    }
    if (size !== expectedLength) {
      throw new SyncError(
        `Upload verification failed: ${path} holds ${size} bytes, expected ` +
          `${expectedLength}`,
        "corrupt-data",
        response.status,
      );
    }
  }

  scope(prefix: string): RemoteStore {
    return scopedStore(this, prefix);
  }

  // ---- requests ----

  /**
   * An RPC route: the argument as a JSON body, on the API host. Content
   * routes are built where they are used — they carry their argument in a
   * header and disagree about Content-Type, so folding both shapes into
   * one helper would hide the difference that makes them work.
   */
  private rpc(
    route: string,
    arg: Record<string, unknown>,
  ): Promise<AuthorizedResponse> {
    return this.http.request({
      url: `${this.apiUrl}/2/${route}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(arg),
    });
  }

  private async upload(
    path: string,
    body: Uint8Array,
    mode: "add" | "overwrite",
  ): Promise<void> {
    const stored = await uploadFile({
      http: this.http,
      contentUrl: this.contentUrl,
      path: this.apiPath(path),
      displayPath: path,
      body,
      mode,
      requestTimeout: this.requestTimeout,
      sessionThreshold: this.sessionThreshold,
      chunkSize: this.sessionChunkSize,
    });
    // Recorded only after uploadFile has compared this size and Dropbox's
    // content_hash against the bytes sent, so the receipt is a
    // verification that happened rather than a promise that one will.
    this.receipt = { path, size: stored.size, at: this.now() };
  }

  private async relocate(from: string, to: string): Promise<void> {
    if (splitPath(from).length === 0 || splitPath(to).length === 0) {
      throw new SyncError(
        `Cannot move ${JSON.stringify(from)} to ${JSON.stringify(to)}: ` +
          `both must name an item, not the sync folder itself`,
        "corrupt-data",
      );
    }
    // Dropbox creates the parents of an *upload*, but a move into a folder
    // that is not there answers not_found, where a WebDAV MOVE would
    // create it. Creating it here keeps `move` landing the same way on
    // every backend.
    await this.makeDirectory(parentPath(to));
    // The bytes at the receipt's path are about to move away from it.
    this.receipt = undefined;

    const response = await this.relocateOnce(from, to);
    if (response.status === 200) return;
    // `move` overwrites, the same as WebDAV's Overwrite: T, so a rebuild
    // can be promoted over the remains of an earlier attempt. Dropbox has
    // no flag for that — autorename would put the tree at a path nothing
    // reads and call it success — so an occupied destination is removed
    // and the move repeated. Only a conflict earns this; every other
    // failure is reported as it stands.
    if (!hasTag(response, "conflict")) {
      throw dropboxError(response, `move ${from} to ${to}`);
    }
    await this.delete(to);
    const retried = await this.relocateOnce(from, to);
    if (retried.status !== 200) {
      throw dropboxError(retried, `move ${from} to ${to}`);
    }
  }

  private relocateOnce(
    from: string,
    to: string,
  ): Promise<AuthorizedResponse> {
    return this.rpc("files/move_v2", {
      from_path: this.apiPath(from),
      to_path: this.apiPath(to),
      // See relocate: a rename here would hide the failure rather than
      // report it.
      autorename: false,
      allow_ownership_transfer: false,
    });
  }

  /** `remote` is relative to the app folder, not to the store root. */
  private async makeOneDirectory(remote: string): Promise<void> {
    const response = await this.rpc("files/create_folder_v2", {
      path: `/${remote}`,
      autorename: false,
    });
    if (response.status === 200) return;
    if (hasTag(response, "conflict")) {
      // Already there is the state this method was asked to reach —
      // unless what is there is a file, in which case every write below
      // this path would fail against something that cannot become a
      // folder.
      if (!hasTag(response, "file")) return;
      throw new SyncError(
        `Cannot create the folder ${remote} in ${DROPBOX_LABEL}: a file of ` +
          `that name is in the way.`,
        "conflict",
        response.status,
      );
    }
    throw dropboxError(response, `create the folder ${remote}`);
  }

  // ---- addressing ----

  /** A store path as Dropbox sees it: relative to the app folder. */
  private remotePath(path: string): string {
    return joinPath(this.directory, assertSafePath(path));
  }

  /**
   * The Dropbox spelling of a store path: a leading slash, no trailing one,
   * and the empty string for the app folder itself. Dropbox rejects both
   * "a/b" (no leading slash) and "/a/b/" (trailing slash), and answers
   * malformed_path for "/" where the root has to be "".
   */
  private apiPath(path: string): string {
    const remote = this.remotePath(path).replace(/\/+$/, "");
    return remote === "" ? "" : `/${remote}`;
  }
}

/** For call sites that want a RemoteStore without knowing the class. */
export function dropboxStore(options: DropboxStoreOptions): RemoteStore {
  return new DropboxStore(options);
}

function toRemoteEntry(
  prefix: string,
  value: unknown,
): RemoteEntry | undefined {
  const item = asRecord(value);
  if (!item) return undefined;
  const tag = item[".tag"];
  // Anything else is a `deleted` placeholder, which describes a path that
  // is not there any more.
  if (tag !== "file" && tag !== "folder") return undefined;

  const name = item.name;
  // A name is chosen by whoever wrote the item, and Dropbox forbids a "/"
  // in one. Were the service ever to hand one over anyway, joining it
  // would produce a path describing a different item than the one listed
  // — which the caller would then read, move or delete.
  if (typeof name !== "string" || name === "" || name.includes("/")) {
    return undefined;
  }
  const isDirectory = tag === "folder";
  // server_modified is when Dropbox stored the file, which is the only one
  // of the two timestamps a second device can compare against its own
  // clock; client_modified is whatever the writing machine claimed.
  const modified = typeof item.server_modified === "string"
    ? Date.parse(item.server_modified)
    : Number.NaN;
  return {
    path: joinPath(prefix, name),
    isDirectory,
    size: !isDirectory && typeof item.size === "number" ? item.size : undefined,
    // A timestamp Dropbox omitted (every folder) or mangled is left unset
    // rather than reported as the epoch, which callers that delete by age
    // (backup pruning) would read as "very old".
    modifiedAt: Number.isFinite(modified) ? modified : undefined,
  };
}

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function describePath(path: string): string {
  return path.replace(/\/+$/, "") || "the sync folder";
}
