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
 * Enough of the Dropbox v2 API to drive the adapter.
 *
 * It models the parts the adapter depends on for correctness rather than the
 * whole service: the RPC/content host split, `mode: "add"` refusing an
 * occupied path, `list_folder` paging through a cursor, `path/not_found` on
 * a delete, and upload sessions. Where the real service has a behaviour the
 * adapter must handle rather than avoid — a 429 with Retry-After, a
 * conflict — the fake can be told to produce it.
 */

import { contentHash } from "../src/dropbox/upload.ts";

const encoder = new TextEncoder();

export interface FakeDropboxOptions {
  /** Fail the next N requests to this route with 429 and this Retry-After. */
  throttle?: { route: string; times: number; retryAfterSeconds: number };
}

interface StoredFile {
  content: Uint8Array;
  rev: number;
}

export class FakeDropbox {
  readonly files = new Map<string, StoredFile>();
  readonly folders = new Set<string>(["/"]);
  /** Every route the adapter called, in order, for assertions about how. */
  readonly calls: string[] = [];
  /** Authorization headers seen, so a test can prove where the token went. */
  readonly authorizations: { route: string; header: string | null }[] = [];
  /** Page size for list_folder; small so paging is exercised. */
  pageSize = 2;

  private server?: Deno.HttpServer;
  private origin = "";
  private cursors = new Map<string, { paths: string[]; index: number }>();
  private sessions = new Map<string, Uint8Array[]>();
  private throttle?: FakeDropboxOptions["throttle"];
  private nextRev = 1;

  constructor(options: FakeDropboxOptions = {}) {
    this.throttle = options.throttle;
  }

  get apiUrl(): string {
    return this.origin;
  }

