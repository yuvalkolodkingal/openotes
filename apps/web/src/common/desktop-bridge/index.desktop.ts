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

/**
 * The renderer half of the desktop bridge.
 *
 * Upstream reached the Electron main process through electron-trpc's
 * ipcLink. Deno Desktop has no IPC; the runtime registers named bindings on
 * the window, so this module reproduces the *same call shape* the rest of
 * the app already uses —
 *
 *     desktop.integration.showNotification.mutate({...})
 *     desktop.updater.onAvailable.subscribe(undefined, { onData() {} })
 *
 * — over two primitives: `bindings.rpc({path, input})` for calls, and a
 * runtime-pushed `globalThis.__openotesEvent(name, payload)` for events.
 * Keeping the shape means the ~50 existing call sites did not have to
 * change, and neither @trpc/client nor electron-trpc is needed any more.
 */

import { AppEventManager, AppEvents } from "../app-events";
import { TaskScheduler } from "../../utils/task-scheduler";
import { checkForUpdate } from "../../utils/updater";
import { store as settingStore } from "../../stores/setting-store";
import type { DesktopIntegration } from "@notesnook/desktop";

type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string; code?: string } };

interface RuntimeBindings {
  rpc(request: { path: string; input?: unknown }): Promise<RpcResponse>;
  hello(): Promise<{
    app: string;
    version: string;
    origin: string;
    platform: string;
    deno: string;
  }>;
}

declare global {
  // eslint-disable-next-line no-var
  var bindings: RuntimeBindings | undefined;
  // eslint-disable-next-line no-var
  var __openotesEvent: ((event: string, payload: unknown) => void) | undefined;
}

/** An error raised by the runtime, carrying its original name and code. */
export class DesktopError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    name = "DesktopError"
  ) {
    super(message);
    this.name = name;
  }
}

async function call(path: string, input?: unknown): Promise<unknown> {
  const runtime = globalThis.bindings;
  if (!runtime?.rpc) {
    throw new DesktopError(
      `The desktop runtime is not available (calling ${path}). This build ` +
        `must run inside the Openotes desktop app.`,
      "no-runtime"
    );
  }

  const response = await runtime.rpc({ path, input });
  if (!response || typeof response !== "object") {
    throw new DesktopError(`Malformed response from ${path}`, "bad-response");
  }
  if (response.ok) return response.result;
  throw new DesktopError(
    response.error?.message ?? `${path} failed`,
    response.error?.code,
    response.error?.name
  );
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

globalThis.__openotesEvent = (event: string, payload: unknown) => {
  const set = listeners.get(event);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(payload);
    } catch (error) {
      console.error(`Error in listener for ${event}:`, error);
    }
  }
};

function subscribe(event: string, listener: Listener): () => void {
  const set = listeners.get(event) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(event, set);
  return () => set.delete(listener);
}

// ---------------------------------------------------------------------------
// Answering the runtime
// ---------------------------------------------------------------------------

/**
 * The runtime asking the interface something, rather than the other way round.
 *
 * Needed because an AI agent asks to read a note whenever it likes, and only
 * this half of the application can render one: the export machinery needs the
 * database singleton that lives here. The runtime emits `bridge.request` with
 * a correlation id, and the answer goes back as an ordinary RPC call.
 */
type RequestHandler = (payload: unknown) => Promise<unknown>;
const requestHandlers = new Map<string, RequestHandler>();

/** Register an answer for one request name. Returns an unregister function. */
export function handleDesktopRequest(
  name: string,
  handler: RequestHandler
): () => void {
  requestHandlers.set(name, handler);
  return () => requestHandlers.delete(name);
}

subscribe("bridge.request", (payload) => {
  const request = payload as {
    requestId: string;
    name: string;
    payload: unknown;
  };
  if (!request?.requestId) return;

  const handler = requestHandlers.get(request.name);
  const answer = handler
    ? handler(request.payload)
    : Promise.reject(new Error(`No handler for ${request.name}`));

  void answer.then(
    (result) => call("bridge.respond", { requestId: request.requestId, result }),
    (error: unknown) =>
      call("bridge.respond", {
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error)
      })
  );
});

// ---------------------------------------------------------------------------
// tRPC-shaped proxy
// ---------------------------------------------------------------------------

interface Procedure<TInput = unknown, TOutput = unknown> {
  query(input?: TInput): Promise<TOutput>;
  mutate(input?: TInput): Promise<TOutput>;
  subscribe(
    input: undefined,
    handlers: { onData?: (payload: any) => void; onError?: (error: unknown) => void }
  ): { unsubscribe(): void };
}

/**
 * Maps a procedure path to the event it emits, so `.subscribe()` keeps
 * working for the handful of push-style APIs the UI listens to.
 */
