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
 * The RemoteStore over WebDAV — the original backend, now reached through
 * the same eleven verbs every other backend implements.
 *
 * It is a thin adapter over WebDavClient on purpose: the client already
 * speaks the protocol, including the compatibility fallbacks real servers
 * need, and every failure it raises is already a SyncError with the code
 * the engine expects. The one place this adapter has to think for itself
 * is `moveRecursive`.
 */

import { WebDavClient } from "./client.ts";
import {
  PutOptions,
  RemoteEntry,
  RemoteStore,
  RemoteStoreCapabilities,
  scopedStore,
} from "./store.ts";
import { SyncError } from "./types.ts";
import type { DavEntry } from "./xml.ts";

/**
 * A WebDAV server is immediately consistent: a GET after a PUT returns the
 * new bytes and a PROPFIND after a PUT lists the new file. Both waits are
 * therefore zero, and declaring zero is what makes every "wait before
 * deciding a batch is missing" rule collapse back to today's behaviour —
 * which is why the existing sync tests keep passing unchanged through this
 * store. A backend that needed a grace period would change those tests.
 */
export const WEBDAV_CAPABILITIES: RemoteStoreCapabilities = {
  label: "WebDAV",
  /** If-None-Match: the server itself refuses the write and answers 412. */
  conditionalCreate: "native",
  propagationGraceMs: 0,
  /**
   * True of the MOVE verb, which relocates a whole collection in one
   * request. `moveRecursive` still cannot lean on it — see the note there.
   */
  atomicDirectoryMove: true,
  settleMs: 0,
};

export class WebDavStore implements RemoteStore {
  readonly capabilities: RemoteStoreCapabilities;

  /**
   * `capabilities` overrides only what a particular deployment differs on
   * (a server known to answer MOVE with 405 can declare
   * `atomicDirectoryMove: false`); the rest stays WEBDAV_CAPABILITIES.
   */
  constructor(
    private readonly client: WebDavClient,
    capabilities: Partial<RemoteStoreCapabilities> = {},
  ) {
    this.capabilities = { ...WEBDAV_CAPABILITIES, ...capabilities };
  }

  async connect(): Promise<void> {
    // OPTIONS is the cheapest request that still proves the URL resolves,
    // the credentials are accepted and something WebDAV-shaped answers.
    // Its SyncError is already the message the settings screen shows.
    await this.client.options();
  }

  async list(path: string): Promise<RemoteEntry[]> {
    // A Depth:1 PROPFIND answers with the collection itself alongside its
    // children. The client drops that entry by comparing the *encoded*
    // request path against decoded hrefs, so a segment that needs
    // percent-encoding slips through — and a self entry reaching
    // moveRecursive would send it into the same directory forever.
    const self = trimSlashes(path);
    const entries: RemoteEntry[] = [];
    for (const entry of await this.client.list(path)) {
      const relative = this.client.relativePath(entry);
      if (relative === self) continue;
      entries.push(toRemoteEntry(relative, entry));
    }
    return entries;
  }

  exists(path: string): Promise<boolean> {
    return this.client.exists(path);
  }

  get(path: string): Promise<Uint8Array> {
    return this.client.get(path);
  }

  getIfExists(path: string): Promise<Uint8Array | undefined> {
    return this.client.getIfExists(path);
  }

  async put(
    path: string,
    body: Uint8Array,
    options: PutOptions = {},
  ): Promise<void> {
    // The ETag the client returns is dropped: no call site reads one, and
    // store.ts keeps them out of the interface deliberately.
    await this.client.put(path, body, { contentType: options.contentType });
  }

  async create(
    path: string,
    body: Uint8Array,
    options: PutOptions = {},
  ): Promise<void> {
    // If-None-Match: * — a conforming server writes nothing and answers
    // 412, which the client already turns into a SyncError carrying
    // "precondition-failed". Passing that through untouched is the whole
    // of create()'s contract, so nothing here catches it.
    await this.client.put(path, body, {
      ifNoneMatch: true,
      contentType: options.contentType,
    });
  }

