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

import { assert, assertEquals } from "@std/assert";
import { WEBDAV_PRESETS, webDavPreset } from "../src/sync/webdav-presets.ts";
import { PROCEDURE_NAMES } from "../src/rpc/protocol.ts";

Deno.test("every preset points somewhere a WebDAV client can reach", () => {
  for (const preset of WEBDAV_PRESETS) {
    assert(
      preset.serverUrl.startsWith("https://"),
      `${preset.label} is not https, which the connection form refuses`,
    );
    // A trailing slash would double up against the paths the engine joins.
    assert(
      !preset.serverUrl.endsWith("/"),
      `${preset.label} has a trailing slash`,
    );
    assert(preset.usernameHint.length > 0, `${preset.label} has no username hint`);
    assert(preset.passwordHint.length > 0, `${preset.label} has no password hint`);
  }
});

Deno.test("preset ids are unique and resolvable", () => {
  const seen = new Set<string>();
  for (const preset of WEBDAV_PRESETS) {
    assert(!seen.has(preset.id), `duplicate preset id "${preset.id}"`);
    seen.add(preset.id);
    assertEquals(webDavPreset(preset.id)?.label, preset.label);
  }
  assertEquals(webDavPreset("nothing-like-this"), undefined);
});

Deno.test("the presets procedure is on the allowlist", () => {
  // Unlisted procedures are rejected before handler lookup, so the form would
  // silently show no shortcuts at all.
  assert((PROCEDURE_NAMES as readonly string[]).includes("webdav.presets"));
});