const SUBSCRIPTION_EVENTS: Record<string, string> = {
  "updater.onChecking": "updater.checking",
  "updater.onAvailable": "updater.available",
  "updater.onNotAvailable": "updater.notAvailable",
  "updater.onDownloadProgress": "updater.downloadProgress",
  "updater.onDownloaded": "updater.downloaded",
  "updater.onError": "updater.error",
  "bridge.onOpenLink": "bridge.openLink",
  "bridge.onCreateItem": "bridge.createItem",
  "integration.onThemeChanged": "integration.themeChanged",
  "window.onWindowStateChanged": "window.stateChanged",
  "window.onClose": "window.close",
  "webdav.onStatus": "webdav.status",
  "webdav.onConflict": "webdav.conflict",
  "backup.onCompleted": "backup.completed",
  "mcp.onStatus": "mcp.status",
  "mcp.onNotesChanged": "mcp.notesChanged"
};

function makeProcedure(path: string): Procedure {
  return {
    query: (input) => call(path, input),
    mutate: (input) => call(path, input),
    subscribe(_input, handlers) {
      const event = SUBSCRIPTION_EVENTS[path];
      if (!event) {
        handlers.onError?.(
          new DesktopError(`${path} is not a subscription`, "not-subscription")
        );
        return { unsubscribe() {} };
      }
      const unsubscribe = subscribe(event, (payload) =>
        handlers.onData?.(payload)
      );
      return { unsubscribe };
    }
  };
}

/**
 * Two levels of proxy: `desktop.<namespace>.<procedure>` resolves to a
 * Procedure object with query/mutate/subscribe, mirroring what
 * createTRPCProxyClient produced.
 */
function makeNamespace(namespace: string) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        return makeProcedure(`${namespace}.${property}`);
      }
    }
  );
}

/**
 * The typed surface of the runtime's procedure allowlist
 * (apps/desktop/src/rpc/protocol.ts), with each procedure's input and
 * output shaped after its handler in apps/desktop/src/rpc/handlers.ts.
 * The proxy underneath is dynamic — these types are the renderer-side
 * contract, and a namespace missing here is a one-line addition, not a
 * runtime change.
 */
export interface DesktopBridge {
  bridge: {
    ready: Procedure<void, { ready: boolean }>;
    onOpenLink: Procedure<void, string>;
    onCreateItem: Procedure<void, string>;
  };
  window: {
    maximize: Procedure<void, void>;
    restore: Procedure<void, void>;
    /** Upstream spelling, kept so the renderer is unchanged. */
    minimze: Procedure<void, void>;
    maximized: Procedure<void, boolean>;
    fullscreen: Procedure<void, boolean>;
    close: Procedure<void, void>;
    setTitle: Procedure<string | { title: string }, void>;
    onWindowStateChanged: Procedure<void, unknown>;
    onClose: Procedure<void, void>;
  };
  integration: {
    isFlatpak: Procedure<void, boolean>;
    isSnap: Procedure<void, boolean>;
    isPortable: Procedure<void, boolean>;
    appVersion: Procedure<void, string>;
    about: Procedure<void, Record<string, string>>;
    backupDirectory: Procedure<void, string | undefined>;
    selectBackupDirectory: Procedure<void, string | undefined>;
    selectDirectory: Procedure<{ title?: string }, string | undefined>;
    selectFile: Procedure<
      { title?: string; extensions?: string[] },
      string | undefined
    >;
    saveFile: Procedure<
      { title?: string; defaultName?: string },
      string | undefined
    >;
    zoomFactor: Procedure<void, number>;
    setZoomFactor: Procedure<number, void>;
    privacyMode: Procedure<void, boolean>;
    setPrivacyMode: Procedure<{ enabled: boolean }, void>;
    desktopIntegration: Procedure<void, DesktopIntegration>;
    setDesktopIntegration: Procedure<Partial<DesktopIntegration>, void>;
    showNotification: Procedure<
      {
        title?: string;
        body?: string;
        tag?: string;
        silent?: boolean;
        urgency?: string;
        timeoutType?: string;
      },
      void
    >;
    showMenu: Procedure<unknown, { handled: boolean }>;
    openPath: Procedure<string | { path: string }, void>;
    revealFile: Procedure<string | { path: string }, void>;
    openExternal: Procedure<string | { url: string }, void>;
    restart: Procedure<void, void>;
    bringToFront: Procedure<void, void>;
    systemTheme: Procedure<void, "light" | "dark">;
    changeTheme: Procedure<
      | "light"
      | "dark"
      | "system"
      | {
        theme: string;
        backgroundColor?: string;
        windowControlsIconColor?: string;
      },
      void
    >;
    onThemeChanged: Procedure<void, unknown>;
    readClipboard: Procedure<void, string>;
    writeClipboard: Procedure<string | { text: string }, void>;
    /** Electron-era, accepted and inert. */
    customDns: Procedure<void, boolean>;
    setCustomDns: Procedure<boolean, boolean>;
    proxyRules: Procedure<void, string>;
    setProxyRules: Procedure<string, string>;
    openLogDirectory: Procedure<void, void>;
    logs: Procedure<{ lines?: number }, string>;
  };
  sqlite: {
    open: Procedure<Record<string, unknown>, unknown>;
    run: Procedure<
      { id: string; sql: string; parameters?: unknown[] },
      unknown
    >;
    close: Procedure<string | { id: string }, void>;
    delete: Procedure<string | { id: string }, void>;
    export: Procedure<string | { id: string }, string>;
  };
  compress: {
    gzip: Procedure<string | { data: string; level?: number }, string>;
    gunzip: Procedure<string | { data: string }, string>;
  };
  safeStorage: {
    isEncryptionAvailable: Procedure<void, boolean>;
    encryptString: Procedure<string | { plaintext: string }, string>;
    decryptString: Procedure<string | { payload: string }, string>;
  };
  updater: {
    check: Procedure<void, unknown>;
    download: Procedure<void, unknown>;
    install: Procedure<void, unknown>;
    autoUpdates: Procedure<void, boolean>;
    toggleAutoUpdates: Procedure<{ enabled: boolean }, void>;
    releaseTrack: Procedure<void, string>;
    changeReleaseTrack: Procedure<{ track: string }, string>;
    onChecking: Procedure<void, unknown>;
    onAvailable: Procedure<void, unknown>;
    onNotAvailable: Procedure<void, unknown>;
    onDownloadProgress: Procedure<void, unknown>;
    onDownloaded: Procedure<void, unknown>;
    onError: Procedure<void, unknown>;
  };
  webdav: {
    fetchAttachment: Procedure<{ hash: string }, boolean>;
    onStatus: Procedure<void, unknown>;
    onConflict: Procedure<void, unknown>;
  };
  mcp: {
    getSettings: Procedure<void, McpSettings>;
    setSettings: Procedure<Partial<McpSettings>, McpStatus>;
    status: Procedure<void, McpStatus>;
    clientConfig: Procedure<void, McpClientConfig>;
    regenerateToken: Procedure<void, McpStatus>;
    onStatus: Procedure<void, McpStatus>;
    onNotesChanged: Procedure<void, unknown>;
  };
}

