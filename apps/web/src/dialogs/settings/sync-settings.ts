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
 * Settings → Sync.
 *
 * Openotes has exactly one synchronization provider: a WebDAV server the user
 * owns. Everything here drives the `webdav.*` procedures in the Deno runtime
 * (apps/desktop/src/rpc/protocol.ts) through stores/webdav-store.ts; the
 * renderer holds no credentials and speaks no WebDAV itself.
 */

import { SettingsGroup } from "./types";
import {
  openConflictsDialog,
  store as webDavStore,
  useStore as useWebDavStore
} from "../../stores/webdav-store";
import { ConfirmDialog } from "../confirm";
import { showToast } from "../../utils/toast";
import { strings } from "@notesnook/intl";
import { WebDavConnectionPanel } from "./components/webdav-connection";
import { DriveConnectionPanel } from "./components/drive-connection";
import type { SyncProvider } from "../../stores/webdav-store";

/** Re-renders a setting whenever the WebDAV config or status changes. */
const onWebDavChange = (listener: (state: unknown, prev: unknown) => void) =>
  useWebDavStore.subscribe(
    (s) => [s.config, s.status, s.conflicts.length] as const,
    listener,
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }
  );

async function run(action: () => Promise<unknown>, success?: string) {
  try {
    await action();
    if (success) showToast("success", success);
  } catch (error) {
    showToast("error", error instanceof Error ? error.message : String(error));
  }
}

const isConfigured = () => !!webDavStore.get().config?.serverUrl;
const isEnabled = () => !!webDavStore.get().config?.enabled;

