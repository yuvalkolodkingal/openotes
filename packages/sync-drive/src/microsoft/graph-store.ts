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
 * The RemoteStore over OneDrive, through Microsoft Graph.
 *
 * EVERYTHING IS UNDER THE APP FOLDER. The registration asks for
 * `Files.ReadWrite.AppFolder` and nothing else, so Graph will only ever
 * show this app `/me/drive/special/approot` and what is inside it. The rest
 * of the user's OneDrive is invisible here, which is the point: a bug in a
 * path cannot reach their documents. The folder is created by the service
 * the first time something asks for it, which is what `connect` does.
 *
 * PATHS ARE ADDRESSABLE, SO THERE IS NO ID WALK. Unlike Google Drive, Graph
 * will resolve a whole path in one request — `approot:/a/b/c.bin:` — so
 * this adapter never has to walk a chain of folder ids or cache one, and
 * two devices writing the same tree cannot disagree about which folder id a
 * name means. Each segment is percent-encoded (`encodePath`); encoding the
 * path in one call would turn "a/b" into a single oddly named file.
 *
 * `create` IS A REAL ATOMIC CREATE. `@microsoft.graph.conflictBehavior=fail`
 * makes the service itself refuse to write over an occupied name and answer
 * 409 `nameAlreadyExists`, having written nothing. That is why the
 * capabilities below say "native" and why nothing here emulates
 * exclusivity — the append-only journal rests on exactly this.
 *
 * WHY THERE IS STILL A PROPAGATION GRACE. A read of an item Graph just
 * wrote is consistent, but a *listing* is served from an index that lags:
 * a batch written on one device can be missing from the parent's children
 * on another for several seconds. The journal reader decides a batch is
 * lost from a listing, so declaring zero here would make it skip past a
 * batch that is merely young — permanently.
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
  AuthorizedFetch,
  type AuthorizedRequest,
  type AuthorizedResponse,
  decodeJson,
} from "../http/authorized-fetch.ts";
import {
  baseName,
  encodePath,
  normalizeDirectory,
  parentPath,
  splitPath,
} from "../path.ts";
import type { DriveStoreOptions } from "../types.ts";
import {
  asRecord,
  graphError,
  hasGraphCode,
  nameTaken,
  ONEDRIVE_LABEL,
  refineTransportError,
} from "./errors.ts";
import {
  type GraphRequester,
  SIMPLE_UPLOAD_LIMIT,
  uploadLargeFile,
} from "./upload.ts";

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/** The only part of the drive this app can see. */
const APP_ROOT = "/me/drive/special/approot";

/** What `list` asks for. Anything else would be paid for on every page. */
const LIST_SELECT = "name,size,folder,file,lastModifiedDateTime";

/** Graph's own maximum for a children page; fewer would mean more pages. */
const LIST_PAGE_SIZE = 200;

/** See "WHY THERE IS STILL A PROPAGATION GRACE" above. */
const LISTING_PROPAGATION_GRACE_MS = 15_000;

export const ONEDRIVE_CAPABILITIES: RemoteStoreCapabilities = {
  label: ONEDRIVE_LABEL,
  /** conflictBehavior=fail: the service refuses the write, not the store. */
  conditionalCreate: "native",
  propagationGraceMs: LISTING_PROPAGATION_GRACE_MS,
  /** One PATCH relocates a folder and everything beneath it. */
  atomicDirectoryMove: true,
  /**
   * A Graph write commits whole: until it does, the old item (or nothing)
   * is what a reader sees, so there is no window in which a partial file is
   * visible and nothing to wait out.
   */
  settleMs: 0,
};

export interface GraphStoreOptions extends DriveStoreOptions {
  /**
   * Overrides the client built from `tokens`. Adapter tests inject one
   * whose delay() does not really sleep; the desktop app leaves it unset.
   */
  http?: GraphRequester;
  /** Overrides the API root, so a test can point the store at a fake. */
  baseUrl?: string;
}

export class GraphStore implements RemoteStore {
  readonly capabilities: RemoteStoreCapabilities = ONEDRIVE_CAPABILITIES;

  private readonly http: GraphRequester;
  private readonly baseUrl: string;
  /** The repository root inside the app folder; "" for the folder itself. */
  private readonly directory: string;

