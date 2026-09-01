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
 * Turning a Dropbox failure into one of sync-remote's SyncError codes.
 *
 * THE STATUS SAYS ALMOST NOTHING. Dropbox answers every route-specific
 * failure with 409 and puts the real answer in the body: the file is
 * missing, the name is taken, the account is full and the app is being
 * throttled all arrive as the same status. So the body is read first and
 * the status is only the fallback — the reverse of most APIs.
 *
 * `error_summary` is a "/"-joined tag chain — "path/conflict/file/." for a
 * taken name, "from_lookup/not_found/." for a move whose source is gone —
 * and the same leaf tag hangs off a different parent depending on which
 * argument of which route it is about. This file therefore matches the
 * individual tags rather than whole prefixes: every union in the API that
 * says `not_found` means the same thing to a store, whichever field it
 * belongs to, and prefix matching would need one entry per route to say
 * so.
 *
 * TWO CLASSIFICATIONS ARE EXPENSIVE, in opposite directions.
 * `too_many_write_operations` arrives on 409 — several writers touching one
 * folder, which for this protocol is the normal state of a busy account —
 * and has to come back RETRYABLE, or one contended move fails the sync
 * cycle. `insufficient_space` has to come back NON-retryable, because three
 * more attempts only delay telling the user the one thing that would fix
 * it.
 */

import { SyncError } from "@notesnook/sync-remote";
import {
  type AuthorizedResponse,
  decodeJson,
} from "../http/authorized-fetch.ts";
import {
  parseRetryAfter,
  RetryAfterError,
  type SyncErrorCode,
} from "../http/retry.ts";

/** Named in every message this file produces, and in the capabilities. */
export const DROPBOX_LABEL = "Dropbox";

/** Longer than this and an error message stops being readable. */
const MAX_MESSAGE_CHARS = 200;

/** Deep enough for every union the API nests; a stop for a cyclic body. */
const MAX_TAG_DEPTH = 6;

/**
 * Tags whose meaning is the same wherever they appear. Throttling, quota
 * and a missing scope are handled separately below: the first needs the
 * response's Retry-After, and the other two need a message that tells the
 * user what to do.
 *
 * Iterated in this order, so an answer carrying two of them resolves to the
 * more specific one rather than to whichever the JSON happened to list
 * first.
 */
const TAG_TO_SYNC_CODE: ReadonlyMap<string, SyncErrorCode> = new Map<
  string,
  SyncErrorCode
>([
  ["not_found", "not-found"],
  // A file where a folder was expected, or the reverse. Nothing retryable,
  // and not the store's to resolve.
  ["not_file", "conflict"],
  ["not_folder", "conflict"],
  ["conflict", "conflict"],
  ["no_write_permission", "forbidden"],
  ["restricted_content", "forbidden"],
  // A name Dropbox will not store at all (".", "..", "desktop.ini" and the
  // rest). Retrying writes the same name again.
  ["disallowed_name", "forbidden"],
  ["team_folder", "forbidden"],
  ["invalid_access_token", "unauthorized"],
  ["expired_access_token", "unauthorized"],
  // A path this adapter built wrong — reported as the bug it is rather
  // than as something the scheduler should keep repeating.
  ["malformed_path", "corrupt-data"],
  // Both are about an upload session rather than about the file: the right
  // answer is to run the whole upload again from a fresh session, which a
  // retryable code gets from the next sync cycle.
  ["incorrect_offset", "server-error"],
  ["closed", "server-error"],
  // A list cursor Dropbox no longer honours. Listing again from the start
  // is exactly what a retryable failure produces.
  ["reset", "server-error"],
]);

/** Dropbox's "slow down", whichever status it is attached to. */
const THROTTLING_TAGS: ReadonlySet<string> = new Set([
  "too_many_requests",
  "too_many_write_operations",
]);

/** Dropbox's "there is no room". Never retryable — see the file note. */
const SPACE_TAGS: ReadonlySet<string> = new Set([
  "insufficient_space",
  "insufficient_quota",
]);