/** Settings → AI assistant. Mirrors McpSettings in the runtime. */
export type McpSettings = {
  enabled: boolean;
  port: number;
  allowWrites: boolean;
};

export type McpStatus = {
  listening: boolean;
  port?: number;
  url?: string;
  allowWrites: boolean;
  requests: number;
  lastError?: string;
  toolCount: number;
};

export type McpClientConfig =
  | { listening: false }
  | {
      listening: true;
      url: string;
      token: string;
      command: string;
      json: string;
    };


export const desktop = new Proxy({} as DesktopBridge, {
  get(_target, property) {
    if (typeof property !== "string") return undefined;
    return makeNamespace(property);
  }
});

/** True when running inside the desktop runtime. */
export function hasDesktopRuntime(): boolean {
  return typeof globalThis.bindings?.rpc === "function";
}

// ---------------------------------------------------------------------------
// Wiring runtime events onto the app's own event manager
// ---------------------------------------------------------------------------

function forward(event: string, appEvent: string) {
  subscribe(event, (payload) => AppEventManager.publish(appEvent, payload));
}

attachListeners();
function attachListeners() {
  if (!hasDesktopRuntime()) return;

  forward("updater.checking", AppEvents.checkingForUpdate);
  forward("updater.available", AppEvents.updateAvailable);
  forward("updater.downloaded", AppEvents.updateDownloadCompleted);
  forward("updater.downloadProgress", AppEvents.updateDownloadProgress);
  forward("updater.notAvailable", AppEvents.updateNotAvailable);
  forward("updater.error", AppEvents.updateError);
  forward("bridge.openLink", AppEvents.onOpenLink);

  TaskScheduler.register("updateCheck", "0 0 */12 * * * *", () => {
    checkForUpdate(settingStore.get().autoUpdates);
  });

  // Tell the runtime the UI is listening, so buffered events (a deep link
  // the app was launched with, an early sync result) are delivered now.
  void call("bridge.ready").catch((error) =>
    console.error("Could not complete the desktop handshake:", error)
  );
}

// ---------------------------------------------------------------------------
// Streamed writes (backups, exports)
// ---------------------------------------------------------------------------

/**
 * A WritableStream that writes through the runtime rather than through the
 * browser's download machinery, which a webview does not provide.
 */
export async function createWritableStream(path: string) {
  const id = (await call("backups.open", { filename: path })) as string;
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      await call("backups.write", { id, chunk: toBase64(chunk) });
    },
    async close() {
      await call("backups.close", { id });
    },
    async abort() {
      await call("backups.close", { id });
    }
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** Direct access for code that wants the raw call, e.g. new settings panels. */
export const desktopCall = call;
export const onDesktopEvent = subscribe;
