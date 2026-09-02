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
import Config from "../utils/config";
import { useEditorStore } from "./editor-store";
import { exportContent } from "@notesnook/common";
import { parseNoteMarkdown } from "@notesnook/core";
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
  /** Models this agent can be asked for; empty means no choice is offered. */
  models: { id: string; name: string }[];
  /** Whether a free-typed model name can be passed to this agent. */
  acceptsCustomModel: boolean;
  /** The model the live connection was started with. */
  modelId?: string;
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

/** How many notes beyond the open one the agent is told about. */
const INDEX_LIMIT = 50;

/**
 * Is this note in the vault?
 *
 * Asked directly rather than left to `exportContent`, which only refuses a
 * locked note while the vault is *locked* — once the user unlocks it to read
 * something, it would happily decrypt vault notes for an agent. SECURITY.md
 * and AI.md both promise a vault note is invisible to an agent, with no
 * "unless" attached, so the check has to be unconditional.
 */
async function isVaultNote(noteId: string): Promise<boolean> {
  try {
    const content = await db.content.findByNoteId(noteId);
    return content?.locked === true;
  } catch {
    // Unreadable is treated as private: excluding a note the agent could have
    // seen is a smaller harm than exposing one it should not.
    return true;
  }
}

/** A filename for a note, unique within one index. */
function noteFileName(title: string, taken: Set<string>): string {
  const cleaned = (title || "Untitled")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Untitled";
  let candidate = `${cleaned}.md`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${cleaned} (${n++}).md`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function rpc<T>(path: string, input?: unknown): Promise<T> {
  if (!hasDesktopRuntime()) {
    return Promise.reject(
      new Error("The AI assistant is only available in the desktop app.")
    );
  }
  return desktopCall(path, input) as Promise<T>;
}

/**
 * Tell the agent which notes exist, and where.
 *
 * The session's workspace directory is real but deliberately empty -- writing
 * notes into it would put plaintext on disk, outside the encrypted database.
 * So discovery happens here instead: each note gets a path inside that
 * directory, the mapping back to its id is recorded, and the list is handed to
 * the agent as text. `fs/read_text_file` on any of these paths then resolves.
 */
async function buildNoteIndex(
  workspace: string
): Promise<{ index: string; count: number; excluded: number }> {
  const taken = new Set<string>();
  const lines: string[] = [];
  let excluded = 0;

  const ordered: { id: string; title: string }[] = [];
  const active = useEditorStore.getState().getActiveNote();
  if (active) ordered.push({ id: active.id, title: active.title });

  const recent = await db.notes.all
    .fields(["notes.id", "notes.title"])
    .items(undefined, db.settings.getGroupOptions("home"));
  for (const note of recent) {
    if (ordered.length >= INDEX_LIMIT) break;
    if (ordered.some((n) => n.id === note.id)) continue;
    ordered.push({ id: note.id, title: note.title });
  }

  pathToNoteId.clear();
  for (const note of ordered) {
    if (await isVaultNote(note.id)) {
      excluded++;
      continue;
    }
    const name = noteFileName(note.title, taken);
    const full = `${workspace}/${name}`;
    // Registered under both spellings: an agent may echo back the absolute
    // path it was given, or just the name relative to its own cwd.
    pathToNoteId.set(full, note.id);
    pathToNoteId.set(name, note.id);
    lines.push(`- ${name}`);
  }

  const header = lines.length
    ? `These notes are available to read and edit in ${workspace}:\n` +
      lines.join("\n")
    : `There are no notes available to read in ${workspace}.`;
  const note = excluded
    ? `\n\n(${excluded} note${excluded === 1 ? " is" : "s are"} in the vault ` +
      `and cannot be shared.)`
    : "";
  return { index: `${header}${note}`, count: lines.length, excluded };
}

class AiStore extends BaseStore<AiStore> {
  agents: AgentStatus[] = [];
  agentId?: string;
  sessionId?: string;
  /** The session's workspace directory; notes are addressed inside it. */
  workspace?: string;
  /** What the agent calls its operating modes, if it has any. */
  modes: { id: string; name: string; description?: string }[] = [];
  currentModeId?: string;
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
    try {
      const agents = await rpc<AgentStatus[]>("acp.listAgents");
      this.set((state) => {
        state.agents = agents;
        state.error = undefined;
      });
    } catch (e) {
      // Deliberately not silent any more. When looking for agents fails --
      // a denied permission, a broken catalog -- an empty list looks exactly
      // like "you have none installed", and the user has no way to tell the
      // difference or anything to act on.
      this.set((state) => {
        state.agents = [];
        state.error = e instanceof Error ? e.message : String(e);
      });
    }
  };

  /** The model chosen for an agent, remembered across restarts. */
  modelFor = (agentId: string): string | undefined =>
    Config.get(`ai:model:${agentId}`, undefined as string | undefined);

  /**
   * Choose a model and restart the agent on it.
   *
   * ACP cannot change a model mid-session -- it has no concept of one -- so
   * the process is started with the choice and switching means reconnecting.
   * The interface says so rather than implying it takes effect silently.
   */
  setModel = async (agentId: string, modelId?: string) => {
    if (modelId) Config.set(`ai:model:${agentId}`, modelId);
    else Config.set(`ai:model:${agentId}`, undefined);
    if (this.get().agentId === agentId) await this.connect(agentId);
    else await this.refresh();
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
      >("acp.connect", { agentId, modelId: this.modelFor(agentId) });

      if (!result.ok) {
        // Not a failure: a question. Approving an agent means letting a
        // program run, so it is asked once and answered explicitly.
        this.set((state) => {
          state.approval = result.needsApproval;
        });
        return;
      }

      // An agent that asked for a sign-in method cannot start a session yet.
      // Calling newSession anyway earns a raw JSON-RPC -32000, which is what
      // used to reach the user instead of the sign-in buttons.
      if (result.agent.authMethods.length > 0) {
        this.set((state) => {
          state.agentId = agentId;
          state.sessionId = undefined;
          state.turns = [];
        });
        await this.refresh();
        return;
      }

      const session = await rpc<{
        sessionId: string;
        workspace: string;
        modes?: {
          currentModeId: string;
          availableModes: { id: string; name: string; description?: string }[];
        };
      }>("acp.newSession", { agentId });
      this.set((state) => {
        state.agentId = agentId;
        state.sessionId = session.sessionId;
        state.workspace = session.workspace;
        state.modes = session.modes?.availableModes ?? [];
        state.currentModeId = session.modes?.currentModeId;
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
      state.workspace = undefined;
      state.modes = [];
      state.currentModeId = undefined;
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
      // Rebuilt every turn rather than once per session: the user switches
      // notes and writes new ones while the conversation is open, and an
      // index captured at connect time goes stale immediately.
      const workspace = this.get().workspace;
      const blocks: { type: "text"; text: string }[] = [];
      if (workspace) {
        const { index } = await buildNoteIndex(workspace);
        blocks.push({ type: "text", text: index });
      }
      blocks.push({ type: "text", text: message });

      const result = await rpc<{ stopReason: string }>("acp.prompt", {
        agentId,
        sessionId,
        prompt: blocks
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

  /** Switch the agent's operating mode; unlike a model, this is live. */
  setMode = async (modeId: string) => {
    const { agentId, sessionId } = this.get();
    if (!agentId || !sessionId) return;
    const previous = this.get().currentModeId;
    this.set((state) => {
      state.currentModeId = modeId;
    });
    try {
      await rpc("acp.setMode", { agentId, sessionId, modeId });
    } catch (e) {
      // Put it back: showing a mode the agent did not accept would be a lie
      // about what it is doing.
      this.set((state) => {
        state.currentModeId = previous;
        state.error = e instanceof Error ? e.message : String(e);
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
      case "current_mode_update":
        // The agent switched modes itself, which it is allowed to do.
        store.set((draft) => {
          draft.currentModeId = String(update.currentModeId ?? "");
        });
        break;
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
/**
 * Which note the agent means.
 *
 * Agents are inconsistent about how they echo a path back: some use the
 * absolute one they were given, some the bare name, some prefix "./". All
 * three name the same note, so all three resolve.
 */
function noteIdForPath(path: string): string | undefined {
  const direct = pathToNoteId.get(path);
  if (direct) return direct;
  const normalised = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return pathToNoteId.get(normalised) ??
    pathToNoteId.get(normalised.split("/").pop() ?? "");
}

async function readNoteForAgent(payload: unknown): Promise<string> {
  const request = payload as { path: string };
  const noteId = noteIdForPath(request.path);
  if (!noteId) throw new Error(`No note at ${request.path}`);

  // Checked again here rather than trusting the index: the index is built per
  // turn, and this is the boundary the agent actually crosses.
  if (await isVaultNote(noteId)) {
    throw new Error(`No note at ${request.path}`);
  }

  const note = await db.notes.note(noteId);
  if (!note) throw new Error(`No note at ${request.path}`);

  const content = await exportContent(note, { format: "md-sync" });
  if (!content) throw new Error(`Could not read ${request.path}`);
  return content;
}

async function writeNoteFromAgent(payload: unknown): Promise<void> {
  const request = payload as { path: string; content: string };
  const noteId = noteIdForPath(request.path);
  if (noteId && (await isVaultNote(noteId))) {
    throw new Error(`No note at ${request.path}`);
  }
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

/**
 * Remember which note a path stands for, so the agent can be handed one.
 *
 * `buildNoteIndex` is the normal caller; this stays exported for a caller that
 * wants to expose a single note without rebuilding the whole index.
 */
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

  // refresh() records its own failure into `error` rather than throwing.
  void store.refresh();
}

attachRuntimeListeners();

export { store, useStore };
