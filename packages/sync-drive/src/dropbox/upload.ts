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
 * Putting bytes into Dropbox, and proving they arrived.
 *
 * THE ARGUMENT TRAVELS IN A HEADER. A content endpoint takes the file as
 * the request body, so everything else — the path, the write mode — goes in
 * `Dropbox-API-Arg` as JSON. A header cannot hold a byte above 0x7f, and a
 * note titled in Hebrew or with an emoji is an ordinary filename here, so
 * the JSON is escaped to ASCII before it is sent (see `apiArg`); without
 * that the whole request is rejected and every non-Latin title is
 * unsyncable.
 *
 * ONE REQUEST, OR A SESSION. Dropbox refuses a single `files/upload` above
 * 150 MB, so past 140 MB the upload becomes three routes: `start`, one
 * `append_v2` per chunk, and `finish`, which is the request that names the
 * destination and commits. The engine writes kilobyte-sized journal
 * batches, so this path exists for attachments and for backups.
 *
 * THE CONFLICT BEHAVIOUR IS DECIDED AT THE START AND ENFORCED AT THE END.
 * `create` writes with mode "add", and Dropbox reports the taken name at
 * the single upload or at `finish` depending on which path the size chose.
 * Both have to produce `precondition-failed`, or a lost race looks like a
 * hard error and the journal stops advancing.
 *
 * AND THE BYTES ARE CHECKED. Every write is answered with the size and the
 * `content_hash` of what Dropbox stored, and both are compared against the
 * body before the write is called done. It is the only end-to-end integrity
 * check the API offers, it costs one local SHA-256 pass, and it is what
 * lets `verifyUpload` trust a fresh write instead of asking again.
 */

import { SyncError } from "@notesnook/sync-remote";
import { encodeHex } from "@std/encoding";
import type {
  AuthorizedRequest,
  AuthorizedResponse,
} from "../http/authorized-fetch.ts";
import {
  asRecord,
  DROPBOX_LABEL,
  dropboxError,
  dropboxFailure,
  dropboxJson,
  hasTag,
  nameTaken,
} from "./errors.ts";

/**
 * Above this a single `files/upload` is refused. Dropbox draws the line at
 * 150 MB; the margin covers the difference between the body we measure and
 * the request Dropbox measures.
 */
export const SINGLE_UPLOAD_LIMIT = 140 * 1024 * 1024;

/**
 * Dropbox recommends a few megabytes per `append_v2`. 8 MiB is two whole
 * content-hash blocks, so a chunk boundary never falls inside one, and it
 * is small enough that a failed chunk on a domestic uplink costs a retry
 * rather than a quarter of an hour.
 */
export const UPLOAD_SESSION_CHUNK_SIZE = 8 * 1024 * 1024;

/** The block size of Dropbox's content_hash. Fixed by the service. */
const HASH_BLOCK_SIZE = 4 * 1024 * 1024;

/** SHA-256, in bytes. */
const DIGEST_SIZE = 32;

/**
 * The slowest uplink an upload timeout should still tolerate. A 30 s
 * request timeout is right for a metadata call and hopeless for an 8 MiB
 * chunk on domestic DSL: every attempt would abort at the same place and
 * the attachment would never sync.
 */
const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;

/**
 * How many times an upload may take Dropbox's word for where it is before
 * giving up. A session that keeps naming the same offset would otherwise
 * spin here forever; a retryable failure hands the whole upload to the next
 * sync cycle, which starts a fresh session.
 */
const MAX_OFFSET_CORRECTIONS = 3;

const EMPTY_BODY = new Uint8Array(0);

/**
 * The one method an upload needs from AuthorizedFetch.
 *
 * Narrowing it lets the store hand over whatever it uses for its own
 * requests, so a large upload reports the same errors as a small one, and
 * lets a test answer without a network. AuthorizedFetch satisfies this
 * shape as it stands.
 */
export interface DropboxRequester {
  request(request: AuthorizedRequest): Promise<AuthorizedResponse>;
}

