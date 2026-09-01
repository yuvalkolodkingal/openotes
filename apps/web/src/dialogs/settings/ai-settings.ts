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

/**
 * Settings → AI.
 *
 * Openotes ships no model and stores no model credentials, so there is
 * nothing here about providers, keys or token budgets. What there is: which
 * agents this machine can run, which of them Openotes has been allowed to
 * launch, and how to undo that.
 */
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
  }
];
