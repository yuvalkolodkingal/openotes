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
 * What Google Drive says when it says no — and the one wrapper that makes
 * every request in the adapter listen to it.
 *
 * THE 403 PROBLEM. Drive reports throttling as HTTP 403 with a reason in
 * the body (`userRateLimitExceeded`, `rateLimitExceeded`) and essentially
 * never as 429, which is the status every generic HTTP layer — including
 * the shared AuthorizedFetch — knows to retry. So the two obvious
 * mappings are both wrong in a way that only shows up on a real account:
 * treating every 403 as `forbidden` turns "you are going too fast" into
 * "your account cannot do this" and stops sync for good, while treating
 * every 403 as retryable hammers a genuine permission failure four times
 * on every single request. The reason string is the only thing that
 * separates them, so it is read before anything else is decided.
 *
 * WHY THE REQUEST WRAPPER LIVES HERE. Retrying is a consequence of reading
 * that envelope, and a request that skips the reading would silently lose
 * the retry. Putting the two together means no caller can have one without
 * the other. The wrapper also owns the ONLY retry loop in the adapter: the
 * AuthorizedFetch it builds is configured with no retries of its own,
 * because two nested loops turn three attempts into sixteen and make a
 * server outage last four times as long as anyone intended.
 */

import { SyncError } from "@notesnook/sync-remote";
import {
  AuthorizedFetch,
  type AuthorizedRequest,
  type AuthorizedResponse,
  decodeJson,
} from "../http/authorized-fetch.ts";
import type { TokenManager } from "../oauth/token-manager.ts";
import {
  DEFAULT_MAX_RETRIES,
  RetryAfterError,
  withRetry,
} from "../http/retry.ts";

/** Shown in every message this adapter produces. */
export const GOOGLE_DRIVE_LABEL = "Google Drive";

/**
 * The reasons that mean "come back in a moment". Deliberately just these
 * two: `dailyLimitExceeded` also arrives as a 403 from the same family and
 * is NOT here, because that quota resets at midnight Pacific and retrying
 * inside a sync cycle only spends the little that is left.
 */
const THROTTLING_REASONS = new Set([
  "userRateLimitExceeded",
  "rateLimitExceeded",
]);

/** The account is full. Not retryable, and not the app's to fix. */
const QUOTA_REASON = "storageQuotaExceeded";

/** Drive's error envelope, reduced to the three things worth acting on. */
export interface DriveFailure {
  status: number;
  /** The first `error.errors[].reason`; what Drive actually keys on. */
  reason?: string;
  /** `error.message`, or the start of the body when it is not JSON. */
  message: string;
}

export interface DriveTransportOptions {
  tokens: TokenManager;
  /** Injected by tests to answer without a network. */
  fetch?: typeof fetch;
  requestTimeout?: number;
  maxRetries?: number;
  /** Injectable so tests do not spend real seconds asleep. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable so tests get a predictable jitter. */
  random?: () => number;
}

/**
 * Every request the Drive adapter makes goes through here: the shared
 * authorized client underneath, Drive's own throttling rules on top.
 */
export class DriveTransport {
  private readonly http: AuthorizedFetch;
  private readonly maxRetries: number;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly random?: () => number;

  constructor(options: DriveTransportOptions) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.delayFn = options.delay ?? sleep;
    this.random = options.random;
    this.http = new AuthorizedFetch({
      tokens: options.tokens,
      fetch: options.fetch,
      requestTimeout: options.requestTimeout,
      // No retries down there — see the note at the top of the file. The
      // retryable SyncErrors it raises for 429 and 5xx are caught by the
      // loop in request(), which also covers Drive's 403 throttling.
      maxRetries: 0,
      delay: options.delay,
      random: options.random,
    });
  }

  /**
   * Perform `request`, retrying throttling and server failures.
   *
   * Statuses the caller has to interpret — 404 above all, since "not there"
   * is a normal answer for half the store's methods — are RETURNED, and the
   * caller passes them through `expectOk` once it has had its look.
   * `action` is a plain-language fragment ("read devices/a/1.bin") that ends
   * up in whatever message the user eventually sees.
   */
  request(
    request: AuthorizedRequest,
    action: string,
  ): Promise<AuthorizedResponse> {
    return withRetry(async () => {
      const response = await this.http.request(request);
      if (response.status !== 403) return response;
      const failure = parseDriveFailure(response);
      // A permission 403 is the caller's to interpret and must not be
      // retried; a throttling 403 is thrown so withRetry backs off, and
      // carries the server's Retry-After when it sent one.
      if (!isThrottling(failure)) return response;
      throw driveError(response, action);
    }, {
      maxRetries: this.maxRetries,
      delay: this.delayFn,
      random: this.random,
    });
  }

  /**
   * The injected clock, shared with the retry backoff. The reconciliation
   * waits in path-index.ts and drive-store.ts use it for the same reason
   * the retries do: a test that really slept two seconds per created file
   * would take minutes.
   */
  sleep(ms: number): Promise<void> {
    return ms > 0 ? this.delayFn(ms) : Promise.resolve();
  }
}

/** Read Drive's error envelope. Never throws: a failure has no fallback. */
export function parseDriveFailure(response: AuthorizedResponse): DriveFailure {
  const text = new TextDecoder().decode(response.body);
  const error = asRecord(asRecord(safeParseJson(text))?.error);
  if (!error) {
    return {
      status: response.status,
      // A body that is not JSON is normal: a proxy's HTML 503, or an empty
      // body on a HEAD-like failure.
      message: text.slice(0, 200),
    };
  }
  const message = typeof error.message === "string"
    ? error.message
    : text.slice(0, 200);
  return { status: response.status, reason: firstReason(error), message };
}

