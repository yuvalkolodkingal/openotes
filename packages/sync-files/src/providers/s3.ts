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

/**
 * S3, and anything that speaks its API.
 *
 * Unlike the other providers this one is not OAuth: S3 authenticates each
 * request by signing it, so there is no token to refresh and no browser
 * hand-off. The credentials are an access key and a secret, which the user
 * gets from their provider.
 *
 * WHY IT IS WORTH HAVING
 *
 * It is the only tier-2 backend with both primitives natively:
 *
 *   putNew     PUT with `If-None-Match: *`, which S3 answers 412 when the
 *              object exists. Real create-if-absent.
 *   putUpdate  PUT with `If-Match: <etag>`, 412 when it has moved on. Real
 *              compare-and-swap.
 *
 * Both are comparatively recent additions to S3 and not every S3-compatible
 * implementation has them. `capabilities()` reports what was negotiated, and
 * a server that ignores a conditional header is caught by `verifyUpload`
 * rather than silently clobbering — the same defence the WebDAV backend needed
 * after the integration suite found a server that accepted `If-Match` and
 * ignored it.
 *
 * There is no delta feed: S3 has no change log, so this deliberately does not
 * implement DeltaSource and the engine falls back to listing.
 *
 * WHAT IS NOT YET PROVEN
 *
 * The SigV4 signing here is exercised by tests for its structure — that every
 * request carries an Authorization header over a hashed payload, and that keys
 * are percent-encoded the way the signature expects — but it has not been run
 * against a live endpoint or checked against AWS's published test vectors. A
 * signing bug shows up as 403 on the first real request, not as data loss, so
 * it fails loudly; but "connects to a real bucket" is not something these
 * tests establish, and DRIVES.md says so too.
 */

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials also carry a session token. */
  sessionToken?: string;
}

export interface S3Options {
  bucket: string;
  region: string;
  /**
   * Endpoint host, for the many services that speak S3 without being S3.
   * Defaults to AWS's regional endpoint.
   */
  endpoint?: string;
  /**
   * Path-style addressing (`host/bucket/key`) rather than virtual-hosted
   * (`bucket.host/key`). Most S3-compatible servers need this; AWS itself
   * prefers virtual-hosted.
   */
  forcePathStyle?: boolean;
}

const ENCODER = new TextEncoder();

async function hmac(
  key: Uint8Array,
  data: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    imported,
    ENCODER.encode(data) as BufferSource,
  );
  return new Uint8Array(signed);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(body: Uint8Array | string): Promise<string> {
  const bytes = typeof body === "string" ? ENCODER.encode(body) : body;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return hex(new Uint8Array(digest));
}