/** What Dropbox says it stored, once it has been checked against the body. */
export interface StoredFile {
  size: number;
  /** Dropbox's own content_hash, equal to `contentHash(body)`. */
  contentHash: string;
}

export interface DropboxUploadRequest {
  http: DropboxRequester;
  /** Origin of the content API — content.dropboxapi.com, or a test's. */
  contentUrl: string;
  /** The destination as Dropbox spells it: "/notes/devices/a/1.bin". */
  path: string;
  /** The store-relative path, which is what the user recognizes. */
  displayPath: string;
  body: Uint8Array;
  /** "add" is `create`'s exclusive write; "overwrite" is `put`. */
  mode: "add" | "overwrite";
  /** The configured per-request timeout, which large bodies extend. */
  requestTimeout: number;
  /** Overridable so a test can walk the session path with a few bytes. */
  sessionThreshold?: number;
  chunkSize?: number;
}

/**
 * Dropbox's content_hash: SHA-256 over the concatenated SHA-256 digests of
 * each 4 MB block of the file, hex-encoded.
 *
 * An empty file hashes the empty concatenation, which is exactly what
 * Dropbox reports for one, so the zero-length case needs no special
 * handling.
 */
export async function contentHash(body: Uint8Array): Promise<string> {
  const blocks = Math.ceil(body.length / HASH_BLOCK_SIZE);
  const digests = new Uint8Array(blocks * DIGEST_SIZE);
  for (let index = 0; index < blocks; index++) {
    const start = index * HASH_BLOCK_SIZE;
    const block = body.subarray(
      start,
      Math.min(start + HASH_BLOCK_SIZE, body.length),
    );
    // The bundled DOM lib types BufferSource as a view over an ArrayBuffer
    // specifically, which a view over the caller's ArrayBufferLike does not
    // satisfy, though Deno's WebCrypto takes one. Same cast as the request
    // bodies in authorized-fetch.ts; copying every block into a fresh
    // buffer to please the type would add a memcpy of the whole file.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      block as BufferSource,
    );
    digests.set(new Uint8Array(digest), index * DIGEST_SIZE);
  }
  const root = await crypto.subtle.digest("SHA-256", digests as BufferSource);
  return encodeHex(new Uint8Array(root));
}

/**
 * The JSON that goes in the Dropbox-API-Arg header.
 *
 * `JSON.stringify` leaves non-ASCII characters literal, and Dropbox rejects
 * the request outright when one reaches the header. Escaping them as
 * \uXXXX produces JSON that parses to the same string, so the service sees
 * the path we meant. A character outside the BMP is held as a surrogate
 * pair and escapes as its two halves, which is the form the API expects.
 * U+007F is escaped along with the rest: it is a control character, and
 * whether every proxy in between passes one through unchanged is not worth
 * finding out.
 */