  constructor(options: GraphStoreOptions) {
    this.directory = normalizeDirectory(options.directory);
    this.baseUrl = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, "");
    this.http = options.http ?? new AuthorizedFetch({
      tokens: options.tokens,
      fetch: options.fetch,
      requestTimeout: options.requestTimeout,
      maxRetries: options.maxRetries,
    });
  }

  async connect(): Promise<void> {
    // A GET on the app folder is both the cheapest proof that the token is
    // accepted with the AppFolder scope and what makes Graph provision the
    // folder: it does not exist until something asks for it, and every
    // path below is relative to it.
    const response = await this.request({
      url: withQuery(this.itemUrl(""), { "$select": "id,name" }),
    });
    if (response.status !== 200) {
      throw graphError(response, `open the ${ONEDRIVE_LABEL} app folder`);
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const prefix = path.replace(/\/+$/, "");
    const origin = new URL(this.baseUrl).origin;
    const entries: RemoteEntry[] = [];
    let url = withQuery(this.childrenUrl(path), {
      "$select": LIST_SELECT,
      "$top": String(LIST_PAGE_SIZE),
    });

    for (;;) {
      const response = await this.request({ url });
      // The interface asks for an empty listing rather than a failure: the
      // engine lists directories a fresh repository has not created yet.
      if (response.status === 404) return [];
      if (response.status !== 200) {
        throw graphError(response, `list ${describePath(path)}`);
      }

      const page = asRecord(decodeJson(response));
      const values = page?.value;
      if (!Array.isArray(values)) {
        throw new SyncError(
          `${ONEDRIVE_LABEL} answered a listing of ${describePath(path)} ` +
            `with no entries array`,
          "corrupt-data",
          response.status,
        );
      }
      for (const value of values) {
        const entry = toRemoteEntry(prefix, value);
        if (entry) entries.push(entry);
      }

      const next = page?.["@odata.nextLink"];
      if (typeof next !== "string" || next.length === 0) return entries;
      // A page that points at itself is a service bug, and following it
      // would list the same children until the process ran out of memory.
      if (next === url) {
        throw new SyncError(
          `${ONEDRIVE_LABEL} returned a listing page of ` +
            `${describePath(path)} that repeats itself`,
          "corrupt-data",
          response.status,
        );
      }
      url = assertSameOrigin(next, origin, path);
    }
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.request({
      url: withQuery(this.itemUrl(path), { "$select": "id" }),
    });
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw graphError(response, `check ${path}`);
  }

  async get(path: string): Promise<Uint8Array> {
    const body = await this.getIfExists(path);
    if (body === undefined) {
      throw new SyncError(
        `${path} is not in the ${ONEDRIVE_LABEL} sync folder`,
        "not-found",
        404,
      );
    }
    return body;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    // Graph answers this with a 302 to a pre-authorized download host.
    // AuthorizedFetch follows it by hand and drops the bearer token as the
    // origin changes, so nothing here has to know it happened.
    const response = await this.request({ url: this.contentUrl(path) });
    if (response.status === 404) return undefined;
    if (response.status !== 200) throw graphError(response, `read ${path}`);
    return response.body;
  }

  put(path: string, body: Uint8Array, options: PutOptions = {}): Promise<void> {
    return this.upload(path, body, "replace", options);
  }

  create(
    path: string,
    body: Uint8Array,
    options: PutOptions = {},
  ): Promise<void> {
    return this.upload(path, body, "fail", options);
  }

  async delete(path: string): Promise<void> {
    // A DELETE on a folder in Graph takes everything under it, so a path
    // that resolves to the repository root would take the repository with
    // it. Nothing in the protocol deletes the root; a caller that arrives
    // here with one has a bug, and carrying it out is unrecoverable.
    if (splitPath(path).length === 0) {
      throw new SyncError(
        `Refusing to delete the ${ONEDRIVE_LABEL} sync folder itself`,
        "corrupt-data",
      );
    }
    const response = await this.request({
      url: this.itemUrl(path),
      method: "DELETE",
    });
    // 404 is the state the caller asked for, not a failure.
    if (
      response.status === 204 || response.status === 200 ||
      response.status === 404
    ) {
      return;
    }
    throw graphError(response, `delete ${path}`);
  }

  move(from: string, to: string): Promise<void> {
    return this.relocate(from, to);
  }

  /**
   * The same PATCH as `move`. Graph relocates a folder and its whole
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
   * Walking only the store-relative part would POST the first subfolder
   * into a parent that is not there yet on the first device to sync into a
   * fresh account, and nothing else ever creates it.
   */
  async makeDirectory(path: string): Promise<void> {
    let parent = "";
    for (const segment of splitPath(this.remotePath(path))) {
      const child = parent === "" ? segment : `${parent}/${segment}`;
      await this.makeOneDirectory(parent, segment, child);
      parent = child;
    }
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const response = await this.request({
      url: withQuery(this.itemUrl(path), { "$select": "size" }),
    });
    if (response.status === 404) {
      throw new SyncError(
        `Upload verification failed: ${path} is not in the ` +
          `${ONEDRIVE_LABEL} sync folder`,
        "corrupt-data",
        response.status,
      );
    }
    if (response.status !== 200) {
      throw graphError(response, `verify ${path}`);
    }
    const size = asRecord(decodeJson(response))?.size;
    if (typeof size !== "number") {
      throw new SyncError(
        `Upload verification failed: ${ONEDRIVE_LABEL} did not report a ` +
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
   * Every request in this file goes through here so the one failure
   * AuthorizedFetch cannot classify — a 507, which it reads as retryable
   * from the status alone and which from Graph means the drive is full —
   * is corrected in a single place. See refineTransportError.
   */
  private async request(
    request: AuthorizedRequest,
  ): Promise<AuthorizedResponse> {
    try {
      return await this.http.request(request);
    } catch (error) {
      throw error instanceof SyncError ? refineTransportError(error) : error;
    }
  }

  private async upload(
    path: string,
    body: Uint8Array,
    conflictBehavior: "fail" | "replace",
    options: PutOptions,
  ): Promise<void> {
    if (body.length > SIMPLE_UPLOAD_LIMIT) {
      // Graph refuses a single PUT this large. The session carries the same
      // conflict behaviour, so `create` stays exclusive at any size.
      await uploadLargeFile({
        // Its own wrapper, not the bare client, so a large upload reports
        // a full drive the same way a small one does.
        http: { request: (request) => this.request(request) },
        sessionUrl: `${this.itemUrl(path)}/createUploadSession`,
        body,
        conflictBehavior,
        path,
      });
      return;
    }

    const response = await this.request({
      url: withQuery(this.contentUrl(path), {
        "@microsoft.graph.conflictBehavior": conflictBehavior,
      }),
      method: "PUT",
      headers: {
        "Content-Type": options.contentType ?? "application/octet-stream",
      },
      body,
    });
    if (response.status === 200 || response.status === 201) return;
    if (
      conflictBehavior === "fail" &&
      hasGraphCode(response, "nameAlreadyExists")
    ) {
      throw nameTaken(path, response.status);
    }
    throw graphError(response, `write ${path}`);
  }

  private async relocate(from: string, to: string): Promise<void> {
    const name = baseName(to);
    if (name.length === 0 || splitPath(from).length === 0) {
      throw new SyncError(
        `Cannot move ${JSON.stringify(from)} to ${JSON.stringify(to)}: ` +
          `both must name an item, not the sync folder itself`,
        "corrupt-data",
      );
    }

    const parent = parentPath(to);
    // Graph rejects the PATCH when the destination folder is missing, where
    // a WebDAV MOVE would create it. Creating it here keeps `move` landing
    // the same way on every backend.
    await this.makeDirectory(parent);
    // The destination is named by id, not by path: `parentReference.path`
    // is only defined against a handful of well-known roots, and a path
    // spelled relative to the app folder is not one of them.
    const parentId = await this.itemId(parent, `move ${from} to ${to}`);

    const response = await this.request({
      url: this.itemUrl(from),
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        parentReference: { id: parentId },
        // `move` overwrites, the same as WebDAV's Overwrite: T, so a
        // rebuild can be promoted over the remains of an earlier attempt.
        "@microsoft.graph.conflictBehavior": "replace",
      }),
    });
    if (response.status === 200) return;
    throw graphError(response, `move ${from} to ${to}`);
  }

  private async itemId(path: string, action: string): Promise<string> {
    const response = await this.request({
      url: withQuery(this.itemUrl(path), { "$select": "id" }),
    });
    if (response.status !== 200) throw graphError(response, action);
    const id = asRecord(decodeJson(response))?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new SyncError(
        `${ONEDRIVE_LABEL} did not report an id for ${describePath(path)}`,
        "corrupt-data",
        response.status,
      );
    }
    return id;
  }

  /**
   * `parent` and `path` are relative to the app folder, not to the store
   * root — makeDirectory walks the configured directory as well.
   */
  private async makeOneDirectory(
    parent: string,
    name: string,
    path: string,
  ): Promise<void> {
    // Asking first, rather than creating and reading the 409 as success:
    // this runs on every sync for a handful of fixed folders that are
    // already there every time but the first, and the check is one request
    // where create-then-confirm is two.
    const existing = await this.request({
      url: withQuery(this.remoteItemUrl(path), { "$select": "id,folder" }),
    });
    if (existing.status === 200) {
      if (asRecord(asRecord(decodeJson(existing))?.folder) !== undefined) {
        return;
      }
      throw new SyncError(
        `Cannot create the folder ${path} in ${ONEDRIVE_LABEL}: a file of ` +
          `that name is in the way.`,
        "conflict",
        existing.status,
      );
    }
    if (existing.status !== 404) {
      throw graphError(existing, `check the folder ${path}`);
    }

    const response = await this.request({
      url: `${this.remoteItemUrl(parent)}/children`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        folder: {},
        // "fail", never "replace" or "rename": replace deletes the folder
        // another device created a moment ago and everything inside it,
        // and rename would silently split the repository in two.
        "@microsoft.graph.conflictBehavior": "fail",
      }),
    });
    if (response.status === 201 || response.status === 200) return;
    // Another device created it between the check and the POST, which is
    // the state this method was asked to reach.
    if (hasGraphCode(response, "nameAlreadyExists")) return;
    throw graphError(response, `create the folder ${path}`);
  }

  // ---- addressing ----

  /**
   * `approot:/<path>:` is Graph's path addressing, and it is only legal
   * when there is a path: the app folder itself is the bare resource, and
   * `approot:/:` is a 400.
   */
  private itemUrl(path: string): string {
    const encoded = encodePath(
      joinPath(this.directory, assertSafePath(path)),
    );
    const root = `${this.baseUrl}${APP_ROOT}`;
    return encoded === "" ? root : `${root}:/${encoded}:`;
  }

  private contentUrl(path: string): string {
    return `${this.itemUrl(path)}/content`;
  }

  private childrenUrl(path: string): string {
    return `${this.itemUrl(path)}/children`;
  }
}

