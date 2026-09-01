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

import { SettingsGroup } from "./types";
import { store as aiStore, useStore as useAiStore } from "../../stores/ai-store";
import { AgentsPanel } from "./components/acp-agents";
import { desktop } from "../../common/desktop-bridge";
import { showToast } from "../../utils/toast";
import { ConfirmDialog } from "../confirm";
import { McpConnectionPanel } from "./components/mcp-connection";
import {
  store as mcpStore,
  useStore as useMcpStore
} from "../../stores/mcp-store";

/**
 * Settings → AI.
 *
 * Openotes ships no model and stores no model credentials, so there is
 * nothing here about providers, keys or token budgets. What there is: which
 * agents this machine can run, which of them Openotes has been allowed to
 * launch, and how to undo that.
 *
 * And the other direction. ACP is Openotes launching an agent; MCP is an
 * assistant the user already runs — Claude Code, Claude Desktop — connecting
 * to Openotes over a port on this machine. Both are off until asked for, and
 * neither sends anything anywhere else.
 */

const onMcpChange = (listener: (state: unknown, prev: unknown) => void) =>
  useMcpStore.subscribe(
    (s) => [s.settings, s.status] as const,
    listener,
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] }
  );

async function runMcp(action: () => Promise<unknown>, success?: string) {
  try {
    await action();
    if (success) showToast("success", success);
  } catch (error) {
    showToast("error", error instanceof Error ? error.message : String(error));
  }
}
export const AiSettings: SettingsGroup[] = [
  {
    key: "ai-agents",
    section: "ai",
    header: "AI assistant",
    settings: [
      {
        key: "acp-agents",
        title: "Agents",
        description:
          "Openotes does not include an AI model. Connect an agent you " +
          "already have and it signs in with your own subscription — " +
          "Openotes never sees those credentials.",
        keywords: [
          "ai",
          "agent",
          "assistant",
          "acp",
          "claude",
          "gemini",
          "codex",
          "opencode",
          "antigravity"
        ],
        components: [{ type: "custom", component: AgentsPanel }]
      }
    ]
  },
  {
    key: "ai-permissions",
    section: "ai",
    header: "What an agent can reach",
    settings: [
      {
        key: "acp-boundaries",
        title: "Notes in your vault are never shared",
        description:
          "A locked note is invisible to an agent, not merely awkward to " +
          "reach. Agents also get no terminal, and every change to a note " +
          "has to be approved before it happens.",
        keywords: ["vault", "locked", "permission", "security"],
        components: []
      },
      {
        key: "acp-forget",
        title: "Forget approved agents",
        description:
          "Openotes asks before running an agent for the first time and " +
          "remembers the answer for that exact program. Clearing it means " +
          "being asked again.",
        keywords: ["approve", "consent", "forget", "revoke"],
        onStateChange: (listener) =>
          useAiStore.subscribe((state) => state.agents, listener),
        components: [
          {
            type: "button",
            title: "Forget",
            action: () => void aiStore.forgetApprovals(),
            variant: "errorSecondary"
          }
        ]
      }
    ]
  },
  {
    key: "mcp-endpoint",
    section: "ai",
    header: "Let an assistant connect to Openotes",
    onStateChange: onMcpChange,
    onRender: () => void mcpStore.get().refresh(),
    settings: [
      {
        key: "mcp-what",
        title: "Answer the Model Context Protocol",
        description:
          "Claude Code, Claude Desktop or anything else that speaks MCP can " +
          "search and read your notes, and edit them if you allow it below. " +
          "The assistant connects to Openotes over a port on this machine; " +
          "nothing is sent anywhere else, and nothing works while Openotes " +
          "is closed or the vault is locked.",
        keywords: [
          "mcp",
          "model context protocol",
          "claude",
          "assistant",
          "ai"
        ],
        components: () => [
          {
            type: "toggle",
            isToggled: () => !!mcpStore.get().settings?.enabled,
            toggle: () =>
              runMcp(() =>
                mcpStore
                  .get()
                  .setSettings({ enabled: !mcpStore.get().settings?.enabled })
              )
          }
        ]
      },
      {
        key: "mcp-writes",
        title: "Let the assistant edit notes",
        description:
          "Off by default. While it is off the assistant can search and " +
          "read, and the tools that create, change, tag or trash a note are " +
          "not even offered to it. Nothing can delete a note permanently — " +
          "the worst it can do is move one to the trash.",
        keywords: ["mcp", "write", "edit", "read-only"],
        isHidden: () => !mcpStore.get().settings?.enabled,
        components: () => [
          {
            type: "toggle",
            isToggled: () => !!mcpStore.get().settings?.allowWrites,
            toggle: () =>
              runMcp(async () => {
                const allow = !mcpStore.get().settings?.allowWrites;
                if (
                  allow &&
                  !(await ConfirmDialog.show({
                    title: "Let the assistant edit notes?",
                    message:
                      "The assistant will be able to create, change, tag " +
                      "and trash notes without asking you each time. Notes " +
                      "kept in a vault stay out of reach either way.",
                    positiveButtonText: "Allow editing",
                    negativeButtonText: "Cancel"
                  }))
                ) {
                  return;
                }
                await mcpStore.get().setSettings({ allowWrites: allow });
                showToast(
                  "success",
                  "Reconnect your assistant so it picks up the change."
                );
              })
          }
        ]
      },
      {
        key: "mcp-port",
        title: "Port",
        description:
          "The port Openotes listens on. Keep it fixed so the client " +
          "configuration you write once keeps working; set it to 0 to let " +
          "the system pick a free one each launch.",
        keywords: ["mcp", "port"],
        isHidden: () => !mcpStore.get().settings?.enabled,
        components: () => [
          {
            type: "input",
            inputType: "number",
            min: 0,
            max: 65535,
            defaultValue: () => mcpStore.get().settings?.port ?? 4747,
            onChange: (port) =>
              void runMcp(() => mcpStore.get().setSettings({ port }))
          }
        ]
      },
      {
        key: "mcp-connection",
        title: "Connect your assistant",
        isHidden: () => !mcpStore.get().settings?.enabled,
        components: [{ type: "custom", component: McpConnectionPanel }]
      },
      {
        key: "mcp-token",
        title: "Replace the access token",
        description:
          "Every assistant configured with the old token stops working " +
          "until you paste the new one. Do this if the token has been seen " +
          "by anyone else.",
        keywords: ["mcp", "token", "revoke"],
        isHidden: () => !mcpStore.get().settings?.enabled,
        components: [
          {
            type: "button",
            title: "Replace token",
            variant: "errorSecondary",
            action: () =>
              runMcp(async () => {
                if (
                  !(await ConfirmDialog.show({
                    title: "Replace the access token?",
                    message:
                      "Assistants configured with the current token will " +
                      "stop working until you give them the new one.",
                    positiveButtonText: "Replace",
                    negativeButtonText: "Cancel"
                  }))
                ) {
                  return;
                }
                await desktop.mcp.regenerateToken.mutate();
                await mcpStore.get().refresh();
              }, "The token was replaced.")
          }
        ]
      }
    ]
  }
];
