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

import { logger } from "../native/logger.ts";

const log = logger.scope("renderer-request");

/**
 * Request/response from the runtime *into* the interface.
 *
 * Everything else in this application flows the other way: the renderer calls
 * `bindings.rpc` and the runtime answers. Events go runtime → renderer, but
 * they are one-way, and nothing until now needed an answer back.
 *
 * Hosting an agent does. An agent asks to read a note at a moment of its
 * choosing, and only the renderer can answer — rendering a note to Markdown
 * needs the database singleton that lives there.
 *
 * WHY IT IS BUILT THIS WAY
 *
 * `executeJs` returns a value, so a single call looks like it would do. But
 * whether it awaits a promise the script returns is not something the runtime
 * documents, and a note read is asynchronous. So this uses only the two
 * primitives already proven in this codebase: an event out, and an ordinary
 * RPC call back carrying a correlation id.
 *
 * Every request has a deadline. A renderer that never answers — mid-reload,
 * or wedged — must not leave an agent waiting on a promise that cannot settle.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

export interface RendererRequest {
  requestId: string;
  name: string;
  payload: unknown;
}

/**
 * Start a request. `emit` is what actually delivers it; this module owns only
 * the correlation and the deadline.
 */
export function requestFromRenderer<T>(
  name: string,
  payload: unknown,
  emit: (request: RendererRequest) => void,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const requestId = crypto.randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`The interface did not answer "${name}" in time`));
    }, timeoutMs);

    pending.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    emit({ requestId, name, payload });
  });
}

/**
 * Deliver an answer. Returns false for an id nobody is waiting on, which is
 * not an error: a late reply to a request that already timed out is expected.
 */
export function deliverRendererResponse(
  requestId: string,
  result: unknown,
  error?: string,
): boolean {
  const entry = pending.get(requestId);
  if (!entry) {
    log.debug("Ignoring a response nobody is waiting for", { requestId });
    return false;
  }
  pending.delete(requestId);
  clearTimeout(entry.timer);
  if (error) entry.reject(new Error(error));
  else entry.resolve(result);
  return true;
}

/** Fail everything outstanding, e.g. when the window is going away. */
export function failAllRendererRequests(reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}