/** For call sites that want a RemoteStore without knowing the class. */
export function graphStore(options: GraphStoreOptions): RemoteStore {
  return new GraphStore(options);
}

/**
 * Graph's OData parameters are named with "$" and "@", which
 * URLSearchParams percent-encodes. RFC 3986 allows both unescaped in a
 * query and every Graph sample writes them that way, so the names go in
 * verbatim and only the values are escaped.
 */
function withQuery(url: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
  return query === "" ? url : `${url}?${query}`;
}

function toRemoteEntry(
  prefix: string,
  value: unknown,
): RemoteEntry | undefined {
  const item = asRecord(value);
  if (!item) return undefined;
  const name = item.name;
  // A name is chosen by whoever wrote the item, and OneDrive forbids a "/"
  // in one. Were the service ever to hand one over anyway, joining it would
  // produce a path describing a different item than the one listed — which
  // the caller would then read, move or delete.
  if (typeof name !== "string" || name === "" || name.includes("/")) {
    return undefined;
  }
  const isDirectory = asRecord(item.folder) !== undefined;
  const modified = typeof item.lastModifiedDateTime === "string"
    ? Date.parse(item.lastModifiedDateTime)
    : Number.NaN;
  return {
    path: joinPath(prefix, name),
    isDirectory,
    // Graph reports a folder's size as the total of everything under it,
    // which is not what RemoteEntry.size means.
    size: !isDirectory && typeof item.size === "number" ? item.size : undefined,
    // A timestamp Graph omitted or mangled is left unset rather than
    // reported as the epoch, which callers that delete by age (backup
    // pruning) would read as "very old".
    modifiedAt: Number.isFinite(modified) ? modified : undefined,
  };
}

/**
 * `@odata.nextLink` is a URL the service chooses and that we then send the
 * bearer token to. Graph always names itself in it; a foreign origin would
 * be a live token handed to a host nobody decided to trust, so it ends the
 * listing instead of starting a request.
 */
function assertSameOrigin(
  next: string,
  origin: string,
  path: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(next);
  } catch {
    throw new SyncError(
      `${ONEDRIVE_LABEL} returned an unparsable next page for ` +
        `${describePath(path)}`,
      "corrupt-data",
    );
  }
  if (parsed.origin !== origin) {
    throw new SyncError(
      `Refusing to continue a ${ONEDRIVE_LABEL} listing at ` +
        `${parsed.origin}, which is not the API`,
      "insecure-url",
    );
  }
  return parsed.toString();
}

function describePath(path: string): string {
  return path.replace(/\/+$/, "") || "the sync folder";
}
