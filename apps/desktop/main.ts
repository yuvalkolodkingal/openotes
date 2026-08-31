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
import {
  handOffToRunningInstance,
  probePort,
  startUiServer,
  UI_ORIGIN
} from "./src/native/server.ts";
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

  // Single instance: a second launch focuses the first and hands over the
  // deep link rather than opening a second window on a taken port.
  const portState = await probePort();
  if (portState === "ours") {
    log.info("Another instance is already running; handing over");
    const handedOff = await handOffToRunningInstance(deepLink);
    if (!handedOff) {
      console.error(
        `${APP_NAME} is already running but did not respond. ` +
          `Close it and try again.`
      );
    }
    Deno.exit(0);
  }

  const uiRoot = resolveUiRoot();
  const instanceId = crypto.randomUUID();

  let onDeepLink: (url: string) => void = () => {};
  const server = await startUiServer({
    root: uiRoot,
    instanceId,
    onDeepLink: (url) => onDeepLink(url)
  });

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

  onDeepLink = (url) => {
    controller.focus();
    if (url) app.emit("bridge.openLink", url);
  };

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
    origin: UI_ORIGIN,
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

  const startUrl = cli.hidden ? undefined : UI_ORIGIN;
  if (startUrl) {
    window.navigate(hashRouteFor(cli, startUrl));
    window.show();
  } else {
    window.hide();
  }

  log.info(`${APP_NAME} ${APP_VERSION} started`, {
    origin: UI_ORIGIN,
    uiRoot,
    cacheDir: cacheDir()
  });
}

/** Turn CLI intents into the UI's hash routes, as upstream did. */
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
