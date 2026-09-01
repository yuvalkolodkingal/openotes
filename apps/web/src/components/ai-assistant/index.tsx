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

import { Button, Flex, Text, Textarea } from "@theme-ui/components";
import React, { useEffect, useRef, useState } from "react";
import { ScopedThemeProvider } from "../theme-provider";
import { TITLE_BAR_HEIGHT } from "../title-bar";
import { store as aiStore, useStore as useAiStore, Turn } from "../../stores/ai-store";

/**
 * The AI assistant panel.
 *
 * Openotes hosts an agent rather than being one, so this shows a conversation
 * with whichever ACP agent the user connected -- and, importantly, shows what
 * the agent is *doing*: its plan, its tool calls, and the permission prompts
 * it has to get past before touching a note.
 */
function AiAssistant() {
  const agents = useAiStore((store) => store.agents);
  const agentId = useAiStore((store) => store.agentId);
  const connecting = useAiStore((store) => store.connecting);
  const busy = useAiStore((store) => store.busy);
  const turns = useAiStore((store) => store.turns);
  const permission = useAiStore((store) => store.permission);
  const approval = useAiStore((store) => store.approval);
  const error = useAiStore((store) => store.error);

  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns]);

  const connected = agents.find((agent) => agent.id === agentId);

  return (
    <Flex
      sx={{
        display: "flex",
        top: TITLE_BAR_HEIGHT,
        zIndex: 999,
        height: "100%",
        borderLeft: "1px solid",
        borderLeftColor: "border"
      }}
    >
      <ScopedThemeProvider
        scope="editorSidebar"
        sx={{
          flex: 1,
          display: "flex",
          bg: "background",
          overflow: "hidden",
          flexDirection: "column"
        }}
      >
        <Flex
          sx={{
            p: 2,
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid",
            borderBottomColor: "border"
          }}
        >
          <Text variant="subtitle">
            {connected?.agentTitle ?? connected?.name ?? "AI assistant"}
          </Text>
          {agentId ? (
            <Button
              variant="secondary"
              sx={{ py: "2px", px: 1, fontSize: "subBody" }}
              onClick={() => void aiStore.disconnect()}
            >
              Disconnect
            </Button>
          ) : null}
        </Flex>

        {approval ? (
          <ApprovalPrompt
            agentName={approval.agentName}
            resolvedPath={approval.resolvedPath}
          />
        ) : null}

        {error ? (
          <Text
            variant="error"
            sx={{ p: 2, fontSize: "subBody", whiteSpace: "pre-wrap" }}
          >
            {error}
          </Text>
        ) : null}

        {!agentId && !approval ? (
          <AgentPicker connecting={connecting} />
        ) : (
          <>
            <Flex sx={{ flex: 1, flexDirection: "column", overflowY: "auto", p: 2 }}>
              {turns.length === 0 ? (
                <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
                  Ask about the note you are reading, or anything else. The
                  assistant has to ask before it changes a note, and it cannot
                  see notes in your vault.
                </Text>
              ) : (
                turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
              )}
              <div ref={endRef} />
            </Flex>

            {permission ? (
              <PermissionPrompt
                title={permission.title}
                options={permission.options}
              />
            ) : null}

            <Flex sx={{ p: 2, gap: 1, borderTop: "1px solid", borderTopColor: "border" }}>
              <Textarea
                value={draft}
                rows={2}
                placeholder="Ask the assistant"
                sx={{ flex: 1, fontSize: "body", resize: "none" }}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends; Shift+Enter is a newline, which is what
                  // people expect from every other chat box.
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!busy && draft.trim()) {
                      void aiStore.send(draft);
                      setDraft("");
                    }
                  }
                }}
              />
              {busy ? (
                <Button variant="secondary" onClick={() => void aiStore.cancel()}>
                  Stop
                </Button>
              ) : (
                <Button
                  variant="accent"
                  disabled={!draft.trim()}
                  onClick={() => {
                    void aiStore.send(draft);
                    setDraft("");
                  }}
                >
                  Send
                </Button>
              )}
            </Flex>
          </>
        )}
      </ScopedThemeProvider>
    </Flex>
  );
}

function AgentPicker({ connecting }: { connecting: boolean }) {
  const agents = useAiStore((store) => store.agents);

  return (
    <Flex sx={{ flexDirection: "column", p: 2, gap: 2, overflowY: "auto" }}>
      <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
        Openotes does not include a model. Connect an agent you already have,
        and it signs in with your own subscription.
      </Text>
      {agents.map((agent) => (
        <Flex
          key={agent.id}
          sx={{
            flexDirection: "column",
            p: 1,
            borderRadius: "default",
            border: "1px solid",
            borderColor: "border"
          }}
        >
          <Flex sx={{ justifyContent: "space-between", alignItems: "center" }}>
            <Text variant="body">{agent.name}</Text>
            {agent.installed ? (
              <Button
                variant="accent"
                disabled={connecting}
                sx={{ py: "2px", px: 1, fontSize: "subBody" }}
                onClick={() => void aiStore.connect(agent.id)}
              >
                {connecting ? "Connecting" : "Connect"}
              </Button>
            ) : (
              <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
                Not installed
              </Text>
            )}
          </Flex>
          <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
            {agent.summary}
          </Text>
          {!agent.installed && agent.install ? (
            <Text variant="subBody" sx={{ color: "paragraph-secondary", mt: 1 }}>
              {agent.install.npm
                ? `npm install -g ${agent.install.npm}`
                : agent.install.docs}
            </Text>
          ) : null}
        </Flex>
      ))}
    </Flex>
  );
}

