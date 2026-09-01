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
 * Retrying a request against a rate-limited API.
 *
 * All three providers throttle per user, and all three answer a throttled
 * request with a number telling you when to come back. Two rules follow
 * from that and they are the whole of this file:
 *
 *  - Back off with FULL jitter, not with a fixed doubling. Every device on
 *    an account wakes on the same sync interval and hits the same quota at
 *    the same moment; a deterministic backoff keeps them in lockstep and
 *    they throttle each other forever.
 *  - Believe Retry-After, but only up to a point. A short one is a request
 *    to pause; a long one (Graph can ask for many minutes) is a request to
 *    go away, and sleeping through it inside a request loop holds the sync
 *    cycle, its locks and its progress open the whole time. Past the cap
 *    the retryable error is thrown so the scheduler can retry the cycle
 *    later, from the top, with everything released.
 */

import { SyncError } from "@notesnook/sync-remote";

/** The `code` union of SyncError, which sync-remote does not export by name. */
export type SyncErrorCode = SyncError["code"];

export const DEFAULT_MAX_RETRIES = 3;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;

/** Longer than this and the caller is told to come back later instead. */
const MAX_RETRY_AFTER_MS = 120_000;

/** Spread added on top of a Retry-After so devices do not return in step. */
const RETRY_AFTER_JITTER_MS = 1_000;

/**
 * A retryable failure that carries the server's own Retry-After. It extends
 * SyncError so every existing `instanceof SyncError` check and every
 * `error.code` switch keeps working on it; the extra field is only read
 * here.
 */
export class RetryAfterError extends SyncError {
  constructor(
    message: string,
    code: SyncErrorCode,
    status: number | undefined,
    readonly retryAfterMs: number,
  ) {
    super(message, code, status);
    this.name = "RetryAfterError";
  }
}

export interface RetryOptions {
  /** Attempts after the first. Defaults to DEFAULT_MAX_RETRIES. */
  maxRetries?: number;
  /** Injectable so tests do not spend real seconds asleep. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable so tests get a predictable jitter. */
  random?: () => number;
}

/**
 * Run `operation`, retrying only failures SyncError itself calls retryable
 * (network, timeout, server-error). Anything else — a 404, a bad key, a
 * cancelled request, a programming error — is rethrown untouched: retrying
 * it would turn one clear failure into four slow ones.
 *
 * `operation` receives the zero-based attempt number, and must be safe to
 * run more than once.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delay = options.delay ?? sleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0;; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!(error instanceof SyncError) || !error.isRetryable) throw error;
      if (attempt >= maxRetries) throw error;
      const wait = retryDelay(error, attempt, random);
      if (wait === undefined) throw error;
      await delay(wait);
    }
  }
}

/**
 * Full jitter (AWS's term): a uniform draw over the whole window rather
 * than the window plus a little noise. The point is that two devices that
 * failed together come back at genuinely unrelated times.
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const window = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(random() * window);
}

/**
 * Retry-After as milliseconds from now. Handles both forms RFC 9110 allows:
 * delta-seconds (what all three providers send) and an HTTP date (which a
 * proxy in front of them may substitute).
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  // A date already in the past means "now", not "negative time".
  return Math.max(0, at - now);
}

/** undefined means "do not wait here — give the error back to the caller". */
function retryDelay(
  error: SyncError,
  attempt: number,
  random: () => number,
): number | undefined {
  if (!(error instanceof RetryAfterError)) return backoffDelay(attempt, random);
  if (error.retryAfterMs > MAX_RETRY_AFTER_MS) return undefined;
  return error.retryAfterMs + Math.floor(random() * RETRY_AFTER_JITTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
