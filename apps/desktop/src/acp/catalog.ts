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

/**
 * The agents Openotes knows how to launch.
 *
 * Data, not code: adding an agent is an entry here, which covers
 * everything not listed. Nothing in this table is user-supplied — the
 * renderer picks an id, never a command line — which is what keeps the
 * subprocess allowlist meaningful.
 */

export type AgentId =
  | "claude-code"
  | "gemini"
  | "opencode"
  | "codex"
  | "antigravity";

export interface AgentCatalogEntry {
  id: AgentId;
  name: string;
  /** One line for the settings list. */
  summary: string;
  /**
   * Launchers to try in order. The first whose binary resolves on PATH wins,
   * so a globally installed agent is preferred over fetching it with npx.
   */
  launchers: { command: string; args: string[] }[];
  /**
   * Binaries that mean this agent is actually installed.
   *
   * Deliberately not the same as `launchers`: the npx fallback resolves on
   * any machine with Node, so treating a launcher as evidence reported every
   * agent as installed and pinned consent to /usr/bin/npx -- a binary that
   * can run anything, which is not what the user agreed to.
   */
  detect: string[];
  /**
   * Models this agent can be asked for, if any.
   *
   * ACP has no model selection -- no `session/set_model`, no `availableModels`
   * -- so the choice has to be made when the process starts, which is why it
   * lives in the catalog beside the launchers rather than in the protocol.
   * Two mechanisms exist in the wild and both are supported: an environment
   * variable (the Claude adapter reads ANTHROPIC_MODEL and parses no model
   * flag at all) and an argument (Gemini takes --model, and also reads
   * GEMINI_MODEL).
   *
   * Absent means this agent gets no picker. That is deliberate for the agents
   * shipped as installer shims, where the real binary's flags could not be
   * confirmed: offering a control that silently does nothing is worse than
   * offering none.
   */
  models?: AgentModel[];
  /**
   * The variable a free-typed model name is passed in, for models not listed.
   * Absent means custom names are not offered.
   */
  modelEnvVar?: string;
  /** Where to get it, shown when nothing is installed. */
  install?: { npm?: string; docs: string };
  /**
   * What signing in looks like, shown before the agent's own flow starts.
   * Openotes never handles these credentials; the agent's CLI owns them.
   */
  authHint: string;
}

/** One selectable model, and how to ask the agent for it. */
export interface AgentModel {
  id: string;
  name: string;
  /** Extra arguments appended to the launcher's own. */
  args?: string[];
  /** Environment set for the agent process. */
  env?: Record<string, string>;
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    summary: "Anthropic's agent. Uses your Claude subscription.",
    launchers: [
      // The package below installs `claude-agent-acp`; `claude-code-acp` is
      // the binary of the other adapter, @zed-industries/claude-code-acp.
      // Both are real and people have both, so both are tried.
      { command: "claude-agent-acp", args: [] },
      { command: "claude-code-acp", args: [] },
      { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] },
    ],
    detect: ["claude-agent-acp", "claude-code-acp"],
    // Aliases rather than pinned identifiers: "opus" keeps meaning the
    // current Opus, where claude-opus-4 would quietly become last year's
    // model and this list would need editing on every release.
    models: [
      { id: "opus", name: "Opus", env: { ANTHROPIC_MODEL: "opus" } },
      { id: "sonnet", name: "Sonnet", env: { ANTHROPIC_MODEL: "sonnet" } },
      { id: "haiku", name: "Haiku", env: { ANTHROPIC_MODEL: "haiku" } },
    ],
    modelEnvVar: "ANTHROPIC_MODEL",
    install: {
      npm: "@agentclientprotocol/claude-agent-acp",
      docs: "https://github.com/agentclientprotocol/claude-agent-acp",
    },
    authHint:
      "Claude Code signs in with your Claude account in a browser window. " +
      "Openotes never sees the credentials.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    summary: "Google's agent. Uses your Google account.",
    launchers: [{ command: "gemini", args: ["--experimental-acp"] }],
    detect: ["gemini"],
    // Gemini accepts --model and also reads GEMINI_MODEL; the flag is used
    // because it is the documented surface, and the variable carries a
    // free-typed name.
    models: [
      { id: "pro", name: "Pro", args: ["--model", "gemini-2.5-pro"] },
      { id: "flash", name: "Flash", args: ["--model", "gemini-2.5-flash"] },
    ],
    modelEnvVar: "GEMINI_MODEL",
    install: {
      npm: "@google/gemini-cli",
      docs: "https://github.com/google-gemini/gemini-cli",
    },
    authHint: "Gemini signs in with your Google account in a browser window. " +
      "Openotes never sees the credentials.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    summary: "Open-source agent supporting many model providers.",
    launchers: [{ command: "opencode", args: ["acp"] }],
    detect: ["opencode"],
    install: { docs: "https://opencode.ai" },
    authHint:
      "OpenCode is configured with its own CLI; whatever provider you set up " +
      "there is what Openotes will use.",
  },
  {
    id: "codex",
    name: "Codex",
    summary: "OpenAI's agent. Uses your ChatGPT subscription.",
    // Codex itself has no ACP mode: `codex acp` is not a subcommand, and
    // launching it that way printed a usage error and exited, which the
    // interface reported as "did not start". The adapter Zed maintains is the
    // ACP surface, and it is a separate binary.
    launchers: [{ command: "codex-acp", args: [] }],
    detect: ["codex-acp"],
    install: {
      npm: "@zed-industries/codex-acp",
      docs: "https://github.com/zed-industries/codex-acp",
    },
    authHint: "Codex signs in with your ChatGPT account through its own CLI. " +
      "Openotes never sees the credentials.",
  },
  {
    id: "antigravity",
    name: "Antigravity",
    summary: "Google's agent. Uses your Google account.",
    // The command-line agent is `agy`; `antigravity` is the editor, and
    // launching the editor with --acp opened a window rather than a protocol.
    launchers: [{ command: "agy", args: ["--acp"] }],
    detect: ["agy"],
    install: { docs: "https://antigravity.google" },
    authHint: "Antigravity signs in with your Google account through its own " +
      "CLI. Openotes never sees the credentials.",
  },
];

export function catalogEntry(id: string): AgentCatalogEntry | undefined {
  return AGENT_CATALOG.find((entry) => entry.id === id);
}

/**
 * Binaries the runtime is permitted to execute.
 *
 * This must stay in step with `permissions.app.run` in deno.json. It is
 * duplicated deliberately rather than derived: the manifest is the real
 * enforcement, and this list is a second check that fails loudly in tests if
 * the two drift apart, instead of a launch failing at runtime with a
 * permission error the user cannot interpret.
 */
export const PERMITTED_COMMANDS: readonly string[] = [
  "node",
  "npx",
  "deno",
  "bun",
  // Windows only: an npm-installed agent is a .cmd shim, which nothing but
  // cmd.exe can start. See spawnPlan() in service.ts for when it is used.
  "cmd",
  "claude-agent-acp",
  "claude-code-acp",
  "gemini",
  "opencode",
  "codex-acp",
  "agy",
];

export function isPermittedCommand(command: string): boolean {
  // Compare the bare name: a resolved absolute path is still the same binary,
  // but a command with a path separator must not smuggle in something else.
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  const withoutExe = base.replace(/\.(exe|cmd|bat)$/i, "");
  return PERMITTED_COMMANDS.includes(withoutExe);
}
