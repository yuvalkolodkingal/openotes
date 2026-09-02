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
 * Drives the real AcpService under the *shipped* permission set.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS
 *
 * `apps/desktop/tests/acp_test.ts` and `packages/acp/tests/` run under
 * `deno test -A`. Everything about the assistant worked under -A. What did
 * not work was the application as shipped, which runs under
 * `permissions.app` — and the entire class of defect that kept the feature
 * broken from 2.0.0 through 2.1.2 lives in that gap:
 *
 *   - PATH was not granted, so finding an agent threw NotCapable;
 *   - the run allowlist is bound to binaries present on PATH at startup, so
 *     a resolvable name is not the same as a launchable one.
 *
 * Neither is visible to a test running with every permission. So this walks
 * the whole path — find, launch, handshake, session, prompt, note read —
 * with exactly the permissions the packaged binary has.
 *
 * HOW
 *
 * The allowlist only permits binaries it resolved at startup, so a fake agent
 * has to be on PATH *before* the checking process begins. This script
 * therefore runs in two parts: the outer half writes a fake agent named after
 * a real catalog entry and re-launches the inner half with PATH extended and
 * `--permission-set=app` applied; the inner half does the work.
 */

import { AcpService } from "../src/acp/service.ts";

const AGENT_ID = "gemini";
const NOTE_PATH_MARKER = "check-note.md";
const NOTE_BODY =
  "# Check note\n\nThe agent read this through fs/read_text_file.\n";

// ---------------------------------------------------------------------------
// The fake agent: a real ACP peer over stdio, scripted rather than mocked.
// ---------------------------------------------------------------------------

async function runFakeAgent(): Promise<never> {
  const encoder = new TextEncoder();
  const send = async (message: unknown) => {
    await Deno.stdout.write(encoder.encode(JSON.stringify(message) + "\n"));
  };

  let buffered = "";
  let promptId: number | string | undefined;
  const decoder = new TextDecoder();
  for await (const chunk of Deno.stdin.readable) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;

      const message = JSON.parse(line) as {
        id?: number | string;
        method?: string;
        result?: unknown;
      };
      if (message.method === "initialize") {
        await send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "fake", title: "Fake agent", version: "0" },
            authMethods: [],
          },
        });
      } else if (message.method === "session/new") {
        await send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "check-session",
            modes: {
              currentModeId: "ask",
              availableModes: [
                { id: "ask", name: "Ask" },
                { id: "code", name: "Code" },
              ],
            },
          },
        });
      } else if (message.method === "session/prompt") {
        // Remember which id to answer. Request ids start at 0 and the client
        // is free to choose them, so assuming one here answers the wrong
        // request and the turn never settles.
        promptId = message.id;
        // Ask the client for a note, the way a real agent would, then report
        // what came back so the caller can tell a real read from a stub.
        await send({
          jsonrpc: "2.0",
          id: 9001,
          method: "fs/read_text_file",
          params: { sessionId: "check-session", path: NOTE_PATH_MARKER },
        });
      } else if (message.id === 9001) {
        const content = (message.result as { content?: string })?.content ?? "";
        await send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "check-session",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `READ:${content.length}` },
            },
          },
        });
        await send({
          jsonrpc: "2.0",
          id: promptId,
          result: { stopReason: "end_turn" },
        });
      }
    }
  }
  Deno.exit(0);
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

