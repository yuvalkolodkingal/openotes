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
 * The renderer <-> runtime contract.
 *
 * Upstream used Electron IPC (electron-trpc) to expose a tRPC router to the
 * renderer. Deno Desktop has no IPC: the webview calls named bindings
 * registered with `win.bind()`. To keep the ~50 renderer call sites
 * unchanged, the whole surface is still addressed by dotted procedure path
 * ("integration.showNotification"), but it now travels through exactly two
 * bindings:
 *
 *   bindings.rpc({ path, input })  — request/response, renderer -> runtime
 *   window.__nnDesktopEvent(event, payload) — runtime -> renderer, pushed
 *                                             with win.executeJs()
 *
 * The renderer therefore has *no* general filesystem, shell or network
 * capability: it can only reach the named procedures listed in
 * PROCEDURE_NAMES, each of which validates its own input.
 */

export interface RpcRequest {
  path: string;
  input?: unknown;
}

export type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string; code?: string } };

/**
 * Every procedure the renderer may call. Anything not in this list is
 * rejected before a handler is looked up, so a compromised renderer cannot
 * probe for undocumented capabilities.
 */
export const PROCEDURE_NAMES = [
  // --- window ---
  "window.maximize",
  "window.restore",
  "window.minimze", // upstream spelling, kept so the renderer is unchanged
  "window.maximized",
  "window.fullscreen",
  "window.close",
  "window.setTitle",

  // --- os integration ---
  "integration.isFlatpak",
  "integration.isSnap",
  "integration.isPortable",
  "integration.backupDirectory",
  "integration.selectBackupDirectory",
  "integration.zoomFactor",
  "integration.setZoomFactor",
  "integration.privacyMode",
  "integration.setPrivacyMode",
  "integration.desktopIntegration",
  "integration.setDesktopIntegration",
  "integration.showNotification",
  "integration.showMenu",
  "integration.openPath",
  "integration.openExternal",
  "integration.revealFile",
  "integration.restart",
  "integration.bringToFront",
  "integration.changeTheme",
  "integration.systemTheme",
  "integration.selectDirectory",
  "integration.selectFile",
  "integration.saveFile",
  "integration.readClipboard",
  "integration.writeClipboard",
  "integration.appVersion",
  "integration.about",
  "integration.openLogDirectory",
  "integration.logs",
  // Electron-era settings the interface still queries at start-up. They are
  // accepted and inert: custom DNS-over-HTTPS and proxy rules were Chromium
  // session features with no webview equivalent, and answering them beats
  // a warning in every session's log.
  "integration.customDns",
  "integration.setCustomDns",
  "integration.proxyRules",
  "integration.setProxyRules",

  // --- sqlite ---
  "sqlite.open",
  "sqlite.close",
  "sqlite.run",
  "sqlite.delete",
  "sqlite.export",

  // --- backups (streamed file writes) ---
  "backups.open",
  "backups.write",
  "backups.close",

  // --- durable renderer storage ---
  // The webview's own localStorage/IndexedDB cannot be used: the runtime
  // assigns a different port on every launch, so the page's origin changes
  // and its storage is orphaned. See native/keyvalue.ts.
  "storage.get",
  "storage.set",
  "storage.remove",
  "storage.keys",
  "storage.entries",
  "storage.clear",

  // --- attachment content (chunked, see native/attachment-store.ts) ---
  // The renderer's streamable-fs layer runs against these instead of
  // origin-scoped browser storage, for the same reason as storage.* above:
  // the webview origin changes every launch, so anything kept there is
  // orphaned on restart.
  "attachments.setMetadata",
  "attachments.getMetadata",
  "attachments.deleteMetadata",
  "attachments.writeChunk",
  "attachments.readChunk",
  "attachments.deleteChunk",
  "attachments.chunkSize",
  "attachments.listChunks",
  "attachments.list",
  "attachments.deleteFile",
  "attachments.clear",

  // --- key storage ---
  "safeStorage.isEncryptionAvailable",
  "safeStorage.encryptString",
  "safeStorage.decryptString",

  // --- compression ---
  "compress.gzip",
  "compress.gunzip",

  // --- updates ---
  "updater.check",
  "updater.download",
  "updater.install",
  "updater.autoUpdates",
  "updater.toggleAutoUpdates",
  "updater.releaseTrack",
  "updater.changeReleaseTrack",

  // --- webdav sync (new in this fork) ---
  "webdav.getConfig",
  "webdav.setConfig",
  "webdav.testConnection",
  "webdav.connect",
  "webdav.disconnect",
  "webdav.syncNow",
  "webdav.status",
  "webdav.resetRemoteState",
  "webdav.rebuildRemote",
  "webdav.setPassphrase",
  "webdav.fetchAttachment",
  // Choosing and signing in to a drive (new in 2.1). 2.0 shipped the
  // providers with nothing to reach them.
  "webdav.presets",
  "webdav.driveSetup",
  "webdav.connectDrive",
  "webdav.disconnectDrive",
  // A Postgres database as the backend (new in 2.2.1): the user's own, or
  // one Neon or Supabase creates on request.
  "webdav.sqlSetup",
  "webdav.testSql",
  "webdav.connectSql",
  "webdav.disconnectSql",
  "webdav.neonAccount",
  "webdav.provisionNeon",
  "webdav.connectSupabaseAccount",
  "webdav.supabaseAccount",
  "webdav.provisionSupabase",

  // --- backup engine (new in this fork) ---
  "backup.getSettings",
  "backup.setSettings",
  "backup.createNow",
  "backup.list",
  "backup.restore",
  "backup.selectLocalDirectory",
  "backup.importFile",

  // --- the built-in MCP endpoint for AI assistants (new in 2.1) ---
  // The other direction from acp.*: those launch an agent, these let an
  // assistant the user already runs connect to Openotes.
  "mcp.getSettings",
  "mcp.setSettings",
  "mcp.status",
  "mcp.clientConfig",
  "mcp.regenerateToken",

  // --- capabilities ---
  "capabilities.get",

  // --- AI assistant (Agent Client Protocol) ---
  // The renderer names an agent by catalog id and never a command line; the
  // command comes from apps/desktop/src/acp/catalog.ts. See AcpService for
  // why that distinction is what keeps the subprocess allowlist meaningful.
  "acp.listAgents",
  "acp.connect",
  "acp.approve",
  "acp.forgetApprovals",
  "acp.disconnect",
  "acp.authenticate",
  "acp.newSession",
  "acp.prompt",
  "acp.cancel",
  "acp.setMode",
  // A model the agent offers inside a session, switched live (new in 2.2.1).
  "acp.setModel",
  "acp.respondPermission",
  "acp.diagnostics",

  // The interface answering a request the runtime made of it.
  "bridge.respond",

  // --- lifecycle ---
  "bridge.ready",
] as const;

export type ProcedureName = (typeof PROCEDURE_NAMES)[number];

const PROCEDURE_SET: ReadonlySet<string> = new Set(PROCEDURE_NAMES);

export function isKnownProcedure(path: string): path is ProcedureName {
  return PROCEDURE_SET.has(path);
}

/** Events pushed from the runtime into the renderer. */
export const EVENT_NAMES = [
  "window.stateChanged",
  "window.close",
  "integration.themeChanged",
  "bridge.openLink",
  "updater.checking",
  "updater.available",
  "updater.notAvailable",
  "updater.downloadProgress",
  "updater.downloaded",
  "updater.error",
  "webdav.status",
  "webdav.conflict",
  "backup.completed",
  "acp.update",
  "acp.permission",
  "acp.status",
  // A request from the runtime that the interface must answer.
  "bridge.request",
  // An assistant changed a note through the MCP endpoint; the interface
  // holds its own cache of the vault and has to reload.
  "mcp.notesChanged",
  "mcp.status",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];
