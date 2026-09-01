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
  PutOptions,
  RemoteCapabilities,
  RemoteEntry,
  RemoteStorage,
  SyncError,
} from "@notesnook/sync-core";
import { WebDavClient } from "./client.ts";

/**
 * A WebDAV server seen as an object store.
 *
 * This is a thin translation and holds no state: the retry policy, timeouts,
 * conditional headers and error mapping all stay in WebDavClient, which the
 * integration suite exercises against real servers.
 *
 * Two WebDAV warts are absorbed here rather than leaking outward:
 *
 *  1. PROPFIND returns hrefs, not repository-relative paths. `list` converts
 *     them once, so no caller needs a second `relativePath` round trip.
 *  2. Create-if-absent needs *two* defences, not one. A conforming server
 *     answers `If-None-Match: *` with 412, but some — dufs among them, caught
 *     by the integration suite — accept the header and ignore it, which would
 *     silently clobber a journal entry. So an explicit existence probe runs
 *     first. This used to live in SyncRepository.writeBatch; it belongs here,
 *     because it is a property of this backend rather than of the protocol.
 */
export class WebDavRemoteStorage implements RemoteStorage {
  constructor(private readonly client: WebDavClient) {}

  /** OPTIONS on the base URL: proves reachability and authentication. */
  async probe(): Promise<void> {
    await this.client.options();
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const entries = await this.client.list(path);
    return entries.map((entry) => ({
      path: this.client.relativePath(entry),
      isCollection: entry.isCollection,
      size: entry.contentLength,
      version: entry.etag,
      modifiedAt: entry.lastModified,
    }));
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const head = await this.client.head(path);
    if (!head.exists) return undefined;
    return {
      path: path.replace(/^\/+/, "").replace(/\/+$/, ""),
      isCollection: path.endsWith("/"),
      size: head.contentLength,
      version: head.etag,
    };
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

  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    // Defence one: ask. See the class comment for why this is not redundant.
    if (await this.client.exists(path)) {
      throw new SyncError(
        `${path} already exists on the server`,
        "precondition-failed",
        412,
      );
    }
    // Defence two: tell the server, for the servers that honour it.
    const { etag } = await this.client.put(path, body, {
      ifNoneMatch: true,
      contentType: options?.contentType,
    });
    return { path, isCollection: false, size: body.length, version: etag };
  }

  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const { etag } = await this.client.put(path, body, {
      ifMatch: expectedVersion,
      contentType: options?.contentType,
    });
    return { path, isCollection: false, size: body.length, version: etag };
  }

  delete(path: string): Promise<void> {
    return this.client.delete(path);
  }

  move(from: string, to: string, overwrite = true): Promise<void> {
    return this.client.move(from, to, overwrite);
  }

  mkdirp(path: string): Promise<void> {
    return this.client.mkcolRecursive(path);
  }

  verifyUpload(path: string, expectedLength: number): Promise<void> {
    return this.client.verifyUpload(path, expectedLength);
  }

  /**
   * Reported rather than probed. `atomicCreate` is true because the probe plus
   * the conditional header together make a same-path race lose — the loser
   * sees 412 either from the server or from the probe, and advances.
   *
   * `serverSideMove` reflects MOVE being a real verb here; whether a given
   * server implements it is discovered at call time, and the rebuild path
   * already handles a server that does not.
   */
  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      atomicCreate: true,
      conditionalUpdate: true,
      serverSideMove: true,
    });
  }

  /** Escape hatch for the few places that still need WebDAV itself. */
  get webdav(): WebDavClient {
    return this.client;
  }
}
