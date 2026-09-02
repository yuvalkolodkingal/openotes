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
import { fromByteaValue, toByteaLiteral } from "./executor.ts";
import { OBJECTS_TABLE } from "./schema.ts";

/**
 * The same table, reached through Supabase's REST API (PostgREST).
 *
 * Why not SQL: a Supabase project's Postgres port is reachable only over a
 * socket, which a phone cannot open, and Supabase has no SQL-over-HTTP
 * endpoint for clients (the management API's query endpoint is for the
 * project owner's tooling, not for a sync loop). PostgREST is what every
 * Supabase client uses, it is plain HTTPS, and it maps onto the two
 * primitives directly:
 *
 *   putNew     POST a row. The primary key makes a duplicate a 409 with
 *              Postgres code 23505 -- refused by the database, not by a
 *              read that could race.
 *   putUpdate  PATCH … ?path=eq.X&version=eq.V with return=representation.
 *              An empty array back means no row matched: the version moved.
 *
 * The key is the project's *service* key. Row-level security is on and has
 * no policies, so the public anon key can do nothing to this table; the
 * service key bypasses RLS and is the credential, kept where the WebDAV
 * password is kept. The notes themselves are ciphertext either way.
 *
 * `bytea` crosses PostgREST as the `\x` hex text Postgres itself uses.
 */
export class SupabaseRestStorage implements RemoteStorage {
  private readonly base: string;

  constructor(
    /** https://<ref>.supabase.co */
    projectUrl: string,
    private readonly serviceKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly options: { newVersion?: () => string } = {},
  ) {
    this.base = `${projectUrl.replace(/\/+$/, "")}/rest/v1/${OBJECTS_TABLE}`;
  }

  private version(): string {
    return this.options.newVersion?.() ?? crypto.randomUUID();
  }

