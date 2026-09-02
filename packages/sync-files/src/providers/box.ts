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

import {
  type PutOptions,
  type RemoteCapabilities,
  type RemoteEntry,
  type RemoteStorage,
  SyncError,
} from "@notesnook/sync-core";
import { authedFetch, type TokenProvider } from "./auth.ts";

const API = "https://api.box.com/2.0";
const UPLOAD = "https://upload.box.com/api/2.0";

/**
 * Box as a RemoteStorage.
 *
 * Box addresses everything by id rather than by path, so this keeps a
 * path -> id map the same way the Drive provider does, and invalidates it
 * whenever a name changes. That is the bulk of the code here; the transfer
 * itself is unremarkable.
 *
 * Both primitives are real, which puts Box with Dropbox and OneDrive rather
 * than with Drive:
 *
 *   putNew     POST /files/content with a parent id and a name. Box answers
 *              409 item_name_in_use rather than silently making a second file
 *              with the same name, which is exactly create-if-absent.
 *   putUpdate  POST /files/<id>/content with `If-Match: <etag>`, answered 412
 *              when the file has moved on. Real compare-and-swap.
 *
 * Box has an events endpoint, but it reports on the whole account rather than
 * a folder and needs its own stream position handling; it is deliberately not
 * implemented here, so the engine falls back to listing rather than half-using
 * a feed. That is the same call the WebDAV backend makes.
 */
export class BoxStorage implements RemoteStorage {
  /** path -> file or folder id. Invalidated whenever a name changes. */
  private readonly ids = new Map<string, string>();
  private rootId?: string;

  constructor(
    private readonly tokens: TokenProvider,
    /** Folder name at the account root, e.g. "Openotes". */
    private readonly root: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async probe(): Promise<void> {
    await authedFetch(this.tokens, `${API}/users/me`, {}, this.fetchFn);
  }

  // --- path resolution -----------------------------------------------------

  /**
   * One API call, with the statuses Box uses for "no" returned rather than
   * thrown: 404 for absent, 409 for a name already taken, 412 for a version
   * that moved on. Each is an answer this provider acts on, not a fault.
   */
  private async json<T>(
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: BodyInit;
    } = {},
  ): Promise<{ status: number; body: T | undefined }> {
    const result = await authedFetch(
      this.tokens,
      url,
      { ...init, expect: [404, 409, 412] },
      this.fetchFn,
    );
    return { status: result.status, body: result.body as T | undefined };
  }

  /** A direct child of `parentId` with this exact name, or undefined. */
  private async childByName(
    parentId: string,
    name: string,
  ): Promise<{ id: string; type: string } | undefined> {
    let offset = 0;
    for (;;) {
      const { body } = await this.json<{
        entries?: { id: string; name: string; type: string }[];
        total_count?: number;
      }>(
        `${API}/folders/${parentId}/items?fields=id,name,type&limit=1000&offset=${offset}`,
      );
      const entries = body?.entries ?? [];
      const match = entries.find((entry) => entry.name === name);
      if (match) return { id: match.id, type: match.type };
      offset += entries.length;
      if (entries.length === 0 || offset >= (body?.total_count ?? 0)) {
        return undefined;
      }
    }
  }

