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
 * Settings → AI assistant.
 *
 * Openotes speaks the Model Context Protocol on a loopback endpoint, so an
 * assistant running on this machine can search, read and edit notes. There
 * is no service behind it and nothing leaves the machine: the assistant
 * connects to Openotes, not the other way round.
 */

import { SettingsGroup } from "./types";
import { desktop } from "../../common/desktop-bridge";
import { showToast } from "../../utils/toast";
import { ConfirmDialog } from "../confirm";
import { McpConnectionPanel } from "./components/mcp-connection";
import { store as mcpStore, useStore as useMcpStore } from "../../stores/mcp-store";

const onMcpChange = (listener: (state: unknown, prev: unknown) => void) =>
  useMcpStore.subscribe(
    (s) => [s.settings, s.status] as const,
    listener,
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] }
  );

async function run(action: () => Promise<unknown>, success?: string) {
  try {
    await action();
    if (success) showToast("success", success);
  } catch (error) {
    showToast("error", error instanceof Error ? error.message : String(error));
  }
}

export const AiSettings: SettingsGroup[] = [
  {
    key: "mcp-endpoint",
    section: "ai",
    header: "AI assistant",
    onStateChange: onMcpChange,
    onRender: () => void mcpStore.get().refresh(),
    settings: [
      {
        key: "mcp-what",
        title: "Let an assistant work with your notes",
        description:
          "Openotes can answer an AI assistant running on this machine — " +
          "Claude Code, Claude Desktop or anything else that speaks the " +
          "Model Context Protocol. The assistant connects to Openotes over " +
          "a port on this machine; nothing is sent anywhere else, and " +
          "nothing works while Openotes is closed or the vault is locked.",
        keywords: ["mcp", "ai", "assistant", "claude", "model context protocol"],
        components: () => [
          {
            type: "toggle",
            isToggled: () => !!mcpStore.get().settings?.enabled,
            toggle: () =>
              run(
                () =>
                  mcpStore
                    .get()
                    .setSettings({
                      enabled: !mcpStore.get().settings?.enabled
                    })
              )
          }
        ]
      },
      {
        key: "mcp-writes",
        title: "Let the assistant edit notes",
        description:
          "Off by default. While it is off the assistant can search and " +
          "read but the tools that create, change, tag or trash a note are " +
          "not even offered to it. Nothing can delete a note permanently — " +
          "the worst it can do is move one to the trash.",
        keywords: ["mcp", "write", "edit", "read-only"],
        isHidden: () => !mcpStore.get().settings?.enabled,
        components: () => [
          {
            type: "toggle",
            isToggled: () => !!mcpStore.get().settings?.allowWrites,
            toggle: () =>
              run(async () => {
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
            onChange: (port) => void run(() => mcpStore.get().setSettings({ port }))
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
              run(async () => {
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
