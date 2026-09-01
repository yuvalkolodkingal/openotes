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
 * Consumer cloud drives as sync backends.
 *
 * This package holds the parts Google Drive, OneDrive and Dropbox share —
 * the OAuth flow, the token lifecycle, the retry policy, the redirect-safe
 * HTTP client and the path helpers — plus, alongside them, the three
 * RemoteStore adapters that use them. The stores themselves implement
 * `RemoteStore` from @notesnook/sync-remote, so the sync engine, the
 * repository layout and the backup engine are untouched by which drive is
 * behind them.
 */

export * from "./types.ts";
export * from "./path.ts";
export * from "./oauth/pkce.ts";
export * from "./oauth/endpoints.ts";
export * from "./oauth/token-manager.ts";
export * from "./http/retry.ts";
export * from "./http/authorized-fetch.ts";
