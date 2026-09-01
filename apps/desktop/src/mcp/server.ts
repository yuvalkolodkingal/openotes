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
 * The MCP endpoint: one loopback HTTP listener inside the running app.
 *
 * WHY IT LIVES IN THE APP
 *
 * The vault is encrypted at rest and the key is derived from the user's
 * password inside the interface, so a separately-spawned helper could not
 * open the database even if it knew where it was. The only process that can
 * answer questions about notes is the one already holding the connection.
 *
 * WHY A SECOND LISTENER
 *
 * The interface server's address is chosen by the runtime and changes every
 * launch (see native/server.ts), which is useless in a client config file
 * the user writes once. A `deno desktop` app can open a second `Deno.serve`
 * on a port it picks, and that socket is reachable from other processes on
 * the machine — measured on Deno 2.9.6, both facts, before this was built.
 *
 * WHAT GUARDS IT
 *
 *   - Off by default. Nothing listens until the user turns it on.
 *   - Bound to 127.0.0.1, never 0.0.0.0.
 *   - Every request needs `Authorization: Bearer <token>`, compared in
 *     constant time. The token is written to a 0600 file the settings
 *     screen reads to show the client snippet.
 *   - Origin and Host are checked, because a page in the user's browser can
 *     POST to a loopback port and a DNS name can be pointed at 127.0.0.1.
 *     A browser cannot set Authorization cross-origin without a preflight,
 *     and the preflight is refused, but defence in depth is cheap here.
 *   - Editing is a separate switch from reading, and write tools are not
 *     even listed until it is on.
 *   - Notes in a vault are never readable through it.
 */

import { join } from "@std/path";
import { logger } from "../native/logger.ts";
import { APP_NAME, APP_VERSION } from "../constants.ts";
import { handleMessage, TOOLS } from "./protocol.ts";
import type { NoteRepository } from "./notes.ts";

const log = logger.scope("mcp");

/** Where a client posts. Kept short because users type it. */
export const MCP_PATH = "/mcp";

export interface McpServerOptions {
  repository: NoteRepository;
  /** Directory for the handshake file. */
  configDirectory: string;
  /** Notifies sync and the interface that notes changed underneath them. */
  onChanged: () => void;
}

export interface McpStatus {
  listening: boolean;
  port?: number;
  url?: string;
  allowWrites: boolean;
  /** Requests served since the listener started, for the settings screen. */
  requests: number;
  lastError?: string;
  toolCount: number;
}

/** The handshake file, so the settings screen and any future bridge agree. */
export interface McpHandshake {
  url: string;
  token: string;
  pid: number;
  app: string;
  version: string;
}

export class McpServer {
  private server?: Deno.HttpServer;
  private token = "";
  private port = 0;
  private allowWrites = false;
  private requests = 0;
  private lastError?: string;

  constructor(private readonly options: McpServerOptions) {}

  get handshakePath(): string {
    return join(this.options.configDirectory, "mcp.json");
  }

  status(): McpStatus {
    return {
      listening: !!this.server,
      port: this.server ? this.port : undefined,
      url: this.server ? `http://127.0.0.1:${this.port}${MCP_PATH}` : undefined,
      allowWrites: this.allowWrites,
      requests: this.requests,
      lastError: this.lastError,
      toolCount: this.allowWrites
        ? TOOLS.length
        : TOOLS.filter((tool) => !tool.mutates).length,
    };
  }

  /** The token, for the settings screen. Empty while the server is off. */
  currentToken(): string {
    return this.server ? this.token : "";
  }

  setAllowWrites(allowed: boolean) {
    this.allowWrites = allowed;
  }

  /**
   * Start listening. `port` 0 asks the OS to choose, which is fine for a
   * quick trial but means the client config changes every launch, so the
   * settings screen offers a fixed port.
   */
  async start(config: {
    port: number;
    allowWrites: boolean;
    token: string;
  }): Promise<McpStatus> {
    await this.stop();
    this.allowWrites = config.allowWrites;
    this.token = config.token;
    this.requests = 0;
    this.lastError = undefined;

    try {
      this.server = Deno.serve(
        {
          hostname: "127.0.0.1",
          port: config.port,
          onListen: ({ port }) => {
            this.port = port;
          },
          onError: (error) => {
            log.error("Unhandled error while answering", {
              error: error instanceof Error ? error.message : String(error),
            });
            return new Response("Internal Server Error", { status: 500 });
          },
        },
        (request) => this.handle(request),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message.includes("Address already in use")
        ? `Port ${config.port} is already in use. Choose another one.`
        : message;
      this.server = undefined;
      log.warn("Could not start the assistant endpoint", { error: message });
      throw new Error(this.lastError);
    }

    await this.writeHandshake();
    log.info("Assistant endpoint listening", {
      port: this.port,
      writes: this.allowWrites,
    });
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      try {
        await server.shutdown();
      } catch {
        /* already down */
      }
      log.info("Assistant endpoint stopped");
    }
    this.token = "";
    await this.removeHandshake();
  }

