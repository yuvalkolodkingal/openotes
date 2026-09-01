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
 * The vocabulary the three consumer-drive backends share.
 *
 * Google Drive, Microsoft Graph and Dropbox differ in almost everything
 * above the transport — path model, conditional writes, error envelopes —
 * but they are the same shape underneath: an OAuth 2.0 authorization-code
 * flow with PKCE, a one-hour bearer token, and a long-lived refresh token
 * that is the only thing worth persisting. Everything in this file is that
 * common part; anything a single provider needs belongs in its own adapter.
 */

import type { TokenManager } from "./oauth/token-manager.ts";

export type DriveProvider = "googledrive" | "onedrive" | "dropbox";

/**
 * The user's own OAuth application. Openotes ships no client credentials:
 * a desktop binary cannot keep a secret, and a shared client id would put
 * every user of the fork behind one quota and one revocable registration.
 * Each user registers an app and pastes the id in — see the per-provider
 * `registrationNotes` in oauth/endpoints.ts.
 */
export interface OAuthClient {
  provider: DriveProvider;
  clientId: string;
  /**
   * Set only for Google, whose "Desktop app" client type issues one and
   * whose token endpoint demands it even in a PKCE flow. Google documents
   * it as not confidential for installed apps. The other two providers are
   * registered as public clients and reject a secret outright, so
   * `ProviderEndpoints.requiresClientSecret` — not the presence of this
   * field — decides whether it is ever sent.
   */
  clientSecret?: string;
}

/** One token endpoint response, normalized. */
export interface TokenSet {
  accessToken: string;
  /**
   * Absent when the response did not carry one. A refresh response often
   * does not (Google, Dropbox), and the previously stored token stays
   * valid; Microsoft rotates it and always sends a new one.
   */
  refreshToken?: string;
  /** Epoch milliseconds at which the access token stops being accepted. */
  expiresAt: number;
}

/**
 * Durable storage for the refresh token — and for nothing else. The desktop
 * app implements this over its encrypted credential store; tests implement
 * it over a Map. Only the refresh token is passed through it: the access
 * token lives an hour and keeping it out of persistent storage keeps a
 * stolen app-data directory from yielding one that is still valid.
 */
export interface TokenStorage {
  /** undefined when the account was never connected, or was disconnected. */
  read(provider: DriveProvider): Promise<string | undefined>;
  write(provider: DriveProvider, refreshToken: string): Promise<void>;
  clear(provider: DriveProvider): Promise<void>;
}

/** What every drive-backed RemoteStore is constructed from. */
export interface DriveStoreOptions {
  client: OAuthClient;
  /**
   * Shared across every request the store makes, so ten parallel uploads
   * cause one token refresh between them.
   */
  tokens: TokenManager;
  /**
   * The repository root inside the provider's account, slash-separated and
   * relative to whatever root that provider gives the app (the Drive "My
   * Drive" root, the OneDrive app folder, the Dropbox app folder). Run it
   * through `normalizeDirectory` before use: it arrives as the user typed
   * it, leading slash and all.
   */
  directory: string;
  /** Milliseconds before a single HTTP request is aborted. */
  requestTimeout?: number;
  /** Retries for retryable failures (429, 5xx, network). */
  maxRetries?: number;
  /**
   * Injected so the adapter tests can run against a loopback fake server
   * instead of the real API. Defaults to the global fetch.
   */
  fetch?: typeof fetch;
}