  delete(path: string): Promise<void> {
    // The client already treats a 404 as success, as the interface asks.
    return this.client.delete(path);
  }

  move(from: string, to: string): Promise<void> {
    return this.client.move(from, to, true);
  }

  /**
   * WebDavClient.move falls back to GET + PUT on the servers that answer
   * MOVE with 405 or 501, and that fallback can only carry a file: aimed at
   * a collection it would write the directory's body into a file at `to`
   * and then delete the original tree. Nothing here can tell which kind of
   * server is on the other end — the client hides the fallback — so the
   * subtree is always walked and only files are ever handed to MOVE.
   */
  async moveRecursive(from: string, to: string): Promise<void> {
    if (!(await this.isCollection(from))) {
      // A file, or nothing at all: one MOVE is exactly right and the
      // client's fallback is safe, there being no subtree to flatten.
      // Treating a file as a directory here would destroy it.
      //
      // The parent is created first because the fallback's PUT answers 409
      // when it is missing, where a native MOVE creates it — and this
      // method must not land differently depending on the server.
      const parent = parentPath(to);
      if (parent) await this.makeDirectory(parent);
      await this.move(from, to);
      return;
    }
    await this.moveTree(from, to);
  }

  makeDirectory(path: string): Promise<void> {
    return this.client.mkcolRecursive(collectionPath(path));
  }

  verifyUpload(path: string, expectedLength: number): Promise<void> {
    return this.client.verifyUpload(path, expectedLength);
  }

  scope(prefix: string): RemoteStore {
    return scopedStore(this, prefix);
  }

  private async moveTree(from: string, to: string): Promise<void> {
    await this.makeDirectory(to);
    for (const entry of await this.list(from)) {
      const name = entry.path.split("/").pop();
      if (!name) continue;
      // Both sides are rebuilt from `from` and `to` rather than from the
      // href the server reported, so a server answering with a path outside
      // the subtree cannot make us move something we were not asked to.
      const source = `${trimSlashes(from)}/${name}`;
      const target = `${trimSlashes(to)}/${name}`;
      if (entry.isDirectory) await this.moveTree(source, target);
      else await this.client.move(source, target, true);
    }
    // Depth-first, so by the time a directory is deleted every file under
    // it has already landed at the destination.
    await this.client.delete(collectionPath(from));
  }

  private async isCollection(path: string): Promise<boolean> {
    let entries: DavEntry[];
    try {
      entries = await this.client.propfind(path, 0);
    } catch (e) {
      // PROPFIND asks for "<path>/", which servers answer with 404 both for
      // a plain file and for a path that is not there. Neither is a tree to
      // walk, and the single-MOVE branch handles both correctly.
      if (e instanceof SyncError && e.code === "not-found") return false;
      throw e;
    }
    // Depth:0 describes exactly the resource asked about.
    return entries.length > 0 && entries[0].isCollection;
  }
}

/** For call sites that want a RemoteStore without knowing the class. */
export function webDavStore(client: WebDavClient): RemoteStore {
  return new WebDavStore(client);
}

function toRemoteEntry(path: string, entry: DavEntry): RemoteEntry {
  const modified = entry.lastModified
    ? Date.parse(entry.lastModified)
    : Number.NaN;
  return {
    path,
    isDirectory: entry.isCollection,
    size: entry.contentLength,
    // A server that omits or mangles getlastmodified leaves this unset
    // instead of reporting the epoch, which callers that delete by age
    // (attachment pruning) would read as "very old".
    modifiedAt: Number.isFinite(modified) ? modified : undefined,
  };
}

/** WebDAV addresses a collection with a trailing slash. */
function collectionPath(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Everything above the last segment; "" when the path is at the root. */
function parentPath(path: string): string {
  const trimmed = trimSlashes(path);
  const cut = trimmed.lastIndexOf("/");
  return cut === -1 ? "" : trimmed.slice(0, cut);
}