export function apiArg(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Upload `body`, choosing the protocol by size, and return Dropbox's view
 * of the stored file once it matches the bytes that were sent.
 */
export async function uploadFile(
  request: DropboxUploadRequest,
): Promise<StoredFile> {
  const threshold = request.sessionThreshold ?? SINGLE_UPLOAD_LIMIT;
  // Hashed before the upload rather than after: the caller owns the buffer
  // and may reuse it, and what this has to describe is the bytes that were
  // actually sent.
  const expected = await contentHash(request.body);
  const metadata = request.body.length > threshold
    ? await uploadSession(request)
    : await uploadSingle(request);
  return verifyStored(request, metadata, expected);
}

/** One request: the commit information in the header, the file as the body. */
async function uploadSingle(
  request: DropboxUploadRequest,
): Promise<Record<string, unknown>> {
  const action = `write ${request.displayPath}`;
  const response = await request.http.request(contentRequest(
    request,
    "files/upload",
    commitInfo(request),
    request.body,
  ));
  if (response.status === 200) return dropboxJson(response, action);
  throw writeFailure(response, request, action);
}

/**
 * Three phases: `start` carries the first chunk and answers with a session
 * id, `append_v2` carries the rest, and `finish` names the destination and
 * commits. Nothing is visible at the path until that commit, so a session
 * abandoned halfway leaves no half-written file behind — only a reservation
 * Dropbox expires on its own.
 */
async function uploadSession(
  request: DropboxUploadRequest,
): Promise<Record<string, unknown>> {
  const chunkSize = request.chunkSize ?? UPLOAD_SESSION_CHUNK_SIZE;
  const total = request.body.length;
  const sessionId = await startSession(request, chunkSize);
  let offset = Math.min(chunkSize, total);
  let corrections = 0;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const response = await request.http.request(contentRequest(
      request,
      "files/upload_session/append_v2",
      { cursor: { session_id: sessionId, offset }, close: false },
      request.body.subarray(offset, end),
    ));
    if (response.status === 200) {
      offset = end;
      continue;
    }

    const corrected = correctOffset(response);
    if (corrected === undefined) {
      throw sessionFailure(response, request, `upload ${request.displayPath}`);
    }
    // The transport replays a request after a network failure, so the same
    // chunk can reach Dropbox twice, and a chunk it recorded only in part
    // leaves it behind where we think it is. Its offset is the truth and
    // ours is an assumption; continuing from ours would leave a hole in
    // the middle of the file, which surfaces much later as a batch that
    // will not decrypt.
    if (corrected > total) {
      throw new SyncError(
        `${DROPBOX_LABEL} holds ${corrected} bytes of ` +
          `${request.displayPath}, which is more than the ${total} bytes ` +
          `it was sent`,
        "corrupt-data",
        response.status,
      );
    }
    if (++corrections > MAX_OFFSET_CORRECTIONS) {
      throw new SyncError(
        `The ${DROPBOX_LABEL} upload of ${request.displayPath} stopped ` +
          `making progress at byte ${corrected}`,
        "server-error",
        response.status,
      );
    }
    offset = corrected;
  }

  return finishSession(request, sessionId, total);
}

async function startSession(
  request: DropboxUploadRequest,
  chunkSize: number,
): Promise<string> {
  const action = `start an upload of ${request.displayPath}`;
  const response = await request.http.request(contentRequest(
    request,
    "files/upload_session/start",
    // close: false — the session stays open for the appends. Closing here
    // would commit nothing and make every later chunk an error.
    { close: false },
    request.body.subarray(0, Math.min(chunkSize, request.body.length)),
  ));
  if (response.status !== 200) throw sessionFailure(response, request, action);

  const sessionId = dropboxJson(response, action).session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new SyncError(
      `${DROPBOX_LABEL} opened an upload session for ` +
        `${request.displayPath} without a session id`,
      "corrupt-data",
      response.status,
    );
  }
  return sessionId;
}

/**
 * The commit. The body is empty because every byte has already been
 * appended; the header carries the destination and the write mode, which is
 * where an "add" that lost its race is reported.
 */
async function finishSession(
  request: DropboxUploadRequest,
  sessionId: string,
  total: number,
): Promise<Record<string, unknown>> {
  const action = `write ${request.displayPath}`;
  const response = await request.http.request(contentRequest(
    request,
    "files/upload_session/finish",
    {
      cursor: { session_id: sessionId, offset: total },
      commit: commitInfo(request),
    },
    EMPTY_BODY,
  ));
  if (response.status === 200) return dropboxJson(response, action);
  throw sessionFailure(response, request, action);
}

function contentRequest(
  request: DropboxUploadRequest,
  route: string,
  arg: unknown,
  body: Uint8Array,
): AuthorizedRequest {
  return {
    url: `${request.contentUrl}/2/${route}`,
    method: "POST",
    headers: {
      "Dropbox-API-Arg": apiArg(arg),
      // Required on every content-upload route, and only there: the
      // download route rejects a request that carries a Content-Type at
      // all, which is why that one is built by hand in the store.
      "Content-Type": "application/octet-stream",
    },
    body,
    timeout: uploadTimeout(request.requestTimeout, body.length),
  };
}

