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
 * The synchronization indicator.
 *
 * Upstream drove this from core's cloud syncer. Openotes has no cloud, so it
 * is driven by the runtime instead: the `webdav.status` event pushes every
 * change, and the `webdav.status` procedure fills in the state on start-up
 * (the store owns both — see stores/webdav-store.ts).
 *
 * The six states are the ones the spec names: Synced, Syncing, Offline,
 * Pending changes, Sync error and Conflict, with a seventh, Sync off, for a
 * WebDAV server that has not been configured. Clicking runs a sync, except
 * in the two states where a sync is not the answer: unconfigured opens the
 * settings panel, a conflict opens the conflict list.
 */

import { Button, Flex, Text } from "@theme-ui/components";
import { getTimeAgo } from "@notesnook/common";
import { Alert, Icon, Sync, SyncError, SyncOff } from "../icons";
import {
  useStore as useWebDavStore,
  store as webDavStore,
  openConflictsDialog
} from "../../stores/webdav-store";
// Aliased: the component below is also called WebDavSyncStatus.
import type {
  SyncProvider,
  WebDavSyncStatus as SyncStatusValue
} from "../../stores/webdav-store";
import { WEBDAV_SETTINGS_SECTION } from "../../dialogs/settings/types";
import { showToast } from "../../utils/toast";
import { strings } from "@notesnook/intl";

/**
 * Loaded on demand. The settings dialog pulls in the WebDAV settings panel,
 * which renders the status pill from this module — importing it eagerly would
 * close that cycle at module-evaluation time.
 */
async function openSyncSettings() {
  const { SettingsDialog } = await import("../../dialogs/settings");
  await SettingsDialog.show({ activeSection: WEBDAV_SETTINGS_SECTION });
}

type Appearance = {
  key: string;
  icon: Icon;
  label: string;
  tooltip: string;
  iconColor?: string;
  spinning?: boolean;
};

// Sync-status colors are a RESERVED vocabulary from the design system, not
// decoration — they match the README's indicator table one-to-one and may
// never be reused for anything else:
//
//   synced   → teal   (the theme `accent`, which the rebrand made teal)
//   syncing  → blue   var(--on-syncing)
//   offline  → gray   var(--on-offline)
//   pending  → gray   var(--on-pending)
//   error    → red    var(--icon-error)
//   conflict → amber  var(--on-conflict)  (a conflict is NOT an error)
//
// The four non-theme colours are custom properties defined per colour scheme
// in app.css. They were literals until 2.1, which meant the light-mode blue
// and amber were also drawn on the dark status bar, at 2.9:1 and 3.4:1.
//
// "Offline is gray, not red: working offline is a normal, supported state of
// the product, and the palette must say so." A conflict is amber, not red,
// for the same reason: both versions were safely kept, nothing failed.
/**
 * What to call the thing notes go to. The status bar is the one place a user
 * looks to find out whether sync is working, so it should name what they
 * actually configured rather than a protocol they may never have chosen.
 */
export function describeProvider(provider?: SyncProvider): string {
  switch (provider) {
    case "googledrive":
      return "Google Drive";
    case "onedrive":
      return "OneDrive";
    case "dropbox":
      return "Dropbox";
    case "neon":
      return "Neon";
    case "supabase":
      return "Supabase";
    case "postgres":
      return "your database";
    default:
      return "your WebDAV server";
  }
}