/** A Dropbox failure body, reduced to the parts worth acting on. */
export interface DropboxFailure {
  status: number;
  /** `error_summary`, or the start of a body that was not JSON. */
  summary: string;
  /** Every tag in the chain: "path", "conflict", "file". */
  tags: ReadonlySet<string>;
  /**
   * The `error` object itself, for the two routes that carry a value in it
   * — `correct_offset` on a resumable upload, `required_scope` on a
   * permission the app was never granted.
   */
  error?: Record<string, unknown>;
}

/**
 * A JSON object, or undefined for anything else.
 *
 * Shared with upload.ts and dropbox-store.ts rather than repeated in each:
 * every Dropbox payload this adapter reads is a bag of optional fields of
 * unknown type, and narrowing from `unknown` is the only way to read one
 * without an `any`.
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Read a failure body as far as it can be read. Never throws. */
export function dropboxFailure(response: AuthorizedResponse): DropboxFailure {
  const text = new TextDecoder().decode(response.body);
  const body = asRecord(safeParseJson(text));
  const error = asRecord(body?.error);
  const summary = typeof body?.error_summary === "string"
    ? body.error_summary
    : undefined;
  return {
    status: response.status,
    summary: (summary ?? text).trim().slice(0, MAX_MESSAGE_CHARS),
    tags: collectTags(summary, error),
    error,
  };
}

/** Whether Dropbox named `tag` anywhere in the failure. */
export function hasTag(response: AuthorizedResponse, tag: string): boolean {
  return dropboxFailure(response).tags.has(tag);
}

/**
 * Dropbox's "there is nothing at that path", whichever argument of
 * whichever route it is about. Half the store's methods treat it as an
 * answer rather than as a failure — a missing directory lists as empty, a
 * missing file deletes successfully — so it is one named check instead of a
 * status comparison repeated at each of them.
 */
export function isNotFound(response: AuthorizedResponse): boolean {
  // Only ever a 409: Dropbox uses 404 for a route that does not exist, and
  // reading that as a missing file would tell the engine a journal batch
  // had been deleted when the adapter had simply asked the wrong endpoint.
  return response.status === 409 && hasTag(response, "not_found");
}

/**
 * The one failure `create` is allowed to produce when it loses the race for
 * a path. The journal rests on this being distinguishable from every other
 * conflict: the caller answers it by moving to the next free sequence
 * number, and answering anything else that way would skip a batch.
 */
export function nameTaken(path: string, status?: number): SyncError {
  return new SyncError(
    `${path} already exists in ${DROPBOX_LABEL} — another device wrote it ` +
      `first`,
    "precondition-failed",
    status,
  );
}

/**
 * Map a response the adapter has decided is a failure. `action` completes
 * the sentence "Could not …", so it reads as "Could not read devices/x".
 */
export function dropboxError(
  response: AuthorizedResponse,
  action: string,
): SyncError {
  const failure = dropboxFailure(response);
  const message = `Could not ${action}` + describe(failure);

  for (const tag of failure.tags) {
    if (THROTTLING_TAGS.has(tag)) return throttled(response, message);
    if (SPACE_TAGS.has(tag)) return outOfSpace(message, failure.status);
    if (tag === "missing_scope") return missingScope(failure, message);
  }
  for (const [tag, code] of TAG_TO_SYNC_CODE) {
    if (failure.tags.has(tag)) {
      return new SyncError(message, code, failure.status);
    }
  }
  return fromStatus(failure, response, message);
}

/**
 * Require a 200 and read the JSON object Dropbox answers with. Every route
 * this adapter calls answers success with 200 and a JSON body, so a
 * response that is neither is a failure however it is dressed.
 */
export function dropboxJson(
  response: AuthorizedResponse,
  action: string,
): Record<string, unknown> {
  const payload = asRecord(decodeJson(response));
  if (!payload) {
    throw new SyncError(
      `${DROPBOX_LABEL} answered the request to ${action} with something ` +
        `that is not a JSON object`,
      "corrupt-data",
      response.status,
    );
  }
  return payload;
}

/**
 * The tags, from both places Dropbox writes them. `error_summary` is the
 * documented one and is present on every route-specific failure; the
 * `error` union is walked as well because the summary is documented as
 * human-readable and only the union is a contract.
 */
