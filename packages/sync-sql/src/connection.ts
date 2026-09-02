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

/**
 * What a Postgres connection string says, minus the secret.
 *
 * Settings screens show the host and database so a user can tell which
 * repository a device is on; the password stays in the credential store and
 * is never part of what this returns.
 */
export interface ConnectionSummary {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Whether the string carries a password at all. */
  hasPassword: boolean;
  /** Recognised hosting, for choosing a transport and a setup path. */
  hosting: "neon" | "supabase" | "postgres";
  ssl: boolean;
}

export function describeConnection(
  connectionString: string,
): ConnectionSummary {
  let url: URL;
  try {
    url = new URL(connectionString.trim());
  } catch {
    throw new SyncError(
      "That is not a Postgres connection string. It should look like " +
        "postgresql://user:password@host/database",
      "corrupt-data",
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new SyncError(
      "A connection string starts with postgresql://",
      "corrupt-data",
    );
  }
  const host = url.hostname;
  if (!host) {
    throw new SyncError("The connection string has no host", "corrupt-data");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) ||
    "postgres";
  const sslmode = url.searchParams.get("sslmode");
  return {
    host,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username),
    hasPassword: url.password.length > 0,
    hosting: hostingOf(host),
    ssl: sslmode !== "disable" && sslmode !== "allow" && !isLocal(host),
  };
}

export function hostingOf(host: string): ConnectionSummary["hosting"] {
  const lower = host.toLowerCase();
  if (lower.endsWith(".neon.tech") || lower.endsWith(".neon.build")) {
    return "neon";
  }
  if (lower.endsWith(".supabase.co") || lower.endsWith(".supabase.com")) {
    return "supabase";
  }
  return "postgres";
}

function isLocal(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** The project ref of a Supabase URL (https://<ref>.supabase.co), if any. */
export function supabaseProjectRef(projectUrl: string): string | undefined {
  try {
    const host = new URL(projectUrl.trim()).hostname.toLowerCase();
    const match = /^([a-z]{20})\.supabase\.(co|com|in)$/.exec(host);
    return match?.[1];
  } catch {
    return undefined;
  }
}
