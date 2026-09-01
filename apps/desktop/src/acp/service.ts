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

import {
  AcpClient,
  AcpProtocolError,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  StreamTransport,
} from "@notesnook/acp";
import { join } from "@std/path";
import {
  AGENT_CATALOG,
  type AgentCatalogEntry,
  catalogEntry,
  isPermittedCommand,
} from "./catalog.ts";
import { logger } from "../native/logger.ts";
import { cacheDir } from "../native/paths.ts";
import { APP_NAME, APP_VERSION } from "../constants.ts";

const log = logger.scope("acp");

/** Kept small: enough to explain a failed launch, not enough to leak a note. */
const STDERR_LINES = 50;

export interface AgentStatusReport {
  id: string;
  name: string;
  summary: string;
  installed: boolean;
  /** Absolute path we would run, once resolved. */
  resolvedPath?: string;
  connected: boolean;
  /** Set once connected: what the agent called itself. */
  agentTitle?: string;
  agentVersion?: string;
  /** Empty means no sign-in step is needed — the one-click path. */
  authMethods: { id: string; name: string; description?: string }[];
  install?: { npm?: string; docs: string };
  authHint: string;
  /** Last launch failure, if any. */
  error?: string;
}

export interface AcpServiceOptions {
  /** Push an event to the interface. */
  emit(event: string, payload: unknown): void;
  /** Read a note rendered as Markdown, addressed by workspace-relative path. */
  readNote(sessionId: string, path: string): Promise<string>;
  /** Apply Markdown back to a note. */
  writeNote(sessionId: string, path: string, content: string): Promise<void>;
  /** Whether the user has consented to launching this agent before. */
  isApproved(agentId: string, resolvedPath: string): boolean;
  /** Record consent after the user grants it. */
  approve(agentId: string, resolvedPath: string): void;
}

interface Connection {
  agentId: string;
  client: AcpClient;
  child: Deno.ChildProcess;
  workspace: string;
  stderr: string[];
  sessions: Set<string>;
}

/**
 * Launches and supervises ACP agents.
 *
 * THE SECURITY POSITION, STATED PLAINLY
 *
 * Before this existed, nothing in Openotes could start a process the user had
 * not already agreed to through the OS — the runtime's subprocess allowlist
 * held twelve binaries, all of them OS integration like `xdg-open`.
 *
 * Hosting an agent means running one. What is preserved:
 *
 *  - The renderer still cannot spawn anything. It names a catalog id; the
 *    command line comes from the catalog, never from the interface.
 *  - The allowlist is still a fixed list of names, not `run: true`.
 *  - argv is always an array, never a shell string.
 *  - A first launch needs explicit consent, recorded against the *resolved
 *    absolute path*. If the binary at that path changes, consent is asked for
 *    again — an agent that was replaced is not the agent that was approved.
 *
 * What is genuinely given up: an approved agent is a program running with the
 * user's privileges, and Openotes cannot constrain what it does beyond
 * refusing to grant it a terminal. That is the trade, and SECURITY.md says so.
 */