function collectTags(
  summary: string | undefined,
  error: Record<string, unknown> | undefined,
): Set<string> {
  const tags = new Set<string>();
  for (const part of summary?.split("/") ?? []) {
    const tag = part.trim();
    // The summary ends in "." or "...", which is punctuation, not a tag.
    if (tag.length > 0 && !/^\.+$/.test(tag)) tags.add(tag);
  }
  let node = error;
  for (let depth = 0; node && depth < MAX_TAG_DEPTH; depth++) {
    const tag = node[".tag"];
    if (typeof tag !== "string") break;
    tags.add(tag);
    // The value of the union's own tag is the next level: `{".tag":"path",
    // "path":{".tag":"conflict"}}`. A leaf has no such field and ends the
    // walk.
    node = asRecord(node[tag]);
  }
  return tags;
}

function fromStatus(
  failure: DropboxFailure,
  response: AuthorizedResponse,
  message: string,
): SyncError {
  switch (failure.status) {
    case 400:
      // "Bad HTTP request": a malformed Dropbox-API-Arg, or a header a
      // content route does not accept. Nothing a retry or the user can
      // change, so it is reported as the bug it is.
      return new SyncError(message, "corrupt-data", failure.status);
    case 401:
      // AuthorizedFetch normally turns a 401 into this itself, after a
      // forced token refresh; reaching here means the request carried no
      // token at all.
      return new SyncError(
        `${message}. Connect the account again in Settings.`,
        "unauthorized",
        failure.status,
      );
    case 403:
      return new SyncError(message, "forbidden", failure.status);
    case 404:
      // See isNotFound: from Dropbox this is a route that does not exist.
      return new SyncError(message, "corrupt-data", failure.status);
    case 409:
      // A route-specific error whose tag is not in the table above. It is
      // about this path and this request, so it is a conflict rather than
      // something to retry.
      return new SyncError(message, "conflict", failure.status);
    case 429:
      return throttled(response, message);
    default:
      // A 5xx is worth another attempt; a 4xx Dropbox did not label is a
      // request this adapter built wrong, and four identical attempts fail
      // identically.
      return new SyncError(
        message,
        failure.status >= 500 ? "server-error" : "corrupt-data",
        failure.status,
      );
  }
}

/**
 * Retryable, and carrying Dropbox's own Retry-After when it sent one so the
 * shared backoff waits exactly as long as the service asked rather than
 * guessing. AuthorizedFetch intercepts a 429 before the adapter sees it;
 * this stays because `too_many_write_operations` arrives on a 409, which
 * that layer passes straight through.
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
 * server-error as retryable, and a full account is the one refusal that is
 * certain to be there on the next attempt too.
 */
function outOfSpace(message: string, status?: number): SyncError {
  return new SyncError(
    `${message} — your ${DROPBOX_LABEL} is out of space. Free some up, or ` +
      `remove old backups from the sync folder, and sync again.`,
    "forbidden",
    status,
  );
}

/**
 * The app was authorized without a permission it needs. Worth its own
 * message because the fix is two steps in two places — enable the
 * permission on the app, then re-authorize, since a token only carries the
 * scopes it was issued with — and neither is guessable from "denied".
 */
function missingScope(failure: DropboxFailure, message: string): SyncError {
  const scope = typeof failure.error?.required_scope === "string"
    ? failure.error.required_scope
    : "files.content.read, files.content.write and files.metadata.read";
  return new SyncError(
    `${message} — the ${DROPBOX_LABEL} app is missing the ${scope} ` +
      `permission. Enable it on the app's Permissions tab at ` +
      `dropbox.com/developers/apps, then connect the account again in ` +
      `Settings.`,
    "forbidden",
    failure.status,
  );
}

function describe(failure: DropboxFailure): string {
  return ` (${DROPBOX_LABEL} → HTTP ${failure.status}` +
    `${failure.summary ? `: ${failure.summary}` : ""})`;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // An error body that is not JSON is normal — a proxy's HTML 502 page,
    // Dropbox's own plain-text 400 — and the status still classifies it.
    // Throwing here would replace the real failure with a parse failure.
    return undefined;
  }
}
