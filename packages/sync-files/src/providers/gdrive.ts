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
import { authedFetch, type TokenProvider } from "./auth.ts";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Google Drive as a RemoteStorage.
 *
 * THE HARDEST OF THE THREE, AND WHY
 *
 * Drive has neither primitive the engines want:
 *
 *   - **No create-if-absent.** Two files may share a name in the same folder.
 *     `files.create` never fails for a collision; it just makes a second file.
 *   - **No conditional update.** v3 dropped ETag-based preconditions, so there
 *     is no way to say "write only if the version is still X".
 *
 * Both are therefore emulated read-then-write, and both can lose a race. That
 * is stated in `capabilities()` as `atomicCreate: false` rather than hidden,
 * so callers can degrade instead of trusting a guarantee that is not there.
 *
 * What makes it acceptable rather than dangerous:
 *
 *   1. Every write is followed by a re-read. A create that finds a duplicate
 *      name deletes *its own* file -- the one whose id it knows -- and reports
 *      precondition-failed, so the loser retreats and the winner stands.
 *   2. An update that finds the revision moved under it reports the same,
 *      and the engine turns that into a conflict copy rather than a clobber.
 *   3. Drive keeps revision history, so even a lost race is recoverable by
 *      hand. Neither of the other backends needs that safety net; Drive does.
 *
 * ADDRESSING
 *
 * Drive has no paths, only ids and parent links, so a path has to be resolved
 * one segment at a time. That is cached per instance -- a sync cycle touching
 * fifty notes in one notebook should not resolve the same folder fifty times.
 */
export class GoogleDriveStorage implements RemoteStorage, DeltaSource {
  /** path -> file id. Cleared for a subtree whenever that subtree changes. */
  private readonly ids = new Map<string, string>();
  private rootId?: string;

