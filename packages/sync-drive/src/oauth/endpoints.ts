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
 * Where each provider's OAuth flow lives, and the per-provider quirks that
 * decide whether a connection survives past the first hour.
 *
 * Everything a provider does differently in the authorization-code flow is
 * a field in this table, so the token manager stays provider-agnostic and
 * a wrong constant is one line in one place rather than three adapters
 * disagreeing quietly.
 */

import type { DriveProvider, OAuthClient } from "../types.ts";
import { SyncError } from "@notesnook/sync-remote";

export interface ProviderEndpoints {
  /** Shown in the settings screen and in error messages. */
  label: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Requested verbatim; joined with spaces in the authorization URL. */
  scopes: readonly string[];
  /**
   * Extra authorization-request parameters. These are what make the
   * provider issue a refresh token at all, so they are not cosmetic.
   */
  authorizationParams: Readonly<Record<string, string>>;
  /**
   * Whether the token endpoint requires `client_secret` alongside PKCE. A
   * provider registered as a public client rejects the request when one is
   * sent, so this — not whether the user happens to have pasted a secret —
   * decides.
   */
  requiresClientSecret: boolean;
  /**
   * Whether a refresh response replaces the refresh token. Where it does,
   * failing to persist the new one leaves the stored token invalid and the
   * account disconnected at the next refresh.
   */
  rotatesRefreshToken: boolean;
  /**
   * The host to build the loopback redirect URI from.
   *
   * Every provider makes an exception to exact redirect-URI matching for
   * loopback so an installed app can use an ephemeral port, but they do not
   * agree on the spelling: Google documents 127.0.0.1, Microsoft and Dropbox
   * document localhost. Registering one and sending the other is rejected
   * with an error that names neither.
   */
  loopbackHost: "127.0.0.1" | "localhost";
  /** What the user has to do in the provider's console, for the UI. */
  registrationNotes: readonly string[];
}

export const OAUTH_ENDPOINTS: Readonly<
  Record<DriveProvider, ProviderEndpoints>
> = {
  googledrive: {
    label: "Google Drive",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    // drive.file grants access only to files this app itself created, so
    // the rest of the user's Drive stays invisible to Openotes and the
    // registration needs no Google verification review.
    scopes: ["https://www.googleapis.com/auth/drive.file"],
    authorizationParams: {
      // Without access_type=offline Google returns an access token and no
      // refresh token, and the connection dies an hour later.
      access_type: "offline",
      // Google issues the refresh token on the *first* consent only. A user
      // who reconnects — after a reinstall, or after clearing credentials —
      // would otherwise get a one-hour connection and no way to renew it.
      prompt: "consent",
    },
    // Google's "Desktop app" client type issues a client_secret and the
    // token endpoint rejects the exchange without it, PKCE or not. Google
    // documents that secret as not confidential for installed apps, since
    // it necessarily ships inside the binary; PKCE is what actually
    // protects the flow. This looks like a mistake in a public-client flow
    // and is not one.
    requiresClientSecret: true,
    // Google keeps the same refresh token until it is revoked or unused for
    // six months, so a refresh response usually omits it.
    rotatesRefreshToken: false,
    loopbackHost: "127.0.0.1",
    registrationNotes: [
      "Create a project at console.cloud.google.com and enable the Google " +
      "Drive API for it.",
      "Configure the OAuth consent screen as External, then add your own " +
      "Google account under Test users (an unpublished app only works for " +
      "those accounts).",
      "Create Credentials → OAuth client ID → Desktop app, and paste both " +
      "the client ID and the client secret here.",
    ],
  },
  onedrive: {
    label: "OneDrive",
    authorizationEndpoint:
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Files.ReadWrite.AppFolder confines Graph to this app's own folder;
    // offline_access is the scope that makes Microsoft issue the refresh
    // token at all, so it belongs in the request rather than in a comment.
    scopes: ["Files.ReadWrite.AppFolder", "offline_access"],
    authorizationParams: {},
    // Registered as a public client with "Allow public client flows" on.
    // Sending a client_secret from one is rejected by the token endpoint.
    requiresClientSecret: false,
    // Microsoft rotates on every refresh: the response always carries a new
    // refresh token and the one that was used stops working. Persisting it
    // every time is mandatory, not an optimization.
    rotatesRefreshToken: true,
    loopbackHost: "localhost",
    registrationNotes: [
      "Register an application at portal.azure.com → App registrations → " +
      "New registration, with supported account types set to include " +
      "personal Microsoft accounts.",
      "Under Authentication → Add a platform → Mobile and desktop " +
      "applications, add the loopback redirect URI Openotes shows you, and " +
      "turn on Allow public client flows.",
      "Paste the Application (client) ID here. Do not create a client " +
      "secret — a public client is rejected when it sends one.",
    ],
  },
  dropbox: {
    label: "Dropbox",
    authorizationEndpoint: "https://www.dropbox.com/oauth2/authorize",
    tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
    scopes: ["files.content.read", "files.content.write"],
    authorizationParams: {
      // Without token_access_type=offline Dropbox issues a short-lived
      // access token and no refresh token, and there is no way to renew it
      // without sending the user back through the browser.
      token_access_type: "offline",
    },
    // A scoped app authorizes with PKCE and no secret; the app key is the
    // client id.
    requiresClientSecret: false,
    rotatesRefreshToken: false,
    loopbackHost: "localhost",
    registrationNotes: [
      "Create an app at dropbox.com/developers/apps with Scoped access and " +
      "the App folder access type, so Openotes can only see its own folder.",
      "On the Permissions tab enable files.content.read and " +
      "files.content.write, then submit the change.",
      "Paste the App key from the Settings tab here. The app secret is not " +
      "needed: the flow uses PKCE.",
    ],
  },
};

export function endpointsFor(provider: DriveProvider): ProviderEndpoints {
  const endpoints = OAUTH_ENDPOINTS[provider];
  if (!endpoints) {
    throw new SyncError(
      `Unknown drive provider: ${JSON.stringify(provider)}`,
      "corrupt-data",
    );
  }
  return endpoints;
}

export interface AuthorizationRequest {
  client: OAuthClient;
  /** The loopback URI the provider redirects the browser back to. */
  redirectUri: string;
  /** From `createPkceChallenge`. */
  codeChallenge: string;
  /** From `createState`, and checked with `statesMatch` on the way back. */
  state: string;
}

/**
 * The URL to open in the user's browser. Built here rather than in the
 * desktop app so that a provider's "issue a refresh token, please"
 * parameters cannot be forgotten by one caller and remembered by another.
 */
export function buildAuthorizationUrl(request: AuthorizationRequest): string {
  const endpoints = endpointsFor(request.client.provider);
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set("client_id", request.client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("scope", endpoints.scopes.join(" "));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(endpoints.authorizationParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