const results: { ok: boolean; label: string; detail: string }[] = [];
function record(ok: boolean, label: string, detail: string) {
  results.push({ ok, label, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: ${detail}`);
}

async function runChecks(): Promise<number> {
  console.log("Checking the ACP path under the shipped permission set\n");

  // 1. PATH is readable at all. Under the manifest this threw NotCapable,
  //    which is what made every agent invisible.
  let pathReadable = false;
  try {
    pathReadable = (Deno.env.get("PATH") ?? "").length > 0;
  } catch { /* denied */ }
  record(
    pathReadable,
    "PATH is readable under the manifest",
    pathReadable ? "granted" : "denied — permissions.app.env is missing PATH",
  );

  const updates: string[] = [];
  let readPath: string | undefined;
  const service = new AcpService({
    emit: (event, payload) => {
      if (event !== "acp.update") return;
      const update = (payload as { update?: { content?: { text?: string } } })
        .update;
      if (update?.content?.text) updates.push(update.content.text);
    },
    readNote: (_sessionId, path) => {
      readPath = path;
      return Promise.resolve(NOTE_BODY);
    },
    writeNote: () => Promise.resolve(),
    // Consent is a user decision; this stands in for one already given.
    isApproved: () => true,
  });

  // 2. The agent is found and reported launchable.
  const listed = await service.listAgents();
  const agent = listed.find((a) => a.id === AGENT_ID);
  record(
    agent?.installed === true,
    "the agent is found and launchable",
    agent?.installed
      ? `resolved ${agent.resolvedPath}`
      : `not launchable: ${agent?.error ?? "not found"}`,
  );

  // 3. It actually starts and completes a handshake.
  let connected = false;
  try {
    const report = await service.connect(AGENT_ID);
    connected = report.connected || report.agentTitle !== undefined;
    record(
      true,
      "the agent launches and completes the handshake",
      `agent reported itself as ${report.agentTitle ?? "(unnamed)"}`,
    );
  } catch (e) {
    record(
      false,
      "the agent launches and completes the handshake",
      e instanceof Error ? e.message.split("\n")[0] : String(e),
    );
  }

  if (connected) {
    // 4. A session starts, and its modes survive rather than being discarded.
    let sessionId: string | undefined;
    try {
      const session = await service.newSession(AGENT_ID);
      sessionId = session.sessionId;
      record(
        (session.modes?.availableModes.length ?? 0) > 0,
        "the session keeps the agent's modes",
        `${session.modes?.availableModes.length ?? 0} modes, workspace ${
          session.workspace ? "provided" : "MISSING"
        }`,
      );
    } catch (e) {
      record(
        false,
        "a session starts",
        e instanceof Error ? e.message.split("\n")[0] : String(e),
      );
    }

    // 5. A turn completes, and the agent's note read reaches the client.
    if (sessionId) {
      try {
        const result = await service.prompt(AGENT_ID, sessionId, [
          { type: "text", text: "read the note" },
        ]);
        const sawRead = updates.some((u) => u.startsWith("READ:")) &&
          readPath === NOTE_PATH_MARKER;
        record(
          result.stopReason === "end_turn" && sawRead,
          "a turn completes and the agent can read a note",
          `stopReason ${result.stopReason}; fs/read_text_file asked for ${
            readPath ?? "nothing"
          }`,
        );
      } catch (e) {
        record(
          false,
          "a turn completes and the agent can read a note",
          e instanceof Error ? e.message.split("\n")[0] : String(e),
        );
      }
    }
  }

  await service.stop();

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "OK" : "FAILED"} — ${
      results.length - failed.length
    }/${results.length} checks passed`,
  );
  return failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry: outer half sets the stage, inner half runs the checks.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  if (Deno.args.includes("--agent")) {
    await runFakeAgent();
  } else if (Deno.args.includes("--inner")) {
    Deno.exit(await runChecks());
  } else {
    // Outer half. Runs with whatever permissions it was given; its only job
    // is to put a fake agent on PATH and start the inner half under the
    // manifest, because the run allowlist binds to what is on PATH at start.
    const stage = await Deno.makeTempDir({ prefix: "openotes-acp-check-" });
    const self = new URL(import.meta.url).pathname;
    const shim = `${stage}/${AGENT_ID}`;
    await Deno.writeTextFile(
      shim,
      `#!/bin/sh\nexec "${Deno.execPath()}" run -A "${self}" --agent\n`,
    );
    await Deno.chmod(shim, 0o755);

    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--permission-set=app", self, "--inner"],
      env: { PATH: `${stage}:${Deno.env.get("PATH") ?? ""}` },
      cwd: new URL("../../../", import.meta.url).pathname,
    }).spawn();
    const status = await child.status;
    await Deno.remove(stage, { recursive: true }).catch(() => {});
    Deno.exit(status.code);
  }
}