/**
 * Approving an agent means letting a program run with the user's privileges.
 * That deserves a real question rather than a toast, and it names the exact
 * binary rather than just the product.
 */
function ApprovalPrompt(props: { agentName: string; resolvedPath: string }) {
  return (
    <Flex
      sx={{
        flexDirection: "column",
        m: 2,
        p: 2,
        gap: 1,
        borderRadius: "default",
        bg: "background-secondary"
      }}
    >
      <Text variant="body">Let Openotes run {props.agentName}?</Text>
      <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
        It runs as a separate program with your permissions, the same as if you
        started it yourself. Openotes will ask again if the program at this path
        changes.
      </Text>
      <Text
        variant="subBody"
        sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
      >
        {props.resolvedPath}
      </Text>
      <Flex sx={{ gap: 1, mt: 1 }}>
        <Button variant="accent" onClick={() => void aiStore.approve()}>
          Allow
        </Button>
        <Button variant="secondary" onClick={() => aiStore.dismissApproval()}>
          Not now
        </Button>
      </Flex>
    </Flex>
  );
}

/**
 * Blocks the turn until answered. The agent is waiting on this promise, which
 * is the point: a prompt it can race past is not a prompt.
 */
function PermissionPrompt(props: {
  title: string;
  options: { optionId: string; name: string; kind: string }[];
}) {
  return (
    <Flex
      sx={{
        flexDirection: "column",
        m: 2,
        p: 2,
        gap: 1,
        borderRadius: "default",
        bg: "background-secondary"
      }}
    >
      <Text variant="body">{props.title}</Text>
      <Flex sx={{ gap: 1, flexWrap: "wrap" }}>
        {props.options.map((option) => (
          <Button
            key={option.optionId}
            variant={option.kind.startsWith("allow") ? "accent" : "secondary"}
            sx={{ py: "2px", px: 1, fontSize: "subBody" }}
            onClick={() => void aiStore.respondPermission(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
        <Button
          variant="secondary"
          sx={{ py: "2px", px: 1, fontSize: "subBody" }}
          onClick={() => void aiStore.respondPermission(undefined)}
        >
          Cancel
        </Button>
      </Flex>
    </Flex>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const [showThoughts, setShowThoughts] = useState(false);

  if (turn.role === "user") {
    return (
      <Flex
        sx={{
          alignSelf: "flex-end",
          maxWidth: "85%",
          bg: "background-secondary",
          borderRadius: "default",
          p: 1,
          mb: 2
        }}
      >
        <Text variant="body" sx={{ whiteSpace: "pre-wrap" }}>
          {turn.text}
        </Text>
      </Flex>
    );
  }

  return (
    <Flex sx={{ flexDirection: "column", mb: 2, gap: 1 }}>
      {turn.plan.length > 0 ? (
        <Flex sx={{ flexDirection: "column", pl: 1, borderLeft: "2px solid", borderLeftColor: "accent" }}>
          {turn.plan.map((entry, index) => (
            <Text
              key={index}
              variant="subBody"
              sx={{
                color:
                  entry.status === "completed"
                    ? "paragraph-secondary"
                    : "paragraph",
                textDecoration:
                  entry.status === "completed" ? "line-through" : "none"
              }}
            >
              {entry.content}
            </Text>
          ))}
        </Flex>
      ) : null}

      {turn.thoughts ? (
        <>
          <Button
            variant="secondary"
            sx={{
              alignSelf: "flex-start",
              py: 0,
              px: 1,
              fontSize: "subBody",
              bg: "transparent",
              color: "paragraph-secondary"
            }}
            onClick={() => setShowThoughts((shown) => !shown)}
          >
            {showThoughts ? "Hide thinking" : "Show thinking"}
          </Button>
          {showThoughts ? (
            <Text
              variant="subBody"
              sx={{
                color: "paragraph-secondary",
                whiteSpace: "pre-wrap",
                fontStyle: "italic"
              }}
            >
              {turn.thoughts}
            </Text>
          ) : null}
        </>
      ) : null}

      {turn.toolCalls.map((call) => (
        <Text
          key={call.toolCallId}
          variant="subBody"
          sx={{ color: "paragraph-secondary" }}
        >
          {call.status === "completed" ? "✓" : "·"} {call.title}
        </Text>
      ))}

      <Text variant="body" sx={{ whiteSpace: "pre-wrap" }}>
        {turn.text}
      </Text>

      {turn.stopReason && turn.stopReason !== "end_turn" ? (
        <Text variant="subBody" sx={{ color: "paragraph-secondary" }}>
          {describeStop(turn.stopReason)}
        </Text>
      ) : null}
    </Flex>
  );
}

/** Protocol stop reasons are not sentences; these are. */
function describeStop(reason: string): string {
  switch (reason) {
    case "cancelled":
      return "Stopped.";
    case "max_tokens":
      return "The agent reached its length limit.";
    case "max_turn_requests":
      return "The agent reached its limit for one turn.";
    case "refusal":
      return "The agent declined to continue.";
    default:
      return reason;
  }
}

export default React.memo(AiAssistant);