  get contentUrl(): string {
    return this.origin;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = Deno.serve(
        {
          hostname: "127.0.0.1",
          port: 0,
          onListen: ({ port }) => {
            this.origin = `http://127.0.0.1:${port}`;
            resolve();
          },
        },
        (request) => this.handle(request),
      );
    });
  }

  async stop(): Promise<void> {
    await this.server?.shutdown();
  }

  /** Put a file there without going through the adapter. */
  seed(path: string, content: string) {
    this.files.set(path, {
      content: encoder.encode(content),
      rev: this.nextRev++,
    });
  }

  text(path: string): string | undefined {
    const file = this.files.get(path);
    return file ? new TextDecoder().decode(file.content) : undefined;
  }

  private async handle(request: Request): Promise<Response> {
    const route = new URL(request.url).pathname.replace(/^\/2\//, "");
    this.calls.push(route);
    this.authorizations.push({
      route,
      header: request.headers.get("authorization"),
    });

    if (
      this.throttle && this.throttle.route === route && this.throttle.times > 0
    ) {
      this.throttle.times--;
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": String(this.throttle.retryAfterSeconds) },
      });
    }

    const arg = request.headers.get("dropbox-api-arg");
    if (arg !== null) {
      // A content route: the argument is in the header and must be ASCII,
      // because Dropbox rejects a header with a raw non-ASCII byte.
      for (const character of arg) {
        if (character.charCodeAt(0) > 0x7e) {
          return this.error(400, "Dropbox-API-Arg is not ASCII");
        }
      }
      return await this.content(route, JSON.parse(arg), request);
    }
    return await this.rpc(route, await request.json().catch(() => ({})));
  }

  private content(
    route: string,
    arg: Record<string, unknown>,
    request: Request,
  ): Promise<Response> {
    switch (route) {
      case "files/upload":
        return request.arrayBuffer().then((body) =>
          this.upload(arg, new Uint8Array(body))
        );
      case "files/download": {
        const file = this.files.get(String(arg.path));
        if (!file) {
          return Promise.resolve(
            this.error(409, "path/not_found", {
              ".tag": "path",
              path: { ".tag": "not_found" },
            }),
          );
        }
        return this.metadata(String(arg.path), file).then((metadata) =>
          new Response(file.content as BodyInit, {
            headers: { "dropbox-api-result": JSON.stringify(metadata) },
          })
        );
      }
      case "files/upload_session/start":
        return request.arrayBuffer().then((body) => {
          const id = `session-${this.sessions.size + 1}`;
          this.sessions.set(id, [new Uint8Array(body)]);
          return this.json({ session_id: id });
        });
      case "files/upload_session/append_v2":
        return request.arrayBuffer().then((body) => {
          const cursor = arg.cursor as { session_id: string };
          this.sessions.get(cursor.session_id)?.push(new Uint8Array(body));
          return new Response(null, { status: 200 });
        });
      case "files/upload_session/finish":
        return request.arrayBuffer().then((body) => {
          const cursor = arg.cursor as { session_id: string };
          const commit = arg.commit as Record<string, unknown>;
          const parts = this.sessions.get(cursor.session_id) ?? [];
          parts.push(new Uint8Array(body));
          const total = parts.reduce((sum, part) => sum + part.length, 0);
          const joined = new Uint8Array(total);
          let offset = 0;
          for (const part of parts) {
            joined.set(part, offset);
            offset += part.length;
          }
          this.sessions.delete(cursor.session_id);
          return this.upload(commit, joined);
        });
      default:
        return Promise.resolve(
          this.error(400, `unknown content route ${route}`),
        );
    }
  }

  private upload(
    arg: Record<string, unknown>,
    body: Uint8Array,
  ): Promise<Response> {
    const path = String(arg.path);
    const mode = typeof arg.mode === "string"
      ? arg.mode
      : (arg.mode as { ".tag"?: string } | undefined)?.[".tag"] ?? "add";
    if (mode === "add" && this.files.has(path)) {
      // strict_conflict: the service refuses rather than autorenaming, which
      // is the whole reason this adapter can declare a native create.
      return Promise.resolve(
        this.error(409, "path/conflict/file", {
          ".tag": "path",
          reason: { ".tag": "conflict", conflict: { ".tag": "file" } },
        }),
      );
    }
    const stored: StoredFile = { content: body, rev: this.nextRev++ };
    this.files.set(path, stored);
    return this.metadata(path, stored).then((metadata) => this.json(metadata));
  }

  private rpc(
    route: string,
    arg: Record<string, unknown>,
  ): Promise<Response> {
    switch (route) {
      case "files/get_metadata":
      case "files/get_current_account": {
        const path = String(arg.path ?? "");
        if (!path) return this.json({ account_id: "fake" });
        const file = this.files.get(path);
        if (file) {
          return this.metadata(path, file).then((m) => this.json(m));
        }
        if (this.folders.has(path)) {
          return this.json({
            ".tag": "folder",
            path_lower: path.toLowerCase(),
            name: nameOf(path),
          });
        }
        return Promise.resolve(
          this.error(409, "path/not_found", {
            ".tag": "path",
            path: { ".tag": "not_found" },
          }),
        );
      }
      case "files/list_folder": {
        const prefix = normalizeFolder(String(arg.path ?? ""));
        // Dropbox creates parent folders implicitly on upload, so a folder
        // exists if anything is under it — modelling it as "only what
        // create_folder made" would make every listing after a put empty.
        const known = prefix === "/" ||
          this.folders.has(prefix.replace(/\/$/, "")) ||
          [...this.files.keys()].some((path) => path.startsWith(prefix));
        if (!known) {
          return Promise.resolve(
            this.error(409, "path/not_found", {
              ".tag": "path",
              path: { ".tag": "not_found" },
            }),
          );
        }
        const children = new Set<string>();
        for (const path of this.files.keys()) {
          if (isChildOf(path, prefix)) children.add(path);
          else if (path.startsWith(prefix)) {
            // An implicit folder: the first segment below the prefix.
            const segment = path.slice(prefix.length).split("/")[0];
            if (segment) children.add(prefix + segment);
          }
        }
        for (const path of this.folders) {
          if (isChildOf(path, prefix)) children.add(path);
        }
        const paths = [...children].sort();
        return this.page(paths, 0);
      }
      case "files/list_folder/continue": {
        const cursor = this.cursors.get(String(arg.cursor));
        if (!cursor) return Promise.resolve(this.error(400, "bad cursor"));
        return this.page(cursor.paths, cursor.index);
      }
      case "files/delete_v2": {
        const path = String(arg.path);
        if (this.files.delete(path) || this.folders.delete(path)) {
          return this.json({
            metadata: { ".tag": "file", path_lower: path.toLowerCase() },
          });
        }
        return Promise.resolve(
          this.error(409, "path_lookup/not_found", {
            ".tag": "path_lookup",
            path_lookup: { ".tag": "not_found" },
          }),
        );
      }
      case "files/move_v2": {
        const from = String(arg.from_path);
        const to = String(arg.to_path);
        const file = this.files.get(from);
        if (file) {
          this.files.delete(from);
          this.files.set(to, file);
        } else if (this.folders.has(from)) {
          this.folders.delete(from);
          this.folders.add(to);
          for (const [path, stored] of [...this.files]) {
            if (!isUnder(path, from)) continue;
            this.files.delete(path);
            this.files.set(to + path.slice(from.length), stored);
          }
        } else {
          return Promise.resolve(
            this.error(409, "from_lookup/not_found", {
              ".tag": "from_lookup",
              from_lookup: { ".tag": "not_found" },
            }),
          );
        }
        return this.json({
          metadata: { ".tag": "file", path_lower: to.toLowerCase() },
        });
      }
      case "files/create_folder_v2": {
        const path = String(arg.path);
        if (this.files.has(path)) {
          return Promise.resolve(
            this.error(409, "path/conflict/file", {
              ".tag": "path",
              reason: { ".tag": "conflict" },
            }),
          );
        }
        this.folders.add(path);
        return this.json({
          metadata: {
            ".tag": "folder",
            path_lower: path.toLowerCase(),
            name: nameOf(path),
          },
        });
      }
      default:
        return Promise.resolve(this.error(400, `unknown rpc route ${route}`));
    }
  }

  private async page(paths: string[], from: number): Promise<Response> {
    const slice = paths.slice(from, from + this.pageSize);
    const next = from + slice.length;
    const hasMore = next < paths.length;
    const cursor = `cursor-${this.cursors.size + 1}`;
    if (hasMore) this.cursors.set(cursor, { paths, index: next });
    const entries = await Promise.all(
      slice.map((path) => {
        const file = this.files.get(path);
        return file ? this.metadata(path, file) : Promise.resolve({
          ".tag": "folder",
          path_lower: path.toLowerCase(),
          name: nameOf(path),
        });
      }),
    );
    return this.json({
      entries,
      cursor: hasMore ? cursor : "",
      has_more: hasMore,
    });
  }

  private async metadata(path: string, file: StoredFile) {
    return {
      ".tag": "file",
      name: nameOf(path),
      path_lower: path.toLowerCase(),
      path_display: path,
      size: file.content.length,
      rev: String(file.rev),
      server_modified: new Date(1_700_000_000_000).toISOString(),
      // The real thing, because the adapter checks it against what it sent —
      // a placeholder here would make every write look corrupt.
      content_hash: await contentHash(file.content),
    };
  }

  private json(body: unknown): Promise<Response> {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      }),
    );
  }

  private error(status: number, summary: string, tag?: unknown): Response {
    return new Response(
      JSON.stringify({ error_summary: `${summary}/...`, error: tag ?? {} }),
      { status, headers: { "content-type": "application/json" } },
    );
  }
}

function nameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? "";
}

function normalizeFolder(path: string): string {
  if (!path || path === "/") return "/";
  return path.endsWith("/") ? path : `${path}/`;
}

function isChildOf(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.includes("/");
}

function isUnder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}
