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

// Imported from the desktop entry directly rather than through the
// platform-swapped barrel, the same way webdav-store does: the assistant runs
// an agent as a separate program, so it is desktop-only by nature and the web
// stub has nothing to offer it.
import {
  desktopCall,
  handleDesktopRequest,
  hasDesktopRuntime,
  onDesktopEvent
} from "../common/desktop-bridge/index.desktop";
import createStore from "../common/store";
import BaseStore from "./index";
import { db } from "../common/db";
import { exportContent, parseNoteMarkdown } from "@notesnook/common";
import { showToast } from "../utils/toast";

/**
 * State for the AI assistant panel.
 *
 * Openotes hosts an agent; it is not one. So this store owns a conversation
 * and a connection, and knows nothing about models, prompts or tokens -- all
 * of that belongs to whichever ACP agent the user connected.
 */

export type AgentStatus = {
  id: string;
  name: string;
  summary: string;
  installed: boolean;
  resolvedPath?: string;
  connected: boolean;
  agentTitle?: string;
  agentVersion?: string;
  authMethods: { id: string; name: string; description?: string }[];
  install?: { npm?: string; docs: string };
  authHint: string;
};

export type ToolCallView = {
  toolCallId: string;
  title: string;
  kind?: string;
  status?: string;
};

export type PlanEntryView = {
  content: string;
  status?: string;
  priority?: string;
};

export type Turn = {
  id: string;
  role: "user" | "agent";
  /** Streamed text, appended chunk by chunk. */
  text: string;
  /** The agent's reasoning, kept apart so it can be collapsed. */
  thoughts: string;
  toolCalls: ToolCallView[];
  plan: PlanEntryView[];
  /** Set once the turn ends. */
  stopReason?: string;
};

export type PendingPermission = {
  requestId: string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
};

/**
 * Notes are addressed to an agent as paths inside its (empty) workspace.
 *
 * A real agent rejects a URI where ACP asks for a path -- `session/new`
 * answers "cwd must be an absolute path" -- so the scheme is a real-looking
 * path and the mapping back to a note id lives here.
 */
const pathToNoteId = new Map<string, string>();

function rpc<T>(path: string, input?: unknown): Promise<T> {
  if (!hasDesktopRuntime()) {
    return Promise.reject(
      new Error("The AI assistant is only available in the desktop app.")
    );
  }
  return desktopCall(path, input) as Promise<T>;
}

class AiStore extends BaseStore<AiStore> {
  agents: AgentStatus[] = [];
  agentId?: string;
  sessionId?: string;
  connecting = false;
  /** True while a turn is in flight. */
  busy = false;
  turns: Turn[] = [];
  permission?: PendingPermission;
  /** Set when connecting needs the user to approve running a program. */
  approval?: { agentId: string; agentName: string; resolvedPath: string };
  error?: string;

  refresh = async () => {
    if (!hasDesktopRuntime()) return;
    const agents = await rpc<AgentStatus[]>("acp.listAgents");
    this.set((state) => {
      state.agents = agents;
    });
  };

  connect = async (agentId: string) => {
    this.set((state) => {
      state.connecting = true;
      state.error = undefined;
      state.approval = undefined;
    });
    try {
      const result = await rpc<
        | { ok: true; agent: AgentStatus }
        | {
            ok: false;
            needsApproval: {
              agentId: string;
              agentName: string;
              resolvedPath: string;
            };
          }
      >("acp.connect", { agentId });

      if (!result.ok) {
        // Not a failure: a question. Approving an agent means letting a
        // program run, so it is asked once and answered explicitly.
        this.set((state) => {
          state.approval = result.needsApproval;
        });
        return;
      }

      const sessionId = await rpc<string>("acp.newSession", { agentId });
      this.set((state) => {
        state.agentId = agentId;
        state.sessionId = sessionId;
        state.turns = [];
      });
      await this.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.set((state) => {
        state.error = message;
      });
    } finally {
      this.set((state) => {
        state.connecting = false;
      });
    }
  };

  /** Grant the consent `connect` asked for, then retry it. */
  approve = async () => {
    const approval = this.get().approval;
    if (!approval) return;
    await rpc("acp.approve", {
      agentId: approval.agentId,
      resolvedPath: approval.resolvedPath
    });
    this.set((state) => {
      state.approval = undefined;
    });
    await this.connect(approval.agentId);
  };

  dismissApproval = () => {
    this.set((state) => {
      state.approval = undefined;
    });
  };

