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

import postgres from "postgres";
import { SyncError } from "@notesnook/sync-core";
import type { SqlExecutor, SqlResult, SqlValue } from "./executor.ts";
import { describeConnection } from "./connection.ts";

/**
 * Any Postgres, over its own wire protocol.
 *
 * This is the desktop's transport for a database the user runs or rents --
 * a VPS, a NAS, a managed instance -- and works for Neon and Supabase too
 * when their socket ports are reachable. It is a separate module because it
 * opens a TCP socket: the phone cannot, and does not import it.
 *
 * postgres.js is pure JavaScript, so it embeds in the desktop binary without
 * a native addon. One connection is enough: a sync cycle is sequential.
 */
export class PostgresExecutor implements SqlExecutor {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(
    connectionString: string,
    options: { timeoutSeconds?: number } = {},
  ) {
    const summary = describeConnection(connectionString);
    this.sql = postgres(connectionString, {
      max: 1,
      // Neon and Supabase both require TLS; a local server usually has none.
      // `prefer` would silently fall back to plaintext on a remote host, so
      // the choice is explicit from the host rather than negotiated.
      ssl: summary.ssl ? "require" : false,
      connect_timeout: options.timeoutSeconds ?? 30,
      idle_timeout: 60,
      // Never rewrite the statements: the storage layer's `::` casts are the
      // whole of the type story, on purpose, so the HTTP transports match.
      transform: undefined,
      onnotice: () => {},
    });
  }

  async query(text: string, params: SqlValue[] = []): Promise<SqlResult> {
    try {
      const result = await this.sql.unsafe(text, params as never[]);
      return {
        rows: [...result] as Record<string, unknown>[],
        rowCount: result.count ?? result.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: string }).code;
      if (code === "28000" || code === "28P01") {
        throw new SyncError(
          `The database refused the credentials: ${message}`,
          "unauthorized",
        );
      }
      if (
        code === "ECONNREFUSED" || code === "ENOTFOUND" ||
        code === "CONNECT_TIMEOUT"
      ) {
        throw new SyncError(
          `Could not reach the database: ${message}`,
          "network",
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