export class AcpService {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly options: AcpServiceOptions) {}

  /** What the settings screen shows: every agent, installed or not. */
  async listAgents(): Promise<AgentStatusReport[]> {
    const reports: AgentStatusReport[] = [];
    for (const entry of AGENT_CATALOG) {
      const resolved = await resolveLauncher(entry);
      const connection = this.connections.get(entry.id);
      reports.push({
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        installed: resolved !== undefined,
        resolvedPath: resolved?.path,
        connected: connection !== undefined,
        agentTitle: connection?.client.agentInfo?.title,
        agentVersion: connection?.client.agentInfo?.version,
        authMethods: [],
        install: entry.install,
        authHint: entry.authHint,
      });
    }
    return reports;
  }

  /**
   * Start an agent and complete the handshake.
   *
   * Returns the agent's auth methods; an empty list means it is already signed
   * in and the interface should go straight to a session rather than inventing
   * a login step.
   */
  async connect(agentId: string): Promise<AgentStatusReport> {
    const existing = this.connections.get(agentId);
    if (existing) {
      return (await this.listAgents()).find((a) => a.id === agentId)!;
    }

    const entry = catalogEntry(agentId);
    if (!entry || entry.id === "custom") {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    const launcher = await resolveLauncher(entry);
    if (!launcher) {
      throw new Error(
        `${entry.name} is not installed. ${
          entry.install?.npm
            ? `Install it with: npm install -g ${entry.install.npm}`
            : `See ${entry.install?.docs ?? "its documentation"}.`
        }`,
      );
    }

    // Belt and braces: the manifest enforces this, but failing here produces a
    // message a person can act on instead of an opaque permission error.
    if (!isPermittedCommand(launcher.command)) {
      throw new Error(
        `Refusing to run "${launcher.command}": not in the permitted list.`,
      );
    }

    if (!this.options.isApproved(agentId, launcher.path)) {
      throw new AgentApprovalRequired(agentId, entry.name, launcher.path);
    }

    const workspace = await Deno.makeTempDir({
      prefix: `openotes-agent-${agentId}-`,
      dir: cacheDir(),
    });

    log.info("Launching agent", {
      agentId,
      command: launcher.command,
      workspace,
    });

    const child = new Deno.Command(launcher.command, {
      args: launcher.args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      cwd: workspace,
    }).spawn();

    const connection: Connection = {
      agentId,
      client: undefined as unknown as AcpClient,
      child,
      workspace,
      stderr: [],
      sessions: new Set(),
    };

    void this.drainStderr(connection);

    const client = new AcpClient({
      transport: new StreamTransport(child.stdout, child.stdin),
      clientInfo: {
        name: APP_NAME.toLowerCase(),
        title: APP_NAME,
        version: APP_VERSION,
      },
      capabilities: { readNotes: true, writeNotes: true },
      handlers: {
        onUpdate: (notification: SessionNotification) =>
          this.options.emit("acp.update", { agentId, ...notification }),
        onPermission: (request: RequestPermissionRequest) =>
          this.requestPermission(agentId, request),
        readTextFile: (request) =>
          this.options.readNote(request.sessionId, request.path),
        writeTextFile: (request) =>
          this.options.writeNote(
            request.sessionId,
            request.path,
            request.content,
          ),
        onError: (error) =>
          log.warn("Agent transport error", { agentId, error: error.message }),
      },
    });
    connection.client = client;
    this.connections.set(agentId, connection);

    try {
      const info = await client.initialize();
      const report = (await this.listAgents()).find((a) => a.id === agentId)!;
      report.authMethods = (info.authMethods ?? []).map((method) => ({
        id: method.id,
        name: method.name,
        description: method.description,
      }));
      this.options.emit("acp.status", { agentId, connected: true });
      return report;
    } catch (e) {
      // A handshake that fails leaves no half-connected agent behind, and the
      // stderr tail is usually the only thing that explains why.
      await this.disconnect(agentId);
      const detail = connection.stderr.slice(-5).join("\n");
      const message = e instanceof AcpProtocolError
        ? e.message
        : `${entry.name} did not start: ${
          e instanceof Error ? e.message : String(e)
        }`;
      throw new Error(detail ? `${message}\n\n${detail}` : message);
    }
  }

  async authenticate(agentId: string, methodId: string): Promise<void> {
    await this.connectionFor(agentId).client.authenticate(methodId);
  }

  async newSession(agentId: string): Promise<string> {
    const connection = this.connectionFor(agentId);
    // cwd must be a real absolute path — a real agent rejects a URI here.
    // The directory stays empty: notes are answered from the database through
    // the fs handlers, never written to disk.
    const session = await connection.client.newSession(connection.workspace);
    connection.sessions.add(session.sessionId);
    return session.sessionId;
  }

  async prompt(
    agentId: string,
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<{ stopReason: string }> {
    const connection = this.connectionFor(agentId);
    const response = await connection.client.prompt({ sessionId, prompt });
    return { stopReason: response.stopReason };
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    await this.connectionFor(agentId).client.cancel(sessionId);
  }

  async setMode(
    agentId: string,
    sessionId: string,
    modeId: string,
  ): Promise<void> {
    await this.connectionFor(agentId).client.setMode(sessionId, modeId);
  }

  /** Grant the consent a connect() attempt asked for, then retry it. */
  approveAgent(agentId: string, resolvedPath: string): void {
    this.options.approve(agentId, resolvedPath);
  }

  /** The tail of what the agent printed, for diagnosing a failed launch. */
  diagnostics(agentId: string): string[] {
    return this.connections.get(agentId)?.stderr ?? [];
  }

  async disconnect(agentId: string): Promise<void> {
    const connection = this.connections.get(agentId);
    if (!connection) return;
    this.connections.delete(agentId);
    try {
      await connection.client?.close();
    } catch {
      // Already gone.
    }
    try {
      connection.child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    try {
      await Deno.remove(connection.workspace, { recursive: true });
    } catch {
      // Best effort; the cache directory is cleaned on startup anyway.
    }
    this.options.emit("acp.status", { agentId, connected: false });
  }

  async stop(): Promise<void> {
    for (const agentId of [...this.connections.keys()]) {
      await this.disconnect(agentId);
    }
  }

  private connectionFor(agentId: string): Connection {
    const connection = this.connections.get(agentId);
    if (!connection) throw new Error(`${agentId} is not connected`);
    return connection;
  }

  /**
   * Ask the interface. The promise is what blocks the agent's tool call, so a
   * prompt the user never answers holds the turn rather than being assumed.
   */
  private requestPermission(
    agentId: string,
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      pendingPermissions.set(requestId, resolve);
      this.options.emit("acp.permission", { agentId, requestId, request });
    });
  }

  private async drainStderr(connection: Connection): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of connection.child.stderr) {
        for (const line of decoder.decode(chunk).split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          connection.stderr.push(trimmed);
          if (connection.stderr.length > STDERR_LINES) {
            connection.stderr.shift();
          }
        }
      }
    } catch {
      // The process went away; nothing further to drain.
    }
  }
}

