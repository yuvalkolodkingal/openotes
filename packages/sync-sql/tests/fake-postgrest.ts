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

import { OBJECTS_TABLE } from "../src/index.ts";

/**
 * Enough of PostgREST to run the storage contract against.
 *
 * It implements the exact operators the storage uses -- `eq`, `like` (with
 * `*` as the wildcard), an `or=(…)` group with double-quoted values, `select`
 * and `limit` -- and the two Prefer behaviours that carry the correctness
 * argument: a duplicate primary key on POST is a 409 with code 23505, and
 * `resolution=merge-duplicates` turns it into an upsert. Everything else is
 * refused with a 400 so an unexpected request fails a test rather than
 * passing by accident.
 */
interface Row {
  path: string;
  body: string;
  version: string;
  size: number;
  content_type: string | null;
  modified_at: string;
}

export class FakePostgrest {
  readonly rows = new Map<string, Row>();
  readonly calls: { method: string; url: string; prefer?: string }[] = [];
  /** Set to refuse every request as unauthorized, e.g. a wrong key. */
  key = "service-key";
  /** Set to pretend the table was never created. */
  missingTable = false;

  constructor(
    readonly projectUrl = "https://abcdefghijklmnopqrst.supabase.co",
  ) {}

  get fetchFn(): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(this.handle(String(input), init ?? {}))) as typeof fetch;
  }

  private handle(url: string, init: RequestInit): Response {
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    this.calls.push({
      method,
      url,
      prefer: headers.get("prefer") ?? undefined,
    });

    const base = `${this.projectUrl}/rest/v1/${OBJECTS_TABLE}`;
    if (!url.startsWith(base)) return json(400, { message: `bad url ${url}` });
    if (
      headers.get("apikey") !== this.key ||
      headers.get("authorization") !== `Bearer ${this.key}`
    ) {
      return json(401, { message: "Invalid API key" });
    }
    if (this.missingTable) {
      return json(404, {
        code: "PGRST205",
        message: "Could not find the table",
      });
    }

    const params = new URLSearchParams(
      url.slice(base.length).replace(/^\?/, ""),
    );
    const filter = this.filterFrom(params);
    const prefer = headers.get("prefer") ?? "";
    const body = typeof init.body === "string"
      ? JSON.parse(init.body)
      : undefined;
    const limit = params.has("limit") ? Number(params.get("limit")) : undefined;
    const select = (params.get("select") ?? "*").split(",");

    switch (method) {
      case "GET": {
        let matched = [...this.rows.values()].filter(filter);
        if (limit !== undefined) matched = matched.slice(0, limit);
        return json(200, matched.map((row) => project(row, select)));
      }
      case "POST": {
        const row = toRow(body);
        const duplicate = this.rows.has(row.path);
        if (duplicate && !prefer.includes("resolution=merge-duplicates")) {
          return json(409, {
            code: "23505",
            message:
              `duplicate key value violates unique constraint "${OBJECTS_TABLE}_pkey"`,
          });
        }
        if (duplicate && params.get("on_conflict") !== "path") {
          return json(400, {
            message: "merge-duplicates needs on_conflict=path",
          });
        }
        this.rows.set(row.path, row);
        return prefer.includes("return=representation")
          ? json(201, [project(row, select)])
          : new Response(null, { status: 201 });
      }
      case "PATCH": {
        const matched = [...this.rows.values()].filter(filter);
        const updated: Row[] = [];
        for (const row of matched) {
          const next = { ...row, ...body } as Row;
          if (next.path !== row.path) {
            if (this.rows.has(next.path)) {
              return json(409, { code: "23505", message: "duplicate key" });
            }
            this.rows.delete(row.path);
          }
          this.rows.set(next.path, next);
          updated.push(next);
        }
        return prefer.includes("return=representation")
          ? json(200, updated.map((row) => project(row, select)))
          : new Response(null, { status: 204 });
      }
      case "DELETE": {
        for (const row of [...this.rows.values()].filter(filter)) {
          this.rows.delete(row.path);
        }
        return new Response(null, { status: 204 });
      }
      default:
        return json(405, { message: `unsupported ${method}` });
    }
  }

  private filterFrom(params: URLSearchParams): (row: Row) => boolean {
    const clauses: ((row: Row) => boolean)[] = [];
    for (const [key, value] of params) {
      if (["select", "limit", "on_conflict", "order"].includes(key)) continue;
      if (key === "or") {
        const inner = value.replace(/^\(/, "").replace(/\)$/, "");
        const parts = splitTopLevel(inner).map((part) => {
          const [column, operator, ...rest] = part.split(".");
          return clause(column, operator, unquote(rest.join(".")));
        });
        clauses.push((row) => parts.some((p) => p(row)));
        continue;
      }
      const dot = value.indexOf(".");
      if (dot === -1) throw new Error(`bad filter ${key}=${value}`);
      clauses.push(clause(key, value.slice(0, dot), value.slice(dot + 1)));
    }
    return (row) => clauses.every((c) => c(row));
  }
}

function clause(column: string, operator: string, value: string) {
  if (!["path", "version"].includes(column)) {
    throw new Error(`unsupported column ${column}`);
  }
  const read = (row: Row) => String(row[column as "path" | "version"]);
  switch (operator) {
    case "eq":
      return (row: Row) => read(row) === value;
    case "like": {
      const pattern = new RegExp(
        "^" + value.split("*").map(escapeRegExp).join(".*") + "$",
      );
      return (row: Row) => pattern.test(read(row));
    }
    default:
      throw new Error(`unsupported operator ${operator}`);
  }
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\"/g, '"')
    : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toRow(body: Record<string, unknown>): Row {
  if (typeof body.path !== "string" || typeof body.body !== "string") {
    throw new Error("row needs path and body");
  }
  if (!body.body.startsWith("\\x")) throw new Error("bytea must be \\x hex");
  return {
    path: body.path,
    body: body.body,
    version: String(body.version),
    size: Number(body.size),
    content_type: (body.content_type as string | null) ?? null,
    modified_at: typeof body.modified_at === "string"
      ? body.modified_at
      : new Date().toISOString(),
  };
}

function project(row: Row, select: string[]): Record<string, unknown> {
  if (select.includes("*")) return { ...row };
  const out: Record<string, unknown> = {};
  for (const column of select) out[column] = row[column as keyof Row];
  return out;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
