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

import { extname, join, normalize } from "@std/path";
import { logger } from "./logger.ts";

const log = logger.scope("server");

/**
 * Serves the built React interface to the webview.
 *
 * HOW THE ADDRESS WORKS, AND WHY IT MATTERS
 *
 * Under `deno desktop` the runtime owns the listening address. A port
 * passed to `Deno.serve` is ignored: the runtime substitutes its own and
 * publishes it as DENO_SERVE_ADDRESS, and the socket is wired to the
 * embedded webview rather than published on the machine — a fetch to that
 * port from another process fails.
 *
 * Two consequences, both measured rather than assumed:
 *
 *  1. Nothing outside the application can reach this server. That is good
 *     for security, and it is why the smoke test inspects the window
 *     instead of curling a health endpoint.
 *
 *  2. The port differs on every launch, so the page's origin does too
 *     (observed: http://127.0.0.1:34265, then http://127.0.0.1:42857 on
 *     the next run). Browser storage is partitioned by origin, so
 *     **anything the page writes to localStorage or IndexedDB is gone
 *     after a restart** — a value written in one run read back as null in
 *     the next.
 *
 * The second point is why nothing durable lives in webview storage. The
 * vault, attachments, settings and key material are all held by the
 * runtime (see native/keyvalue.ts) and reached through bindings. Treat any
 * new use of localStorage or IndexedDB in the interface as a bug.
 */

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export interface UiServerOptions {
  /** Directory holding the built interface (index.html at its root). */
  root: string;
  /** Identifies this instance; returned by the health route. */
  instanceId: string;
  /**
   * The colour scheme the window should paint before the interface has
   * booted. See BOOT_THEME below for why the server, not the page, decides.
   */
  colorScheme?: () => "light" | "dark";
}

export interface RunningUiServer {
  /** The origin the runtime actually assigned. */
  origin: string;
  shutdown(): Promise<void>;
}

/** Health route, used by the interface handshake and by the smoke test. */
export const HEALTH_PATH = "/__openotes/health";
const INSTANCE_HEADER = "x-openotes-instance";

/**
 * The address the runtime assigned, once serving has started. Read from
 * DENO_SERVE_ADDRESS, which `deno desktop` sets before user code runs.
 */
export function assignedOrigin(fallbackPort?: number): string {
  const address = Deno.env.get("DENO_SERVE_ADDRESS");
  if (address) {
    // Format is "tcp:127.0.0.1:45597".
    const parts = address.split(":");
    const port = parts[parts.length - 1];
    const host = parts.length >= 3 ? parts[parts.length - 2] : "127.0.0.1";
    if (/^\d+$/.test(port)) return `http://${host}:${port}`;
  }
  return `http://127.0.0.1:${fallbackPort ?? 0}`;
}

/**
 * The first paint, before any JavaScript has run.
 *
 * The interface cannot colour its own first frame. `--background` is defined
 * by a stylesheet the page fills in from settings, and on desktop those
 * settings arrive over an RPC round trip, so for the first few frames the
 * document has no background at all and the webview paints its default
 * white. In dark mode that is a white flash on every single launch.
 *
 * The runtime already knows the answer, so it stamps it into the document as
 * it serves it: `data-theme` for anything keyed off it, a `color-scheme` so
 * the platform paints scrollbars and form controls to match, and a literal
 * background colour that matches the theme's `base.primary.background`. The
 * interface overwrites all of it a moment later; this only has to be right
 * for the frames before that.
 */
const BOOT_BACKGROUND: Record<"light" | "dark", string> = {
  light: "#fafaf9",
  dark: "#171412",
};

function bootThemeMarkup(scheme: "light" | "dark"): string {
  return `<style id="boot-theme">:root{color-scheme:${scheme}}` +
    `html,body{background-color:${BOOT_BACKGROUND[scheme]}}</style>`;
}

/** Stamp the boot theme into the served index.html. */
export function injectBootTheme(
  html: string,
  scheme: "light" | "dark",
): string {
  let out = html;
  // Anything already keyed off data-theme (the skeleton loader, for one)
  // then matches from the very first frame instead of after hydration.
  if (/<html\b[^>]*\bdata-theme=/.test(out)) {
    out = out.replace(
      /(<html\b[^>]*\bdata-theme=)(["'])[^"']*\2/,
      `$1$2${scheme}$2`,
    );
  } else {
    out = out.replace(/<html\b/, `<html data-theme="${scheme}"`);
  }
  const markup = bootThemeMarkup(scheme);
  return out.includes("</head>")
    ? out.replace("</head>", `  ${markup}\n  </head>`)
    : markup + out;
}

export async function startUiServer(
  options: UiServerOptions,
): Promise<RunningUiServer> {
  const root = await Deno.realPath(options.root);

  // The port here is a request, not a guarantee: under `deno desktop` the
  // runtime overrides it. onListen reports what was actually assigned.
  let origin = assignedOrigin();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: (address) => {
        origin = `http://${address.hostname}:${address.port}`;
      },
    },
    async (request) => {
      const url = new URL(request.url);

      if (url.pathname === HEALTH_PATH) {
        return new Response(
          JSON.stringify({ ok: true, instance: options.instanceId }),
          {
            headers: {
              "content-type": "application/json",
              [INSTANCE_HEADER]: options.instanceId,
            },
          },
        );
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      return await serveStatic(
        root,
        url.pathname,
        request.method === "HEAD",
        options.colorScheme?.() ?? "light",
      );
    },
  );

  log.info("Interface server started", { origin, root });

  return {
    get origin() {
      return origin;
    },
    shutdown: () => server.shutdown(),
  };
}

async function serveStatic(
  root: string,
  pathname: string,
  headOnly: boolean,
  colorScheme: "light" | "dark",
): Promise<Response> {
  let requested: string;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Normalize and confine to the interface root. The interface is trusted
  // content, but a traversal here would turn an XSS in a note into
  // arbitrary file reads.
  const relative = normalize(requested).replace(/^([/\\])+/, "");
  if (relative.split(/[/\\]/).includes("..")) {
    return new Response("Forbidden", { status: 403 });
  }

  let filePath = join(root, relative);
  let stat: Deno.FileInfo | undefined;
  try {
    stat = await Deno.stat(filePath);
    if (stat.isDirectory) {
      filePath = join(filePath, "index.html");
      stat = await Deno.stat(filePath);
    }
  } catch {
    stat = undefined;
  }

  // Single-page app: unknown non-asset routes fall through to index.html so
  // the router-driven views keep working on a hard reload.
  if (!stat) {
    if (extname(relative)) return new Response("Not Found", { status: 404 });
    filePath = join(root, "index.html");
    try {
      stat = await Deno.stat(filePath);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  if (!filePath.startsWith(root)) {
    return new Response("Forbidden", { status: 403 });
  }

  const isDocument = filePath.endsWith("index.html");
  const headers = new Headers({
    "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "cache-control": isDocument
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });

  if (isDocument) {
    // Rewritten per request, so content-length comes from the rewrite and
    // the document is never cached with last launch's colour scheme.
    const body = new TextEncoder().encode(
      injectBootTheme(await Deno.readTextFile(filePath), colorScheme),
    );
    headers.set("content-length", String(body.byteLength));
    if (headOnly) return new Response(null, { status: 200, headers });
    return new Response(body, { status: 200, headers });
  }

  headers.set("content-length", String(stat.size));
  if (headOnly) return new Response(null, { status: 200, headers });

  const file = await Deno.open(filePath, { read: true });
  return new Response(file.readable, { status: 200, headers });
}
