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
 * The small surface the renderer shares with the runtime.
 *
 * This is the *only* module in apps/desktop that apps/web imports. It holds
 * types and constants, never behaviour: everything the renderer can
 * actually do goes through the procedure allowlist in rpc/protocol.ts.
 *
 * Upstream's equivalent re-exported the Electron main process's tRPC router
 * type, which dragged Electron's types into the renderer's build. Keeping
 * this to plain data means the renderer's build has no dependency on the
 * runtime's implementation at all.
 */

/** Desktop integration preferences, as stored and as the settings UI edits them. */
export interface DesktopIntegration {
  autoStart: boolean;
  startMinimized: boolean;
  minimizeToSystemTray: boolean;
  closeToSystemTray: boolean;
  nativeTitlebar: boolean;
}

/** Default locations, relative to the directories the runtime resolves. */
export const PATHS = {
  backupsDirectory: "documents/Openotes/backups",
  logsDirectory: "logs/",
} as const;

/** Sync status, mirrored from @notesnook/sync-webdav for the status indicator. */
export type SyncStatusType =
  | "synced"
  | "syncing"
  | "offline"
  | "pending"
  | "error"
  | "conflict"
  | "disabled";

/** What `capabilities.get` returns. No subscription tiers exist in this fork. */
export interface Capabilities {
  allLocalFeatures: boolean;
  syncProvider: "webdav";
  cloudAccountRequired: false;
}

export type { EventName, ProcedureName } from "./rpc/protocol.ts";
