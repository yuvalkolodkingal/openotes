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
  for (
    const expected of [
      "claude-code",
      "gemini",
      "opencode",
      "codex",
      "antigravity",
    ]
  ) {
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
  for (
    const required of [
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
    ]
  ) {
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

  for (
    const id of ["custom", "sh", "definitely-not-an-agent", "../../bin/sh"]
  ) {
    const error = await assertRejects(() => service.connect(id), Error);
    assert(
      error.message.includes("Unknown agent"),
      `connect("${id}") failed for the wrong reason: ${error.message}`,
    );
  }
});

Deno.test("every offered model actually changes how the agent starts", () => {
  // A picker entry that contributes neither an argument nor an environment
  // variable would look like it works and do nothing at all -- the failure
  // mode this catalog is meant to avoid, since ACP has no model selection of
  // its own to fall back on.
  for (const entry of AGENT_CATALOG) {
    for (const model of entry.models ?? []) {
      const args = model.args?.length ?? 0;
      const env = Object.keys(model.env ?? {}).length;
      assert(
        args > 0 || env > 0,
        `${entry.name} offers model "${model.id}" but passes nothing to the agent`,
      );
    }
    // Free-typed names need somewhere to go.
    if (entry.modelEnvVar !== undefined) {
      assert(
        entry.modelEnvVar.length > 0,
        `${entry.name} declares an empty model variable`,
      );
    }
  }
});

Deno.test("a model id is unique within its agent", () => {
  for (const entry of AGENT_CATALOG) {
    const seen = new Set<string>();
    for (const model of entry.models ?? []) {
      assert(
        !seen.has(model.id),
        `${entry.name} lists model id "${model.id}" twice`,
      );
      seen.add(model.id);
    }
  }
});

// ---------------------------------------------------------------------------
// Launching on Windows, where a name is not enough
// ---------------------------------------------------------------------------

import {
  npmShimEntry,
  spawnPlan,
  windowsExtensions,
} from "../src/acp/service.ts";

const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@agentclientprotocol\\claude-agent-acp\\dist\\index.js" %*',
].join("\r\n");

Deno.test("on Windows an npm shim is run as node plus its script", async () => {
  // The runtime resolves a bare name by appending .exe, so spawning
  // "claude-agent-acp" found nothing even though claude-agent-acp.cmd was
  // right there. Every npm-installed agent failed this way on Windows.
  const plan = await spawnPlan(
    "claude-agent-acp",
    [],
    "C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd",
    "windows",
    () => Promise.resolve(NPM_SHIM),
  );
  assertEquals(plan.command, "node");
  assertEquals(plan.args.length, 1);
  assert(
    plan.args[0].replace(/\\/g, "/").endsWith(
      "npm/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js",
    ),
    `unexpected script path ${plan.args[0]}`,
  );
  assert(isPermittedCommand(plan.command));
});

Deno.test("on Windows a .cmd that is not an npm shim goes through cmd.exe", async () => {
  const plan = await spawnPlan(
    "gemini",
    ["--experimental-acp"],
    "C:\\tools\\gemini.cmd",
    "windows",
    () => Promise.resolve("@echo off\r\nsomething-else.exe %*\r\n"),
  );
  assertEquals(plan.command, "cmd");
  assertEquals(plan.args, [
    "/d",
    "/c",
    "C:\\tools\\gemini.cmd",
    "--experimental-acp",
  ]);
  assert(isPermittedCommand(plan.command));
});

Deno.test("on Windows a real executable is spawned by name", async () => {
  const plan = await spawnPlan(
    "opencode",
    ["acp"],
    "C:\\tools\\opencode.exe",
    "windows",
    () => Promise.reject(new Error("must not read an .exe")),
  );
  assertEquals(plan, { command: "opencode", args: ["acp"] });
});

Deno.test("elsewhere the catalog command is spawned unchanged", async () => {
  const plan = await spawnPlan(
    "gemini",
    ["--experimental-acp"],
    "/usr/local/bin/gemini",
    "linux",
    () => Promise.reject(new Error("must not read the binary")),
  );
  assertEquals(plan, { command: "gemini", args: ["--experimental-acp"] });
});

Deno.test("a shim whose script cannot be found is not guessed at", async () => {
  assertEquals(
    await npmShimEntry(
      "C:\\x\\a.cmd",
      () => Promise.resolve("@echo off\r\nnode %*"),
    ),
    undefined,
  );
  assertEquals(
    await npmShimEntry("C:\\x\\a.cmd", () => Promise.reject(new Error("gone"))),
    undefined,
  );
});

Deno.test("Windows never looks for an extensionless file", () => {
  // npm leaves a POSIX shim named `gemini` beside `gemini.cmd`; finding the
  // former first produced a path nothing on Windows could start.
  const extensions = windowsExtensions(".COM;.EXE;.BAT;.CMD;.VBS;.JS");
  assert(!extensions.includes(""));
  assertEquals(extensions.slice(0, 3), [".exe", ".cmd", ".bat"]);
  assert(extensions.includes(".vbs"));
  assertEquals(windowsExtensions(undefined).slice(0, 2), [".exe", ".cmd"]);
});

Deno.test("the model procedure is on the allowlist alongside the mode one", () => {
  const names = new Set<string>(PROCEDURE_NAMES);
  assert(names.has("acp.setModel"));
});
