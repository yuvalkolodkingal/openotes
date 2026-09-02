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
 * Providers reached through WebDAV rather than through an API of their own.
 *
 * Koofr and pCloud were both on the list of drives to support, and both
 * publish a WebDAV endpoint. Writing a second API client for each would have
 * meant two more sets of create-if-absent and compare-and-swap semantics to
 * get right, against a backend that already has them and a real integration
 * suite behind it. So they are presets: the same tested code path, with the
 * server URL and the account rules filled in.
 *
 * This is data, not code. A preset only fills the form in; the user can still
 * type any server, and nothing here is required to sync.
 */

export interface WebDavPreset {
  id: string;
  label: string;
  serverUrl: string;
  /** What to type in the username box. */
  usernameHint: string;
  /**
   * What to type in the password box. Named separately because getting this
   * wrong is the usual reason a WebDAV connection fails: several providers
   * refuse the account password and want a generated one.
   */
  passwordHint: string;
  /** Where to get that password, when it is not the account one. */
  setupUrl?: string;
}

export const WEBDAV_PRESETS: readonly WebDavPreset[] = [
  {
    id: "koofr",
    label: "Koofr",
    serverUrl: "https://app.koofr.net/dav/Koofr",
    usernameHint: "Your Koofr email address",
    passwordHint:
      "A Koofr app password — the account password is refused by this endpoint",
    setupUrl: "https://app.koofr.net/app/admin/preferences/password",
  },
  {
    id: "pcloud",
    label: "pCloud (US)",
    serverUrl: "https://webdav.pcloud.com",
    usernameHint: "Your pCloud email address",
    passwordHint: "Your pCloud password",
  },
  {
    id: "pcloud-eu",
    label: "pCloud (EU)",
    // pCloud keeps EU accounts on a separate host, and the US host simply
    // rejects them rather than redirecting, so both are offered.
    serverUrl: "https://ewebdav.pcloud.com",
    usernameHint: "Your pCloud email address",
    passwordHint: "Your pCloud password",
  },
  {
    id: "nextcloud",
    label: "Nextcloud / ownCloud",
    serverUrl: "https://cloud.example.com/remote.php/dav/files/USERNAME",
    usernameHint: "Your Nextcloud username",
    passwordHint:
      "An app password from Settings → Security, if you use two-factor",
  },
];

export function webDavPreset(id: string): WebDavPreset | undefined {
  return WEBDAV_PRESETS.find((preset) => preset.id === id);
}
