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
 * Where each drive provider's OAuth lives, and how a stored connection turns
 * into something the sync engine can write to.
 *
 * packages/sync-files already speaks all three APIs and
 * security/oauth.ts already runs the authorization-code flow; what was
 * missing was anything that put the two together and let a user choose. This
 * is that piece.
 *
 * Openotes registers no OAuth application of its own. A registered client
 * would make this fork a service, and its client id would be the single
 * thing every user's access hung from. Each user brings their own — which is
 * also why the scopes below can be the narrow, app-scoped ones: the
 * application in question is theirs.
 */

import {
  DropboxStorage,
  GoogleDriveStorage,
  OneDriveStorage,
  type TokenProvider,
} from "@notesnook/sync-files";
import type { RemoteStorage } from "@notesnook/sync-core";
import {
  isExpired,
  type OAuthClient,
  type OAuthTokens,
  refreshTokens,
} from "../security/oauth.ts";
import { logger } from "../native/logger.ts";

const log = logger.scope("drive");

export type DriveProvider = "googledrive" | "dropbox" | "onedrive";

export const DRIVE_PROVIDERS: readonly DriveProvider[] = [
  "googledrive",
  "dropbox",
  "onedrive",
];

export function isDriveProvider(value: unknown): value is DriveProvider {
  return DRIVE_PROVIDERS.includes(value as DriveProvider);
}

export interface DriveDescription {
  label: string;
  /** Requested verbatim. Every one is scoped to files this app created. */
  scopes: string[];
  /** Whether the token endpoint needs a client secret alongside PKCE. */
  requiresClientSecret: boolean;
  /**
   * The loopback host to register. Providers all make an exception to exact
   * redirect matching for loopback so an installed app can use an ephemeral
   * port, but they do not agree on the spelling, and registering one while
   * sending the other fails with an error that names neither.
   */
  loopbackHost: string;
  /** The steps to follow in the provider's own console, for the UI. */
  registrationNotes: string[];
}

const CALLBACK_PATH = "/openotes/oauth";

/** The static half: endpoints, scopes and what to tell the user. */
export function describeDrive(provider: DriveProvider): DriveDescription {
  switch (provider) {
    case "googledrive":
      return {
        label: "Google Drive",
        // drive.file reaches only files this application created, so the
        // rest of the user's Drive stays invisible and the registration
        // needs no Google verification review.
        scopes: ["https://www.googleapis.com/auth/drive.file"],
        // Google's "Desktop app" client type issues a secret and its token
        // endpoint requires it even with PKCE, while Google's own
        // documentation says it is not treated as confidential for an
        // installed app. It looks like a mistake otherwise.
        requiresClientSecret: true,
        loopbackHost: "127.0.0.1",
        registrationNotes: [
          "Google Cloud console → APIs & Services → Enable the Google Drive API.",
          "Credentials → Create credentials → OAuth client ID → Desktop app.",
          "Copy both the client ID and the client secret.",
          `Authorized redirect URI: http://127.0.0.1${CALLBACK_PATH} — the port changes each time, which Google allows for loopback.`,
        ],
      };
    case "dropbox":
      return {
        label: "Dropbox",
        scopes: ["files.content.read", "files.content.write"],
        requiresClientSecret: false,
        loopbackHost: "localhost",
        registrationNotes: [
          "Dropbox App Console → Create app → Scoped access → App folder.",
          "Permissions tab → tick files.content.read and files.content.write → Submit.",
          "Settings tab → copy the App key. There is no secret to copy: this is a public client using PKCE.",
          `Redirect URIs → add http://localhost${CALLBACK_PATH}.`,
        ],
      };
    case "onedrive":
      return {
        label: "OneDrive",
        // The app folder, and offline_access so the connection survives the
        // hour an access token lasts.
        scopes: ["Files.ReadWrite.AppFolder", "offline_access"],
        requiresClientSecret: false,
        loopbackHost: "localhost",
        registrationNotes: [
          "Azure portal → App registrations → New registration.",
          "Supported account types: personal Microsoft accounts (and work accounts if you use one).",
          'Redirect URI → platform "Mobile and desktop applications" → ' +
          `http://localhost${CALLBACK_PATH}.`,
          "Copy the Application (client) ID. Do not create a secret: a desktop app is a public client.",
        ],
      };
  }
}

