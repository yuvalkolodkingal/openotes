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

import { SyncError } from "./types.ts";

/**
 * Transport abstraction so the WebDAV client can run:
 *  - directly on `fetch` (Deno runtime, tests, the desktop process), and
 *  - proxied through desktop bindings from inside the OS webview, where
 *    cross-origin requests to a WebDAV server would be blocked by CORS and
 *    where credentials must not be exposed to renderer code.
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Basic-auth credential provider. Keeps the password out of config objects. */
export interface CredentialProvider {
  getBasicAuth(): Promise<string | undefined>;
}

export class FetchTransport implements HttpTransport {
  constructor(
    private readonly credentials?: CredentialProvider,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const headers = new Headers(req.headers);
    if (this.credentials && !headers.has("Authorization")) {
      const auth = await this.credentials.getBasicAuth();
      if (auth) headers.set("Authorization", auth);
    }

    const controller = new AbortController();
    const timeout = req.timeout ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeout);
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener("abort", () => controller.abort());
    }

    try {
      const response = await this.fetchFn(req.url, {
        method: req.method,
        headers,
        body: req.body as BodyInit | undefined,
        signal: controller.signal,
        redirect: "follow",
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      return { status: response.status, headers: responseHeaders, body };
    } catch (e) {
      if (controller.signal.aborted && !req.signal?.aborted) {
        throw new SyncError(`Request timed out after ${timeout}ms`, "timeout");
      }
      if (req.signal?.aborted) {
        throw new SyncError("Request cancelled", "cancelled");
      }
      throw new SyncError(
        `Network error: ${e instanceof Error ? e.message : String(e)}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export function toBasicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`;
  // btoa() only handles latin1; encode via bytes for full UTF-8 support.
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}