  constructor(
    private readonly tokens: TokenProvider,
    /** Folder name at the drive root, e.g. "Openotes". */
    private readonly root: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async probe(): Promise<void> {
    await authedFetch(
      this.tokens,
      `${API}/about?fields=user/emailAddress`,
      {},
      this.fetchFn,
    );
  }

  // --- path resolution -----------------------------------------------------

  private async rootFolderId(): Promise<string> {
    if (this.rootId) return this.rootId;
    const existing = await this.childByName("root", this.root);
    this.rootId = existing?.id ?? await this.createFolder("root", this.root);
    return this.rootId;
  }

  /** Resolve a repository-relative path to a file id, or undefined. */
  private async idOf(path: string): Promise<string | undefined> {
    const clean = normalize(path);
    if (!clean) return await this.rootFolderId();
    const cached = this.ids.get(clean);
    if (cached) return cached;

    let parent = await this.rootFolderId();
    const parts = clean.split("/");
    let walked = "";
    for (const part of parts) {
      walked = walked ? `${walked}/${part}` : part;
      const hit = this.ids.get(walked);
      if (hit) {
        parent = hit;
        continue;
      }
      const child = await this.childByName(parent, part);
      if (!child) return undefined;
      this.ids.set(walked, child.id);
      parent = child.id;
    }
    return parent;
  }

  private async childByName(
    parentId: string,
    name: string,
  ): Promise<DriveFile | undefined> {
    const query = `'${parentId}' in parents and name = '${
      escapeQuery(name)
    }' and trashed = false`;
    const result = await authedFetch(
      this.tokens,
      `${API}/files?q=${
        encodeURIComponent(query)
      }&fields=${FIELDS}&pageSize=10`,
      {},
      this.fetchFn,
    );
    const files = (result.body as { files: DriveFile[] }).files ?? [];
    if (files.length <= 1) return files[0];
    // Duplicates exist: Drive allows them. Deterministically prefer the
    // lowest id so every device agrees which one is the real file.
    return files.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const result = await authedFetch(this.tokens, `${API}/files?fields=id`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      }),
    }, this.fetchFn);
    return (result.body as { id: string }).id;
  }

  // --- RemoteStorage -------------------------------------------------------

  async list(path: string): Promise<RemoteEntry[]> {
    const parentId = await this.idOf(path);
    if (!parentId) return [];
    const prefix = normalize(path);

    const entries: RemoteEntry[] = [];
    let pageToken: string | undefined;
    do {
      const query = `'${parentId}' in parents and trashed = false`;
      const url = `${API}/files?q=${encodeURIComponent(query)}` +
        `&fields=nextPageToken,files(${FIELD_LIST})&pageSize=200` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const result = await authedFetch(this.tokens, url, {}, this.fetchFn);
      const page = result.body as {
        files: DriveFile[];
        nextPageToken?: string;
      };
      for (const file of page.files ?? []) {
        const childPath = prefix ? `${prefix}/${file.name}` : file.name;
        this.ids.set(childPath, file.id);
        entries.push(toEntry(file, childPath));
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return entries;
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const id = await this.idOf(path);
    if (!id) return undefined;
    const result = await authedFetch(
      this.tokens,
      `${API}/files/${id}?fields=${FIELD_LIST}`,
      { expect: [404] },
      this.fetchFn,
    );
    if (result.status === 404) return undefined;
    return toEntry(result.body as DriveFile, normalize(path));
  }

  async exists(path: string): Promise<boolean> {
    return (await this.idOf(path)) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const bytes = await this.getIfExists(path);
    if (!bytes) {
      throw new SyncError(`${path} is not on Google Drive`, "not-found", 404);
    }
    return bytes;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const id = await this.idOf(path);
    if (!id) return undefined;
    const result = await authedFetch(
      this.tokens,
      `${API}/files/${id}?alt=media`,
      { json: false, expect: [404] },
      this.fetchFn,
    );
    if (result.status === 404) return undefined;
    return result.body as Uint8Array;
  }

  /**
   * Create, emulating create-if-absent.
   *
   * Drive cannot refuse a duplicate name, so the sequence is: check, create,
   * check again. If the second check finds another file with the same name,
   * this call lost a race -- so it deletes the file *it* created, by id, and
   * reports precondition-failed. Deleting by id is what makes that safe: the
   * winner's file is never touched.
   */
  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    if (await this.idOf(path)) {
      throw new SyncError(
        `${path} already exists on Google Drive`,
        "precondition-failed",
        412,
      );
    }

    const clean = normalize(path);
    const parentPath = clean.split("/").slice(0, -1).join("/");
    const name = clean.split("/").pop()!;
    await this.mkdirp(parentPath);
    const parentId = (await this.idOf(parentPath))!;

    const created = await this.uploadNew(
      parentId,
      name,
      body,
      options?.contentType,
    );

    const duplicates = await this.namesakes(parentId, name);
    if (duplicates.length > 1) {
      const winner = duplicates.sort((a, b) => (a.id < b.id ? -1 : 1))[0];
      if (winner.id !== created.id) {
        // We lost. Remove only our own file, then step aside.
        await this.trash(created.id);
        throw new SyncError(
          `${path} was created by another device at the same moment`,
          "precondition-failed",
          412,
        );
      }
    }

    this.ids.set(clean, created.id);
    return toEntry(created, clean);
  }

  /**
   * Overwrite, emulating compare-and-swap.
   *
   * Drive v3 has no conditional update, so the revision is read first and
   * compared. A race between the read and the write is possible and cannot be
   * closed from here; the engine turns the resulting mismatch into a conflict
   * copy, and Drive's own revision history is the last line of defence.
   */
  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const clean = normalize(path);
    const id = await this.idOf(clean);
    if (!id) {
      // Nothing there to update: fall through to a create.
      return await this.putNew(clean, body, options);
    }

    if (expectedVersion) {
      const current = await this.stat(clean);
      if (current?.version !== expectedVersion) {
        throw new SyncError(
          `${path} changed on Google Drive before this write`,
          "precondition-failed",
          412,
        );
      }
    }

    const result = await authedFetch(
      this.tokens,
      `${UPLOAD}/files/${id}?uploadType=media&fields=${FIELD_LIST}`,
      {
        method: "PATCH",
        headers: {
          "content-type": options?.contentType ?? "text/markdown",
        },
        body: body as unknown as BodyInit,
      },
      this.fetchFn,
    );
    return toEntry(result.body as DriveFile, clean);
  }

  async delete(path: string): Promise<void> {
    const clean = normalize(path);
    const id = await this.idOf(clean);
    if (!id) return;
    await this.trash(id);
    this.forget(clean);
  }

  async move(from: string, to: string, overwrite = true): Promise<void> {
    const fromClean = normalize(from);
    const toClean = normalize(to);
    const id = await this.idOf(fromClean);
    if (!id) return;

    if (overwrite) {
      const existing = await this.idOf(toClean);
      if (existing && existing !== id) await this.trash(existing);
    }

    const parentPath = toClean.split("/").slice(0, -1).join("/");
    const name = toClean.split("/").pop()!;
    await this.mkdirp(parentPath);
    const newParent = (await this.idOf(parentPath))!;
    const oldParent = (await this.idOf(
      fromClean.split("/").slice(0, -1).join("/"),
    ))!;

    await authedFetch(
      this.tokens,
      `${API}/files/${id}?addParents=${newParent}` +
        `&removeParents=${oldParent}&fields=id`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      },
      this.fetchFn,
    );

    this.forget(fromClean);
    this.ids.set(toClean, id);
  }

  async mkdirp(path: string): Promise<void> {
    const clean = normalize(path);
    if (!clean) {
      await this.rootFolderId();
      return;
    }
    let parent = await this.rootFolderId();
    let walked = "";
    for (const part of clean.split("/")) {
      walked = walked ? `${walked}/${part}` : part;
      const cached = this.ids.get(walked);
      if (cached) {
        parent = cached;
        continue;
      }
      const existing = await this.childByName(parent, part);
      const id = existing?.id ?? await this.createFolder(parent, part);
      this.ids.set(walked, id);
      parent = id;
    }
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const entry = await this.stat(path);
    if (!entry) {
      throw new SyncError(
        `Upload verification failed: ${path} is not on Google Drive`,
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

  /**
   * Honest about what Drive cannot do. A caller that needs a hard guarantee
   * reads this rather than assuming, and degrades to conflict copies.
   */
  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      atomicCreate: false,
      conditionalUpdate: false,
      serverSideMove: true,
    });
  }

  // --- DeltaSource ---------------------------------------------------------

  async startCursor(): Promise<string> {
    const result = await authedFetch(
      this.tokens,
      `${API}/changes/startPageToken`,
      {},
      this.fetchFn,
    );
    return (result.body as { startPageToken: string }).startPageToken;
  }

  async changesSince(
    cursor: string,
  ): Promise<{ changes: RemoteChange[]; cursor: string }> {
    if (!cursor) return { changes: [], cursor: await this.startCursor() };

    const changes: RemoteChange[] = [];
    let pageToken: string | undefined = cursor;
    let next = cursor;

    while (pageToken) {
      const url = `${API}/changes?pageToken=${pageToken}` +
        `&fields=nextPageToken,newStartPageToken,` +
        `changes(fileId,removed,file(${FIELD_LIST}))&pageSize=200`;
      const result = await authedFetch(this.tokens, url, {}, this.fetchFn);
      const page = result.body as {
        changes: { fileId: string; removed?: boolean; file?: DriveFile }[];
        nextPageToken?: string;
        newStartPageToken?: string;
      };

      for (const change of page.changes ?? []) {
        // Drive reports changes by file id across the whole account, so a
        // path is only known for files this instance has already resolved.
        const path = this.pathOfId(change.fileId);
        if (!path) continue;
        changes.push(
          change.removed || !change.file
            ? { path, type: "deleted" }
            : { path, type: "modified", entry: toEntry(change.file, path) },
        );
      }

      if (page.newStartPageToken) next = page.newStartPageToken;
      pageToken = page.nextPageToken;
    }
    return { changes, cursor: next };
  }

  private pathOfId(id: string): string | undefined {
    for (const [path, known] of this.ids) {
      if (known === id) return path;
    }
    return undefined;
  }

  private async namesakes(
    parentId: string,
    name: string,
  ): Promise<DriveFile[]> {
    const query = `'${parentId}' in parents and name = '${
      escapeQuery(name)
    }' and trashed = false`;
    const result = await authedFetch(
      this.tokens,
      `${API}/files?q=${
        encodeURIComponent(query)
      }&fields=files(id,name)&pageSize=10`,
      {},
      this.fetchFn,
    );
    return (result.body as { files: DriveFile[] }).files ?? [];
  }

  private async uploadNew(
    parentId: string,
    name: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<DriveFile> {
    // Multipart: metadata and content in one request, so a created file is
    // never briefly nameless or parentless.
    const boundary = `openotes-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name, parents: [parentId] });
    const encoder = new TextEncoder();
    const head = encoder.encode(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
        `${metadata}\r\n--${boundary}\r\ncontent-type: ` +
        `${contentType ?? "text/markdown"}\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const payload = new Uint8Array(head.length + body.length + tail.length);
    payload.set(head, 0);
    payload.set(body, head.length);
    payload.set(tail, head.length + body.length);

    const result = await authedFetch(
      this.tokens,
      `${UPLOAD}/files?uploadType=multipart&fields=${FIELD_LIST}`,
      {
        method: "POST",
        headers: { "content-type": `multipart/related; boundary=${boundary}` },
        body: payload as unknown as BodyInit,
      },
      this.fetchFn,
    );
    return result.body as DriveFile;
  }

  private async trash(id: string): Promise<void> {
    // Trashing rather than deleting outright: a mistake here is recoverable
    // from the user's own bin, which matters more on the backend that cannot
    // promise atomicity.
    await authedFetch(
      this.tokens,
      `${API}/files/${id}?fields=id`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trashed: true }),
        expect: [404],
      },
      this.fetchFn,
    );
  }

  private forget(path: string): void {
    this.ids.delete(path);
    for (const key of [...this.ids.keys()]) {
      if (key.startsWith(path + "/")) this.ids.delete(key);
    }
  }
}

const FIELD_LIST =
  "id,name,mimeType,size,modifiedTime,headRevisionId,md5Checksum,trashed";
const FIELDS = encodeURIComponent(`files(${FIELD_LIST})`);

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  md5Checksum?: string;
  trashed?: boolean;
}

function toEntry(file: DriveFile, path: string): RemoteEntry {
  return {
    path: normalize(path),
    isCollection: file.mimeType === FOLDER_MIME,
    // Drive reports size as a string, and not at all for folders.
    size: file.size !== undefined ? Number(file.size) : undefined,
    // headRevisionId changes on every content write; md5Checksum stands in
    // where Drive omits it.
    version: file.headRevisionId ?? file.md5Checksum,
    modifiedAt: file.modifiedTime,
  };
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Escape a name for a Drive query string.
 *
 * Names come from note titles, so they contain whatever the user typed. An
 * unescaped apostrophe would break the query and, worse, could change which
 * files it matches.
 */
function escapeQuery(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