  // -- request handling ----------------------------------------------------

  private handle(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);

    // A browser page must not be able to reach this even with a stolen
    // token: refuse the preflight, so a cross-origin fetch with an
    // Authorization header never gets sent.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 405 });
    }
    if (!this.originIsLocal(request)) {
      return json(403, { error: "Cross-origin requests are refused." });
    }
    if (url.pathname !== MCP_PATH) {
      return json(404, { error: `Not found. The endpoint is ${MCP_PATH}.` });
    }
    if (request.method !== "POST") {
      return json(405, {
        error: "Use POST with a JSON-RPC body.",
      });
    }
    if (!this.authorized(request)) {
      return new Response(
        JSON.stringify({ error: "Missing or wrong bearer token." }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer realm="${APP_NAME}"`,
          },
        },
      );
    }

    this.requests++;
    return this.answer(request);
  }

  /** Guards have passed; read the body and answer it. */
  private async answer(request: Request): Promise<Response> {
    const text = await request.text();
    {
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch {
        return json(400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Body is not valid JSON" },
        });
      }

      const options = {
        repository: this.options.repository,
        allowWrites: this.allowWrites,
        serverName: "openotes",
        serverVersion: APP_VERSION,
        onChanged: this.options.onChanged,
      };

      // A batch is an array; each element answers independently and
      // notifications drop out of the reply entirely.
      if (Array.isArray(message)) {
        const answers = message
          .map((one) => handleMessage(one, options))
          .filter((one) => one !== undefined);
        if (!answers.length) return new Response(null, { status: 202 });
        return json(200, answers);
      }

      const answer = handleMessage(message, options);
      if (!answer) return new Response(null, { status: 202 });
      return json(200, answer);
    }
  }

  private authorized(request: Request): boolean {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return false;
    return timingSafeEqual(match[1], this.token);
  }

  /**
   * Only same-machine callers. A client that sends no Origin (curl, an MCP
   * client) is fine; a browser page always sends one, and a DNS name
   * resolved to 127.0.0.1 shows up in Host.
   */
  private originIsLocal(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        const hostname = new URL(origin).hostname;
        if (!isLoopbackHostname(hostname)) return false;
      } catch {
        return false;
      }
    }
    const host = request.headers.get("host");
    if (host) {
      const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (!isLoopbackHostname(hostname)) return false;
    }
    return true;
  }

  // -- the handshake file --------------------------------------------------

  private async writeHandshake(): Promise<void> {
    const handshake: McpHandshake = {
      url: `http://127.0.0.1:${this.port}${MCP_PATH}`,
      token: this.token,
      pid: Deno.pid,
      app: APP_NAME,
      version: APP_VERSION,
    };
    const path = this.handshakePath;
    try {
      await Deno.writeTextFile(path, JSON.stringify(handshake, null, 2), {
        mode: 0o600,
      });
      // `mode` is ignored on Windows and only applies at creation on unix,
      // so an existing file keeps whatever it had. Set it explicitly.
      if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
    } catch (error) {
      log.warn("Could not write the assistant handshake file", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async removeHandshake(): Promise<void> {
    try {
      await Deno.remove(this.handshakePath);
    } catch {
      /* it may never have been written */
    }
  }
}

/**
 * The token outlives the listener.
 *
 * A client config is written once and kept, so a token that changed every
 * launch would break it every launch. It lives in its own 0600 file rather
 * than in settings.json, which is world-readable and gets copied into bug
 * reports; `mcp.json` next to it is the live handshake and is removed when
 * the listener stops, so nothing stale ever points at a dead port.
 */
export async function readOrCreateToken(
  configDirectory: string,
): Promise<string> {
  const path = join(configDirectory, "mcp.token");
  try {
    const existing = (await Deno.readTextFile(path)).trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* first run, or unreadable — write a fresh one below */
  }
  return await rotateToken(configDirectory);
}

/** Replace the token, invalidating every client config that carries it. */
export async function rotateToken(configDirectory: string): Promise<string> {
  const path = join(configDirectory, "mcp.token");
  const token = generateToken();
  await Deno.writeTextFile(path, token, { mode: 0o600 });
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o600);
  return token;
}

/** A token a client can paste: 32 bytes, base64url, no padding. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/** Compares without leaking how much of the token matched. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Different lengths still walk the longer string, so the loop's duration
  // does not report the length of the secret.
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Nothing here is meant for a browser.
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
