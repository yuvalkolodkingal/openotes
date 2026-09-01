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
  type DeltaSource,
  type PutOptions,
  type RemoteCapabilities,
  type RemoteChange,
  type RemoteEntry,
  type RemoteStorage,
  SyncError,
} from "@notesnook/sync-core";
import { authedFetch, joinPath, type TokenProvider } from "./auth.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * OneDrive, through Microsoft Graph.
 *
 * Like Dropbox, it has both primitives as real features:
 *
 *   putNew     PUT .../content?@microsoft.graph.conflictBehavior=fail
 *   putUpdate  PUT .../content with `if-match: <eTag>`
 *
 * And a delta feed: `/delta` returns a link that encodes the cursor, so
 * change detection is a single request rather than a walk of the folder.
 *
 * WHICH TAG TO COMPARE
 *
 * Graph reports two: `eTag` changes when anything about the item changes,
 * including a move or a metadata edit; `cTag` changes only when the *content*
 * does. Content is what a merge base is about, so cTag is preferred and eTag
 * is the fallback. Using eTag alone would report a note as edited because it
 * was renamed, producing conflict copies nobody asked for.
 */
export class OneDriveStorage implements RemoteStorage, DeltaSource {
  constructor(
    private readonly tokens: TokenProvider,
    /** Folder holding the repository, relative to the drive root. */
    private readonly root: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Graph addresses an item by path with a `:/path:` segment. */
  private itemUrl(path: string, suffix = ""): string {
    const full = joinPath(this.root, path).replace(/^\/+/, "");
    if (!full) return `${GRAPH}/me/drive/root${suffix}`;
    return `${GRAPH}/me/drive/root:/${encodePath(full)}:${suffix}`;
  }

  async probe(): Promise<void> {
    await authedFetch(this.tokens, `${GRAPH}/me/drive`, {}, this.fetchFn);
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    let url: string | undefined = this.itemUrl(path, "/children");
    while (url) {
      const result = await authedFetch(
        this.tokens,
        url,
        { expect: [404] },
        this.fetchFn,
      );
      // A folder that does not exist lists as empty, matching the interface.
      if (result.status === 404) return [];
      const page = result.body as {
        value: GraphItem[];
        "@odata.nextLink"?: string;
      };
      const prefix = joinPath(this.root, path).replace(/^\/+/, "");
      for (const item of page.value) {
        entries.push(
          this.toEntry(item, prefix ? `${prefix}/${item.name}` : item.name),
        );
      }
      url = page["@odata.nextLink"];
    }
    return entries;
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const result = await authedFetch(
      this.tokens,
      this.itemUrl(path),
      { expect: [404] },
      this.fetchFn,
    );
    if (result.status === 404) return undefined;
    return this.toEntry(result.body as GraphItem, normalize(path));
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const bytes = await this.getIfExists(path);
    if (!bytes) {
      throw new SyncError(`${path} is not on OneDrive`, "not-found", 404);
    }
    return bytes;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const result = await authedFetch(
      this.tokens,
      this.itemUrl(path, "/content"),
      { json: false, expect: [404] },
      this.fetchFn,
    );
    if (result.status === 404) return undefined;
    return result.body as Uint8Array;
  }

  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const result = await authedFetch(
      this.tokens,
      this.itemUrl(path, "/content?@microsoft.graph.conflictBehavior=fail"),
      {
        method: "PUT",
        headers: { "content-type": options?.contentType ?? "text/markdown" },
        body: body as unknown as BodyInit,
        expect: [409, 412],
      },
      this.fetchFn,
    );
    if (result.status === 409 || result.status === 412) {
      throw new SyncError(
        `${path} already exists on OneDrive`,
        "precondition-failed",
        412,
      );
    }
    return this.toEntry(result.body as GraphItem, normalize(path));
  }

  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const headers: Record<string, string> = {
      "content-type": options?.contentType ?? "text/markdown",
    };
    if (expectedVersion) headers["if-match"] = expectedVersion;

