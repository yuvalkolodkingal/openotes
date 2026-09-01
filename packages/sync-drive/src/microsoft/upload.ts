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
 * Putting a large body into OneDrive.
 *
 * Up to a few megabytes a single PUT to the item's `/content` carries the
 * whole thing. Past that Graph refuses it and the upload becomes a session:
 * one POST that reserves the destination and answers with an `uploadUrl`,
 * then the body in ranges, then a commit. Three properties of that session
 * are easy to get wrong and each of them is load-bearing.
 *
 * THE SESSION URL IS PRE-AUTHORIZED AND IS NOT GRAPH. It carries its own
 * credential in the query string and points at whichever storage front end
 * Graph picked. Sending the bearer token there would hand a live token with
 * write access to the user's app folder to a host we never decided to
 * trust, so every range request is anonymous.
 *
 * A RANGE THAT ALREADY ARRIVED IS NOT AN ERROR. The transport replays a
 * request after a network failure, so the same bytes can reach Graph twice;
 * it answers the duplicate with 416 and, when asked, with its own idea of
 * where the upload really is. Believing `nextExpectedRanges` over our own
 * arithmetic is what stops a replayed range from deadlocking the upload or,
 * worse, leaving a hole in the middle of a journal entry.
 *
 * THE CONFLICT BEHAVIOUR IS DECIDED AT THE START AND ENFORCED AT THE END.
 * `create` asks for "fail", and Graph may report the taken name either when
 * the session is opened or when the last range commits. Both paths have to
 * produce `precondition-failed`, or a lost race looks like a hard error and
 * the journal stops advancing.
 */

import { SyncError } from "@notesnook/sync-remote";
import type {
  AuthorizedRequest,
  AuthorizedResponse,
} from "../http/authorized-fetch.ts";
import {
  asRecord,
  graphError,
  hasGraphCode,
  nameTaken,
  ONEDRIVE_LABEL,
} from "./errors.ts";

/**
 * The largest body Graph accepts as a single PUT to `/content`. Anything
 * larger has to go through a session, so this is the threshold the store
 * switches on rather than a tuning knob.
 */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

/**
 * Every range but the last must be a multiple of 320 KiB — Graph rejects
 * anything else mid-upload — and Microsoft recommends 5–10 MiB. 20 × 320
 * KiB is 6.25 MiB, inside that window and exactly divisible, so no
 * arithmetic here can produce a non-conforming range.
 */
export const UPLOAD_CHUNK_SIZE = 20 * 320 * 1024;

/**
 * The one method an upload needs from AuthorizedFetch.
 *
 * Narrowing it lets the store hand over its own wrapper — the one that
 * re-reads a 507 as a full drive — instead of the bare client, so a large
 * upload reports the same errors as a small one. AuthorizedFetch satisfies
 * this shape as it stands.
 */
export interface GraphRequester {
  request(request: AuthorizedRequest): Promise<AuthorizedResponse>;
}

export interface LargeUploadRequest {
  http: GraphRequester;
  /** Absolute Graph URL of the item's `createUploadSession` action. */
  sessionUrl: string;
  body: Uint8Array;
  /**
   * "fail" is what makes `create` atomic: Graph writes nothing and answers
   * 409 when the name is taken. "replace" is `put`.
   */
  conflictBehavior: "fail" | "replace";
  /** Store-relative path of the destination, for the error messages. */
  path: string;
  /** Overridable so a test can walk the multi-range path cheaply. */
  chunkSize?: number;
}

/**
 * Upload `body` through an upload session.
 *
 * Returns once Graph has every byte. It deliberately does not confirm the
 * committed length: the engine calls `verifyUpload` after every write and
 * that is the authority on whether the bytes landed, so duplicating the
 * check here would only add a request to every large upload.
 */
