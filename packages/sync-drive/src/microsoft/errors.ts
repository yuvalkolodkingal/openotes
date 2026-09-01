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
 * Turning a Microsoft Graph failure into one of sync-remote's SyncError
 * codes.
 *
 * Graph answers a failure with a status and, in the body, an envelope whose
 * `code` is the part that says what actually happened. The status on its
 * own is not enough twice over, and both cases matter:
 *
 *  - The same 409 means "the name was taken" — which is exactly how
 *    `create` learns it lost a race and must report `precondition-failed` —
 *    or an ordinary conflict the caller cannot do anything about.
 *  - The same 507 means "the drive is full", which no amount of retrying
 *    fixes, while every other 5xx means "come back shortly".
 *
 * Retryability is the other half of the job, and it is expensive in both
 * directions. `activityLimitReached` is Graph's throttling code and has to
 * come back retryable and carrying the service's own Retry-After, because a
 * fixed backoff against a throttled account simply extends the throttle.
 * `quotaLimitReached` has to come back non-retryable, because three more
 * attempts only delay telling the user the one thing that would fix it.
 */

import { SyncError } from "@notesnook/sync-remote";
import type { AuthorizedResponse } from "../http/authorized-fetch.ts";
import {
  parseRetryAfter,
  RetryAfterError,
  type SyncErrorCode,
} from "../http/retry.ts";

/** Named in every message this file produces, and in the capabilities. */
export const ONEDRIVE_LABEL = "OneDrive";

/** Longer than this and an error message stops being readable. */
const MAX_MESSAGE_CHARS = 200;

/** What Graph puts in the `error` object of a failure body. */
export interface GraphErrorDetail {
  /** `error.code` — the documented, stable identifier. */
  code?: string;
  /**
   * `error.innerError.code`, where Graph often puts the specific reason
   * under a generic outer one. Matched alongside `code` so a
   * `nameAlreadyExists` reported that way still reaches `create`'s
   * `precondition-failed` path instead of surfacing as a bare conflict.
   */
  innerCode?: string;
  message?: string;
}

/**
 * Graph codes whose meaning is fixed regardless of the status they arrive
 * with. Throttling and quota are handled separately below: the first needs
 * the response's Retry-After and the second needs a message that tells the
 * user what to do.
 */
const CODE_TO_SYNC_CODE: ReadonlyMap<string, SyncErrorCode> = new Map<
  string,
  SyncErrorCode
>([
  ["itemNotFound", "not-found"],
  ["nameAlreadyExists", "conflict"],
  ["unauthenticated", "unauthorized"],
  ["accessDenied", "forbidden"],
  ["notAllowed", "forbidden"],
  // The file is intact on our side; OneDrive is refusing to hand it back.
  // Retrying cannot change its mind, and only the user can release it.
  ["malwareDetected", "forbidden"],
  // A Content-Range the upload session did not expect. The bytes we hold
  // and the bytes Graph holds disagree, which is a data problem, not a
  // transient one.
  ["invalidRange", "corrupt-data"],
]);

/** Graph's "slow down" codes, whichever status they are attached to. */
const THROTTLING_CODES: ReadonlySet<string> = new Set([
  "activityLimitReached",
  "serviceNotAvailable",
]);

/** Graph's "there is no room" codes. Never retryable — see the file note. */
const QUOTA_CODES: ReadonlySet<string> = new Set([
  "quotaLimitReached",
  "insufficientStorage",
]);

/**
 * A JSON object, or undefined for anything else.
 *
 * Shared with upload.ts and graph-store.ts rather than repeated in each:
 * every Graph payload this adapter reads is a bag of optional fields of
 * unknown type, and narrowing from `unknown` is the only way to read one
 * without an `any`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** The `error` object of a failure body, as far as it can be read. */
export function graphErrorDetail(
  response: AuthorizedResponse,
): GraphErrorDetail {
  const error = asRecord(asRecord(safeJson(response.body))?.error);
  if (!error) return {};
  const inner = asRecord(error.innerError);
  return {
    code: typeof error.code === "string" ? error.code : undefined,
    innerCode: inner && typeof inner.code === "string" ? inner.code : undefined,
    message: typeof error.message === "string"
      ? error.message.slice(0, MAX_MESSAGE_CHARS)
      : undefined,
  };
}

/** Whether Graph named `code`, at either level of the error envelope. */
export function hasGraphCode(
  response: AuthorizedResponse,
  code: string,
): boolean {
  const detail = graphErrorDetail(response);
  return detail.code === code || detail.innerCode === code;
}

