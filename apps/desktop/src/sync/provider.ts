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
 * Turning the sync settings into a place to put encrypted blobs.
 *
 * Both the sync engine and the backup engine need this and they used to
 * build a WebDAV client each; now there is one function, so a provider added
 * here is a provider both of them gained.
 *
 * A note on what "Google Drive" means in this file. Two different things
 * reach the same account:
 *
 *   - "folder" points at a directory the provider's own desktop client
 *     already keeps in step with the account. Nothing here talks to Google,
 *     Microsoft or Dropbox at all — the files are written to disk and their
 *     client uploads them. It needs no OAuth registration, works with iCloud
 *     Drive and Syncthing and a NAS mount and a USB stick as well, and it is
 *     the option to reach for first.
 *   - "googledrive", "onedrive" and "dropbox" talk to the API directly, for
 *     a machine with no desktop client. They need an OAuth client the user
 *     registers themselves (Openotes has no registered application and
 *     cannot have one), and they are scoped so the app can only ever see
 *     files it created.
 */

import {
  FetchTransport,
  FolderStore,
  type RemoteStore,
  SyncError,
  toBasicAuth,
  WebDavClient,
  webDavStore,
} from "@notesnook/sync-remote";
import { isAbsolute, join } from "@std/path";
import { USER_AGENT } from "../constants.ts";
import type { SyncProvider, WebDavSettings } from "../native/settings.ts";

export interface ProviderContext {
  config: WebDavSettings;
  /** The WebDAV password, or a drive provider's OAuth client secret. */
  secret?: string;
}

/** A one-line description for the settings screen and the status bar. */
export function describeProvider(provider: SyncProvider): string {
  switch (provider) {
    case "webdav":
      return "your WebDAV server";
    case "folder":
      return "a folder on this machine";
    case "googledrive":
      return "Google Drive";
    case "onedrive":
      return "OneDrive";
    case "dropbox":
      return "Dropbox";
  }
}

/** Whether the provider needs a password or an OAuth secret to build. */
export function providerNeedsSecret(provider: SyncProvider): boolean {
  return provider === "webdav";
}

/** What the settings form must fill in before a store can be built. */
export function missingConfiguration(
  config: WebDavSettings,
): string | undefined {
  switch (config.provider) {
    case "webdav":
      if (!config.serverUrl) return "a server URL";
      if (!config.username) return "a username";
      return undefined;
    case "folder":
      if (!config.folderPath) return "a folder";
      if (!isAbsolute(config.folderPath)) {
        return "a full path to the folder, not a relative one";
      }
      return undefined;
    case "googledrive":
    case "onedrive":
    case "dropbox":
      if (!config.clientId) return "an OAuth client id";
      if (!config.connected) return "a connected account";
      return undefined;
  }
}

/**
 * Build the store the current settings describe. Throws a SyncError the
 * settings screen can show verbatim when they do not describe one yet.
 */
export function buildRemoteStore(context: ProviderContext): RemoteStore {
  const { config } = context;
  const missing = missingConfiguration(config);
  if (missing) {
    throw new SyncError(
      `Synchronization is not configured yet: it needs ${missing}.`,
      "not-found",
    );
  }

  switch (config.provider) {
    case "webdav": {
      if (!context.secret) {
        throw new SyncError(
          "The WebDAV password is not available. Unlock the vault, or " +
            "re-enter the password in Settings → Synchronization.",
          "unauthorized",
        );
      }
      const password = context.secret;
      const transport = new FetchTransport({
        getBasicAuth: () =>
          Promise.resolve(toBasicAuth(config.username, password)),
      }, (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("user-agent", USER_AGENT);
        return fetch(input, { ...init, headers });
      });
      return webDavStore(
        new WebDavClient(transport, {
          baseUrl: joinUrl(config.serverUrl, config.directory),
          requestTimeout: config.timeoutSeconds * 1000,
          maxRetries: config.maxRetries,
          allowInsecureHttp: config.allowInsecureHttp,
        }),
      );
    }

    case "folder":
      // The repository goes in a subdirectory rather than at the folder the
      // user picked: they will point this at "Google Drive" or "Dropbox"
      // itself, and writing protocol.json into the root of their drive is
      // not what anyone means by that.
      return new FolderStore({
        root: join(config.folderPath, config.directory),
        consistency: config.folderConsistency,
      });

    case "googledrive":
    case "onedrive":
    case "dropbox":
      throw new SyncError(
        `${describeProvider(config.provider)} needs this build to include ` +
          `the drive providers, which it does not. Point the "folder" ` +
          `provider at the directory ${
            describeProvider(config.provider)
          }'s desktop client keeps in step instead — it reaches the same ` +
          `account and needs no sign-in here.`,
        "protocol-mismatch",
      );
  }
}

/**
 * Join a server URL and a directory into a base URL that ends in "/".
 * Segments are encoded and "." / ".." are dropped, so a directory name from
 * the settings form cannot walk out of the configured path.
 */
export function joinUrl(base: string, directory: string): string {
  let url = base.trim();
  if (!url.endsWith("/")) url += "/";
  const clean = directory
    .split("/")
    .filter((part) => part.length > 0 && part !== "." && part !== "..")
    .map(encodeURIComponent)
    .join("/");
  return clean ? `${url}${clean}/` : url;
}
