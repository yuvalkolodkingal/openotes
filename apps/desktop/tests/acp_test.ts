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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AGENT_CATALOG,
  catalogEntry,
  isPermittedCommand,
  PERMITTED_COMMANDS,
} from "../src/acp/catalog.ts";
import { PROCEDURE_NAMES } from "../src/rpc/protocol.ts";
import { readPermissionManifest } from "./manifest.ts";
import { AcpService } from "../src/acp/service.ts";

/**
 * Launching an agent is the one place this application starts a program the
 * user did not ask the OS to start. These tests guard the two things that
 * keep that bounded: the allowlist, and the fact that the interface can only
 * name a catalog id.
 */

Deno.test("every launcher the catalog can run is permitted by the manifest", async () => {
  // The manifest is the real enforcement; the constant in catalog.ts is a
  // second copy. Drift between them would mean a launch failing at runtime
  // with a permission error no user could interpret, so it fails here first.
  const manifest = await readPermissionManifest();
  const allowed = new Set(manifest.run);

  for (const command of PERMITTED_COMMANDS) {
    assert(
      allowed.has(command),
      `catalog permits "${command}" but deno.json does not allow running it`,
    );
  }

  for (const entry of AGENT_CATALOG) {
    for (const launcher of entry.launchers) {
      assert(
        allowed.has(launcher.command),
        `${entry.name} launches "${launcher.command}", which deno.json does not allow`,
      );
    }
  }
});

Deno.test("a command with a path separator cannot smuggle in something else", () => {
  assert(isPermittedCommand("/usr/local/bin/gemini"));
  assert(isPermittedCommand("C:\\tools\\npx.cmd"));
  assert(!isPermittedCommand("/usr/local/bin/curl"));
  assert(!isPermittedCommand("../../bin/sh"));
  assert(!isPermittedCommand("sh"));
  assert(!isPermittedCommand("bash"));
});

Deno.test("the catalog covers the agents the interface offers", () => {
  const ids = AGENT_CATALOG.map((entry) => entry.id);
  for (const expected of ["claude-code", "gemini", "opencode", "codex", "antigravity"]) {
    assert(ids.includes(expected as typeof ids[number]), `missing ${expected}`);
  }
});

Deno.test("every catalog entry can actually be launched and explained", () => {
  for (const entry of AGENT_CATALOG) {
    assert(entry.launchers.length > 0, `${entry.id} has no launcher`);
    assert(entry.detect.length > 0, `${entry.id} cannot be detected`);
    assert(entry.authHint.length > 0, `${entry.id} has no auth hint`);
    for (const launcher of entry.launchers) {
      // Never a shell string: argv is an array, and the command is one word.
      assert(
        !launcher.command.includes(" "),
        `${entry.id} launcher looks like a shell string`,
      );
    }
  }
});

Deno.test("an unknown agent id resolves to nothing", () => {
  assertEquals(catalogEntry("definitely-not-an-agent"), undefined);
});

Deno.test("the acp procedures are on the allowlist", () => {
  // A procedure missing here is rejected before handler lookup, so the
  // feature would fail with a confusing "unknown procedure" instead.
  const names = new Set<string>(PROCEDURE_NAMES);
  for (const required of [
    "acp.listAgents",
    "acp.connect",
    "acp.approve",
    "acp.disconnect",
    "acp.authenticate",
    "acp.newSession",
    "acp.prompt",
    "acp.cancel",
    "acp.setMode",
    "acp.respondPermission",
    "acp.diagnostics",
    "bridge.respond",
  ]) {
    assert(names.has(required), `${required} is not on the allowlist`);
  }
});

Deno.test("connecting refuses anything that is not a catalog entry", async () => {
  // The containment argument rests on this: the renderer names an agent id and
  // the command comes from the catalog, so an id that is not in the catalog
  // must produce no launch at all.
  const service = new AcpService({
    emit: () => {},
    readNote: () => Promise.resolve(""),
    writeNote: () => Promise.resolve(),
    // Approve everything, so a refusal can only come from the id itself.
    isApproved: () => true,
  });

  for (const id of ["custom", "sh", "definitely-not-an-agent", "../../bin/sh"]) {
    const error = await assertRejects(() => service.connect(id), Error);
    assert(
      error.message.includes("Unknown agent"),
      `connect("${id}") failed for the wrong reason: ${error.message}`,
    );
  }
});
