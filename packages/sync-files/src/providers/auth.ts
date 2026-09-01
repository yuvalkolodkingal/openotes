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

import { SyncError } from "@notesnook/sync-core";

/**
 * Shared plumbing for the cloud-drive providers.
 *
 * Each provider is plain `fetch` against a documented HTTP API — no SDKs, the
 * same choice packages/sync-webdav made. An SDK for three providers would be
 * three dependency trees, three release cadences and three different opinions
 * about retries, to wrap request shapes that fit on a page each.
 */

/**
 * Supplies a valid bearer token, refreshing it when needed.
 *
 * The host implements this over the encrypted credential store; a test
 * implements it with a constant. Refreshing lives behind this interface so no
 * provider has to know about OAuth.
 */
export interface TokenProvider {
  token(): Promise<string>;
  /**
   * Called after a 401, to force a refresh before one retry. Returns false
   * when the connection cannot be recovered and the user must sign in again.
   */
  refresh(): Promise<boolean>;
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  /** Parse the response as JSON. Defaults to true. */
  json?: boolean;
  /** Statuses to return rather than throw on, e.g. 409 for a conflict probe. */
  expect?: number[];
  signal?: AbortSignal;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  /** Parsed JSON, or raw bytes when `json` was false. */
  body: unknown;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;

/**
 * One authenticated request, with the two recoveries every provider needs:
 * a single retry after refreshing an expired token, and backoff on the
 * statuses that mean "later" rather than "no".
 *
 * `Retry-After` is honoured when present. Dropbox and Graph both send it, and
 * ignoring it is how an application earns a longer ban.
 */
export async function authedFetch(
  tokens: TokenProvider,
  url: string,
  options: HttpOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<HttpResult> {
  let refreshed = false;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await delay(Math.min(2 ** attempt * 500, 8000));
    }

    const token = await tokens.token();
    const response = await fetchFn(url, {
      method: options.method ?? "GET",
      headers: {
        ...options.headers,
        authorization: `Bearer ${token}`,
      },
      body: options.body,
      signal: options.signal,
    });

    if (response.status === 401 && !refreshed) {
      // One refresh, one retry. A second 401 after a successful refresh means
      // the grant is gone, not that the token was stale.
      refreshed = true;
      await response.body?.cancel();
      if (await tokens.refresh()) continue;
      throw new SyncError(
        "This account is no longer connected. Sign in again to resume syncing.",
        "unauthorized",
        401,
      );
    }

    if (RETRYABLE.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        await delay(Math.min(retryAfter * 1000, 30_000));
      }
      continue;
    }

    if (!response.ok && !(options.expect ?? []).includes(response.status)) {
      throw await toSyncError(response, url);
    }

    return {
      status: response.status,
      headers: response.headers,
      body: options.json === false
        ? new Uint8Array(await response.arrayBuffer())
        : await readJson(response),
    };
  }

  throw new SyncError(
    `The provider did not respond successfully after ${MAX_ATTEMPTS} attempts`,
    "server-error",
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toSyncError(
  response: Response,
  url: string,
): Promise<SyncError> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 400);
  } catch {
    // Body already consumed or unreadable; the status is enough.
  }
  const where = ` (${new URL(url).pathname} → HTTP ${response.status})`;
  switch (response.status) {
    case 401:
      return new SyncError(
        "This account is no longer connected. Sign in again to resume syncing." +
          where,
        "unauthorized",
        401,
      );
    case 403:
      return new SyncError(
        "The provider denied access. The app may need permission again." +
          where + (detail ? ` ${detail}` : ""),
        "forbidden",
        403,
      );
    case 404:
      return new SyncError("Not found" + where, "not-found", 404);
    case 409:
      return new SyncError(
        "Conflict" + where + (detail ? ` ${detail}` : ""),
        "conflict",
        409,
      );
    case 412:
      return new SyncError(
        "The file changed on the server" + where,
        "precondition-failed",
        412,
      );
    case 507:
      return new SyncError(
        "The account is out of storage space." + where,
        "server-error",
        507,
      );
    default:
      return new SyncError(
        `Unexpected response${where}${detail ? ` ${detail}` : ""}`,
        response.status >= 500 ? "server-error" : "corrupt-data",
        response.status,
      );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Join a repository root with a repository-relative path. */
export function joinPath(root: string, path: string): string {
  const left = root.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!right) return left || "/";
  return `${left}/${right}`;
}
