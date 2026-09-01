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
 * Connecting a drive account, end to end.
 *
 * Openotes has no registered OAuth application and cannot have one — a
 * registered client would make this fork a service, and its client id would
 * be the thing every user's access hung from. Instead each user registers
 * their own, which is also why a drive provider can only ever see files
 * Openotes created: the scopes are app-scoped and the app in question is
 * theirs.
 */

import {
  buildAuthorizationUrl,
  createPkceChallenge,
  createState,
  type DriveProvider,
  endpointsFor,
  type OAuthClient,
  TokenManager,
  type TokenStorage,
} from "@notesnook/sync-drive";
import { logger } from "../native/logger.ts";
import type { CredentialStore } from "../security/credentials.ts";
import type { Shell } from "../native/shell.ts";
import { listenForRedirect } from "./loopback.ts";

const log = logger.scope("oauth");

/** Refresh tokens go in the encrypted credential store, one key each. */
export function credentialTokenStorage(
  credentials: CredentialStore,
): TokenStorage {
  const key = (provider: DriveProvider) => `drive.${provider}.refreshToken`;
  return {
    read: (provider) => credentials.get(key(provider)),
    write: (provider, refreshToken) =>
      credentials.set(key(provider), refreshToken),
    clear: (provider) => credentials.set(key(provider), undefined),
  };
}

export interface ConnectOptions {
  client: OAuthClient;
  credentials: CredentialStore;
  shell: Shell;
  /** How long to wait for the person to finish signing in. */
  timeoutMs?: number;
}

export interface ConnectResult {
  provider: DriveProvider;
  label: string;
}

/**
 * Run the whole authorization-code flow and leave a usable refresh token in
 * the credential store. Throws with something the settings screen can show.
 */
export async function connectDrive(
  options: ConnectOptions,
): Promise<ConnectResult> {
  const endpoints = endpointsFor(options.client.provider);
  if (!options.client.clientId) {
    throw new Error(
      `${endpoints.label} needs the OAuth client id you registered. See the ` +
        `setup steps in the settings screen.`,
    );
  }
  if (endpoints.requiresClientSecret && !options.client.clientSecret) {
    throw new Error(
      `${endpoints.label} also needs the client secret from the same ` +
        `registration. It is not treated as confidential for an installed ` +
        `app, but the token endpoint rejects the exchange without it.`,
    );
  }

  const pkce = await createPkceChallenge();
  const state = createState();
  const listener = listenForRedirect({
    host: endpoints.loopbackHost,
    expectedState: state,
    timeoutMs: options.timeoutMs,
  });

  try {
    const url = buildAuthorizationUrl({
      client: options.client,
      redirectUri: listener.redirectUri,
      codeChallenge: pkce.challenge,
      state,
    });
    // The system browser, never the app's webview: a webview cannot be
    // trusted by the user to be showing the real provider, and it would not
    // carry an existing session either.
    await options.shell.openExternal(url);
    log.info("Waiting for the browser to finish signing in", {
      provider: options.client.provider,
    });

    const redirect = await listener.result;
    const tokens = new TokenManager({
      client: options.client,
      storage: credentialTokenStorage(options.credentials),
    });
    await tokens.exchangeCode({
      code: redirect.code,
      // Byte-identical to the one in the authorization request, which is
      // what every provider checks.
      redirectUri: listener.redirectUri,
      codeVerifier: pkce.verifier,
    });
    log.info("Drive account connected", { provider: options.client.provider });
    return { provider: options.client.provider, label: endpoints.label };
  } finally {
    await listener.close();
  }
}

/** Forget the account. The provider still has the grant until it is revoked. */
export async function disconnectDrive(
  provider: DriveProvider,
  credentials: CredentialStore,
): Promise<void> {
  await credentialTokenStorage(credentials).clear(provider);
  log.info("Drive account disconnected", { provider });
}
