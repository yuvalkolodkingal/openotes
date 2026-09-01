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
 * The loopback half of an OAuth authorization-code flow.
 *
 * The sign-in happens in the user's own browser, not in the app's webview:
 * a webview cannot be trusted by the user to be showing the real Google, and
 * every provider's own guidance for an installed app says the same. So the
 * app opens a system browser, listens on a loopback port for the redirect,
 * and takes the code off the query string.
 *
 * `Deno.serve` on an explicit-or-ephemeral port works under `deno desktop`
 * and the socket is reachable from other processes — both measured on Deno
 * 2.9.6, and both load-bearing here, since the browser is another process.
 *
 * The page the browser lands on is static and never echoes a query value:
 * everything in that URL came from the provider's redirect, and reflecting
 * it would turn a loopback listener into a cross-site scripting surface on
 * an origin the app itself uses.
 */

import { logger } from "../native/logger.ts";
import { APP_NAME } from "../constants.ts";

const log = logger.scope("oauth");

/** Nothing is held open longer than a person takes to sign in. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const CALLBACK_PATH = "/oauth/callback";

export interface LoopbackResult {
  code: string;
  state: string;
}

export interface LoopbackListener {
  /** What to hand the provider as redirect_uri. */
  redirectUri: string;
  /** Resolves when the browser comes back, rejects on refusal or timeout. */
  result: Promise<LoopbackResult>;
  /** Stop listening. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Start listening for one redirect.
 *
 * `host` differs by provider: Google documents 127.0.0.1 and Microsoft and
 * Dropbox document localhost, and each rejects the other spelling against a
 * registration that used its own.
 */
export function listenForRedirect(options: {
  host: "127.0.0.1" | "localhost";
  /** Rejects anything whose `state` is not this. */
  expectedState: string;
  timeoutMs?: number;
}): LoopbackListener {
  let settle: (result: LoopbackResult) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  let port = 0;
  const server = Deno.serve(
    {
      // Always bind the address, never the name: "localhost" can resolve to
      // ::1 first and leave the provider's redirect knocking on IPv4.
      hostname: "127.0.0.1",
      port: 0,
      onListen: (address) => {
        port = address.port;
      },
      onError: () => new Response("Internal Server Error", { status: 500 }),
    },
    (request) => {
      const url = new URL(request.url);
      if (url.pathname !== CALLBACK_PATH) {
        return page(404, "Not found", "That is not the sign-in page.");
      }

      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? "";
        fail(
          new Error(
            description
              ? `${error}: ${description}`
              : `Sign-in failed: ${error}`,
          ),
        );
        return page(
          400,
          "Sign-in was refused",
          `You can close this tab and try again in ${APP_NAME}.`,
        );
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        fail(
          new Error("The provider came back without an authorization code."),
        );
        return page(
          400,
          "Something went wrong",
          `You can close this tab and try again in ${APP_NAME}.`,
        );
      }
      if (!constantTimeEqual(state, options.expectedState)) {
        // Someone else's redirect, or a forged one. Do not touch the code.
        fail(new Error("The sign-in response did not match this request."));
        return page(
          400,
          "That sign-in was not the one we started",
          "Close this tab and start again.",
        );
      }

      settle({ code, state });
      return page(
        200,
        "Signed in",
        `You can close this tab and go back to ${APP_NAME}.`,
      );
    },
  );

  const timeout = setTimeout(() => {
    fail(new Error("Timed out waiting for the browser to come back."));
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const close = async () => {
    clearTimeout(timeout);
    // Settle the promise if nothing else has: a caller that abandons the
    // flow should not leave an await hanging for the rest of the session.
    fail(new Error("Sign-in was cancelled."));
    try {
      await server.shutdown();
    } catch {
      /* already down */
    }
  };
  // Whatever happens, stop listening. A loopback port left open after a
  // failed sign-in is a port anything on the machine can post a code to.
  void result.catch(() => {}).finally(() => void close());

  // onListen has run by the time Deno.serve returns.
  const redirectUri = `http://${options.host}:${port}${CALLBACK_PATH}`;
  log.info("Waiting for an OAuth redirect", { redirectUri });

  return { redirectUri, result, close };
}

/** A static page. Nothing from the request reaches it. */
function page(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>:root{color-scheme:light dark}` +
      `body{font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;` +
      `place-items:center;height:100vh;background:#fafaf9;color:#1c1917}` +
      `@media(prefers-color-scheme:dark){body{background:#171412;color:#e7e5e4}}` +
      `main{text-align:center;max-width:32rem;padding:2rem}` +
      `h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}` +
      `p{margin:0;color:#78716c}` +
      `@media(prefers-color-scheme:dark){p{color:#a8a29e}}</style></head>` +
      `<body><main><h1>${escapeHtml(title)}</h1>` +
      `<p>${escapeHtml(body)}</p></main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Belt and braces: the page has no dynamic content, and now it
        // could not run any if it did.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** The state is a secret for the length of the flow; compare it as one. */
function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
