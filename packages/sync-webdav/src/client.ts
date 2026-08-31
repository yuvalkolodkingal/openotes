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

import { HttpRequest, HttpResponse, HttpTransport } from "./http.ts";
import { DavEntry, parseMultistatus, PROPFIND_BODY } from "./xml.ts";
import { SyncError } from "./types.ts";

export interface WebDavClientOptions {
  baseUrl: string;
  requestTimeout?: number;
  maxRetries?: number;
  allowInsecureHttp?: boolean;
  /** Delay function, injectable for tests. */
  delay?: (ms: number) => Promise<void>;
}

export interface PutOptions {
  /** Only create; fail with precondition-failed if the resource exists. */
  ifNoneMatch?: boolean;
  /** Only overwrite when the current ETag matches. */
  ifMatch?: string;
  contentType?: string;
}

const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 507, 429]);

/**
 * A deliberately small WebDAV client implementing exactly the verbs the
 * sync/backup engines need: OPTIONS, PROPFIND, MKCOL, GET, PUT, DELETE,
 * MOVE, HEAD — with conditional requests and compatibility fallbacks for
 * servers that implement optional features differently (nginx, Apache
 * mod_dav, Nextcloud/ownCloud/sabre, dufs, ...).
 */
export class WebDavClient {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(
    private readonly transport: HttpTransport,
    options: WebDavClientOptions,
  ) {
    let url = options.baseUrl;
    if (!/^https?:\/\//i.test(url)) {
      throw new SyncError(
        `Invalid WebDAV URL: ${url} — must start with http:// or https://`,
        "insecure-url",
      );
    }
    if (url.startsWith("http://") && !options.allowInsecureHttp) {
      throw new SyncError(
        "Plain HTTP WebDAV is disabled. Use HTTPS, or explicitly enable " +
          "insecure connections for trusted local networks.",
        "insecure-url",
      );
    }
    if (!url.endsWith("/")) url += "/";
    this.baseUrl = url;
    this.basePath = new URL(url).pathname;
    this.timeout = options.requestTimeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.delay = options.delay ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Resolve a repository-relative path to an absolute URL. */
  url(path: string): string {
    const clean = path
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => {
        if (part === "." || part === "..") {
          throw new SyncError(
            `Invalid path segment in "${path}"`,
            "corrupt-data",
          );
        }
        return encodeURIComponent(part);
      })
      .join("/");
    return this.baseUrl + clean + (path.endsWith("/") && clean ? "/" : "");
  }

