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

import { Button, Flex, Text } from "@theme-ui/components";
import { useEffect } from "react";
import {
  store as aiStore,
  useStore as useAiStore
} from "../../../stores/ai-store";

/**
 * Settings → AI → Agents.
 *
 * Shows every agent Openotes knows how to launch and whether this machine has
 * it, so "why is nothing listed" is never a mystery. Installing one is the
 * agent's own business; the command is shown rather than run.
 */
export function AgentsPanel() {
  const agents = useAiStore((store) => store.agents);
  const connecting = useAiStore((store) => store.connecting);
  const connectedId = useAiStore((store) => store.agentId);
  const approval = useAiStore((store) => store.approval);
  const error = useAiStore((store) => store.error);

  useEffect(() => {
    // refresh() records its own failure into `error`, which renders above
    // the list; nothing is swallowed here.
    void aiStore.refresh();
  }, []);

  if (!IS_DESKTOP_APP) {
    return (
      <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
        The AI assistant runs an agent as a separate program, which only the
        desktop application can do.
      </Text>
    );
  }

  return (
    <Flex sx={{ flexDirection: "column", gap: 1, width: "100%" }}>
      {error ? (
        <Text variant="error" sx={{ fontSize: "subBody", whiteSpace: "pre-wrap" }}>
          {error}
        </Text>
      ) : null}

      {approval ? (
        <Flex
          sx={{
            flexDirection: "column",
            gap: 1,
            p: 1,
            borderRadius: "default",
            bg: "background-secondary"
          }}
        >
          <Text variant="body">Let Openotes run {approval.agentName}?</Text>
          <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
            It runs with your permissions, the same as starting it yourself.
          </Text>
          <Text
            variant="subBody"
            sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
          >
            {approval.resolvedPath}
          </Text>
          <Flex sx={{ gap: 1 }}>
            <Button variant="accent" onClick={() => void aiStore.approve()}>
              Allow
            </Button>
            <Button
              variant="secondary"
              onClick={() => aiStore.dismissApproval()}
            >
              Not now
            </Button>
          </Flex>
        </Flex>
      ) : null}

      {agents.length === 0 ? (
        <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
          Looking for installed agents…
        </Text>
      ) : null}

      {agents.map((agent) => {
        const isConnected = agent.id === connectedId;
        return (
          <Flex
            key={agent.id}
            sx={{
              justifyContent: "space-between",
              alignItems: "center",
              gap: 2,
              py: 1,
              borderBottom: "1px solid",
              borderBottomColor: "border"
            }}
          >
            <Flex sx={{ flexDirection: "column", flex: 1 }}>
              <Text variant="body">
                {agent.name}
                {agent.agentVersion ? (
                  <Text
                    as="span"
                    variant="subBody"
                    sx={{ color: "paragraph-secondary", ml: 1 }}
                  >
                    {agent.agentVersion}
                  </Text>
                ) : null}
              </Text>
              <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
                {agent.summary}
              </Text>
              {agent.installed ? (
                <Text
                  variant="subBody"
                  sx={{
                    color: "paragraph-secondary",
                    fontFamily: "monospace",
                    wordBreak: "break-all"
                  }}
                >
                  {agent.resolvedPath}
                </Text>
              ) : (
                <Text
                  variant="subBody"
                  sx={{ color: "paragraph-secondary", fontFamily: "monospace" }}
                >
                  {agent.install?.npm
                    ? `npm install -g ${agent.install.npm}`
                    : agent.install?.docs}
                </Text>
              )}
              {isConnected && agent.authMethods.length > 0 ? (
                <Flex sx={{ gap: 1, mt: 1, flexWrap: "wrap" }}>
                  {agent.authMethods.map((method) => (
                    <Button
                      key={method.id}
                      variant="secondary"
                      sx={{ py: "2px", px: 1, fontSize: "subBody" }}
                      onClick={() => void aiStore.authenticate(method.id)}
                    >
                      {method.name}
                    </Button>
                  ))}
                </Flex>
              ) : null}
              {agent.models.length > 0 ? (
                <Flex sx={{ alignItems: "center", gap: 1, mt: 1 }}>
                  <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
                    Model
                  </Text>
                  <select
                    value={aiStore.modelFor(agent.id) ?? ""}
                    onChange={(e) =>
                      void aiStore.setModel(
                        agent.id,
                        e.target.value || undefined
                      )
                    }
                    style={{
                      fontSize: "inherit",
                      fontFamily: "inherit",
                      padding: "2px 4px"
                    }}
                  >
                    <option value="">Agent's default</option>
                    {agent.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  {isConnected ? (
                    <Text
                      variant="subBody"
                      sx={{ color: "paragraph-secondary" }}
                    >
                      changing this restarts {agent.name}
                    </Text>
                  ) : null}
                </Flex>
              ) : null}

              {isConnected && agent.authMethods.length === 0 ? (
                // An agent whose own CLI is already signed in needs no login
                // step, and inventing one would be a lie about what happened.
                <Text variant="subBody" sx={{ color: "accent" }}>
                  Signed in already — nothing else to do.
                </Text>
              ) : null}
            </Flex>

            {!agent.installed ? (
              <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
                Not installed
              </Text>
            ) : isConnected ? (
              <Button
                variant="secondary"
                onClick={() => void aiStore.disconnect()}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={connecting}
                onClick={() => void aiStore.connect(agent.id)}
              >
                {connecting ? "Connecting…" : "Connect"}
              </Button>
            )}
          </Flex>
        );
      })}
    </Flex>
  );
}
