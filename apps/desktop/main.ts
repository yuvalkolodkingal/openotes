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
 * Openotes — entry point.
 *
 * Run under `deno desktop`, which opens a native window backed by the OS
 * webview (WebView2 on Windows, WebKitGTK on Linux) and runs this file in
 * the same process. There is no main/renderer process split and no IPC:
 * the UI reaches privileged operations through named bindings registered
 * below, each one validated in apps/desktop/src/rpc/handlers.ts.
 */

/// <reference path="./types/deno-desktop.d.ts" />

import { join } from "@std/path";
import { APP_NAME, APP_VERSION, DEEP_LINK_SCHEME } from "./src/constants.ts";
import { logger } from "./src/native/logger.ts";
import { startUiServer } from "./src/native/server.ts";
import { createApp, type WindowController } from "./src/app.ts";
import { createHandlers, dispatch } from "./src/rpc/handlers.ts";
import type { EventName } from "./src/rpc/protocol.ts";
import { parseArguments } from "./src/cli.ts";
import { cacheDir } from "./src/native/paths.ts";

const log = logger.scope("main");

/** Where the built UI lives, in a compiled binary and in development. */
function resolveUiRoot(): string {
  const override = Deno.env.get("OPENOTES_UI_ROOT");
  if (override) return override;

  const candidates = [
    join(dirOf(Deno.execPath()), "ui"),
    join(Deno.cwd(), "apps", "desktop", "ui"),
    join(Deno.cwd(), "apps", "web", "build"),
    join(Deno.cwd(), "ui")
  ];
  for (const candidate of candidates) {
    try {
      Deno.statSync(join(candidate, "index.html"));
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `Could not find the built user interface. Run "deno task build:ui" ` +
      `first, or set OPENOTES_UI_ROOT. Looked in:\n  ${candidates.join("\n  ")}`
  );
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? "." : path.slice(0, index);
}

/** Deep link passed on the command line, e.g. openotes://note/<id>. */
function deepLinkFromArgs(args: string[]): string | undefined {
  return args.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`));
}

/** Wraps Deno.BrowserWindow behind the interface the app expects. */
function createWindowController(
  window: Deno.BrowserWindow,
  state: { maximized: boolean }
): WindowController {
  return {
    maximize() {
      // Deno Desktop has no maximize primitive yet; approximate it by
      // sizing the window to the work area and remember that we did.
      state.maximized = true;
      window.setSize(1920, 1080);
    },
    restore() {
      state.maximized = false;
      window.setSize(1200, 800);
    },
    minimize() {
      window.hide();
    },
    isMaximized: () => state.maximized,
    focus: () => {
      window.show();
      window.focus();
    },
    setTitle: (title) => window.setTitle(title),
    setZoom: (factor) => {
      void window
        .executeJs(`document.documentElement.style.zoom = ${JSON.stringify(String(factor))}`)
        .catch(() => {});
    },
    requestClose: () => window.close(),
    emit(event: EventName, payload: unknown) {
      // Pushed into the renderer's event bus (see the web-side bridge).
      const script =
        `globalThis.__openotesEvent && globalThis.__openotesEvent(` +
        `${JSON.stringify(event)}, ${JSON.stringify(payload ?? null)})`;
      void window.executeJs(script).catch((error: unknown) => {
        log.debug("Could not deliver an event to the renderer", {
          event,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  };
}

async function main() {
  const cli = await parseArguments(Deno.args);
  const deepLink = deepLinkFromArgs(Deno.args);

  // Single instance is enforced by a lock file rather than by probing a
  // port: the interface server is only reachable by this process's own
  // webview, so a second instance cannot talk to the first over HTTP.
  const lock = await acquireInstanceLock();
  if (lock === undefined) {
    console.error(
      `${APP_NAME} is already running. Bring the existing window to the ` +
        `front instead of starting a second copy.`
    );
    Deno.exit(0);
  }
  // Held for the lifetime of the process; the kernel releases it on exit.
  void lock;

  const uiRoot = resolveUiRoot();
  const instanceId = crypto.randomUUID();

  const server = await startUiServer({ root: uiRoot, instanceId });

  const windowState = { maximized: false };
  const window = new Deno.BrowserWindow({
    title: APP_NAME,
    width: 1200,
    height: 800
  });

  const controller = createWindowController(window, windowState);
  const app = await createApp({
    window: controller,
    initialDeepLink: deepLink
  });

  // Restore the saved geometry now that settings are loaded.
  const savedWindow = app.settings.get("window");
  window.setSize(savedWindow.width, savedWindow.height);
  if (savedWindow.x !== undefined && savedWindow.y !== undefined) {
    window.setPosition(savedWindow.x, savedWindow.y);
  }
  windowState.maximized = savedWindow.maximized;

  // ---- bindings: the entire renderer -> runtime surface ----

  const handlers = createHandlers();

  window.bind("rpc", async (request: unknown) => {
    return await dispatch(
      request as { path: string; input?: unknown },
      handlers,
      app
    );
  });

  // A tiny separate binding so the renderer can learn where to connect and
  // what it is running against before the main bridge is initialized.
  window.bind("hello", () => ({
    app: APP_NAME,
    version: APP_VERSION,
    origin: server.origin,
    platform: Deno.build.os,
    deno: Deno.version.deno
  }));

  // ---- window lifecycle ----

  let savingGeometry: ReturnType<typeof setTimeout> | undefined;
  const persistGeometry = () => {
    if (savingGeometry !== undefined) clearTimeout(savingGeometry);
    savingGeometry = setTimeout(() => {
      try {
        const [width, height] = window.getSize();
        const [x, y] = window.getPosition();
        void app.settings.set("window", {
          width,
          height,
          x,
          y,
          maximized: windowState.maximized
        });
      } catch {
        /* the window may already be gone */
      }
    }, 500);
  };

  window.addEventListener("resize", persistGeometry);
  window.addEventListener("move", persistGeometry);

  let closing = false;
  window.addEventListener("close", (event: Event) => {
    if (closing) return;
    const desktop = app.settings.get("desktop");
    if (desktop.closeToSystemTray) {
      event.preventDefault();
      window.hide();
      return;
    }
    event.preventDefault();
    closing = true;
    // Give the app a chance to flush the outgoing queue before exiting.
    void (async () => {
      try {
        await app.shutdown();
      } finally {
        await server.shutdown().catch(() => {});
        Deno.exit(0);
      }
    })();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => {
        void app.shutdown().finally(() => Deno.exit(0));
      });
    } catch {
      // SIGTERM is not available on Windows.
    }
  }

  // ---- go ----

  window.navigate(hashRouteFor(cli, server.origin));
  if (cli.hidden) window.hide();
  else window.show();

  log.info(`${APP_NAME} ${APP_VERSION} started`, {
    origin: server.origin,
    uiRoot,
    cacheDir: cacheDir()
  });
}

/**
 * Single-instance lock.
 *
 * An advisory file lock, not a pid file. The kernel releases it when the
 * process dies however it dies, so a crash cannot leave the application
 * refusing to start — which a pid file does as soon as the recorded pid is
 * reused by something unrelated.
 *
 * The lock is held for the process's lifetime; the returned handle exists
 * so the caller keeps a reference and the file is not closed early.
 */
function instanceLockPath(): string {
  return join(cacheDir(), "instance.lock");
}

async function acquireInstanceLock(): Promise<Deno.FsFile | undefined> {
  const path = instanceLockPath();
  await Deno.mkdir(cacheDir(), { recursive: true }).catch(() => {});

  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { create: true, write: true, read: true });
  } catch (error) {
    // If the lock file cannot even be created, do not block start-up over
    // it: opening the user's notes matters more than the guarantee.
    log.warn("Could not create the instance lock; continuing without it", {
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined as unknown as Deno.FsFile;
  }

  try {
    // Exclusive, non-blocking: fails immediately if another instance holds it.
    file.lockSync(true);
  } catch {
    file.close();
    return undefined;
  }

  try {
    await file.write(new TextEncoder().encode(String(Deno.pid)));
  } catch {
    /* the pid is informational only */
  }
  return file;
}


/** Turn CLI intents into the interface's hash routes, as upstream did. */
function hashRouteFor(
  cli: Awaited<ReturnType<typeof parseArguments>>,
  origin: string
): string {
  if (cli.note === true) return `${origin}/#/notes/create/1`;
  if (typeof cli.note === "string") return `${origin}/#/notes/${cli.note}/edit`;
  if (cli.notebook === true) return `${origin}/#/notebooks/create`;
  if (typeof cli.notebook === "string") {
    return `${origin}/#/notebooks/${cli.notebook}`;
  }
  if (cli.reminder === true) return `${origin}/#/reminders/create`;
  return origin;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Startup failed", { error: message });
    console.error(`\n${APP_NAME} could not start:\n\n  ${message}\n`);
    Deno.exit(1);
  }
}