  private async request(
    method: string,
    query: string,
    init: { body?: unknown; prefer?: string; expect?: number[] } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {
      apikey: this.serviceKey,
      authorization: `Bearer ${this.serviceKey}`,
      accept: "application/json",
    };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.prefer) headers["prefer"] = init.prefer;

    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${query}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch (error) {
      throw new SyncError(
        `Could not reach Supabase: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "network",
      );
    }

    const text = await response.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (response.ok || init.expect?.includes(response.status)) {
      return { status: response.status, body };
    }

    const detail = body && typeof body === "object"
      ? (body as { message?: string; code?: string })
      : {};
    const message = detail.message ?? (typeof body === "string" ? body : "");
    switch (response.status) {
      case 401:
      case 403:
        throw new SyncError(
          `Supabase refused the service key${message ? `: ${message}` : ""}`,
          "unauthorized",
          response.status,
        );
      case 404:
        // PostgREST answers 404 (PGRST205) when the table is not in its
        // schema cache -- which is what "setup was never run" looks like.
        throw new SyncError(
          `The ${OBJECTS_TABLE} table is missing from this Supabase ` +
            `project. Run the setup step again.`,
          "not-found",
          404,
        );
      case 409:
        throw new SyncError(
          message || "Supabase reported a conflict",
          "conflict",
          409,
        );
      default:
        throw new SyncError(
          `Supabase answered HTTP ${response.status}${
            message ? `: ${message}` : ""
          }`,
          response.status >= 500 ? "server-error" : "network",
          response.status,
        );
    }
  }

  async probe(): Promise<void> {
    await this.request("GET", "?select=path&limit=1");
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const prefix = normalise(path);
    // PostgREST spells LIKE's wildcard as `*`; a literal `*` in a path is
    // not something the engines ever produce.
    const pattern = prefix ? `${prefix}/*` : "*";
    const rows = await this.rows(
      `?select=path,size,version,modified_at&path=like.${
        encodeURIComponent(pattern)
      }`,
    );
    const out = new Map<string, RemoteEntry>();
    for (const row of rows) {
      const full = String(row.path);
      const rest = prefix ? full.slice(prefix.length + 1) : full;
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        out.set(full, toEntry(row));
      } else {
        const dir = (prefix ? `${prefix}/` : "") + rest.slice(0, slash);
        if (!out.has(dir)) out.set(dir, { path: dir, isCollection: true });
      }
    }
    return [...out.values()];
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const key = normalise(path);
    const rows = await this.rows(
      `?select=path,size,version,modified_at&path=eq.${
        encodeURIComponent(key)
      }`,
    );
    if (rows[0]) return toEntry(rows[0]);
    const children = await this.rows(
      `?select=path&path=like.${encodeURIComponent(`${key}/*`)}&limit=1`,
    );
    return children.length > 0 ? { path: key, isCollection: true } : undefined;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const bytes = await this.getIfExists(path);
    if (!bytes) {
      throw new SyncError(`${path} is not in Supabase`, "not-found", 404);
    }
    return bytes;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const rows = await this.rows(
      `?select=body&path=eq.${encodeURIComponent(normalise(path))}`,
    );
    const row = rows[0];
    if (!row) return undefined;
    try {
      return fromByteaValue(row.body);
    } catch (error) {
      throw new SyncError(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
        "corrupt-data",
      );
    }
  }

  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const key = normalise(path);
    const version = this.version();
    const result = await this.request("POST", "", {
      body: {
        path: key,
        body: toByteaLiteral(body),
        version,
        size: body.length,
        content_type: options?.contentType ?? null,
      },
      prefer: "return=minimal",
      expect: [409],
    });
    if (result.status === 409) {
      throw new SyncError(`${path} already exists`, "precondition-failed", 412);
    }
    return { path: key, isCollection: false, size: body.length, version };
  }

  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const key = normalise(path);
    const version = this.version();
    const row = {
      path: key,
      body: toByteaLiteral(body),
      version,
      size: body.length,
      content_type: options?.contentType ?? null,
      modified_at: new Date().toISOString(),
    };

    if (expectedVersion !== undefined) {
      const result = await this.request(
        "PATCH",
        `?path=eq.${encodeURIComponent(key)}&version=eq.${
          encodeURIComponent(expectedVersion)
        }`,
        { body: row, prefer: "return=representation" },
      );
      if (!Array.isArray(result.body) || result.body.length === 0) {
        throw new SyncError(
          `${path} was changed by another device`,
          "precondition-failed",
          412,
        );
      }
    } else {
      await this.request("POST", "?on_conflict=path", {
        body: row,
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
    return { path: key, isCollection: false, size: body.length, version };
  }

  async delete(path: string): Promise<void> {
    const key = normalise(path);
    await this.request(
      "DELETE",
      `?or=(path.eq.${encodeURIComponent(quoted(key))},path.like.${
        encodeURIComponent(quoted(`${key}/*`))
      })`,
      { prefer: "return=minimal" },
    );
  }

  async move(from: string, to: string, overwrite = true): Promise<void> {
    const source = normalise(from);
    const target = normalise(to);
    if (!overwrite && (await this.exists(target))) {
      throw new SyncError(`${to} already exists`, "precondition-failed", 412);
    }
    if (overwrite) await this.delete(target);
    const moved = await this.request(
      "PATCH",
      `?path=eq.${encodeURIComponent(source)}`,
      { body: { path: target }, prefer: "return=representation" },
    );
    if (Array.isArray(moved.body) && moved.body.length > 0) return;

    // A collection: rename each object under it, one at a time. PostgREST
    // has no expression update; the engines only move whole trees during a
    // rebuild, where a partial rename is retried harmlessly.
    const children = await this.rows(
      `?select=path&path=like.${encodeURIComponent(`${source}/*`)}`,
    );
    if (children.length === 0) {
      throw new SyncError(`${from} is not in Supabase`, "not-found", 404);
    }
    for (const child of children) {
      const childPath = String(child.path);
      await this.request(
        "PATCH",
        `?path=eq.${encodeURIComponent(childPath)}`,
        {
          body: { path: target + childPath.slice(source.length) },
          prefer: "return=minimal",
        },
      );
    }
  }

  mkdirp(_path: string): Promise<void> {
    return Promise.resolve();
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const entry = await this.stat(path);
    if (!entry || entry.isCollection) {
      throw new SyncError(`${path} is missing after upload`, "server-error");
    }
    if (entry.size !== expectedLength) {
      throw new SyncError(
        `${path} holds ${entry.size} bytes but ${expectedLength} were written`,
        "server-error",
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

  private async rows(query: string): Promise<Record<string, unknown>[]> {
    const result = await this.request("GET", query);
    if (!Array.isArray(result.body)) {
      throw new SyncError(
        "Supabase answered with something other than rows",
        "server-error",
      );
    }
    return result.body as Record<string, unknown>[];
  }
}

function toEntry(row: Record<string, unknown>): RemoteEntry {
  return {
    path: String(row.path),
    isCollection: false,
    size: Number(row.size),
    version: String(row.version),
    modifiedAt: row.modified_at === undefined || row.modified_at === null
      ? undefined
      : String(row.modified_at),
  };
}

function normalise(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Inside an `or=(…)` group PostgREST reads `.` and `,` as its own syntax, so
 * a value there is double-quoted. Elsewhere the raw value is fine.
 */
function quoted(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