export async function uploadLargeFile(
  request: LargeUploadRequest,
): Promise<void> {
  const uploadUrl = await createSession(request);
  try {
    await sendRanges(request, uploadUrl);
  } catch (error) {
    // An abandoned session holds a partial body and a reservation on the
    // name; cancelling releases both now instead of when Graph expires the
    // session days later.
    await cancelSession(request.http, uploadUrl);
    throw error;
  }
}

async function createSession(request: LargeUploadRequest): Promise<string> {
  const response = await request.http.request({
    url: request.sessionUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      item: {
        "@microsoft.graph.conflictBehavior": request.conflictBehavior,
      },
    }),
  });
  if (response.status !== 200 && response.status !== 201) {
    throw uploadFailure(
      response,
      request,
      `start an upload of ${request.path}`,
    );
  }

  const uploadUrl = asRecord(decodeBody(response, request.path))?.uploadUrl;
  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    throw new SyncError(
      `${ONEDRIVE_LABEL} opened an upload session for ${request.path} ` +
        `without an upload URL`,
      "corrupt-data",
      response.status,
    );
  }
  return assertUploadUrl(uploadUrl, request.sessionUrl);
}

async function sendRanges(
  request: LargeUploadRequest,
  uploadUrl: string,
): Promise<void> {
  const total = request.body.length;
  const chunkSize = request.chunkSize ?? UPLOAD_CHUNK_SIZE;
  let offset = 0;

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const response = await request.http.request({
      url: uploadUrl,
      method: "PUT",
      // See the file note: this host is not Graph and must never see the
      // bearer token.
      anonymous: true,
      headers: {
        "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        "Content-Type": "application/octet-stream",
      },
      body: request.body.subarray(offset, end),
    });

    // The commit. Graph answers the final range with the finished item.
    if (response.status === 200 || response.status === 201) return;

    if (response.status === 202) {
      // Continue where the service says it is, not where we think it
      // should be: a range it recorded only in part is one it will ask for
      // again, and jumping to `end` would leave a hole that surfaces much
      // later as an undecryptable batch.
      const next = nextExpectedOffset(response);
      offset = next === undefined ? end : advance(request, offset, next);
      continue;
    }

    if (response.status === 416) {
      // These bytes already arrived — a replayed range after a network
      // failure. Only the session knows what is still outstanding.
      offset = await resume(request, uploadUrl, offset);
      continue;
    }

    if (response.status === 404) {
      // The session expired or was cancelled. Deliberately not `not-found`,
      // which would tell the engine the destination is missing: the right
      // answer is to run the whole upload again, which a retryable code
      // gets from the next sync cycle with a fresh session.
      throw new SyncError(
        `The ${ONEDRIVE_LABEL} upload session for ${request.path} expired ` +
          `before the upload finished`,
        "server-error",
        response.status,
      );
    }

    throw uploadFailure(response, request, `upload ${request.path}`);
  }
}

/** Ask the session what is still outstanding. */
async function resume(
  request: LargeUploadRequest,
  uploadUrl: string,
  offset: number,
): Promise<number> {
  const response = await request.http.request({
    url: uploadUrl,
    anonymous: true,
  });
  if (response.status !== 200) {
    throw uploadFailure(
      response,
      request,
      `resume the upload of ${request.path}`,
    );
  }

  const ranges = expectedRanges(response);
  if (ranges === undefined) {
    throw new SyncError(
      `${ONEDRIVE_LABEL} did not say how much of ${request.path} it holds`,
      "corrupt-data",
      response.status,
    );
  }
  // Nothing outstanding: the session has the whole body and committed it.
  if (ranges.length === 0) return request.body.length;

  const next = parseRangeStart(ranges[0]);
  if (next === undefined) {
    throw new SyncError(
      `${ONEDRIVE_LABEL} reported an unreadable outstanding range ` +
        `(${JSON.stringify(ranges[0])}) for ${request.path}`,
      "corrupt-data",
      response.status,
    );
  }
  return advance(request, offset, next);
}