/** The OAuth client for a provider, given the registration the user made. */
export function driveClient(
  provider: DriveProvider,
  credentials: { clientId: string; clientSecret?: string },
): OAuthClient {
  const description = describeDrive(provider);
  const base = {
    clientId: credentials.clientId,
    clientSecret: description.requiresClientSecret
      ? credentials.clientSecret
      : undefined,
    scopes: description.scopes,
  };
  switch (provider) {
    case "googledrive":
      return {
        ...base,
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        authorizeParams: {
          // Without access_type=offline Google returns an access token and
          // no refresh token, and the connection dies an hour later.
          access_type: "offline",
          // Google issues the refresh token on the *first* consent only, so
          // a user reconnecting after a reinstall would otherwise get a
          // one-hour connection with no way to renew it.
          prompt: "consent",
        },
      };
    case "dropbox":
      return {
        ...base,
        authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
        tokenUrl: "https://api.dropboxapi.com/oauth2/token",
        // Dropbox returns a short-lived token and no refresh token unless
        // this is set.
        authorizeParams: { token_access_type: "offline" },
      };
    case "onedrive":
      return {
        ...base,
        authorizeUrl:
          "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      };
  }
}

export interface StoredConnection {
  /** Read the saved tokens, or undefined when the account is not connected. */
  read(): Promise<OAuthTokens | undefined>;
  /** Persist tokens after a sign-in or a refresh. */
  write(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

/**
 * A TokenProvider over a stored connection.
 *
 * Access tokens live in memory only: they last an hour, a restart costs one
 * refresh, and persisting them would widen the blast radius of a stolen app
 * data directory for nothing. Refresh tokens are written back on every
 * response that carries one — Microsoft rotates them, and dropping the new
 * one leaves the stored token invalid at the next refresh.
 */
export function driveTokenProvider(options: {
  client: OAuthClient;
  connection: StoredConnection;
  fetchFn?: typeof fetch;
}): TokenProvider {
  let cached: OAuthTokens | undefined;
  let refreshing: Promise<boolean> | undefined;

  const load = async (): Promise<OAuthTokens> => {
    cached ??= await options.connection.read();
    if (!cached) {
      throw new Error(
        "This drive is not connected. Sign in again in Settings → " +
          "Synchronization.",
      );
    }
    return cached;
  };

  const doRefresh = async (): Promise<boolean> => {
    const tokens = await load();
    if (!tokens.refreshToken) return false;
    try {
      const fresh = await refreshTokens(
        options.client,
        tokens.refreshToken,
        options.fetchFn,
      );
      cached = {
        ...fresh,
        // Providers that do not rotate omit it; keeping the old one is what
        // makes the next refresh possible.
        refreshToken: fresh.refreshToken ?? tokens.refreshToken,
      };
      await options.connection.write(cached);
      return true;
    } catch (error) {
      log.warn("Could not refresh the drive connection", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  return {
    async token() {
      const tokens = await load();
      if (isExpired(tokens)) {
        // Share one refresh between every caller that arrives while it runs,
        // so a cycle of parallel uploads does not stampede the endpoint.
        refreshing ??= doRefresh().finally(() => {
          refreshing = undefined;
        });
        if (!(await refreshing)) {
          throw new Error(
            "The drive connection expired and could not be renewed. Sign " +
              "in again in Settings → Synchronization.",
          );
        }
        return (await load()).accessToken;
      }
      return tokens.accessToken;
    },
    refresh() {
      refreshing ??= doRefresh().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
  };
}

/** The storage the sync engine writes through. */
export function driveStorage(
  provider: DriveProvider,
  tokens: TokenProvider,
  directory: string,
): RemoteStorage {
  // Each provider's own root differs — Drive's My Drive, the OneDrive and
  // Dropbox app folders — so this is a folder name, not a path.
  const root = directory.replace(/^\/+|\/+$/g, "") || "Openotes";
  switch (provider) {
    case "googledrive":
      return new GoogleDriveStorage(tokens, root);
    case "dropbox":
      return new DropboxStorage(tokens, `/${root}`);
    case "onedrive":
      return new OneDriveStorage(tokens, root);
  }
}