/**
 * The one failure `create` is allowed to produce when it loses the race for
 * a path. The journal rests on this being distinguishable from every other
 * conflict: the caller answers it by moving to the next free sequence
 * number, and answering anything else that way would skip a batch.
 */
export function nameTaken(path: string, status?: number): SyncError {
  return new SyncError(
    `${path} already exists in ${ONEDRIVE_LABEL} — another device wrote ` +
      `it first`,
    "precondition-failed",
    status,
  );
}

/**
 * Map a response the adapter has decided is a failure. `action` completes
 * the sentence "Could not …", so it reads as "Could not read devices/x".
 */
export function graphError(
  response: AuthorizedResponse,
  action: string,
): SyncError {
  const detail = graphErrorDetail(response);
  const message = `Could not ${action}` + describe(response, detail);

  for (const code of [detail.code, detail.innerCode]) {
    if (!code) continue;
    if (THROTTLING_CODES.has(code)) return throttled(response, message);
    if (QUOTA_CODES.has(code)) return outOfSpace(message, response.status);
    const mapped = CODE_TO_SYNC_CODE.get(code);
    if (mapped) return new SyncError(message, mapped, response.status);
  }

  return fromStatus(response, message);
}

/**
 * Re-read an error AuthorizedFetch has already classified.
 *
 * AuthorizedFetch decides retryability from the status alone — it has to,
 * because what a body means differs per provider — and it counts 507 among
 * the statuses worth retrying. From Graph a 507 is a full drive, and by the
 * time the error is thrown the body that said so has been dropped. This is
 * the last place the store can still correct that, so every request in the
 * adapter is funnelled through it.
 */
export function refineTransportError(error: SyncError): SyncError {
  if (error.status !== 507) return error;
  return outOfSpace(error.message, error.status);
}

function fromStatus(
  response: AuthorizedResponse,
  message: string,
): SyncError {
  switch (response.status) {
    case 401:
      return new SyncError(message, "unauthorized", response.status);
    case 403:
      return new SyncError(message, "forbidden", response.status);
    case 404:
    case 410:
      return new SyncError(message, "not-found", response.status);
    case 409:
      return new SyncError(message, "conflict", response.status);
    case 412:
      return new SyncError(message, "precondition-failed", response.status);
    case 423:
      return new SyncError(message, "forbidden", response.status);
    case 429:
    case 503:
      return throttled(response, message);
    case 507:
      return outOfSpace(message, response.status);
    default:
      // A 5xx Graph did not label is worth another attempt; a 4xx it did
      // not label is a request this adapter built wrong or a name the
      // service refuses, and four identical attempts fail identically.
      return new SyncError(
        message,
        response.status >= 500 ? "server-error" : "corrupt-data",
        response.status,
      );
  }
}

/**
 * Retryable, and carrying Graph's own Retry-After when it sent one so the
 * shared backoff waits exactly as long as the service asked rather than
 * guessing. AuthorizedFetch normally intercepts 429 and 503 before the
 * adapter sees them; this stays because the classification must not depend
 * on which layer happened to notice, and because `activityLimitReached`
 * also arrives on statuses that layer passes through.
 */
function throttled(
  response: AuthorizedResponse,
  message: string,
): SyncError {
  const retryAfter = parseRetryAfter(response.headers["retry-after"]);
  return retryAfter === undefined
    ? new SyncError(message, "server-error", response.status)
    : new RetryAfterError(
      message,
      "server-error",
      response.status,
      retryAfter,
    );
}

/**
 * Deliberately `forbidden` and not `server-error`: SyncError treats
 * server-error as retryable, and a full drive is the one refusal that is
 * certain to be there on the next attempt too.
 */
function outOfSpace(message: string, status?: number): SyncError {
  return new SyncError(
    `${message} — your ${ONEDRIVE_LABEL} is out of space. Free some up, ` +
      `or remove old backups from the sync folder, and sync again.`,
    "forbidden",
    status,
  );
}

function describe(
  response: AuthorizedResponse,
  detail: GraphErrorDetail,
): string {
  return ` (${ONEDRIVE_LABEL} → HTTP ${response.status}` +
    `${detail.code ? ` ${detail.code}` : ""}` +
    `${detail.message ? `: ${detail.message}` : ""})`;
}

function safeJson(body: Uint8Array): unknown {
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    // An error body that is not JSON is normal — a proxy's HTML 502 page,
    // an empty 401 — and the status alone still classifies it. Throwing
    // here would replace the real failure with a parse failure.
    return undefined;
  }
}