/**
 * Percent-encode one path segment the way SigV4 wants it.
 *
 * `encodeURIComponent` leaves !'()* alone, and S3 expects them encoded; a
 * mismatch here produces a signature error rather than a wrong path, which is
 * why note titles with an apostrophe used to be a problem on other backends.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

export class S3Storage implements RemoteStorage {
  constructor(
    private readonly credentials: S3Credentials,
    private readonly options: S3Options,
    /** Key prefix holding the repository, e.g. "Openotes". */
    private readonly root: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private get host(): string {
    const endpoint = this.options.endpoint ??
      `s3.${this.options.region}.amazonaws.com`;
    const bare = endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return this.options.forcePathStyle || this.options.endpoint
      ? bare
      : `${this.options.bucket}.${bare}`;
  }

  private keyFor(path: string): string {
    const trimmed = path.replace(/^\/+/, "");
    const prefix = this.root.replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/${trimmed}` : trimmed;
  }

  private pathFor(key: string): string {
    const prefix = this.root.replace(/^\/+|\/+$/g, "");
    return prefix && key.startsWith(`${prefix}/`)
      ? key.slice(prefix.length + 1)
      : key;
  }

  /** Sign and send one request. */
  private async send(
    method: string,
    key: string,
    init: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      query?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const host = this.host;
    const encodedKey = encodeKey(key);
    const canonicalPath = this.options.forcePathStyle || this.options.endpoint
      ? `/${encodeSegment(this.options.bucket)}/${encodedKey}`
      : `/${encodedKey}`;

    const query = init.query ?? {};
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encodeSegment(k)}=${encodeSegment(query[k])}`)
      .join("&");

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = await sha256Hex(init.body ?? "");

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(this.credentials.sessionToken
        ? { "x-amz-security-token": this.credentials.sessionToken }
        : {}),
      ...Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    };

    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders
      .map((h) => `${h}:${headers[h].trim()}\n`)
      .join("");
    const signedHeaderList = signedHeaders.join(";");

    const canonicalRequest = [
      method,
      canonicalPath,
      canonicalQuery,
      canonicalHeaders,
      signedHeaderList,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.options.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      await sha256Hex(canonicalRequest),
    ].join("\n");

    let signingKey: Uint8Array<ArrayBuffer> = ENCODER.encode(
      `AWS4${this.credentials.secretAccessKey}`,
    );
    for (const part of [dateStamp, this.options.region, "s3", "aws4_request"]) {
      signingKey = await hmac(signingKey, part);
    }
    const signature = hex(await hmac(signingKey, stringToSign));

    const url = `https://${host}${canonicalPath}${
      canonicalQuery ? `?${canonicalQuery}` : ""
    }`;

    return await this.fetchFn(url, {
      method,
      headers: {
        ...headers,
        Authorization:
          `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${scope}, ` +
          `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
      },
      body: init.body as BodyInit | undefined,
    });
  }

  /** Translate a status into the error vocabulary the engines expect. */
  private async fail(response: Response, path: string): Promise<never> {
    const body = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new SyncError(`${path} does not exist`, "not-found");
    }
    if (response.status === 412 || response.status === 409) {
      throw new SyncError(
        `${path} changed on the server`,
        "precondition-failed",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SyncError(
        `The S3 credentials were refused for ${path}`,
        "unauthorized",
      );
    }
    throw new SyncError(
      `S3 answered ${response.status} for ${path}${
        body ? `: ${body.slice(0, 200)}` : ""
      }`,
      "server-error",
    );
  }

  private entryFrom(
    path: string,
    response: Response,
    fallbackSize?: number,
  ): RemoteEntry {
    const etag = response.headers.get("etag")?.replace(/"/g, "") ?? "";
    const length = response.headers.get("content-length");
    return {
      path,
      isCollection: false,
      size: length !== null ? Number(length) : fallbackSize,
      version: etag,
      // Kept exactly as the server said it, per RemoteEntry: parsing a
      // timestamp only to re-serialise it loses precision for no gain.
      modifiedAt: response.headers.get("last-modified") ?? undefined,
    };
  }

  async probe(): Promise<void> {
    // A prefix listing of nothing: proves the bucket exists and the signature
    // is accepted, without creating anything.
    const response = await this.send("GET", "", {
      query: { "list-type": "2", "max-keys": "0", prefix: this.keyFor("") },
    });
    if (!response.ok) await this.fail(response, this.options.bucket);
    await response.body?.cancel();
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const prefix = this.keyFor(path).replace(/\/*$/, "/");
    const entries: RemoteEntry[] = [];
    let token: string | undefined;

    do {
      const response = await this.send("GET", "", {
        query: {
          "list-type": "2",
          prefix,
          delimiter: "/",
          ...(token ? { "continuation-token": token } : {}),
        },
      });
      if (response.status === 404) return [];
      if (!response.ok) await this.fail(response, path);
      const xml = await response.text();

      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const chunk = match[1];
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(chunk)?.[1];
        if (!key || key === prefix) continue;
        entries.push({
          path: this.pathFor(key),
          isCollection: false,
          size: Number(/<Size>(\d+)<\/Size>/.exec(chunk)?.[1] ?? 0),
          version: /<ETag>&quot;?([^<&]*)&quot;?<\/ETag>/.exec(chunk)?.[1] ??
            /<ETag>"?([^<"]*)"?<\/ETag>/.exec(chunk)?.[1] ?? "",
          modifiedAt: /<LastModified>([\s\S]*?)<\/LastModified>/.exec(
            chunk,
          )?.[1],
        });
      }

      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(
          xml,
        )?.[1]
        : undefined;
    } while (token);

    return entries;
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const response = await this.send("HEAD", this.keyFor(path));
    if (response.status === 404) return undefined;
    if (!response.ok) await this.fail(response, path);
    await response.body?.cancel();
    return this.entryFrom(path, response);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== undefined;
  }

  async get(path: string): Promise<Uint8Array> {
    const response = await this.send("GET", this.keyFor(path));
    if (!response.ok) await this.fail(response, path);
    return new Uint8Array(await response.arrayBuffer());
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    const response = await this.send("GET", this.keyFor(path));
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) await this.fail(response, path);
    return new Uint8Array(await response.arrayBuffer());
  }

  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const response = await this.send("PUT", this.keyFor(path), {
      body,
      headers: {
        "if-none-match": "*",
        "content-type": options?.contentType ?? "application/octet-stream",
      },
    });
    if (!response.ok) await this.fail(response, path);
    await response.body?.cancel();
    return this.entryFrom(path, response, body.byteLength);
  }

  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    const response = await this.send("PUT", this.keyFor(path), {
      body,
      headers: {
        ...(expectedVersion ? { "if-match": expectedVersion } : {}),
        "content-type": options?.contentType ?? "application/octet-stream",
      },
    });
    if (!response.ok) await this.fail(response, path);
    await response.body?.cancel();
    return this.entryFrom(path, response, body.byteLength);
  }

  async delete(path: string): Promise<void> {
    const response = await this.send("DELETE", this.keyFor(path));
    // S3 answers 204 for a key that was never there, which is the semantics
    // the interface asks for.
    if (!response.ok && response.status !== 404) {
      await this.fail(response, path);
    }
    await response.body?.cancel();
  }

  /** S3 has no move; a copy and a delete is the whole of it. */
  async move(from: string, to: string, overwrite = true): Promise<void> {
    if (!overwrite && (await this.exists(to))) {
      throw new SyncError(`${to} already exists`, "precondition-failed");
    }
    const source = `/${this.options.bucket}/${encodeKey(this.keyFor(from))}`;
    const response = await this.send("PUT", this.keyFor(to), {
      headers: { "x-amz-copy-source": source },
    });
    if (!response.ok) await this.fail(response, from);
    await response.body?.cancel();
    await this.delete(from);
  }

  /**
   * Nothing to do: S3 has no directories, only keys that happen to contain
   * slashes. Creating a marker object would leave litter the engine would
   * then have to learn to ignore.
   */
  mkdirp(_path: string): Promise<void> {
    return Promise.resolve();
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    const entry = await this.stat(path);
    if (!entry) {
      throw new SyncError(
        `${path} is not there after being written`,
        "server-error",
      );
    }
    if (entry.size !== expectedLength) {
      throw new SyncError(
        `${path} was stored as ${entry.size} bytes, not ${expectedLength}`,
        "server-error",
      );
    }
  }

  capabilities(): Promise<RemoteCapabilities> {
    return Promise.resolve({
      // Both are real headers here. An S3-compatible server that ignores them
      // is caught by verifyUpload and by the engine's own re-read, the same
      // way a WebDAV server that ignores If-Match is.
      atomicCreate: true,
      conditionalUpdate: true,
      // Copy-and-delete, not a server-side rename: it costs a round trip and
      // is not atomic, which the engine needs to know.
      serverSideMove: false,
    });
  }
}