export const SyncSettings: SettingsGroup[] = [
  {
    key: "webdav-connection",
    section: "sync",
    header: "Synchronization",
    // The panel below refreshes the store when it mounts, which covers this
    // group and the two that follow (they render in the same section).
    settings: [
      {
        key: "sync-provider-choice",
        title: "Sync through",
        description:
          "Openotes has no cloud account and no server of its own. Notes are " +
          "encrypted on this device before they go anywhere, so whichever of " +
          "these you pick only ever holds ciphertext — even the filenames are " +
          "keyed digests.",
        keywords: [
          "provider",
          "webdav",
          "google drive",
          "dropbox",
          "onedrive",
          "sync"
        ],
        onStateChange: onWebDavChange,
        components: () => [
          {
            type: "dropdown",
            options: [
              { value: "webdav", title: "A WebDAV server you control" },
              { value: "googledrive", title: "Google Drive" },
              { value: "dropbox", title: "Dropbox" },
              { value: "onedrive", title: "OneDrive" }
            ],
            selectedOption: () =>
              webDavStore.get().config?.provider ?? "webdav",
            onSelectionChanged: (provider) =>
              run(() =>
                webDavStore
                  .get()
                  .saveConfig({ provider: provider as SyncProvider })
              )
          }
        ]
      },
      {
        key: "sync-provider",
        title: "Your WebDAV server",
        description:
          "Nextcloud, ownCloud, sabre/dav, Apache mod_dav or anything else " +
          "that speaks the protocol.",
        keywords: [
          "webdav",
          "sync",
          "server",
          "nextcloud",
          "owncloud",
          "passphrase",
          "encryption"
        ],
        isHidden: () =>
          (webDavStore.get().config?.provider ?? "webdav") !== "webdav",
        onStateChange: onWebDavChange,
        components: [{ type: "custom", component: WebDavConnectionPanel }]
      },
      {
        key: "sync-drive",
        title: "Sign in to your drive",
        description:
          "You register the application yourself, so Openotes can only ever " +
          "see the files it created and there is no shared client id for a " +
          "provider to revoke.",
        keywords: [
          "google drive",
          "dropbox",
          "onedrive",
          "oauth",
          "sign in",
          "client id"
        ],
        isHidden: () =>
          (webDavStore.get().config?.provider ?? "webdav") === "webdav",
        onStateChange: onWebDavChange,
        components: [{ type: "custom", component: DriveConnectionPanel }]
      },
      {
        key: "sync-now",
        title: "Sync now",
        description:
          "Run a synchronization cycle immediately instead of waiting for the " +
          "next scheduled one.",
        keywords: ["sync now", "force sync", "manual sync"],
        isHidden: () => !isEnabled(),
        onStateChange: onWebDavChange,
        components: [
          {
            type: "button",
            title: strings.sync(),
            variant: "secondary",
            action: () => run(() => webDavStore.syncNow())
          }
        ]
      },
      {
        key: "sync-conflicts",
        title: "Sync conflicts",
        description:
          "Items that were edited on two devices at once. Both versions were " +
          "kept; open the list to decide which one to keep.",
        keywords: ["conflict", "merge", "duplicate"],
        isHidden: () => webDavStore.get().conflicts.length === 0,
        onStateChange: onWebDavChange,
        components: [
          {
            type: "button",
            title: "Review",
            variant: "error",
            action: () => openConflictsDialog()
          }
        ]
      },
      {
        key: "sync-disconnect",
        title: "Disconnect",
        description:
          "Stop syncing on this device. The encrypted data already on the " +
          "server is left untouched, and your notes stay on this device.",
        keywords: ["disconnect", "stop sync", "sign out of server"],
        isHidden: () => !isEnabled(),
        onStateChange: onWebDavChange,
        components: [
          {
            type: "button",
            title: "Disconnect",
            variant: "errorSecondary",
            action: () =>
              ConfirmDialog.show({
                title: "Disconnect from the WebDAV server?",
                message:
                  "This device will stop syncing. Your notes stay here and " +
                  "the encrypted repository stays on the server, but the " +
                  "WebDAV password and sync passphrase stored on this device " +
                  "are deleted — you will need to enter both again to " +
                  "reconnect.",
                positiveButtonText: "Disconnect",
                negativeButtonText: strings.cancel()
              }).then((result) => {
                if (!result) return;
                return run(
                  () => webDavStore.disconnect(),
                  "Disconnected from the WebDAV server."
                );
              })
          }
        ]
      }
    ]
  },
  {
    key: "webdav-schedule",
    section: "sync",
    header: strings.advanced(),
    isHidden: () => !isConfigured(),
    onStateChange: onWebDavChange,
    settings: [
      {
        key: "sync-interval",
        title: "Sync interval",
        description:
          "How often Openotes syncs on its own. Manual syncs are always " +
          "available regardless of this setting.",
        keywords: ["interval", "schedule", "periodic", "automatic sync"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "dropdown",
            options: [
              { value: "0", title: "Only when I ask" },
              { value: "5", title: strings.minutes(5) },
              { value: "15", title: strings.minutes(15) },
              { value: "30", title: strings.minutes(30) },
              { value: "60", title: "1 hour" },
              { value: "240", title: "4 hours" },
              { value: "1440", title: "24 hours" }
            ],
            selectedOption: () =>
              String(webDavStore.get().config?.intervalMinutes ?? 15),
            onSelectionChanged: (value) =>
              run(() =>
                webDavStore.saveConfig({ intervalMinutes: parseInt(value) })
              )
          }
        ]
      },
      {
        key: "sync-on-startup",
        title: "Sync on startup",
        description: "Run one cycle as soon as the app opens.",
        keywords: ["startup", "launch", "boot"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "toggle",
            isToggled: () => !!webDavStore.get().config?.syncOnStartup,
            toggle: () =>
              run(() =>
                webDavStore.saveConfig({
                  syncOnStartup: !webDavStore.get().config?.syncOnStartup
                })
              )
          }
        ]
      },
      {
        key: "sync-after-edits",
        title: "Sync after edits",
        description:
          "Push changes shortly after you stop typing instead of waiting for " +
          "the next interval.",
        keywords: ["after edits", "debounce", "realtime"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "toggle",
            isToggled: () => !!webDavStore.get().config?.syncAfterEdits,
            toggle: () =>
              run(() =>
                webDavStore.saveConfig({
                  syncAfterEdits: !webDavStore.get().config?.syncAfterEdits
                })
              )
          }
        ]
      },
      {
        key: "sync-debounce",
        title: "Wait after the last edit",
        description:
          "Seconds of quiet before an edit-triggered sync runs. Longer means " +
          "fewer, larger uploads.",
        keywords: ["debounce", "delay", "seconds"],
        isHidden: () => !webDavStore.get().config?.syncAfterEdits,
        onStateChange: onWebDavChange,
        components: [
          {
            type: "input",
            inputType: "number",
            min: 1,
            max: 600,
            defaultValue: () => webDavStore.get().config?.debounceSeconds ?? 20,
            onChange: (value) =>
              void run(() => webDavStore.saveConfig({ debounceSeconds: value }))
          }
        ]
      },
      {
        key: "sync-on-metered",
        title: "Sync on a metered network",
        description:
          "Off by default: on a tethered or capped connection Openotes waits " +
          "for an unmetered network instead of uploading attachments over it. " +
          "Manual syncs still run.",
        keywords: ["metered", "mobile data", "tethering", "roaming"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "toggle",
            isToggled: () => !!webDavStore.get().config?.syncOnMeteredNetwork,
            toggle: () =>
              run(() =>
                webDavStore.saveConfig({
                  syncOnMeteredNetwork:
                    !webDavStore.get().config?.syncOnMeteredNetwork
                })
              )
          }
        ]
      },
      {
        key: "sync-attachments",
        title: "Sync attachments",
        description:
          "Upload attachment files alongside your notes. With this off, notes " +
          "still sync and attachments stay on the device that created them.",
        keywords: ["attachments", "files", "images"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "toggle",
            isToggled: () => !!webDavStore.get().config?.syncAttachments,
            toggle: () =>
              run(() =>
                webDavStore.saveConfig({
                  syncAttachments: !webDavStore.get().config?.syncAttachments
                })
              )
          }
        ]
      },
      {
        key: "sync-timeout",
        title: "Request timeout",
        description:
          "Seconds to wait for the server before giving up on a request.",
        keywords: ["timeout", "slow server"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "input",
            inputType: "number",
            min: 5,
            max: 600,
            defaultValue: () => webDavStore.get().config?.timeoutSeconds ?? 30,
            onChange: (value) =>
              void run(() => webDavStore.saveConfig({ timeoutSeconds: value }))
          }
        ]
      },
      {
        key: "sync-retries",
        title: "Retries",
        description:
          "How many times a failed request is retried, with a growing delay " +
          "between attempts, before the cycle reports an error.",
        keywords: ["retry", "retries", "backoff"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "input",
            inputType: "number",
            min: 0,
            max: 10,
            defaultValue: () => webDavStore.get().config?.maxRetries ?? 3,
            onChange: (value) =>
              void run(() => webDavStore.saveConfig({ maxRetries: value }))
          }
        ]
      },
      {
        key: "sync-allow-http",
        title: "Allow plain HTTP",
        description:
          "**Off by default, and it should stay off.** Without TLS anyone on " +
          "the network can read and alter the traffic. Your notes remain " +
          "encrypted, but the server address, your username and your WebDAV " +
          "password are exposed. Only enable this for a server on a network " +
          "you control.",
        keywords: ["http", "insecure", "tls", "ssl", "self-hosted", "lan"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "toggle",
            isToggled: () => !!webDavStore.get().config?.allowInsecureHttp,
            toggle: async () => {
              const enabled = !!webDavStore.get().config?.allowInsecureHttp;
              if (enabled)
                return run(() =>
                  webDavStore.saveConfig({ allowInsecureHttp: false })
                );

              const result = await ConfirmDialog.show({
                title: "Allow unencrypted connections?",
                message:
                  "Traffic to an http:// server is not protected in transit. " +
                  "Your notes are encrypted before upload, but your WebDAV " +
                  "password, the server address and everything about when and " +
                  "how much you sync travel in the clear, and an attacker on " +
                  "the same network can modify the responses.",
                checks: {
                  accept: {
                    text: "I understand the risk and control this network",
                    default: false
                  }
                },
                positiveButtonText: strings.continue(),
                negativeButtonText: strings.cancel()
              });
              if (!result || !result.checks?.accept) return;
              return run(() =>
                webDavStore.saveConfig({ allowInsecureHttp: true })
              );
            }
          }
        ]
      },
      {
        key: "sync-store-credentials",
        title: "Remember the password without unlocking",
        description:
          "Store the WebDAV password with a machine key so background syncs " +
          "work before the vault is unlocked. Turn it off to require an unlock " +
          "first, at the cost of no unattended sync.",
        keywords: ["credentials", "keychain", "machine key", "unattended"],
        onStateChange: onWebDavChange,
        components: [
          {
            type: "toggle",
            isToggled: () =>
              !!webDavStore.get().config?.storeCredentialsWithMachineKey,
            toggle: () =>
              run(() =>
                webDavStore.saveConfig({
                  storeCredentialsWithMachineKey:
                    !webDavStore.get().config?.storeCredentialsWithMachineKey
                })
              )
          }
        ]
      }
    ]
  },
  {
    key: "webdav-danger",
    section: "sync",
    header: "Danger zone",
    isHidden: () => !isConfigured(),
    onStateChange: onWebDavChange,
    settings: [
      {
        key: "sync-reset-remote-state",
        title: "Reset remote sync state",
        description:
          "Forget which remote changes this device has already applied, so " +
          "the next sync re-reads the whole repository. Nothing is deleted " +
          "and nothing is uploaded — use this when a device is stuck or has " +
          "fallen out of step.",
        keywords: ["reset", "cursor", "stuck", "re-read", "resync"],
        components: [
          {
            type: "button",
            title: strings.reset(),
            variant: "errorSecondary",
            action: () =>
              ConfirmDialog.show({
                title: "Reset remote sync state?",
                message:
                  "The next sync will read every record on the server again. " +
                  "This can take a while on a large repository, but it does " +
                  "not delete or overwrite anything.",
                positiveButtonText: strings.continue(),
                negativeButtonText: strings.cancel()
              }).then((result) => {
                if (!result) return;
                return run(
                  () => webDavStore.resetRemoteState(),
                  "Remote sync state was reset. The next sync will start from scratch."
                );
              })
          }
        ]
      },
      {
        key: "sync-rebuild-remote",
        title: "Rebuild WebDAV repository",
        description:
          "**Destructive.** Discards the repository on the server and writes " +
          "a fresh one from the data on *this* device. Anything that only " +
          "exists on another device and has not reached this one yet is lost, " +
          "and every other device has to reconnect and re-download " +
          "everything. Use it only when the remote repository is corrupt.",
        keywords: ["rebuild", "corrupt", "repair", "reinitialize", "wipe"],
        components: [
          {
            type: "button",
            title: "Rebuild",
            variant: "error",
            action: async () => {
              const result = await ConfirmDialog.show({
                title: "Rebuild the remote repository?",
                message:
                  "The encrypted repository on the server will be replaced by " +
                  "a new one built from this device's data.\n\n" +
                  "- Changes made on other devices that have not synced to " +
                  "this device yet **will be lost**.\n" +
                  "- Every other device must reconnect and download the " +
                  "repository again.\n" +
                  "- Take a backup first if you are not certain.",
                warnings: ["This cannot be undone."],
                checks: {
                  accept: {
                    text: "I understand this replaces the remote data",
                    default: false
                  }
                },
                inputs: {
                  confirm: {
                    title: 'Type "rebuild" to confirm',
                    required: true
                  }
                },
                positiveButtonText: "Rebuild repository",
                negativeButtonText: strings.cancel()
              });
              if (!result || !result.checks?.accept) return;
              if (result.inputs?.confirm?.trim().toLowerCase() !== "rebuild") {
                showToast("error", 'Type "rebuild" to confirm.');
                return;
              }
              await run(async () => {
                const { generation } = await webDavStore.rebuildRemote();
                showToast(
                  "success",
                  `The remote repository was rebuilt (generation ${generation}).`
                );
              });
            }
          }
        ]
      }
    ]
  }
];