    const result = await authedFetch(
      this.tokens,
      this.itemUrl(path, "/content"),
      {
        method: "PUT",
        headers,
        body: body as unknown as BodyInit,
        expect: expectedVersion ? [412] : [],
      },
      this.fetchFn,
    );
    if (result.status === 412) {
      throw new SyncError(
        `${path} changed on OneDrive before this write`,
        "precondition-failed",
        412,
      );
    }
    return this.toEntry(result.body as GraphItem, normalize(path));
  }

  async delete(path: string): Promise<void> {
    await authedFetch(
      this.tokens,
      this.itemUrl(path),
      { method: "DELETE", expect: [404] },
      this.fetchFn,
    );
  }

  async move(from: string, to: string, overwrite = true): Promise<void> {
    const target = normalize(joinPath(this.root, to));
    const parent = target.split("/").slice(0, -1).join("/");
    const name = target.split("/").pop()!;

    if (overwrite) {
      // Graph refuses a move onto an existing item; clearing first makes the
      // operation match the interface's overwrite semantics.
      await this.delete(to).catch(() => {});
    }

    await authedFetch(
      this.tokens,
      this.itemUrl(from),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          parentReference: {
            path: `/drive/root:${parent ? "/" + encodePath(parent) : ""}`,
          },
        }),
      },
      this.fetchFn,
    );
  }

  async mkdirp(path: string): Promise<void> {
    const full = normalize(joinPath(this.root, path));
    if (!full) return;
    const parts = full.split("/").filter(Boolean);
    let walked = "";
    for (const part of parts) {
      const parent = walked;
      walked = walked ? `${walked}/${part}` : part;
      const url = parent
        ? `${GRAPH}/me/drive/root:/${encodePath(parent)}:/children`
        : `${GRAPH}/me/drive/root/children`;
      await authedFetch(
        this.tokens,
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: part,
            folder: {},
            // Already existing is success for an idempotent mkdirp.
            "@microsoft.graph.conflictBehavior": "replace",
          }),
          expect: [409],
        },
        this.fetchFn,
      );
    }
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const entry = await this.stat(path);
    if (!entry) {
      throw new SyncError(
        `Upload verification failed: ${path} is not on OneDrive`,
        "corrupt-data",
      );
    }
    if (entry.size !== undefined && entry.size !== expectedLength) {
      throw new SyncError(
        `Upload verification failed: ${path} is ${entry.size} bytes, ` +
          `expected ${expectedLength}`,
        "corrupt-data",
      );
    }
  }

  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      atomicCreate: true,
      conditionalUpdate: true,
      serverSideMove: true,
    });
  }

  // --- DeltaSource ---------------------------------------------------------

  async startCursor(): Promise<string> {
    // `token=latest` asks for a cursor without the current contents, which is
    // what "start watching from now" means.
    const result = await authedFetch(
      this.tokens,
      this.itemUrl("", "/delta?token=latest"),
      { expect: [404] },
      this.fetchFn,
    );
    if (result.status === 404) return "";
    return (result.body as { "@odata.deltaLink"?: string })[
      "@odata.deltaLink"
    ] ??
      "";
  }

  async changesSince(
    cursor: string,
  ): Promise<{ changes: RemoteChange[]; cursor: string }> {
    if (!cursor) return { changes: [], cursor: await this.startCursor() };

    const changes: RemoteChange[] = [];
    let url: string | undefined = cursor;
    let next = cursor;

    while (url) {
      const result = await authedFetch(this.tokens, url, {}, this.fetchFn);
      const page = result.body as {
        value: GraphItem[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      for (const item of page.value) {
        const path = pathOfDeltaItem(item, this.root);
        if (!path) continue;
        changes.push(
          item.deleted
            ? { path, type: "deleted" }
            : { path, type: "modified", entry: this.toEntry(item, path) },
        );
      }
      if (page["@odata.deltaLink"]) next = page["@odata.deltaLink"];
      url = page["@odata.nextLink"];
    }
    return { changes, cursor: next };
  }

  private toEntry(item: GraphItem, path: string): RemoteEntry {
    return {
      path: normalize(path),
      isCollection: item.folder !== undefined,
      size: item.size,
      // cTag changes only with content; eTag also changes on a rename, which
      // would look like an edit and produce conflict copies nobody asked for.
      version: item.cTag ?? item.eTag,
      modifiedAt: item.lastModifiedDateTime,
    };
  }
}

interface GraphItem {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
  deleted?: Record<string, unknown>;
  parentReference?: { path?: string };
}

/** Repository-relative path of a delta item, or undefined if outside the root. */
function pathOfDeltaItem(item: GraphItem, root: string): string | undefined {
  const parentPath = item.parentReference?.path;
  if (!parentPath) return undefined;
  // e.g. "/drive/root:/Openotes/Work"
  const afterRoot = parentPath.replace(/^\/drive\/root:?/, "").replace(
    /^\/+/,
    "",
  );
  const full = afterRoot ? `${afterRoot}/${item.name}` : item.name;
  const prefix = normalize(root);
  if (!prefix) return normalize(full);
  if (full === prefix) return "";
  if (!full.startsWith(prefix + "/")) return undefined;
  return full.slice(prefix.length + 1);
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Percent-encode each segment, keeping the separators. */
function encodePath(path: string): string {
  return normalize(path).split("/").map(encodeURIComponent).join("/");
}
