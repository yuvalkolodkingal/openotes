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

const RPC = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const NOTIFY = "https://notify.dropboxapi.com/2";

/**
 * Dropbox as a RemoteStorage.
 *
 * The best-behaved of the three backends, because it has both primitives the
 * engines need as real API features rather than as emulations:
 *
 *   putNew     files/upload with mode=add and autorename=false. Dropbox's
 *              default is to rename a colliding upload to "note (1).md",
 *              which would silently fork a note; turning autorename off makes
 *              it a 409 instead, which is exactly create-if-absent.
 *   putUpdate  files/upload with mode={".tag":"update","update":"<rev>"}.
 *              A rev that has moved on is rejected -- real compare-and-swap.
 *
 * It also has a delta feed with long-polling, so change detection need not be
 * a poll of the whole folder.
 *
 * Paths are case-insensitive but case-preserving on Dropbox, so the manifest's
 * stored path is used verbatim rather than re-derived.
 */
export class DropboxStorage implements RemoteStorage, DeltaSource {
  constructor(
    private readonly tokens: TokenProvider,
    /** Folder holding the repository, e.g. "/Openotes". */
    private readonly root: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private full(path: string): string {
    const joined = joinPath(this.root, path);
    return joined.startsWith("/") ? joined : `/${joined}`;
  }

  private rpc(endpoint: string, body: unknown, expect?: number[]) {
    return authedFetch(this.tokens, `${RPC}/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      expect,
    }, this.fetchFn);
  }

  async probe(): Promise<void> {
    await authedFetch(this.tokens, `${RPC}/users/get_current_account`, {
      method: "POST",
      // This endpoint rejects a JSON content-type with an empty body.
      headers: {},
    }, this.fetchFn);
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const entries: RemoteEntry[] = [];
    // The root is an empty string to Dropbox, and a path must not end in "/".
    const target = this.full(path).replace(/\/+$/, "");
    let result = await this.rpc("files/list_folder", {
      path: target === "/" ? "" : target,
      recursive: false,
    }, [409]);

    // A folder that does not exist lists as empty, matching the interface.
    if (result.status === 409) return [];

    for (;;) {
      const page = result.body as DropboxPage;
      for (const entry of page.entries) entries.push(this.toEntry(entry));
      if (!page.has_more) break;
      result = await this.rpc("files/list_folder/continue", {
        cursor: page.cursor,
      });
    }
    return entries;
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const result = await this.rpc(
      "files/get_metadata",
      { path: this.full(path) },
      [409],
    );
    if (result.status === 409) return undefined;
    return this.toEntry(result.body as DropboxEntry);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const bytes = await this.download(path);
    if (!bytes) {
      throw new SyncError(`${path} is not on Dropbox`, "not-found", 404);
    }
    return bytes;
  }

  getIfExists(path: string): Promise<Uint8Array | undefined> {
    return this.download(path);
  }

  private async download(path: string): Promise<Uint8Array | undefined> {
    const result = await authedFetch(this.tokens, `${CONTENT}/files/download`, {
      method: "POST",
      headers: { "dropbox-api-arg": apiArg({ path: this.full(path) }) },
      json: false,
      expect: [409],
    }, this.fetchFn);
    if (result.status === 409) return undefined;
    return result.body as Uint8Array;
  }

  putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    // autorename:false turns a collision into an error rather than a silently
    // forked "note (1).md".
    return this.upload(path, body, { ".tag": "add" }, options, false);
  }

  putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const mode = expectedVersion
      ? { ".tag": "update", update: expectedVersion }
      : { ".tag": "overwrite" };
    return this.upload(
      path,
      body,
      mode,
      options,
      expectedVersion !== undefined,
    );
  }

  private async upload(
    path: string,
    body: Uint8Array,
    mode: unknown,
    _options: PutOptions | undefined,
    conditional: boolean,
  ): Promise<RemoteEntry> {
    const result = await authedFetch(this.tokens, `${CONTENT}/files/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "dropbox-api-arg": apiArg({
          path: this.full(path),
          mode,
          autorename: false,
          mute: true,
        }),
      },
      body: body as unknown as BodyInit,
      expect: [409],
    }, this.fetchFn);

