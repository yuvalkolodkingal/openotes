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
 * Putting bytes into Google Drive.
 *
 * Drive has two upload protocols and the choice between them is about size,
 * not preference. A multipart upload is one request carrying the metadata
 * and the content together — the cheapest thing that works, and what nearly
 * every write in the sync protocol is, a journal batch being a few
 * kilobytes. Past a few megabytes Google's own guidance is the resumable
 * protocol: a POST that opens a session and a PUT that fills it, which is
 * the only path that survives an attachment large enough for a proxy or a
 * mobile hotspot to cut the connection halfway.
 *
 * The threshold is 5 MB, which is where Google draws it.
 *
 * The content is uploaded in a single PUT rather than in chunks. There is
 * nothing to gain from chunking here: the body is already a Uint8Array in
 * memory (the sync engine encrypts whole records), and the shared HTTP
 * client replays whole requests, so a chunk loop would add bookkeeping
 * without adding a resume point anyone could use.
 */

import { SyncError } from "@notesnook/sync-remote";
import {
  DRIVE_FILE_FIELDS,
  type DriveFile,
  parseDriveFile,
} from "./path-index.ts";
import { DriveTransport, expectJson, expectOk } from "./errors.ts";

/** Where uploads go; the metadata API lives on a different path. */
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

/** Above this, open a resumable session instead of posting one request. */
export const RESUMABLE_THRESHOLD_BYTES = 5 * 1024 * 1024;

/**
 * The slowest uplink an upload timeout should still tolerate. A 30 s
 * request timeout is right for a metadata call and hopeless for a 40 MB
 * attachment on domestic DSL: every attempt would abort at the same place
 * and the attachment would never sync.
 */
const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;

export interface DriveUploadRequest {
  transport: DriveTransport;
  /** The name the file gets, or keeps. */
  name: string;
  body: Uint8Array;
  contentType: string;
  /**
   * Set to replace the content of an existing file. Leave it out to create
   * a new one, in which case `parentId` says where.
   */
  fileId?: string;
  /** The folder a new file goes in. Ignored when `fileId` is set. */
  parentId?: string;
  /** The configured per-request timeout, which large bodies extend. */
  requestTimeout: number;
  /** Verb phrase for error messages: "write devices/a/1.bin". */
  action: string;
}

/** Upload `body`, choosing the protocol by size. Returns Drive's own view. */
export function uploadFile(request: DriveUploadRequest): Promise<DriveFile> {
  assertHeaderSafe(request.contentType, request.action);
  return request.body.length > RESUMABLE_THRESHOLD_BYTES
    ? resumableUpload(request)
    : multipartUpload(request);
}

/**
 * One request: a multipart/related body whose first part is the metadata
 * JSON and whose second part is the content.
 */
async function multipartUpload(
  request: DriveUploadRequest,
): Promise<DriveFile> {
  // A random boundary, because the delimiter must not occur in the content
  // and the content is arbitrary encrypted bytes. A v4 UUID makes that
  // collision impossible in practice, where a fixed string would not.
  const boundary = `openotes-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadataFor(request))}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${request.contentType}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + request.body.length + tail.length);
  body.set(head, 0);
  body.set(request.body, head.length);
  body.set(tail, head.length + request.body.length);

  const response = await request.transport.request({
    url: uploadUrl(request, "multipart"),
    method: request.fileId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
    timeout: uploadTimeout(request.requestTimeout, body.length),
  }, request.action);
  return parseDriveFile(expectJson(response, request.action), request.action);
}

/** Two requests: open a session, then fill it. */
async function resumableUpload(
  request: DriveUploadRequest,
): Promise<DriveFile> {
  const start = await request.transport.request({
    url: uploadUrl(request, "resumable"),
    method: request.fileId ? "PATCH" : "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      // Declaring both up front lets Drive reject an upload that cannot fit
      // in the account's remaining quota before the bytes are sent, instead
      // of after.
      "X-Upload-Content-Type": request.contentType,
      "X-Upload-Content-Length": String(request.body.length),
    },
    body: JSON.stringify(metadataFor(request)),
  }, request.action);
  expectOk(start, request.action);

  const session = sessionUri(start.headers["location"], request.action);
  const response = await request.transport.request({
    url: session,
    method: "PUT",
    headers: { "Content-Type": request.contentType },
    body: request.body,
    // The session URI carries its own credential (the upload_id) and Drive
    // is free to put it on a different host. Attaching the bearer token
    // would hand a live, write-capable Drive token to whatever host the API
    // named — which is the one thing the shared client exists to prevent.
    anonymous: true,
    timeout: uploadTimeout(request.requestTimeout, request.body.length),
  }, request.action);
  // A complete single-shot PUT answers 200 or 201 with the file resource.
  // A 308 would mean Drive received fewer bytes than were sent; the shared
  // client classifies 308 as a redirect and rejects it for having no
  // Location, which reports the truncation as the failure it is.
  return parseDriveFile(expectJson(response, request.action), request.action);
}

function metadataFor(request: DriveUploadRequest): Record<string, unknown> {
  const metadata: Record<string, unknown> = { name: request.name };
  // `parents` is writable only when the file is created. Sending it on an
  // update is rejected, and the parent is changed with the addParents /
  // removeParents query parameters instead — see the store's move().
  if (!request.fileId && request.parentId) {
    metadata.parents = [request.parentId];
  }
  return metadata;
}

function uploadUrl(
  request: DriveUploadRequest,
  uploadType: "multipart" | "resumable",
): string {
  const url = new URL(
    request.fileId
      ? `${DRIVE_UPLOAD_URL}/${encodeURIComponent(request.fileId)}`
      : DRIVE_UPLOAD_URL,
  );
  url.searchParams.set("uploadType", uploadType);
  // Without this the answer is a bare id, and the caller would need another
  // round trip for the size it is about to verify.
  url.searchParams.set("fields", DRIVE_FILE_FIELDS);
  return url.toString();
}

function sessionUri(location: string | undefined, action: string): string {
  if (!location) {
    throw new SyncError(
      `Google Drive opened an upload session to ${action} but did not say ` +
        `where to send the content`,
      "server-error",
    );
  }
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new SyncError(
      `Google Drive opened an upload session to ${action} at an address ` +
        `that cannot be parsed`,
      "corrupt-data",
    );
  }
  if (url.protocol !== "https:") {
    throw new SyncError(
      `Refusing to upload to ${url.protocol}//${url.host} — Google Drive ` +
        `is https only`,
      "insecure-url",
    );
  }
  return url.toString();
}

function uploadTimeout(base: number, bytes: number): number {
  return Math.max(base, Math.ceil(bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
}

/**
 * The content type is written into a header — a real one for the resumable
 * PUT, a part header inside the multipart body. A newline in it would end
 * that header and let the rest be read as another one, so a value that is
 * not plain printable ASCII is refused rather than sanitized: every caller
 * in this package passes a constant, so a strange one is a bug worth
 * seeing.
 */
function assertHeaderSafe(contentType: string, action: string): void {
  if (/^[\x20-\x7e]+$/.test(contentType)) return;
  throw new SyncError(
    `Refusing to ${action}: ${JSON.stringify(contentType)} is not a usable ` +
      `content type`,
    "corrupt-data",
  );
}
