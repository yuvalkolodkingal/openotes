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
 * Serves the built React UI to the webview.
 *
 * ORIGIN STABILITY — this matters for data safety.
 *
 * The webview stores things keyed by origin: IndexedDB (the key store) and
 * localStorage (settings). Upstream's Electron shell kept the origin fixed
 * by intercepting a constant https:// URL. Deno Desktop serves over
 * http://127.0.0.1:<port>, so a port that changed between launches would
 * silently orphan that data — the app would look freshly installed.
 *
 * So the port is *fixed*, not ephemeral. If it is already taken we do not
 * quietly fall back to a different one: we probe whether the listener is
 * another instance of this app (in which case we hand off to it) and
 * otherwise fail loudly with an explanation, because starting on a
 * different port would lose the user's local settings and keys.
 *
 * Attachments and the vault database deliberately live on the Deno side
 * (filesystem, under the app data directory) rather than in webview
 * storage, so the bulk of user data does not depend on this at all.
 */

/** Fixed loopback port. Chosen from the IANA dynamic range. */
export const UI_PORT = 49732;
export const UI_HOST = "127.0.0.1";
export const UI_ORIGIN = `http://${UI_HOST}:${UI_PORT}`;

/** Identifies our own listener during the single-instance probe. */
const INSTANCE_HEADER = "x-openotes-instance";
const HEALTH_PATH = "/__openotes/health";

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
  ".txt": "text/plain; charset=utf-8"
};

export interface UiServerOptions {
  /** Directory holding the built UI (index.html at its root). */
  root: string;
  /** Extra headers, e.g. a stricter CSP in production. */
  instanceId: string;
  /** Called with a deep link when another instance hands one off. */
  onDeepLink?: (url: string) => void;
}

export interface RunningUiServer {
  origin: string;
  shutdown(): Promise<void>;
}

/**
 * Is something already listening on our fixed port, and is it us?
 * Returns "free", "ours" or "foreign".
 */
export async function probePort(): Promise<"free" | "ours" | "foreign"> {
  try {
    const listener = Deno.listen({ hostname: UI_HOST, port: UI_PORT });
    listener.close();
    return "free";
  } catch (error) {
    if (!(error instanceof Deno.errors.AddrInUse)) throw error;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${UI_ORIGIN}${HEALTH_PATH}`, {
      signal: controller.signal
    });
    clearTimeout(timer);
    if (response.ok && response.headers.get(INSTANCE_HEADER)) {
      await response.body?.cancel();
      return "ours";
    }
    await response.body?.cancel();
  } catch {
    // Not reachable or not speaking our protocol.
  }
  return "foreign";
}

/** Ask an already-running instance to focus itself, optionally with a link. */
export async function handOffToRunningInstance(
  deepLink?: string
): Promise<boolean> {
  try {
    const response = await fetch(`${UI_ORIGIN}${HEALTH_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "focus", deepLink })
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

export class PortUnavailableError extends Error {
  constructor() {
    super(
      `Another program is already listening on ${UI_ORIGIN}. Openotes serves ` +
        `its interface on a fixed port so the browser storage holding your ` +
        `settings and keys keeps the same origin between launches; starting ` +
        `on a different port would make the app look freshly installed. ` +
        `Close whatever is using port ${UI_PORT} and start Openotes again.`
    );
    this.name = "PortUnavailableError";
  }
}

export async function startUiServer(
  options: UiServerOptions
): Promise<RunningUiServer> {
  const root = await Deno.realPath(options.root);
  const state = await probePort();
  if (state === "foreign") throw new PortUnavailableError();
  if (state === "ours") {
    throw new Error(
      "Another Openotes instance is already running. This one will hand over."
    );
  }

  const server = Deno.serve(
    { hostname: UI_HOST, port: UI_PORT, onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);

      if (url.pathname === HEALTH_PATH) {
        if (request.method === "POST") {
          try {
            const body = await request.json();
            if (body?.deepLink && typeof body.deepLink === "string") {
              options.onDeepLink?.(body.deepLink);
            } else {
              options.onDeepLink?.("");
            }
          } catch {
            options.onDeepLink?.("");
          }
          return new Response(null, {
            status: 204,
            headers: { [INSTANCE_HEADER]: options.instanceId }
          });
        }
        return new Response("ok", {
          headers: { [INSTANCE_HEADER]: options.instanceId }
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      return await serveStatic(root, url.pathname, request.method === "HEAD");
    }
  );

  log.info("UI server listening", { origin: UI_ORIGIN, root });

  return {
    origin: UI_ORIGIN,
    shutdown: () => server.shutdown()
  };
}

async function serveStatic(
  root: string,
  pathname: string,
  headOnly: boolean
): Promise<Response> {
  let requested: string;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Normalize and confine to the UI root. The UI is trusted content, but a
  // traversal here would turn an XSS in a note into arbitrary file reads.
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
  // the hash/router-driven views keep working on a hard reload.
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

  const headers = new Headers({
    "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ??
      "application/octet-stream",
    "content-length": String(stat.size),
    // The renderer is local content that must not be reachable from a page
    // in the user's browser, and must not reach the network on its own.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "x-content-type-options": "nosniff",
    "cache-control": filePath.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable"
  });

  if (headOnly) return new Response(null, { status: 200, headers });

  const file = await Deno.open(filePath, { read: true });
  return new Response(file.readable, { status: 200, headers });
}