/**
 * Accept the service's new offset only if it is actually ahead of ours.
 * A session that keeps naming the same offset would otherwise spin here
 * forever; a retryable code hands the whole upload back to the next sync
 * cycle, which starts a fresh session.
 */
function advance(
  request: LargeUploadRequest,
  offset: number,
  next: number,
): number {
  if (next > offset) return next;
  throw new SyncError(
    `The ${ONEDRIVE_LABEL} upload of ${request.path} stopped making ` +
      `progress at byte ${offset}`,
    "server-error",
  );
}

/**
 * Never throws: it is called from a catch, and replacing the failure the
 * caller has to see with a cleanup failure would hide why the upload failed
 * in the first place.
 */
async function cancelSession(
  http: GraphRequester,
  uploadUrl: string,
): Promise<void> {
  try {
    await http.request({ url: uploadUrl, method: "DELETE", anonymous: true });
  } catch {
    // Graph expires an abandoned session on its own, so there is nothing
    // left worth reporting and nothing left to do about it.
  }
}

/**
 * `create` loses its race either when the session opens or when the last
 * range commits, and both have to reach the caller as the same
 * `precondition-failed`. Every other failure goes through the shared
 * mapper.
 */
function uploadFailure(
  response: AuthorizedResponse,
  request: LargeUploadRequest,
  action: string,
): SyncError {
  if (
    request.conflictBehavior === "fail" &&
    hasGraphCode(response, "nameAlreadyExists")
  ) {
    return nameTaken(request.path, response.status);
  }
  return graphError(response, action);
}

/** undefined when the body carried no `nextExpectedRanges` at all. */
function expectedRanges(
  response: AuthorizedResponse,
): string[] | undefined {
  const payload = asRecord(safeJson(response.body));
  const ranges = payload?.nextExpectedRanges;
  if (!Array.isArray(ranges)) return undefined;
  return ranges.filter((range): range is string => typeof range === "string");
}

/** undefined when the body did not say, which the caller reads as "no news". */
function nextExpectedOffset(
  response: AuthorizedResponse,
): number | undefined {
  const ranges = expectedRanges(response);
  if (ranges === undefined || ranges.length === 0) return undefined;
  return parseRangeStart(ranges[0]);
}

/** "12345-" and "12345-55232" both mean "resume at 12345". */
function parseRangeStart(range: string): number | undefined {
  const start = Number.parseInt(range.split("-")[0], 10);
  return Number.isSafeInteger(start) && start >= 0 ? start : undefined;
}

/**
 * The upload URL carries its own credential in the query string, so over
 * plain http that credential and the note bytes behind it cross the network
 * in the clear. The single exception is a URL on the same origin as the
 * request that produced it: an adapter test points the whole client at a
 * loopback fake server, where there is no https to be had.
 */
function assertUploadUrl(uploadUrl: string, sessionUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    throw new SyncError(
      `${ONEDRIVE_LABEL} returned an upload URL that is not a URL`,
      "corrupt-data",
    );
  }
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.origin === new URL(sessionUrl).origin) return parsed.toString();
  throw new SyncError(
    `Refusing to upload to ${parsed.protocol}//${parsed.host} — a ` +
      `${ONEDRIVE_LABEL} upload URL carries its own credential and must ` +
      `be https`,
    "insecure-url",
  );
}

function decodeBody(
  response: AuthorizedResponse,
  path: string,
): unknown {
  const payload = safeJson(response.body);
  if (payload === undefined) {
    throw new SyncError(
      `${ONEDRIVE_LABEL} answered the upload session request for ${path} ` +
        `with something that is not JSON`,
      "corrupt-data",
      response.status,
    );
  }
  return payload;
}

function safeJson(body: Uint8Array): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    // A 202 with an empty or non-JSON body is normal, and so is a proxy's
    // HTML error page; the caller falls back to its own arithmetic or to
    // the status.
    return undefined;
  }
}