  authenticate = async (methodId: string) => {
    const agentId = this.get().agentId ?? this.get().approval?.agentId;
    if (!agentId) return;
    try {
      await rpc("acp.authenticate", { agentId, methodId });
      await this.connect(agentId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.set((state) => {
        state.error = message;
      });
    }
  };

  disconnect = async () => {
    const agentId = this.get().agentId;
    if (agentId) await rpc("acp.disconnect", { agentId }).catch(() => {});
    this.set((state) => {
      state.agentId = undefined;
      state.sessionId = undefined;
      state.turns = [];
      state.busy = false;
    });
    await this.refresh();
  };

  send = async (message: string) => {
    const { agentId, sessionId } = this.get();
    if (!agentId || !sessionId || !message.trim()) return;

    this.set((state) => {
      state.busy = true;
      state.error = undefined;
      state.turns.push(newTurn("user", message));
      state.turns.push(newTurn("agent", ""));
    });

    try {
      const result = await rpc<{ stopReason: string }>("acp.prompt", {
        agentId,
        sessionId,
        prompt: [{ type: "text", text: message }]
      });
      this.set((state) => {
        const last = state.turns[state.turns.length - 1];
        if (last) last.stopReason = result.stopReason;
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.set((state) => {
        state.error = message;
      });
    } finally {
      this.set((state) => {
        state.busy = false;
      });
    }
  };

  cancel = async () => {
    const { agentId, sessionId } = this.get();
    if (!agentId || !sessionId) return;
    await rpc("acp.cancel", { agentId, sessionId }).catch(() => {});
  };

  /**
   * Forget every recorded approval, so the next launch asks again.
   *
   * Deliberately all-or-nothing: a per-agent list would imply the approvals
   * are fine-grained, when what they actually pin is one binary at one path.
   */
  forgetApprovals = async () => {
    await rpc("acp.forgetApprovals").catch(() => {});
    await this.disconnect();
  };

  /** Answer a permission prompt. `undefined` refuses. */
  respondPermission = async (optionId?: string) => {
    const permission = this.get().permission;
    if (!permission) return;
    this.set((state) => {
      state.permission = undefined;
    });
    await rpc("acp.respondPermission", {
      requestId: permission.requestId,
      optionId
    });
  };
}

function newTurn(role: "user" | "agent", text: string): Turn {
  return {
    id: crypto.randomUUID(),
    role,
    text,
    thoughts: "",
    toolCalls: [],
    plan: []
  };
}

const [useStore, store] = createStore<AiStore>(
  (set, get) => new AiStore(set, get)
);

// ---------------------------------------------------------------------------
// Streaming updates
// ---------------------------------------------------------------------------

function applyUpdate(payload: unknown) {
  const notification = payload as {
    update?: Record<string, unknown>;
  };
  const update = notification?.update;
  if (!update) return;

  store.set((state) => {
    const turn = state.turns[state.turns.length - 1];
    if (!turn || turn.role !== "agent") return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        turn.text += textOf(update.content);
        break;
      case "agent_thought_chunk":
        turn.thoughts += textOf(update.content);
        break;
      case "tool_call":
        turn.toolCalls.push({
          toolCallId: String(update.toolCallId ?? ""),
          title: String(update.title ?? "Tool call"),
          kind: update.kind as string | undefined,
          status: (update.status as string) ?? "pending"
        });
        break;
      case "tool_call_update": {
        const existing = turn.toolCalls.find(
          (call) => call.toolCallId === update.toolCallId
        );
        if (existing) {
          if (update.status) existing.status = String(update.status);
          if (update.title) existing.title = String(update.title);
        }
        break;
      }
      case "plan":
        turn.plan = ((update.entries as PlanEntryView[]) ?? []).map((entry) => ({
          content: String(entry.content ?? ""),
          status: entry.status,
          priority: entry.priority
        }));
        break;
      default:
        // Modes and command lists are not surfaced yet; ignoring an unknown
        // update is correct rather than an error -- agents add them freely.
        break;
    }
  });
}

function textOf(content: unknown): string {
  const block = content as { type?: string; text?: string } | undefined;
  return block?.type === "text" ? block.text ?? "" : "";
}

// ---------------------------------------------------------------------------
// Answering the runtime: notes in, notes out
// ---------------------------------------------------------------------------

/**
 * Render a note for an agent.
 *
 * `exportContent` refuses a locked note without an unlocked vault, and no
 * `unlockVault` callback is passed here on purpose: a vault note is invisible
 * to an agent rather than merely awkward to reach.
 */
async function readNoteForAgent(payload: unknown): Promise<string> {
  const request = payload as { path: string };
  const noteId = pathToNoteId.get(request.path);
  if (!noteId) throw new Error(`No note at ${request.path}`);

  const note = await db.notes.note(noteId);
  if (!note) throw new Error(`No note at ${request.path}`);

  const content = await exportContent(note, { format: "md-sync" });
  if (!content) throw new Error(`Could not read ${request.path}`);
  return content;
}

async function writeNoteFromAgent(payload: unknown): Promise<void> {
  const request = payload as { path: string; content: string };
  const noteId = pathToNoteId.get(request.path);
  const parsed = parseNoteMarkdown(request.content);

  const id = noteId ?? parsed.id;
  if (!id) throw new Error(`Cannot write to ${request.path}: unknown note`);

  await db.notes.add({
    id,
    title: parsed.title,
    content: { type: "tiptap", data: parsed.html }
  });
  showToast("success", "The assistant updated a note.");
}

/** Remember which note a path stands for, so the agent can be handed one. */
export function registerAgentNotePath(path: string, noteId: string) {
  pathToNoteId.set(path, noteId);
}

function attachRuntimeListeners() {
  if (!hasDesktopRuntime()) return;

  onDesktopEvent("acp.update", applyUpdate);

  onDesktopEvent("acp.permission", (payload) => {
    const event = payload as {
      requestId: string;
      request: {
        toolCall: { title: string };
        options: { optionId: string; name: string; kind: string }[];
      };
    };
    store.set((state) => {
      state.permission = {
        requestId: event.requestId,
        title: event.request?.toolCall?.title ?? "Allow this action?",
        options: event.request?.options ?? []
      };
    });
  });

  onDesktopEvent("acp.status", () => {
    void store.refresh().catch(() => {});
  });

  handleDesktopRequest("acp.readNote", readNoteForAgent);
  handleDesktopRequest("acp.writeNote", async (payload) => {
    await writeNoteFromAgent(payload);
    return null;
  });

  void store.refresh().catch(() => {
    // The panel shows its own empty state; a failed probe is not a toast.
  });
}

attachRuntimeListeners();

export { store, useStore };
