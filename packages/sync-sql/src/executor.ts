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
 * The one thing a SQL transport has to provide: run a parameterised
 * statement, return the rows. Postgres placeholders ($1, $2, …) throughout.
 *
 * Kept this small on purpose so it can be met by a socket driver, by an HTTP
 * endpoint, and by a recording fake in tests. Transactions are deliberately
 * not part of it -- Neon's HTTP endpoint offers them only for batches, and
 * PostgREST not at all -- so the storage layer is written to need none:
 * every guarantee rests on a single statement.
 */
export interface SqlExecutor {
  query(sql: string, params?: SqlValue[]): Promise<SqlResult>;
  /** Release whatever the transport holds. Optional; HTTP has nothing. */
  close?(): Promise<void>;
}

export type SqlValue = string | number | boolean | null | Uint8Array;

export interface SqlResult {
  rows: Record<string, unknown>[];
  /** Rows affected for a write, rows returned for a read. */
  rowCount: number;
}

/**
 * Postgres's own text form of `bytea`: `\x` followed by hex. It is what the
 * HTTP transports send and receive, and what a socket driver accepts too, so
 * it is the one encoding used everywhere rather than a second base64 one.
 */
export function toByteaLiteral(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `\\x${hex}`;
}

/**
 * Bytes back out of whatever a transport returned for a `bytea` column.
 *
 * Every transport in this package produces the `\x` text form; a socket
 * driver may hand back the buffer itself. Anything else is refused loudly,
 * because silently decoding the wrong thing would corrupt a note.
 */
export function fromByteaValue(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    // A driver's Buffer is a Uint8Array subclass; callers compare against
    // plain ones, so hand back the plain kind.
    return value.constructor === Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    if (value.startsWith("\\x") || value.startsWith("\\X")) {
      const hex = value.slice(2);
      if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
        throw new Error("Malformed bytea hex from the database");
      }
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return out;
    }
    throw new Error("Unexpected text where bytea was expected");
  }
  throw new Error(`Unexpected ${typeof value} where bytea was expected`);
}