function commitInfo(request: DropboxUploadRequest): Record<string, unknown> {
  return {
    path: request.path,
    mode: request.mode,
    // Never: a renamed journal batch is a batch at a path no other device
    // will ever look at, and the write would report success.
    autorename: false,
    // This is what makes `create` exclusive. Without it, an "add" whose
    // bytes happen to match the file already at the path is answered with
    // success and the existing revision, so two devices would both believe
    // they had written that sequence number. (Inert for "overwrite", which
    // has no conflict to detect.)
    strict_conflict: true,
    // Every journal batch would otherwise land in the account's activity
    // feed and raise a desktop notification on the user's other machines.
    mute: true,
  };
}

/**
 * A lost race for a path is `precondition-failed` and nothing else — see
 * nameTaken. Every other failure goes through the shared mapper.
 */
function writeFailure(
  response: AuthorizedResponse,
  request: DropboxUploadRequest,
  action: string,
): SyncError {
  if (request.mode === "add" && hasTag(response, "conflict")) {
    return nameTaken(request.displayPath, response.status);
  }
  return dropboxError(response, action);
}

/**
 * A session Dropbox no longer knows about: expired, or closed by an earlier
 * attempt at the same upload. Deliberately retryable rather than
 * `not-found`, which would tell the engine the destination is missing; the
 * right answer is to run the whole upload again from a fresh session, which
 * is what the next sync cycle does.
 */
function sessionFailure(
  response: AuthorizedResponse,
  request: DropboxUploadRequest,
  action: string,
): SyncError {
  if (hasTag(response, "closed") || hasTag(response, "not_found")) {
    return new SyncError(
      `The ${DROPBOX_LABEL} upload session for ${request.displayPath} is ` +
        `no longer open`,
      "server-error",
      response.status,
    );
  }
  return writeFailure(response, request, action);
}

/**
 * Where Dropbox says the session actually is. `append_v2` reports
 * `incorrect_offset` as the error itself and `finish` hangs the same union
 * off `lookup_failed`; both spellings are read here so a resume works
 * wherever it is discovered. undefined means this is not an offset problem,
 * or is one Dropbox put no number on — and inventing a number would risk
 * exactly the hole this exists to prevent.
 */
function correctOffset(response: AuthorizedResponse): number | undefined {
  const failure = dropboxFailure(response);
  if (!failure.tags.has("incorrect_offset")) return undefined;
  const places = [failure.error, asRecord(failure.error?.lookup_failed)];
  for (const place of places) {
    const offset = place?.correct_offset;
    if (
      typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
    ) {
      return offset;
    }
  }
  return undefined;
}

/** Read what Dropbox stored, and refuse it if it is not what was sent. */
function verifyStored(
  request: DropboxUploadRequest,
  metadata: Record<string, unknown>,
  expected: string,
): StoredFile {
  const where = `${request.displayPath} in ${DROPBOX_LABEL}`;
  const size = metadata.size;
  if (typeof size !== "number") {
    throw new SyncError(
      `${DROPBOX_LABEL} did not report a size for ${request.displayPath} ` +
        `after writing it`,
      "corrupt-data",
    );
  }
  if (size !== request.body.length) {
    throw new SyncError(
      `${where} holds ${size} bytes, but ${request.body.length} were sent`,
      "corrupt-data",
    );
  }
  const stored = metadata.content_hash;
  if (typeof stored !== "string" || stored.length === 0) {
    // Every file metadata carries one. Accepting a response without it
    // would mean an upload that quietly skipped the only integrity check
    // the API offers, and a `verifyUpload` that then trusted that write.
    throw new SyncError(
      `${DROPBOX_LABEL} did not report a content hash for ` +
        `${request.displayPath} after writing it`,
      "corrupt-data",
    );
  }
  if (stored !== expected) {
    throw new SyncError(
      `${where} does not match what was sent (content hash ${stored}, ` +
        `expected ${expected})`,
      "corrupt-data",
    );
  }
  return { size, contentHash: stored };
}

function uploadTimeout(base: number, bytes: number): number {
  return Math.max(base, Math.ceil(bytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
}