/** Whether this failure means "the same request, a moment later". */
export function isThrottling(failure: DriveFailure): boolean {
  return failure.status === 403 && failure.reason !== undefined &&
    THROTTLING_REASONS.has(failure.reason);
}

/**
 * Map a failed response onto a SyncError. `action` completes the sentence
 * "could not <action>", so pass a verb phrase.
 */
export function driveError(
  response: AuthorizedResponse,
  action: string,
): SyncError {
  const failure = parseDriveFailure(response);
  const suffix = ` (HTTP ${failure.status}` +
    `${failure.reason ? ` ${failure.reason}` : ""}` +
    `${failure.message ? `: ${failure.message}` : ""})`;

  if (isThrottling(failure)) {
    const retryAfter = parseRetryAfterHeader(response);
    const message =
      `${GOOGLE_DRIVE_LABEL} is rate limiting this account, so it could ` +
      `not ${action} right now` + suffix;
    return retryAfter === undefined
      ? new SyncError(message, "server-error", failure.status)
      : new RetryAfterError(
        message,
        "server-error",
        failure.status,
        retryAfter,
      );
  }

  if (failure.reason === QUOTA_REASON) {
    // Naming the trash is the whole point of this branch: Drive counts
    // trashed files against the quota until the trash is emptied, and a
    // user who has just deleted a lot of data reads "out of space" as a
    // bug in the app rather than as something they can act on.
    return new SyncError(
      `${GOOGLE_DRIVE_LABEL} is out of space, so it could not ${action}. ` +
        `Deleted files keep taking up space until the trash is emptied at ` +
        `drive.google.com/drive/trash; empty it, or free space in the ` +
        `account, and sync will carry on.` + suffix,
      "forbidden",
      failure.status,
    );
  }

  switch (failure.status) {
    case 401:
      // AuthorizedFetch normally turns a 401 into this itself, after a
      // forced token refresh; reaching here means it came back on a
      // request that carried no token at all.
      return new SyncError(
        `${GOOGLE_DRIVE_LABEL} refused the sign-in while trying to ` +
          `${action}. Connect the account again in Settings.` + suffix,
        "unauthorized",
        failure.status,
      );
    case 403:
      return new SyncError(
        `${GOOGLE_DRIVE_LABEL} denied permission to ${action}. Openotes ` +
          `asks for the drive.file scope, which only reaches files it ` +
          `created itself — a file put there by hand or by another app is ` +
          `invisible to it.` + suffix,
        "forbidden",
        failure.status,
      );
    case 404:
      return new SyncError(
        `${GOOGLE_DRIVE_LABEL} could not ${action}: it is not there` + suffix,
        "not-found",
        failure.status,
      );
    case 409:
      return new SyncError(
        `${GOOGLE_DRIVE_LABEL} reported a conflict trying to ${action}` +
          suffix,
        "conflict",
        failure.status,
      );
    case 412:
      return new SyncError(
        `${GOOGLE_DRIVE_LABEL} refused to ${action}: it changed underneath ` +
          `us` + suffix,
        "precondition-failed",
        failure.status,
      );
    case 400:
      // A malformed query or metadata document. Nothing a retry or the user
      // can change, so it is reported as the bug it is rather than as a
      // transient failure the scheduler would keep repeating.
      return new SyncError(
        `${GOOGLE_DRIVE_LABEL} rejected the request to ${action}` + suffix,
        "corrupt-data",
        failure.status,
      );
    default:
      return new SyncError(
        `${GOOGLE_DRIVE_LABEL} could not ${action}` + suffix,
        "server-error",
        failure.status,
      );
  }
}

/** Pass a successful response through; turn anything else into a SyncError. */
export function expectOk(
  response: AuthorizedResponse,
  action: string,
): AuthorizedResponse {
  if (response.status >= 200 && response.status < 300) return response;
  throw driveError(response, action);
}

/** `expectOk` plus JSON parsing, which is nearly every Drive call. */
export function expectJson(
  response: AuthorizedResponse,
  action: string,
): unknown {
  return decodeJson(expectOk(response, action));
}

/**
 * Drive sends Retry-After on some throttling answers and not others.
 * Re-parsed here rather than reusing the shared client's copy because that
 * one only runs for statuses it already considers retryable, and 403 is
 * not one of them.
 */
function parseRetryAfterHeader(
  response: AuthorizedResponse,
): number | undefined {
  const value = response.headers["retry-after"];
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/**
 * The reason lives in `error.errors[].reason` in the classic envelope and
 * in `error.details[].reason` in the newer one. Both shapes are still in
 * circulation across Drive endpoints, and the throttling rules above are
 * worthless if we read the wrong one.
 */
function firstReason(error: Record<string, unknown>): string | undefined {
  for (const key of ["errors", "details"]) {
    const list = error[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const reason = asRecord(entry)?.reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  }
  // The newer envelope's `status` ("PERMISSION_DENIED", "RESOURCE_
  // EXHAUSTED") is not a reason and must not be treated as one: it does not
  // distinguish throttling from a permission failure, which is the entire
  // question this function exists to answer.
  return undefined;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
