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
 * Fork identity.
 *
 * This is a fork, not an official Notesnook build. The name, identifier,
 * data directory, update endpoint and user agent are all distinct from
 * upstream so a user can never mistake one for the other, and so this app
 * never contacts Notesnook-operated infrastructure. See NOTICE and
 * UPSTREAM.md for attribution.
 */

/** Display name shown in windows, menus and packages. */
export const APP_NAME = "Openotes";

/** Lowercase name used for executables, packages and XDG directories. */
export const APP_ID = "openotes";

/** Reverse-DNS bundle identifier. */
export const APP_IDENTIFIER = "org.openotes.Openotes";

/** Fork version (semver). Kept in sync with deno.json by the build script. */
export const APP_VERSION = "2.1.1";

/** Upstream revision this fork is based on, for Help -> About. */
export const UPSTREAM_BASE = "streetwriters/notesnook v3.4.7";

/** WebDAV sync protocol version implemented by this build. */
export const SYNC_PROTOCOL_VERSION = 1;

/** The fork's own release repository. Never a Notesnook endpoint. */
export const RELEASE_REPOSITORY = "yuvalkolodkingal/notesnook";
export const RELEASE_BASE_URL =
  "https://github.com/yuvalkolodkingal/notesnook/releases";
export const UPDATE_MANIFEST_URL =
  "https://github.com/yuvalkolodkingal/notesnook/releases/latest/download/latest.json";

/** Sent on outbound WebDAV/update requests. Identifies the fork, not Notesnook. */
export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (+${RELEASE_BASE_URL})`;

/** Custom URL scheme registered with the OS for deep links. */
export const DEEP_LINK_SCHEME = "openotes";

/**
 * Telemetry is off and has no endpoint. The constant exists so a reviewer
 * can grep for it and see there is nothing to configure.
 */
export const TELEMETRY_ENABLED = false as const;