/**
 * Thrown when an agent has never been approved on this machine. Carries what
 * the interface needs to ask the question, so the caller does not have to
 * reconstruct it.
 */
export class AgentApprovalRequired extends Error {
  constructor(
    readonly agentId: string,
    readonly agentName: string,
    readonly resolvedPath: string,
  ) {
    super(`${agentName} has not been approved to run on this computer yet.`);
    this.name = "AgentApprovalRequired";
  }
}

/** Answers to permission prompts, keyed by the id the interface was given. */
const pendingPermissions = new Map<
  string,
  (response: RequestPermissionResponse) => void
>();

export function resolvePermission(
  requestId: string,
  response: RequestPermissionResponse,
): boolean {
  const resolve = pendingPermissions.get(requestId);
  if (!resolve) return false;
  pendingPermissions.delete(requestId);
  resolve(response);
  return true;
}

/** First launcher whose binary is on PATH, with the path it resolved to. */
async function resolveLauncher(
  entry: AgentCatalogEntry,
): Promise<{ command: string; args: string[]; path: string } | undefined> {
  for (const launcher of entry.launchers) {
    const path = await which(launcher.command);
    if (path) return { ...launcher, path };
  }
  return undefined;
}

/**
 * Where a command lives, or undefined.
 *
 * PATH is walked directly rather than shelling out to `which`, because
 * spawning a shell to find out what we are allowed to spawn is the wrong shape
 * — and `which` is not on the permitted list, correctly.
 */
async function which(command: string): Promise<string | undefined> {
  const path = Deno.env.get("PATH");
  if (!path) return undefined;
  const isWindows = Deno.build.os === "windows";
  const separator = isWindows ? ";" : ":";
  const extensions = isWindows ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const directory of path.split(separator)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      try {
        const info = await Deno.stat(candidate);
        if (info.isFile) return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}