  private async rootFolderId(): Promise<string> {
    if (this.rootId) return this.rootId;
    // "0" is Box's name for the account root.
    const existing = await this.childByName("0", this.root);
    if (existing) return (this.rootId = existing.id);
    const { body } = await this.json<{ id: string }>(`${API}/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: this.root, parent: { id: "0" } }),
    });
    if (!body?.id) {
      throw new SyncError(
        `Could not create the ${this.root} folder on Box`,
        "server-error",
      );
    }
    return (this.rootId = body.id);
  }

  /** Resolve a repository-relative path to an id, or undefined. */
  private async idFor(path: string): Promise<string | undefined> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    if (!clean) return await this.rootFolderId();
    const cached = this.ids.get(clean);
    if (cached) return cached;

    let parent = await this.rootFolderId();
    const parts = clean.split("/");
    for (let i = 0; i < parts.length; i++) {
      const child = await this.childByName(parent, parts[i]);
      if (!child) return undefined;
      parent = child.id;
      this.ids.set(parts.slice(0, i + 1).join("/"), child.id);
    }
    return parent;
  }

  /** Resolve the parent folder of `path`, creating it when missing. */
  private async parentIdFor(path: string): Promise<string> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    const parts = clean.split("/");
    parts.pop();
    if (parts.length === 0) return await this.rootFolderId();
    await this.mkdirp(parts.join("/"));
    const id = await this.idFor(parts.join("/"));
    if (!id) {
      throw new SyncError(
        `Could not create ${parts.join("/")}`,
        "server-error",
      );
    }
    return id;
  }

  private nameOf(path: string): string {
    return path.replace(/^\/+|\/+$/g, "").split("/").pop() ?? "";
  }

  /** Forget a path and anything beneath it, after a rename or a delete. */
  private forget(path: string): void {
    const clean = path.replace(/^\/+|\/+$/g, "");
    for (const key of [...this.ids.keys()]) {
      if (key === clean || key.startsWith(`${clean}/`)) this.ids.delete(key);
    }
  }

  private entryOf(
    path: string,
    item: { size?: number; etag?: string; modified_at?: string; type?: string },
  ): RemoteEntry {
    return {
      path,
      isCollection: item.type === "folder",
      size: item.size,
      // Box's etag is a small integer version counter, compared for equality
      // only, which is all RemoteEntry promises about a version.
      version: item.etag,
      modifiedAt: item.modified_at,
    };
  }

  // --- RemoteStorage -------------------------------------------------------

  async list(path: string): Promise<RemoteEntry[]> {
    const id = await this.idFor(path);
    if (!id) return [];
    const entries: RemoteEntry[] = [];
    let offset = 0;
    for (;;) {
      const { body } = await this.json<{
        entries?: {
          id: string;
          name: string;
          type: string;
          size?: number;
          etag?: string;
          modified_at?: string;
        }[];
        total_count?: number;
      }>(
        `${API}/folders/${id}/items?fields=id,name,type,size,etag,modified_at` +
          `&limit=1000&offset=${offset}`,
      );
      const page = body?.entries ?? [];
      for (const item of page) {
        const childPath = path
          ? `${path.replace(/\/+$/, "")}/${item.name}`
          : item.name;
        this.ids.set(childPath.replace(/^\/+/, ""), item.id);
        entries.push(this.entryOf(childPath, item));
      }
      offset += page.length;
      if (page.length === 0 || offset >= (body?.total_count ?? 0)) break;
    }
    return entries;
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const id = await this.idFor(path);
    if (!id) return undefined;
    const { body } = await this.json<{
      size?: number;
      etag?: string;
      modified_at?: string;
      type?: string;
    }>(`${API}/files/${id}?fields=size,etag,modified_at,type`);
    if (!body) return undefined;
    return this.entryOf(path, body);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.idFor(path)) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const bytes = await this.getIfExists(path);
    if (!bytes) throw new SyncError(`${path} does not exist`, "not-found");
    return bytes;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const id = await this.idFor(path);
    if (!id) return undefined;
    const result = await authedFetch(
      this.tokens,
      `${API}/files/${id}/content`,
      { json: false, expect: [404] },
      this.fetchFn,
    );
    if (result.status === 404) return undefined;
    return result.body as Uint8Array;
  }

  /** Box uploads are multipart: a JSON attributes part, then the bytes. */
  private uploadBody(
    attributes: Record<string, unknown>,
    body: Uint8Array,
    contentType: string,
  ): FormData {
    const form = new FormData();
    form.append("attributes", JSON.stringify(attributes));
    form.append("file", new Blob([body as BlobPart], { type: contentType }));
    return form;
  }

  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const parent = await this.parentIdFor(path);
    const result = await authedFetch(
      this.tokens,
      `${UPLOAD}/files/content`,
      {
        method: "POST",
        body: this.uploadBody(
          { name: this.nameOf(path), parent: { id: parent } },
          body,
          options?.contentType ?? "application/octet-stream",
        ),
        expect: [409],
      },
      this.fetchFn,
    );
    if (result.status === 409) {
      // Box refuses a duplicate name outright rather than renaming, which is
      // the whole point: a silent rename would fork a note.
      throw new SyncError(`${path} already exists`, "precondition-failed");
    }
    const created = result.body as {
      entries?: { id: string; etag?: string; modified_at?: string }[];
    };
    const entry = created?.entries?.[0];
    if (entry?.id) this.ids.set(path.replace(/^\/+/, ""), entry.id);
    return this.entryOf(path, { ...entry, size: body.byteLength });
  }

  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const id = await this.idFor(path);
    if (!id) return await this.putNew(path, body, options);

    const result = await authedFetch(
      this.tokens,
      `${UPLOAD}/files/${id}/content`,
      {
        method: "POST",
        headers: expectedVersion ? { "if-match": expectedVersion } : {},
        body: this.uploadBody(
          { name: this.nameOf(path) },
          body,
          options?.contentType ?? "application/octet-stream",
        ),
        expect: [412],
      },
      this.fetchFn,
    );
    if (result.status === 412) {
      throw new SyncError(
        `${path} changed on the server`,
        "precondition-failed",
      );
    }
    const updated = result.body as {
      entries?: { id: string; etag?: string; modified_at?: string }[];
    };
    return this.entryOf(path, {
      ...updated?.entries?.[0],
      size: body.byteLength,
    });
  }

  async delete(path: string): Promise<void> {
    const id = await this.idFor(path);
    if (!id) return;
    await this.json(`${API}/files/${id}`, { method: "DELETE" });
    this.forget(path);
  }

  async move(from: string, to: string, overwrite = true): Promise<void> {
    const id = await this.idFor(from);
    if (!id) throw new SyncError(`${from} does not exist`, "not-found");
    if (!overwrite && (await this.exists(to))) {
      throw new SyncError(`${to} already exists`, "precondition-failed");
    }
    const parent = await this.parentIdFor(to);
    const { status } = await this.json(`${API}/files/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: this.nameOf(to), parent: { id: parent } }),
    });
    if (status === 409) {
      throw new SyncError(`${to} already exists`, "precondition-failed");
    }
    // Both ends move: the old path is gone and the new one now has this id.
    this.forget(from);
    this.ids.set(to.replace(/^\/+/, ""), id);
  }

  async mkdirp(path: string): Promise<void> {
    const clean = path.replace(/^\/+|\/+$/g, "");
    if (!clean) {
      await this.rootFolderId();
      return;
    }
    let parent = await this.rootFolderId();
    const parts = clean.split("/");
    for (let i = 0; i < parts.length; i++) {
      const so_far = parts.slice(0, i + 1).join("/");
      const cached = this.ids.get(so_far);
      if (cached) {
        parent = cached;
        continue;
      }
      const existing = await this.childByName(parent, parts[i]);
      if (existing) {
        parent = existing.id;
      } else {
        const { status, body } = await this.json<{ id: string }>(
          `${API}/folders`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: parts[i],
              parent: { id: parent },
            }),
          },
        );
        if (status === 409) {
          // Another device created it between the check and the create, which
          // is a race to lose gracefully rather than an error.
          const now = await this.childByName(parent, parts[i]);
          if (!now) {
            throw new SyncError(`Could not create ${so_far}`, "server-error");
          }
          parent = now.id;
        } else if (body?.id) {
          parent = body.id;
        } else {
          throw new SyncError(`Could not create ${so_far}`, "server-error");
        }
      }
      this.ids.set(so_far, parent);
    }
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const entry = await this.stat(path);
    if (!entry) {
      throw new SyncError(
        `${path} is not there after being written`,
        "server-error",
      );
    }
    if (entry.size !== undefined && entry.size !== expectedLength) {
      throw new SyncError(
        `${path} was stored as ${entry.size} bytes, not ${expectedLength}`,
        "server-error",
      );
    }
  }

  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      atomicCreate: true,
      conditionalUpdate: true,
      // Box renames and reparents in one call, so a retitle is one request
      // and does not go through copy-and-delete.
      serverSideMove: true,
    });
  }
}
