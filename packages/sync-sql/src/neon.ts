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

import { SyncError } from "@notesnook/sync-core";
import type { SqlExecutor, SqlResult, SqlValue } from "./executor.ts";
import { toByteaLiteral } from "./executor.ts";

/**
 * Neon's SQL-over-HTTP endpoint, spoken with plain fetch.
 *
 * The protocol is the one @neondatabase/serverless uses and was read out of
 * that driver rather than assumed: POST `https://<host>/sql`, the connection
 * string in a `Neon-Connection-String` header, `{query, params}` as the body,
 * and -- with `Neon-Raw-Text-Output: true` and `Neon-Array-Mode: true` --
 * every value back as text in row arrays, with `fields[].name` naming the
 * columns. A 400 carries the Postgres error as JSON with a `message`.
 *
 * Why not the driver itself: it is one more dependency to embed in the
 * desktop binary and to make run on a phone, for a protocol that is four
 * headers and a JSON body. Speaking it directly is what lets the same code
 * run on both.
 *
 * The connection string carries the password, and travels in a header over
 * TLS -- the same exposure as the driver has.
 */
export class NeonHttpExecutor implements SqlExecutor {
  private readonly endpoint: string;

  constructor(
    private readonly connectionString: string,
    private readonly fetchFn: typeof fetch = fetch,
    endpoint?: string,
  ) {
    this.endpoint = endpoint ?? neonHttpEndpoint(connectionString);
  }

  async query(sql: string, params: SqlValue[] = []): Promise<SqlResult> {
    let response: Response;
    try {
      response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Neon-Connection-String": this.connectionString,
          "Neon-Raw-Text-Output": "true",
          "Neon-Array-Mode": "true",
        },
        body: JSON.stringify({ query: sql, params: params.map(toWire) }),
      });
    } catch (error) {
      throw new SyncError(
        `Could not reach Neon: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "network",
      );
    }

    if (response.status === 400) {
      const body = await response.json().catch(() => ({})) as {
        message?: string;
        code?: string;
      };
      throw new SyncError(
        body.message ?? "Neon rejected the query",
        isAuthCode(body.code) ? "unauthorized" : "server-error",
        400,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SyncError(
        "Neon refused the credentials in the connection string",
        "unauthorized",
        response.status,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new SyncError(
        `Neon answered HTTP ${response.status}${text ? `: ${text}` : ""}`,
        response.status >= 500 ? "server-error" : "network",
        response.status,
      );
    }

    const payload = await response.json() as {
      fields?: { name: string }[];
      rows?: unknown[][];
      rowCount?: number | null;
    };
    const names = (payload.fields ?? []).map((field) => field.name);
    const rows = (payload.rows ?? []).map((values) => {
      const row: Record<string, unknown> = {};
      names.forEach((name, index) => {
        row[name] = values[index];
      });
      return row;
    });
    return { rows, rowCount: payload.rowCount ?? rows.length };
  }
}

/** The HTTP endpoint for a Neon connection string's host. */
export function neonHttpEndpoint(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new SyncError(
      "The Neon connection string is not a valid URL",
      "corrupt-data",
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new SyncError(
      "The Neon connection string must start with postgresql://",
      "corrupt-data",
    );
  }
  if (!url.hostname) {
    throw new SyncError(
      "The Neon connection string has no host",
      "corrupt-data",
    );
  }
  return `https://${url.hostname}/sql`;
}

/** Everything travels as text; Postgres casts from the statement's `::`. */
function toWire(value: SqlValue): string | null {
  if (value === null) return null;
  if (value instanceof Uint8Array) return toByteaLiteral(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function isAuthCode(code: string | undefined): boolean {
  // 28000 invalid_authorization_specification, 28P01 invalid_password.
  return code === "28000" || code === "28P01";
}