export function describeSyncStatus(
  status: SyncStatusValue,
  conflicts: number,
  provider?: SyncProvider
): Appearance {
  const target = describeProvider(provider);
  // A recorded conflict outranks whatever the last cycle reported: an
  // otherwise "synced" repository with an unreviewed conflict must not look
  // like everything is fine.
  if (conflicts > 0 && status.type !== "syncing")
    return {
      key: "conflict",
      icon: Alert,
      iconColor: "var(--on-conflict)",
      label: conflicts === 1 ? "Conflict" : `${conflicts} conflicts`,
      tooltip:
        "Both versions of an item were kept. Click to review the conflicts."
    };

  switch (status.type) {
    case "synced":
      return {
        key: "synced",
        icon: Sync,
        iconColor: "accent",
        label: strings.synced(),
        tooltip: status.at
          ? `All changes are synced (${getTimeAgo(status.at, "en_short", {
              minInterval: 1000
            })}). Click to sync now.`
          : "All changes are synced. Click to sync now."
      };
    case "syncing":
      return {
        key: "syncing",
        icon: Sync,
        iconColor: "var(--on-syncing)",
        spinning: true,
        label: status.progress
          ? `${strings.syncing()} ${status.progress.done}/${
              status.progress.total
            }`
          : strings.syncing(),
        tooltip: `Syncing with ${target}...`
      };
    case "offline":
      return {
        key: "offline",
        icon: SyncOff,
        iconColor: "var(--on-offline)",
        label: strings.offline(),
        tooltip:
          `${target[0].toUpperCase()}${
            target.slice(1)
          } cannot be reached. Changes are kept on this device and will sync when it is back.`
      };
    case "pending":
      return {
        key: "pending",
        icon: Sync,
        iconColor: "var(--on-pending)",
        label:
          status.count > 0 ? `${status.count} pending` : "Pending changes",
        tooltip: "There are local changes waiting to sync. Click to sync now."
      };
    case "error":
      return {
        key: "error",
        icon: SyncError,
        iconColor: "var(--icon-error)",
        label: strings.syncFailed(),
        tooltip: `${status.error} Click to try again.`
      };
    case "conflict":
      return {
        key: "conflict",
        icon: Alert,
        iconColor: "var(--on-conflict)",
        label: status.count === 1 ? "Conflict" : `${status.count} conflicts`,
        tooltip:
          "Both versions of an item were kept. Click to review the conflicts."
      };
    case "disabled":
    default:
      return {
        key: "disabled",
        icon: SyncOff,
        iconColor: "var(--icon-disabled)",
        label: "Sync off",
        tooltip:
          "Synchronization is not set up. Click to configure it."
      };
  }
}

async function onIndicatorClick(status: SyncStatusValue, conflicts: number) {
  if (conflicts > 0 || status.type === "conflict")
    return void openConflictsDialog();
  if (status.type === "disabled" || !webDavStore.get().config?.enabled)
    return void openSyncSettings();
  try {
    await webDavStore.syncNow();
  } catch (error) {
    showToast("error", error instanceof Error ? error.message : String(error));
  }
}

/** The status-bar button. Icon only, with everything else in the tooltip. */
export function WebDavSyncStatus() {
  const status = useWebDavStore((store) => store.status);
  const conflicts = useWebDavStore((store) => store.conflicts.length);
  const provider = useWebDavStore((store) => store.config?.provider);
  const appearance = describeSyncStatus(status, conflicts, provider);

  return (
    <Button
      variant="statusitem"
      onClick={() => onIndicatorClick(status, conflicts)}
      sx={{
        alignItems: "center",
        justifyContent: "center",
        display: "flex",
        color: "paragraph",
        height: "100%"
      }}
      title={appearance.tooltip}
      data-test-id={`sync-status-${appearance.key}`}
    >
      <appearance.icon
        size={12}
        rotate={appearance.spinning}
        rotateDirection="counterclockwise"
        color={appearance.iconColor}
      />
      <Text variant="subBody" ml={1} sx={{ color: "paragraph" }}>
        {appearance.label}
      </Text>
    </Button>
  );
}

/**
 * The same state, spelled out, for the settings panel: there the user is
 * looking straight at the sync configuration and a bare icon is not enough.
 */
export function WebDavStatusPill() {
  const status = useWebDavStore((store) => store.status);
  const conflicts = useWebDavStore((store) => store.conflicts.length);
  const provider = useWebDavStore((store) => store.config?.provider);
  const appearance = describeSyncStatus(status, conflicts, provider);

  return (
    <Flex
      sx={{
        alignItems: "center",
        gap: 1,
        alignSelf: "start",
        px: 2,
        py: 1,
        borderRadius: "default",
        bg: "background-secondary",
        border: "1px solid var(--border)"
      }}
      data-test-id={`webdav-status-${appearance.key}`}
    >
      <appearance.icon
        size={14}
        rotate={appearance.spinning}
        rotateDirection="counterclockwise"
        color={appearance.iconColor}
      />
      <Text variant="body" sx={{ color: "heading" }}>
        {appearance.label}
      </Text>
      <Text variant="subBody">{appearance.tooltip}</Text>
    </Flex>
  );
}