  /** Path of a DavEntry relative to the client's base path. */
  relativePath(entry: DavEntry): string {
    let path = entry.href;
    if (path.startsWith(this.basePath)) {
      path = path.slice(this.basePath.length);
    }
    return path.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private async send(
    req: HttpRequest,
    okStatuses: number[],
    retryable = true,
  ): Promise<HttpResponse> {
    let lastError: SyncError | undefined;
    const attempts = retryable ? this.maxRetries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        await this.delay(Math.min(2 ** attempt * 500, 8000));
      }
      let response: HttpResponse;
      try {
        response = await this.transport.request({
          timeout: this.timeout,
          ...req,
        });
      } catch (e) {
        lastError = e instanceof SyncError
          ? e
          : new SyncError(String(e), "network");
        if (!lastError.isRetryable || lastError.code === "cancelled") {
          throw lastError;
        }
        continue;
      }
      if (okStatuses.includes(response.status)) return response;
      const error = statusToError(response.status, req);
      if (retryable && error.isRetryable) {
        lastError = error;
        continue;
      }
      throw error;
    }
    throw lastError ??
      new SyncError(`Request failed: ${req.method} ${req.url}`, "network");
  }

  async options(): Promise<{ dav: string; allow: string }> {
    const response = await this.send(
      { method: "OPTIONS", url: this.baseUrl },
      [200, 204, 207],
    );
    return {
      dav: response.headers["dav"] ?? "",
      allow: response.headers["allow"] ?? "",
    };
  }

  async head(
    path: string,
  ): Promise<{ exists: boolean; etag?: string; contentLength?: number }> {
    try {
      const response = await this.send(
        { method: "HEAD", url: this.url(path) },
        [200, 204],
      );
      const length = response.headers["content-length"];
      return {
        exists: true,
        etag: response.headers["etag"],
        contentLength: length ? parseInt(length, 10) : undefined,
      };
    } catch (e) {
      if (e instanceof SyncError && e.code === "not-found") {
        return { exists: false };
      }
      throw e;
    }
  }

  async propfind(path: string, depth: 0 | 1 = 1): Promise<DavEntry[]> {
    const response = await this.send(
      {
        method: "PROPFIND",
        url: this.url(path.endsWith("/") || path === "" ? path : path + "/"),
        headers: {
          Depth: String(depth),
          "Content-Type": 'application/xml; charset="utf-8"',
        },
        body: PROPFIND_BODY,
      },
      [207, 200],
    );
    const text = new TextDecoder().decode(response.body);
    return parseMultistatus(text);
  }

  /** List non-collection children of a directory. Returns [] when missing. */
  async list(path: string): Promise<DavEntry[]> {
    let entries: DavEntry[];
    try {
      entries = await this.propfind(path, 1);
    } catch (e) {
      if (e instanceof SyncError && e.code === "not-found") return [];
      throw e;
    }
    const selfPath = this.relativePath({
      href: new URL(this.url(path)).pathname,
      isCollection: true,
    });
    return entries.filter((entry) => this.relativePath(entry) !== selfPath);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.head(path)).exists;
  }

  async mkcol(path: string): Promise<void> {
    try {
      await this.send(
        {
          method: "MKCOL",
          url: this.url(path.endsWith("/") ? path : path + "/"),
        },
        [201, 200],
      );
    } catch (e) {
      // 405 = already exists on most servers; treat as success.
      if (e instanceof SyncError && e.status === 405) return;
      // Some servers reply 409 when the collection exists as well; probe.
      if (e instanceof SyncError && e.code === "conflict") {
        try {
          const entries = await this.propfind(path, 0);
          if (entries.length > 0 && entries[0].isCollection) return;
        } catch {
          /* fall through to the original error */
        }
      }
      throw e;
    }
  }

  /** Create a directory and any missing parents. */
  async mkcolRecursive(path: string): Promise<void> {
    const parts = path.split("/").filter((part) => part.length > 0);
    let current = "";
    for (const part of parts) {
      current += part + "/";
      await this.mkcol(current);
    }
  }

  async get(path: string): Promise<Uint8Array> {
    const response = await this.send(
      { method: "GET", url: this.url(path) },
      [200],
    );
    return response.body;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    try {
      return await this.get(path);
    } catch (e) {
      if (e instanceof SyncError && e.code === "not-found") return undefined;
      throw e;
    }
  }

  async put(
    path: string,
    body: Uint8Array | string,
    options: PutOptions = {},
  ): Promise<{ etag?: string }> {
    const headers: Record<string, string> = {
      "Content-Type": options.contentType ?? "application/octet-stream",
    };
    if (options.ifNoneMatch) headers["If-None-Match"] = "*";
    if (options.ifMatch) headers["If-Match"] = options.ifMatch;

    // PUT is not retried blindly when conditional headers are absent could
    // cause duplicate work — but PUT to the same path is idempotent, so
    // retries are safe. Conditional failures (412) are never retried.
    const response = await this.send(
      { method: "PUT", url: this.url(path), headers, body },
      [200, 201, 204],
    );
    return { etag: response.headers["etag"] };
  }

  async delete(path: string): Promise<void> {
    try {
      await this.send(
        { method: "DELETE", url: this.url(path) },
        [200, 202, 204],
      );
    } catch (e) {
      if (e instanceof SyncError && e.code === "not-found") return;
      throw e;
    }
  }

  async move(from: string, to: string, overwrite = true): Promise<void> {
    try {
      await this.send(
        {
          method: "MOVE",
          url: this.url(from),
          headers: {
            Destination: this.url(to),
            Overwrite: overwrite ? "T" : "F",
          },
        },
        [200, 201, 204],
      );
      return;
    } catch (e) {
      // Compatibility fallback: some minimal servers don't implement MOVE.
      if (
        e instanceof SyncError &&
        (e.status === 405 || e.status === 501 || e.code === "forbidden")
      ) {
        const body = await this.get(from);
        await this.put(to, body, overwrite ? {} : { ifNoneMatch: true });
        await this.delete(from);
        return;
      }
      throw e;
    }
  }

  /**
   * Verify a write landed (spec: "Never mark a record as synchronized before
   * the corresponding remote object is verified as uploaded").
   */
  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const head = await this.head(path);
    if (!head.exists) {
      throw new SyncError(
        `Upload verification failed: ${path} does not exist on the server`,
        "corrupt-data",
      );
    }
    if (
      head.contentLength !== undefined &&
      head.contentLength !== expectedLength
    ) {
      throw new SyncError(
        `Upload verification failed: ${path} has length ` +
          `${head.contentLength}, expected ${expectedLength}`,
        "corrupt-data",
      );
    }
  }
}

function statusToError(status: number, req: HttpRequest): SyncError {
  const suffix = ` (${req.method} ${req.url} → HTTP ${status})`;
  switch (status) {
    case 401:
      return new SyncError(
        "Authentication failed — check your WebDAV username and password" +
          suffix,
        "unauthorized",
        status,
      );
    case 403:
      return new SyncError(
        "The WebDAV server denied access" + suffix,
        "forbidden",
        status,
      );
    case 404:
    case 410:
      return new SyncError("Not found" + suffix, "not-found", status);
    case 409:
      return new SyncError(
        "Conflict — a parent collection may be missing" + suffix,
        "conflict",
        status,
      );
    case 412:
      return new SyncError(
        "Precondition failed — the resource changed on the server" + suffix,
        "precondition-failed",
        status,
      );
    case 423:
      return new SyncError("Resource is locked" + suffix, "forbidden", status);
    default:
      if (RETRYABLE_STATUS.has(status)) {
        return new SyncError("Server error" + suffix, "server-error", status);
      }
      return new SyncError(
        "Unexpected response" + suffix,
        "server-error",
        status,
      );
  }
}
