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

import { SyncError } from "@notesnook/sync-remote";
import type { AppContext } from "../app.ts";
import {
  isKnownProcedure,
  type RpcRequest,
  type RpcResponse,
} from "./protocol.ts";
import { logger } from "../native/logger.ts";
import {
  APP_IDENTIFIER,
  APP_NAME,
  APP_VERSION,
  SYNC_PROTOCOL_VERSION,
  UPSTREAM_BASE,
} from "../constants.ts";
import {
  assertInside,
  isFlatpak,
  isPortable,
  isSnap,
} from "../native/paths.ts";
import { PathAccessError } from "../native/paths.ts";

const log = logger.scope("rpc");

type Handler = (input: any, context: AppContext) => unknown | Promise<unknown>;

/**
 * The procedure table. Everything the renderer can reach is here, and each
 * handler validates its own input — the renderer supplies data, never
 * capabilities.
 */
export function createHandlers(): Record<string, Handler> {
  return {
    // ---------------- lifecycle ----------------

    "bridge.ready": (_input, context) => {
      context.markRendererReady();
      return { ready: true };
    },

    "capabilities.get": () => ({
      // No subscription tiers exist in this fork.
      allLocalFeatures: true,
      syncProvider: "webdav",
      cloudAccountRequired: false,
    }),

    // ---------------- window ----------------

    "window.maximize": (_input, context) => {
      context.window.maximize();
    },
    "window.restore": (_input, context) => {
      context.window.restore();
    },
    "window.minimze": (_input, context) => {
      context.window.minimize();
    },
    "window.maximized": (_input, context) => context.window.isMaximized(),
    "window.fullscreen": () => false,
    "window.close": (_input, context) => {
      context.window.requestClose();
    },
    "window.setTitle": (input, context) => {
      context.window.setTitle(asString(input, "title", 200));
    },

    // ---------------- os integration ----------------

    "integration.isFlatpak": () => isFlatpak(),
    "integration.isSnap": () => isSnap(),
    "integration.isPortable": () => isPortable(),
    "integration.appVersion": () => APP_VERSION,

    "integration.about": () => ({
      name: APP_NAME,
      identifier: APP_IDENTIFIER,
      version: APP_VERSION,
      upstreamBase: UPSTREAM_BASE,
      denoVersion: Deno.version.deno,
      v8Version: Deno.version.v8,
      syncProtocolVersion: SYNC_PROTOCOL_VERSION,
      platform: `${Deno.build.os}/${Deno.build.arch}`,
    }),

    "integration.backupDirectory": (_input, context) =>
      context.settings.get("backup").localDirectory,

    "integration.selectBackupDirectory": async (_input, context) => {
      const directory = await context.dialogs.selectDirectory({
        title: "Choose a folder for backups",
      });
      if (!directory) return undefined;
      await context.settings.patchBackup({ localDirectory: directory });
      context.refreshAllowedRoots();
      return directory;
    },

    "integration.selectDirectory": async (input, context) =>
      await context.dialogs.selectDirectory({
        title: optionalString(input?.title) ?? "Choose a folder",
      }),

    "integration.selectFile": async (input, context) =>
      await context.dialogs.selectFile({
        title: optionalString(input?.title) ?? "Choose a file",
        extensions: Array.isArray(input?.extensions)
          ? input.extensions.filter((e: unknown) => typeof e === "string")
          : undefined,
      }),

    "integration.saveFile": async (input, context) =>
      await context.dialogs.saveFile({
        title: optionalString(input?.title) ?? "Save file",
        defaultName: optionalString(input?.defaultName) ?? "export",
      }),

    "integration.zoomFactor": (_input, context) =>
      context.settings.get("zoomFactor"),
    "integration.setZoomFactor": async (input, context) => {
      const factor = Number(input);
      if (!Number.isFinite(factor) || factor < 0.25 || factor > 4) {
        throw new Error("Zoom factor must be between 0.25 and 4");
      }
      await context.settings.set("zoomFactor", factor);
      context.window.setZoom(factor);
    },

    "integration.privacyMode": (_input, context) =>
      context.settings.get("privacyMode"),
    "integration.setPrivacyMode": async (input, context) => {
      await context.settings.set("privacyMode", !!input?.enabled);
    },

    "integration.desktopIntegration": (_input, context) =>
      context.settings.get("desktop"),
    "integration.setDesktopIntegration": async (input, context) => {
      const current = context.settings.get("desktop");
      await context.settings.set("desktop", {
        autoStart: boolOr(input?.autoStart, current.autoStart),
        startMinimized: boolOr(input?.startMinimized, current.startMinimized),
        minimizeToSystemTray: boolOr(
          input?.minimizeToSystemTray,
          current.minimizeToSystemTray,
        ),
        closeToSystemTray: boolOr(
          input?.closeToSystemTray,
          current.closeToSystemTray,
        ),
        nativeTitlebar: boolOr(input?.nativeTitlebar, current.nativeTitlebar),
      });
      await context.applyDesktopIntegration();
    },

    "integration.showNotification": async (input, context) =>
      await context.notifications.show({
        title: optionalString(input?.title) ?? APP_NAME,
        body: optionalString(input?.body) ?? "",
        tag: optionalString(input?.tag) ?? "",
        silent: !!input?.silent,
      }),

    "integration.showMenu": () => {
      // Native popup menus are a macOS nicety upstream; the web UI has an
      // HTML fallback it uses everywhere else, so this reports "unhandled"
      // and the renderer draws its own menu.
      return { handled: false };
    },

    "integration.openPath": async (input, context) => {
      const path = assertInside(
        asString(input, "path", 4096),
        context.allowedRoots(),
        "path",
      );
      await context.shell.openPath(path);
    },

    "integration.revealFile": async (input, context) => {
      const path = assertInside(
        asString(input, "path", 4096),
        context.allowedRoots(),
        "path",
      );
      await context.shell.revealPath(path);
    },

    "integration.openExternal": async (input, context) => {
      await context.shell.openExternal(asString(input, "url", 2048));
    },

    "integration.restart": (_input, context) => {
      context.restart();
    },
    "integration.bringToFront": (_input, context) => {
      context.window.focus();
    },

    "integration.systemTheme": (_input, context) => context.theme.current(),
    "integration.changeTheme": async (input, context) => {
      // The interface sends { theme, backgroundColor?, ... }; a bare string
      // is accepted too.
      const raw = input && typeof input === "object" ? input.theme : input;
      const theme = raw === "dark" || raw === "light" || raw === "system"
        ? raw
        : "system";
      await context.settings.set("theme", theme);
      context.theme.apply(theme);
    },

    "integration.readClipboard": (_input, context) =>
      context.clipboard.readText(),
    "integration.writeClipboard": (input, context) => {
      context.clipboard.writeText(asString(input, "text", 5_000_000));
    },

    // Electron-era session features with no webview equivalent; accepted
    // and inert so the interface's start-up queries do not error.
    "integration.customDns": () => false,
    "integration.setCustomDns": () => false,
    "integration.proxyRules": () => "",
    "integration.setProxyRules": () => "",

    "integration.openLogDirectory": async (_input, context) => {
      await context.shell.openPath(context.logDirectory);
    },
    "integration.logs": async (input, context) =>
      await context.tailLogs(clampInt(input?.lines, 1, 5000, 500)),

    // ---------------- sqlite ----------------

    "sqlite.open": (input, context) =>
      context.sqlite.open({
        filePath: asString(input, "filePath", 4096),
        password: optionalString(input?.password),
        journalMode: input?.journalMode,
        lockingMode: input?.lockingMode,
        synchronous: input?.synchronous,
        pageSize: input?.pageSize,
        cacheSize: input?.cacheSize,
        tempStore: input?.tempStore,
      }),

    "sqlite.run": (input, context) => {
      const result = context.sqlite.run(
        asString(input, "id", 64),
        asString(input, "sql", 1_000_000),
        Array.isArray(input?.parameters) ? input.parameters : [],
      );
      // The database is the vault: a write is a local change worth syncing.
      if (isWriteStatement(input.sql)) context.notifyLocalChange();
      return result;
    },

    "sqlite.close": (input, context) => {
      context.sqlite.close(asString(input, "id", 64));
    },
    "sqlite.delete": (input, context) => {
      context.sqlite.delete(asString(input, "id", 64));
    },
    "sqlite.export": (input, context) =>
      base64Encode(context.sqlite.export(asString(input, "id", 64))),

    // ---------------- streamed exports/backups ----------------

    "backups.open": async (input, context) =>
      await context.exports.open(asString(input, "filename", 4096)),
    "backups.write": async (input, context) => {
      await context.exports.write(
        asString(input, "id", 64),
        base64Decode(asString(input, "chunk", 100_000_000)),
      );
    },
    "backups.close": async (input, context) =>
      await context.exports.close(asString(input, "id", 64)),

    // ---------------- durable renderer storage ----------------

    "storage.get": (input, context) =>
      context.storage.get(input?.namespace, input?.key),
    "storage.set": async (input, context) => {
      await context.storage.set(input?.namespace, input?.key, input?.value);
      return { ok: true };
    },
    "storage.remove": async (input, context) => {
      await context.storage.remove(input?.namespace, input?.key);
      return { ok: true };
    },
    "storage.keys": (input, context) => context.storage.keys(input?.namespace),
    "storage.entries": (input, context) =>
      context.storage.entries(input?.namespace),
    "storage.clear": async (input, context) => {
      if (input?.confirm !== "clear") {
        throw new Error("Clearing stored data requires explicit confirmation");
      }
      await context.storage.clear(input?.namespace);
      return { ok: true };
    },

    // ---------------- attachment content ----------------

    // The renderer's streamable-fs layer, served by the runtime's chunked
    // attachment store. Chunk names are `<hash>-chunk-<index>` and are
    // parsed and validated strictly by the store before any path is built.
    // Binary travels as base64, like every other binary procedure here.

    "attachments.setMetadata": async (input, context) => {
      const filename = asString(input, "filename", 200);
      const metadata = input?.metadata;
      if (
        !metadata || typeof metadata !== "object" || Array.isArray(metadata)
      ) {
        throw new Error('"metadata" must be an object');
      }
      await context.files.setMetadata(filename, {
        filename,
        size: Number(metadata.size ?? 0),
        type: optionalString(metadata.type) ?? "application/octet-stream",
        additionalData: isPlainObject(metadata.additionalData)
          ? metadata.additionalData
          : undefined,
      });
      return { ok: true };
    },
    "attachments.getMetadata": async (input, context) =>
      (await context.files.getMetadata(asString(input, "filename", 200))) ??
        null,
    "attachments.deleteMetadata": async (input, context) => {
      await context.files.deleteMetadata(asString(input, "filename", 200));
      return { ok: true };
    },
    "attachments.writeChunk": async (input, context) => {
      await context.files.writeChunk(
        asString(input, "chunkName", 200),
        base64Decode(asString(input, "data", 4_000_000)),
      );
      return { ok: true };
    },
    "attachments.readChunk": async (input, context) => {
      const data = await context.files.readChunk(
        asString(input, "chunkName", 200),
      );
      return data ? base64Encode(data) : null;
    },
    "attachments.deleteChunk": async (input, context) => {
      await context.files.deleteChunk(asString(input, "chunkName", 200));
      return { ok: true };
    },
    "attachments.chunkSize": async (input, context) =>
      await context.files.chunkSize(asString(input, "chunkName", 200)),
    "attachments.listChunks": async (input, context) =>
      await context.files.listChunks(asString(input, "chunkPrefix", 200)),
    "attachments.list": async (_input, context) => await context.files.list(),
    "attachments.deleteFile": async (input, context) =>
      await context.files.deleteFile(asString(input, "filename", 200)),
    "attachments.clear": async (input, context) => {
      if (input?.confirm !== "clear") {
        throw new Error(
          "Clearing attachment storage requires explicit confirmation",
        );
      }
      await context.files.clear();
      return { ok: true };
    },

    // ---------------- key storage ----------------

    // The renderer's key store wraps its AES key through these two calls
    // and persists only the ciphertext — upstream's own desktop path,
    // running unchanged. See security/safe-storage.ts for what the
    // encryption is and, more importantly, what it is not.
    "safeStorage.isEncryptionAvailable": (_input, context) =>
      context.safeStorage.isAvailable(),
    "safeStorage.encryptString": async (input, context) =>
      await context.safeStorage.encryptString(
        asString(input, "plaintext", 1_000_000),
      ),
    "safeStorage.decryptString": async (input, context) =>
      await context.safeStorage.decryptString(
        asString(input, "payload", 1_000_000),
      ),

    // ---------------- compression ----------------

    "compress.gzip": async (input) =>
      base64Encode(
        await compress(base64Decode(asString(input, "data", 100_000_000))),
      ),
    "compress.gunzip": async (input) =>
      base64Encode(
        await decompress(base64Decode(asString(input, "data", 100_000_000))),
      ),

    // ---------------- updates ----------------

    "updater.check": async (_input, context) => await context.updater.check(),
    "updater.download": async (_input, context) =>
      await context.updater.download(),
    "updater.install": async (_input, context) =>
      await context.updater.install(),
    "updater.autoUpdates": (_input, context) =>
      context.settings.get("automaticUpdates"),
    "updater.toggleAutoUpdates": async (input, context) => {
      await context.settings.set("automaticUpdates", !!input?.enabled);
    },
    "updater.releaseTrack": () => "stable",
    "updater.changeReleaseTrack": () => {
      // A single stable track; there is no beta feed for this fork.
      return "stable";
    },

    // ---------------- webdav sync ----------------

    "webdav.getConfig": (_input, context) => {
      const config = context.settings.get("webdav");
      // The password is deliberately absent: it never travels to the
      // renderer, not even back to the settings form.
      return { ...config, hasPassword: context.hasStoredWebDavPassword() };
    },

    "webdav.setConfig": async (input, context) => {
      const current = context.settings.get("webdav");
      const serverUrl = optionalString(input?.serverUrl) ?? current.serverUrl;
      if (serverUrl && !/^https?:\/\//i.test(serverUrl)) {
        throw new Error("The server URL must start with https:// or http://");
      }
      if (
        serverUrl.startsWith("http://") &&
        !(input?.allowInsecureHttp ?? current.allowInsecureHttp)
      ) {
        throw new Error(
          "Plain HTTP is disabled. Use https://, or explicitly enable " +
            "insecure connections for a trusted local network.",
        );
      }
      await context.settings.patchWebDav({
        enabled: boolOr(input?.enabled, current.enabled),
        serverUrl,
        username: optionalString(input?.username) ?? current.username,
        directory: optionalString(input?.directory) ?? current.directory,
        intervalMinutes: clampInt(
          input?.intervalMinutes,
          0,
          1440,
          current.intervalMinutes,
        ),
        syncOnStartup: boolOr(input?.syncOnStartup, current.syncOnStartup),
        syncAfterEdits: boolOr(input?.syncAfterEdits, current.syncAfterEdits),
        debounceSeconds: clampInt(
          input?.debounceSeconds,
          1,
          600,
          current.debounceSeconds,
        ),
        syncOnMeteredNetwork: boolOr(
          input?.syncOnMeteredNetwork,
          current.syncOnMeteredNetwork,
        ),
        syncAttachments: boolOr(
          input?.syncAttachments,
          current.syncAttachments,
        ),
        timeoutSeconds: clampInt(
          input?.timeoutSeconds,
          5,
          600,
          current.timeoutSeconds,
        ),
        maxRetries: clampInt(input?.maxRetries, 0, 10, current.maxRetries),
        allowInsecureHttp: boolOr(
          input?.allowInsecureHttp,
          current.allowInsecureHttp,
        ),
        storeCredentialsWithMachineKey: boolOr(
          input?.storeCredentialsWithMachineKey,
          current.storeCredentialsWithMachineKey,
        ),
      });
      await context.reconfigureSync();
      return {
        ...context.settings.get("webdav"),
        hasPassword: context.hasStoredWebDavPassword(),
      };
    },

    "webdav.setPassphrase": async (input, context) => {
      await context.sync.setCredentials({
        password: optionalString(input?.password),
        passphrase: optionalString(input?.passphrase),
      });
      return { ok: true };
    },

    "webdav.testConnection": async (input, context) =>
      await context.sync.testConnection({
        serverUrl: asString(input, "serverUrl", 2048),
        username: asString(input, "username", 256),
        password: asString(input, "password", 1024),
        directory: optionalString(input?.directory) ?? "Openotes",
        passphrase: asString(input, "passphrase", 1024),
        allowInsecureHttp: !!input?.allowInsecureHttp,
        timeoutSeconds: clampInt(input?.timeoutSeconds, 5, 600, 30),
      }),

    "webdav.connect": async (_input, context) => {
      await context.settings.patchWebDav({ enabled: true });
      await context.reconfigureSync();
      await context.sync.syncNow();
      return context.sync.currentStatus;
    },

    "webdav.disconnect": async (_input, context) => {
      await context.sync.disconnect();
      return context.sync.currentStatus;
    },

    "webdav.syncNow": async (_input, context) => {
      await context.sync.syncNow();
      return context.sync.currentStatus;
    },

    "webdav.status": async (_input, context) => ({
      status: context.sync.currentStatus,
      pending: await context.sync.pendingCount(),
    }),

    "webdav.fetchAttachment": async (input, context) =>
      await context.sync.fetchAttachment(asString(input, "hash", 128)),

    "webdav.resetRemoteState": async (_input, context) => {
      await context.sync.resetRemoteState();
      return { ok: true };
    },

    "webdav.rebuildRemote": async (input, context) => {
      if (input?.confirm !== "rebuild") {
        throw new Error(
          "Rebuilding the remote repository requires explicit confirmation",
        );
      }
      const generation = await context.sync.rebuildRemote();
      return { generation };
    },

    // ---------------- backups ----------------

    "backup.getSettings": (_input, context) => context.settings.get("backup"),

    "backup.setSettings": async (input, context) => {
      const current = context.settings.get("backup");
      const localDirectory = optionalString(input?.localDirectory);
      await context.settings.patchBackup({
        localEnabled: boolOr(input?.localEnabled, current.localEnabled),
        localDirectory: localDirectory ?? current.localDirectory,
        webdavEnabled: boolOr(input?.webdavEnabled, current.webdavEnabled),
        webdavDirectory: optionalString(input?.webdavDirectory) ??
          current.webdavDirectory,
        interval:
          ["manual", "daily", "weekly", "monthly"].includes(input?.interval)
            ? input.interval
            : current.interval,
        retention: clampInt(input?.retention, 0, 1000, current.retention),
        backupBeforeRestore: boolOr(
          input?.backupBeforeRestore,
          current.backupBeforeRestore,
        ),
        backupBeforeMaintenance: boolOr(
          input?.backupBeforeMaintenance,
          current.backupBeforeMaintenance,
        ),
      });
      context.refreshAllowedRoots();
      return context.settings.get("backup");
    },

    "backup.createNow": async (input, context) => {
      const targets = Array.isArray(input?.targets)
        ? input.targets.filter((t: unknown) => t === "local" || t === "webdav")
        : undefined;
      const result = await context.backups.createNow({ targets });
      return {
        name: result.name,
        written: result.written,
        counts: result.manifest.counts,
        attachments: result.manifest.attachments,
      };
    },

    "backup.list": async (input, context) =>
      await context.backups.list(
        input?.target === "webdav" ? "webdav" : "local",
      ),

    "backup.selectLocalDirectory": async (_input, context) => {
      const directory = await context.dialogs.selectDirectory({
        title: "Choose a folder for backups",
      });
      if (!directory) return undefined;
      await context.settings.patchBackup({ localDirectory: directory });
      context.refreshAllowedRoots();
      return directory;
    },

    "backup.importFile": async (_input, context) => {
      const picked = await context.dialogs.selectFile({
        title: "Choose a backup file",
        extensions: ["enc", "nnbackup", "nnbackupz", "json"],
      });
      // Picking through the native dialog is the capability grant that lets
      // backup.restore read this one file from outside the app directories.
      if (picked) context.backups.grantFile(picked);
      return picked;
    },

    "backup.restore": async (input, context) => {
      if (input?.confirm !== "restore") {
        throw new Error("Restoring requires explicit confirmation");
      }
      const which = input?.target === "webdav"
        ? "webdav"
        : input?.target === "file"
        ? "file"
        : "local";
      return await context.backups.restore(
        which,
        asString(input, "name", 4096),
        (progress) => context.emit("backup.completed", progress),
      );
    },

    // ---------------- the assistant endpoint (MCP) ----------------

    "mcp.getSettings": (_input, context) => context.settings.get("mcp"),

    "mcp.setSettings": async (input, context) => {
      const current = context.settings.get("mcp");
      const port = input?.port === undefined
        ? current.port
        : asPort(input.port);
      await context.settings.patchMcp({
        enabled: input?.enabled === undefined
          ? current.enabled
          : !!input.enabled,
        port,
        allowWrites: input?.allowWrites === undefined
          ? current.allowWrites
          : !!input.allowWrites,
      });
      await context.applyMcpSettings();
      return context.mcp.status();
    },

    "mcp.status": (_input, context) => context.mcp.status(),

    /**
     * The snippet a user pastes into their MCP client. The token is in it,
     * which is the point — it is shown once the user asks for it, in the
     * settings screen, and nowhere else.
     */
    "mcp.clientConfig": (_input, context) => {
      const status = context.mcp.status();
      if (!status.listening || !status.url) {
        return { listening: false };
      }
      const token = context.mcp.currentToken();
      return {
        listening: true,
        url: status.url,
        token,
        // Claude Code and anything else that takes a command line.
        command: `claude mcp add --transport http openotes ${status.url} ` +
          `--header "Authorization: Bearer ${token}"`,
        // The shape most desktop clients keep in a JSON config file.
        json: JSON.stringify(
          {
            mcpServers: {
              openotes: {
                type: "http",
                url: status.url,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
          null,
          2,
        ),
      };
    },

    "mcp.regenerateToken": async (_input, context) => {
      await context.regenerateMcpToken();
      return context.mcp.status();
    },
  };
}

/**
 * A TCP port the endpoint may bind. 0 means "any free port"; anything below
 * 1024 needs privileges the app does not have and should not ask for.
 */
function asPort(value: unknown): number {
  const port = typeof value === "string" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port)) {
    throw new Error("The port must be a whole number.");
  }
  if (port === 0) return 0;
  if (port < 1024 || port > 65535) {
    throw new Error(
      "Choose a port between 1024 and 65535, or 0 for any free port.",
    );
  }
  return port;
}

/** Dispatch one renderer call. Never throws; always returns an RpcResponse. */
export async function dispatch(
  request: RpcRequest,
  handlers: Record<string, Handler>,
  context: AppContext,
): Promise<RpcResponse> {
  const path = typeof request?.path === "string" ? request.path : "";

  if (!isKnownProcedure(path)) {
    log.warn("Rejected an unknown procedure", { path });
    return {
      ok: false,
      error: {
        name: "UnknownProcedure",
        message: `Unknown procedure: ${path}`,
      },
    };
  }

  const handler = handlers[path];
  if (!handler) {
    return {
      ok: false,
      error: {
        name: "NotImplemented",
        message: `Procedure ${path} has no handler`,
      },
    };
  }

  try {
    const result = await handler(request.input, context);
    return { ok: true, result: result === undefined ? null : result };
  } catch (error) {
    const name = error instanceof PathAccessError
      ? "PathAccessError"
      : error instanceof SyncError
      ? "SyncError"
      : error instanceof Error
      ? error.name
      : "Error";
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof SyncError ? error.code : undefined;
    log.warn("Procedure failed", {
      path,
      name,
      message: message.slice(0, 300),
    });
    return { ok: false, error: { name, message, code } };
  }
}

// ---------------- input validation helpers ----------------

function asString(input: any, key: string, maxLength: number): string {
  const value = typeof input === "string" ? input : input?.[key];
  if (typeof value !== "string") {
    throw new Error(`"${key}" must be a string`);
  }
  if (value.length > maxLength) {
    throw new Error(`"${key}" is too long (max ${maxLength} characters)`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Cheap check for "did this statement change the vault?". */
export function isWriteStatement(sql: unknown): boolean {
  if (typeof sql !== "string") return false;
  return /^\s*(insert|update|delete|replace|drop|alter|create)\b/i.test(sql);
}

async function compress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}