    if (result.status === 409) {
      // A conflict here means exactly what the caller asked us to detect.
      throw new SyncError(
        conditional
          ? `${path} changed on Dropbox before this write`
          : `${path} already exists on Dropbox`,
        "precondition-failed",
        412,
      );
    }
    return this.toEntry(result.body as DropboxEntry);
  }

  async delete(path: string): Promise<void> {
    await this.rpc("files/delete_v2", { path: this.full(path) }, [409]);
  }

  async move(from: string, to: string, overwrite = true): Promise<void> {
    const result = await this.rpc("files/move_v2", {
      from_path: this.full(from),
      to_path: this.full(to),
      autorename: false,
      allow_ownership_transfer: false,
    }, [409]);
    if (result.status !== 409) return;

    if (!overwrite) {
      throw new SyncError(
        `Could not move ${from} to ${to}`,
        "precondition-failed",
        412,
      );
    }
    // Dropbox refuses to move onto an existing path, so clear it first.
    await this.delete(to);
    await this.rpc("files/move_v2", {
      from_path: this.full(from),
      to_path: this.full(to),
      autorename: false,
    });
  }

  async mkdirp(path: string): Promise<void> {
    const target = this.full(path).replace(/\/+$/, "");
    if (!target || target === "/") return;
    // create_folder_v2 answers 409 when it already exists, which is success
    // for an idempotent mkdirp.
    await this.rpc("files/create_folder_v2", {
      path: target,
      autorename: false,
    }, [409]);
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const entry = await this.stat(path);
    if (!entry) {
      throw new SyncError(
        `Upload verification failed: ${path} is not on Dropbox`,
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
    const target = this.full("").replace(/\/+$/, "");
    const result = await this.rpc("files/list_folder/get_latest_cursor", {
      path: target === "/" ? "" : target,
      recursive: true,
    }, [409]);
    if (result.status === 409) return "";
    return (result.body as { cursor: string }).cursor;
  }

  async changesSince(
    cursor: string,
  ): Promise<{ changes: RemoteChange[]; cursor: string }> {
    if (!cursor) return { changes: [], cursor: await this.startCursor() };

    const changes: RemoteChange[] = [];
    let current = cursor;
    for (;;) {
      const result = await this.rpc("files/list_folder/continue", {
        cursor: current,
      });
      const page = result.body as DropboxPage;
      for (const entry of page.entries) {
        changes.push(
          entry[".tag"] === "deleted"
            ? { path: this.relative(entry.path_display), type: "deleted" }
            : {
              path: this.relative(entry.path_display),
              type: "modified",
              entry: this.toEntry(entry),
            },
        );
      }
      current = page.cursor;
      if (!page.has_more) break;
    }
    return { changes, cursor: current };
  }

  /**
   * Block until something changes, up to `timeoutSeconds`.
   *
   * Unauthenticated by design -- the cursor is the credential -- so it does
   * not go through authedFetch.
   */
  async longpoll(cursor: string, timeoutSeconds = 30): Promise<boolean> {
    const response = await this.fetchFn(
      `${NOTIFY}/files/list_folder/longpoll`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor, timeout: timeoutSeconds }),
      },
    );
    if (!response.ok) return false;
    return ((await response.json()) as { changes: boolean }).changes;
  }

  private relative(fullPath: string): string {
    const root = this.full("").replace(/\/+$/, "");
    // Dropbox echoes paths with the display case but matches case-insensitively.
    if (fullPath.toLowerCase().startsWith(root.toLowerCase() + "/")) {
      return fullPath.slice(root.length + 1);
    }
    return fullPath.replace(/^\/+/, "");
  }

  private toEntry(entry: DropboxEntry): RemoteEntry {
    return {
      path: this.relative(entry.path_display),
      isCollection: entry[".tag"] === "folder",
      size: entry.size,
      // `rev` is Dropbox's version token and the input to a conditional
      // update; content_hash stands in for entries that have no rev.
      version: entry.rev ?? entry.content_hash,
      modifiedAt: entry.server_modified,
    };
  }
}

interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_display: string;
  size?: number;
  rev?: string;
  content_hash?: string;
  server_modified?: string;
}

interface DropboxPage {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

/**
 * Dropbox passes JSON arguments in an HTTP header, so the value has to be
 * HTTP-safe: anything above ASCII is escaped rather than sent raw, or the
 * header is rejected and a note with an accented title fails to upload.
 */
function apiArg(value: unknown): string {
  let out = "";
  for (const char of JSON.stringify(value)) {
    const code = char.charCodeAt(0);
    out += code > 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : char;
  }
  return out;
}
