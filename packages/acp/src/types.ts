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
 * Agent Client Protocol, version 1.
 *
 * https://agentclientprotocol.com — JSON-RPC 2.0 in both directions over a
 * transport, conventionally a subprocess's stdin/stdout.
 *
 * Openotes implements the CLIENT half only. It hosts agents; it never is one.
 *
 * THESE TYPES WERE CHECKED AGAINST A REAL AGENT
 *
 * A handshake against @agentclientprotocol/claude-agent-agp v0.70.0 returned
 * several things the published schema does not mention — `sessionCapabilities`,
 * `auth.logout`, and vendor extensions under `_meta` at four different levels.
 * Two consequences are baked into the types below:
 *
 *  1. `_meta` is load-bearing and must round-trip. Stripping unknown keys
 *     would quietly break agents that negotiate through it.
 *  2. Capability members are empty objects meaning "supported", not booleans.
 *     Typing them as `boolean` would make `if (caps.logout)` compile and then
 *     be wrong in the other direction — `{}` is truthy, `false` is not, and an
 *     absent key is the real "no".
 */

export const PROTOCOL_VERSION = 1;

/** Anything the protocol lets an implementation hang extensions from. */
export type Meta = Record<string, unknown>;

/** Present means supported. The object's contents are agent-defined. */
export type CapabilityFlag = Record<string, unknown>;

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface ClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  /**
   * Openotes always sends false. A notes application has no business handing
   * an agent a shell, and advertising the capability is what makes an agent
   * try to use one.
   */
  terminal?: boolean;
  _meta?: Meta;
}

export interface Implementation {
  name: string;
  title?: string;
  version?: string;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation;
  _meta?: Meta;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  auth?: { logout?: CapabilityFlag };
  providers?: Record<string, unknown>;
  /** close, delete, fork, list, resume, additionalDirectories — all `{}`. */
  sessionCapabilities?: Record<string, CapabilityFlag>;
  _meta?: Meta;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  _meta?: Meta;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: Implementation;
  /**
   * Empty means no authentication step is needed — usually because the agent's
   * own CLI is already signed in. That is the one-click path, and the
   * interface must not invent a login step when this array is empty.
   */
  authMethods?: AuthMethod[];
  _meta?: Meta;
}

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: "text"; text: string; _meta?: Meta }
  | {
    type: "image";
    data: string;
    mimeType: string;
    uri?: string;
    _meta?: Meta;
  }
  | { type: "audio"; data: string; mimeType: string; _meta?: Meta }
  | {
    type: "resource_link";
    uri: string;
    name: string;
    mimeType?: string;
    title?: string;
    description?: string;
    size?: number;
    _meta?: Meta;
  }
  | {
    type: "resource";
    resource:
      | { uri: string; mimeType?: string; text: string }
      | { uri: string; mimeType?: string; blob: string };
    _meta?: Meta;
  };

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

export interface NewSessionRequest {
  /** ACP requires an absolute path. Openotes passes an openotes:// URI. */
  cwd: string;
  mcpServers?: unknown[];
  _meta?: Meta;
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: SessionModeState;
  _meta?: Meta;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface PromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: Meta;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface PromptResponse {
  stopReason: StopReason;
  _meta?: Meta;
}

// ---------------------------------------------------------------------------
// tool calls
// ---------------------------------------------------------------------------

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCall {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: Meta;
}

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | {
    type: "diff";
    path: string;
    oldText: string | null;
    newText: string;
  }
  | { type: "terminal"; terminalId: string };

export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
}

// ---------------------------------------------------------------------------
// session/update — the notification that carries everything streamed
// ---------------------------------------------------------------------------

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | {
    sessionUpdate: "agent_message_chunk";
    content: ContentBlock;
    messageId?: string;
  }
  | {
    sessionUpdate: "agent_thought_chunk";
    content: ContentBlock;
    messageId?: string;
  }
  | ({ sessionUpdate: "tool_call" } & ToolCall)
  | ({ sessionUpdate: "tool_call_update" } & Partial<ToolCall> & {
    toolCallId: string;
  })
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
  _meta?: Meta;
}

// ---------------------------------------------------------------------------
// permission — the client's decision point
// ---------------------------------------------------------------------------

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
  _meta?: Meta;
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
  _meta?: Meta;
}

export type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome;
  _meta?: Meta;
}

// ---------------------------------------------------------------------------
// filesystem — mapped onto notes, never onto a real filesystem
// ---------------------------------------------------------------------------

export interface ReadTextFileRequest {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
  _meta?: Meta;
}

export interface ReadTextFileResponse {
  content: string;
  _meta?: Meta;
}

export interface WriteTextFileRequest {
  sessionId: string;
  path: string;
  content: string;
  _meta?: Meta;
}

export interface AuthenticateRequest {
  methodId: string;
  _meta?: Meta;
}
