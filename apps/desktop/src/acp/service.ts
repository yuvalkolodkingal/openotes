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
  type AuthMethod,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionMode,
  type SessionModelState,
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

/** How long a terminal sign-in may take before it is abandoned. */
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export interface AgentAuthMethodReport {
  id: string;
  name: string;
  description?: string;
  /** "terminal" means the protocol cannot complete it; see `command`. */
  type?: string;
  /**
   * The command the user would run in a terminal to complete this sign-in,
   * when the agent described one. Shown so the user can do it by hand, and
   * run by `signIn` when the program it names is one Openotes may launch.
   */
  command?: string;
  /** Whether `signIn` can run that command rather than only showing it. */
  runnable: boolean;
}

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
  authMethods: AgentAuthMethodReport[];
  install?: { npm?: string; docs: string };
  authHint: string;
  /** Models this agent can be asked for at launch; empty means no choice. */
  models: { id: string; name: string }[];
  /** Whether a free-typed model name can be passed to this agent. */
  acceptsCustomModel: boolean;
  /** The model this connection was started with, if any. */
  modelId?: string;
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
  /**
   * Whether the user has consented to launching this agent before.
   *
   * Recording that consent is the RPC handler's job, not this service's: it
   * owns the settings store. This asks the question and never answers it.
   */
  isApproved(agentId: string, resolvedPath: string): boolean;
  /**
   * Open a URL in the system browser. A terminal sign-in prints the page to
   * visit; opening it is the one thing that turns "run this in a terminal"
   * into a flow the user can finish from inside Openotes.
   */
  openUrl?(url: string): Promise<void>;
}

interface Connection {
  agentId: string;
  /** The model this process was started with; fixed for its lifetime. */
  modelId?: string;
  /** The launcher that started it, kept for describing sign-in commands. */
  launcher: ResolvedLauncher;
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
      // "Installed" means one of this agent's own binaries is present. The
      // launcher may still be `npx`, which resolves everywhere Node does and
      // would otherwise report every agent as installed.
      const detected = await resolveDetected(entry);
      const resolved = await resolveLauncher(entry);
      const connection = this.connections.get(entry.id);
      reports.push({
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        installed: detected?.launchable === true,
        resolvedPath: detected?.path ?? resolved?.path,
        connected: connection !== undefined,
        agentTitle: connection?.client.agentInfo?.title,
        agentVersion: connection?.client.agentInfo?.version,
        // Read from the live connection rather than hardcoded empty: the
        // interface refreshes this list right after connecting, so an empty
        // array here erased the sign-in methods the handshake had just
        // reported and left every agent claiming it was already signed in.
        authMethods: (connection?.client.authMethods ?? []).map((method) =>
          describeAuthMethod(method, connection!.launcher)
        ),
        install: entry.install,
        authHint: entry.authHint,
        models: (entry.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
        })),
        acceptsCustomModel: entry.modelEnvVar !== undefined,
        modelId: connection?.modelId,
        // Present but unreachable is its own state, and the only one the user
        // can act on: telling them to install what they already installed
        // would be worse than saying nothing.
        error: detected && !detected.launchable
          ? `Found at ${detected.path}, but Openotes can only launch programs ` +
            `on its own PATH. Add that directory to your PATH and restart ` +
            `Openotes, or start Openotes from a terminal.`
          : undefined,
      });
    }
    return reports;
  }

  /**
   * Start an agent, optionally asking it for a particular model.
   *
   * Returns the agent's report, including its auth methods; an empty list
   * means it is already signed in and the interface should go straight to a
   * session rather than inventing a login step.
   *
   * The model is fixed when the process starts -- a launch-time model is an
   * environment variable or flag -- so switching means reconnecting, and an
   * already-running connection with a different model is replaced rather
   * than reused. (A model the agent offers *inside* a session is different:
   * see `setModel`, which is live.)
   */
  async connect(
    agentId: string,
    modelId?: string,
  ): Promise<AgentStatusReport> {
    const existing = this.connections.get(agentId);
    if (existing) {
      if (existing.modelId === modelId) {
        return (await this.listAgents()).find((a) => a.id === agentId)!;
      }
      await this.disconnect(agentId);
    }

    const entry = catalogEntry(agentId);
    if (!entry) {
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
    // message a person can act on instead of an opaque permission error. Both
    // the catalog command and the program actually spawned are checked: on
    // Windows they differ (see spawnPlan).
    for (const command of [launcher.command, launcher.spawn.command]) {
      if (!isPermittedCommand(command)) {
        throw new Error(
          `Refusing to run "${command}": not in the permitted list.`,
        );
      }
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
      command: launcher.spawn.command,
      args: launcher.spawn.args,
      workspace,
    });

    // A listed model contributes arguments, an environment variable, or both;
    // an unlisted one is passed through the agent's own variable when it has
    // one. Anything unrecognised is ignored rather than guessed at.
    const chosen = entry.models?.find((model) => model.id === modelId);
    const custom = !chosen && modelId && entry.modelEnvVar
      ? { [entry.modelEnvVar]: modelId }
      : undefined;
    const modelEnv = { ...(chosen?.env ?? {}), ...(custom ?? {}) };

    const child = new Deno.Command(launcher.spawn.command, {
      args: [...launcher.spawn.args, ...(chosen?.args ?? [])],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      cwd: workspace,
      // Merged with the inherited environment, not replacing it: the agent
      // still needs its own credentials, PATH and config directory.
      ...(Object.keys(modelEnv).length > 0 ? { env: modelEnv } : {}),
    }).spawn();

    const connection: Connection = {
      agentId,
      modelId,
      launcher,
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
      await client.initialize();
      // listAgents() now reads the auth methods off the live connection, so
      // the report is already correct and does not need patching afterwards.
      const report = (await this.listAgents()).find((a) => a.id === agentId)!;
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

  /**
   * Complete a sign-in method.
   *
   * Two kinds exist. A protocol method is answered by the agent itself over
   * `authenticate`. A *terminal* method is one the agent refuses over the
   * protocol -- the Claude adapter answers "Method not implemented" -- and
   * describes as a command instead. For those, the command is run here when
   * it names a program Openotes may launch, its output is watched for the
   * page to sign in on, and that page is opened in the browser. Either way
   * the agent is restarted afterwards, because it read its credentials when
   * it started.
   */
  async signIn(
    agentId: string,
    methodId: string,
  ): Promise<{ output: string[] }> {
    const connection = this.connectionFor(agentId);
    const method = connection.client.authMethods.find((m) => m.id === methodId);
    if (!method) {
      throw new Error(`${agentId} offers no sign-in method "${methodId}".`);
    }

    if (method.type !== "terminal") {
      await connection.client.authenticate(methodId);
      return { output: [] };
    }

    const plan = terminalAuthPlan(method, connection.launcher);
    const described = describeAuthMethod(method, connection.launcher);
    if (!plan) {
      throw new Error(
        `${described.name} has to be completed in a terminal. Run this, then connect again:\n\n` +
          `  ${described.command ?? method.description ?? methodId}`,
      );
    }

    log.info("Running a terminal sign-in", {
      agentId,
      methodId,
      command: plan.command,
    });
    const child = new Deno.Command(plan.command, {
      args: plan.args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      cwd: connection.workspace,
    }).spawn();

    const output: string[] = [];
    let opened = false;
    const watch = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for await (const chunk of stream) {
          buffered += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (!line) continue;
            output.push(line);
            if (output.length > 200) output.shift();
            // The login prints the page to visit. Opening it is the whole
            // point; a URL left in a log nobody sees would be a dead end.
            const url = /https?:\/\/[^\s"'<>]+/.exec(line)?.[0];
            if (url && !opened && this.options.openUrl) {
              opened = true;
              await this.options.openUrl(url).catch((error) =>
                log.warn("Could not open the sign-in page", {
                  error: error instanceof Error ? error.message : String(error),
                })
              );
            }
          }
        }
      } catch {
        // The process went away.
      }
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }, SIGN_IN_TIMEOUT_MS);
    try {
      const [status] = await Promise.all([
        child.status,
        watch(child.stdout),
        watch(child.stderr),
      ]);
      if (!status.success) {
        throw new Error(
          `The sign-in command exited with code ${status.code}.` +
            (output.length ? `\n\n${output.slice(-5).join("\n")}` : ""),
        );
      }
    } finally {
      clearTimeout(timer);
    }

    // Credentials are read at startup, so the running process still has
    // none. Restart it under the same model.
    const modelId = connection.modelId;
    await this.disconnect(agentId);
    await this.connect(agentId, modelId);
    return { output };
  }

  /** Answer a protocol sign-in method directly. Kept for callers that know. */
  async authenticate(agentId: string, methodId: string): Promise<void> {
    await this.signIn(agentId, methodId);
  }

  async newSession(
    agentId: string,
  ): Promise<
    {
      sessionId: string;
      workspace: string;
      modes?: { currentModeId: string; availableModes: SessionMode[] };
      models?: SessionModelState;
    }
  > {
    const connection = this.connectionFor(agentId);
    // cwd must be a real absolute path — a real agent rejects a URI here.
    // The directory stays empty: notes are answered from the database through
    // the fs handlers, never written to disk.
    const session = await connection.client.newSession(connection.workspace);
    connection.sessions.add(session.sessionId);
    // The workspace goes back with the id because the interface has to name
    // notes as paths inside it; without it there is no way to tell the agent
    // where a note lives, which is why nothing could be read.
    // The agent's modes and models travel with the session rather than being
    // dropped: "ask" and "code" behave differently enough that hiding the
    // switch made the agent look inconsistent, and a model the agent offers
    // is the one choice that can be made without restarting it.
    return {
      sessionId: session.sessionId,
      workspace: connection.workspace,
      modes: session.modes,
      models: session.models,
    };
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

  /** Switch a session's model, live. Only for models the agent offered. */
  async setModel(
    agentId: string,
    sessionId: string,
    modelId: string,
  ): Promise<void> {
    await this.connectionFor(agentId).client.setModel(sessionId, modelId);
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

// ---------------------------------------------------------------------------
// Sign-in methods that need a terminal
// ---------------------------------------------------------------------------

interface TerminalAuthMeta {
  command?: string;
  args?: string[];
  label?: string;
}

function terminalAuthMeta(method: AuthMethod): TerminalAuthMeta | undefined {
  const meta = method._meta?.["terminal-auth"];
  if (!meta || typeof meta !== "object") return undefined;
  const record = meta as Record<string, unknown>;
  return {
    command: typeof record.command === "string" ? record.command : undefined,
    args: Array.isArray(record.args)
      ? record.args.filter((a): a is string => typeof a === "string")
      : undefined,
    label: typeof record.label === "string" ? record.label : undefined,
  };
}

/**
 * The command a person would type for a terminal sign-in.
 *
 * The adapter describes it as its own runtime and entry script -- something
 * like `/usr/bin/node …/dist/index.js --cli auth login` -- which is exact and
 * unreadable. The agent's own launcher with the same trailing arguments is
 * the same command in the form people install it under, so that is what is
 * shown; the exact form is what gets run.
 */
export function describeAuthMethod(
  method: AuthMethod,
  launcher: ResolvedLauncher,
): AgentAuthMethodReport {
  const report: AgentAuthMethodReport = {
    id: method.id,
    name: method.name,
    description: method.description,
    type: method.type,
    runnable: false,
  };
  if (method.type !== "terminal") return report;

  const meta = terminalAuthMeta(method);
  const extra = (method as unknown as { args?: unknown }).args;
  const trailing = Array.isArray(extra)
    ? extra.filter((a): a is string => typeof a === "string")
    : meta?.args?.filter((arg) => !arg.endsWith(".js")) ?? [];
  report.command = [launcher.command, ...launcher.args, ...trailing].join(" ");
  report.runnable = terminalAuthPlan(method, launcher) !== undefined;
  return report;
}

/**
 * How to run a terminal sign-in from here, or undefined when it cannot be.
 *
 * Preference order: the exact command the agent described, when it names a
 * permitted program; otherwise the agent's own launcher with the method's
 * arguments appended, which is how the Claude adapter's `--cli auth login`
 * is spelled. Anything else is shown to the user rather than guessed at.
 */
function terminalAuthPlan(
  method: AuthMethod,
  launcher: ResolvedLauncher,
): { command: string; args: string[] } | undefined {
  const meta = terminalAuthMeta(method);
  if (meta?.command && meta.args && isPermittedCommand(meta.command)) {
    return { command: meta.command, args: meta.args };
  }
  const extra = (method as unknown as { args?: unknown }).args;
  if (Array.isArray(extra) && extra.every((a) => typeof a === "string")) {
    return {
      command: launcher.spawn.command,
      args: [...launcher.spawn.args, ...(extra as string[])],
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Finding agents
// ---------------------------------------------------------------------------

/**
 * Places agents get installed that a desktop launcher's PATH will not have.
 *
 * An application started from a dock, a .desktop file or an AppImage inherits
 * a minimal PATH, not the one a login shell builds. An agent installed with
 * npm -g under nvm, or with Homebrew, is invisible to it -- which reads to the
 * user as "not installed" when it plainly is. (The packaged Linux launchers
 * now extend PATH before the runtime starts -- see packaging/linux/
 * openotes-launcher.sh -- so this is the fallback that explains the case
 * they miss.)
 */
function extraDirs(): string[] {
  let home: string | undefined;
  let appData: string | undefined;
  try {
    home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
    appData = Deno.env.get("APPDATA");
  } catch {
    return [];
  }
  if (!home) return [];

  const dirs = [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, ".volta", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  // npm's global prefix on Windows.
  if (appData) dirs.push(join(appData, "npm"));

  // nvm keeps a directory per installed Node version; any of them may hold a
  // globally installed adapter.
  const nvm = join(home, ".nvm", "versions", "node");
  try {
    for (const entry of Deno.readDirSync(nvm)) {
      if (entry.isDirectory) dirs.push(join(nvm, entry.name, "bin"));
    }
  } catch {
    // No nvm here.
  }
  return dirs;
}

/**
 * Where this agent's own binary is, and whether it can actually be launched.
 *
 * The distinction is forced by how the permission set works. Deno resolves
 * `--allow-run=gemini` to the binary on PATH when the process starts, and
 * refuses any other path afterwards -- verified: an allowlisted name at an
 * unusual path is denied, and extending PATH later does not help. So a binary
 * found outside PATH is real, and is also unlaunchable, and saying "not
 * installed" would send the user to reinstall something they already have.
 */
async function resolveDetected(
  entry: AgentCatalogEntry,
): Promise<{ path: string; launchable: boolean } | undefined> {
  for (const candidate of entry.detect) {
    const onPath = await which(candidate);
    if (onPath) return { path: onPath, launchable: true };
  }
  const extra = extraDirs();
  for (const candidate of entry.detect) {
    const elsewhere = await which(candidate, extra);
    if (elsewhere) return { path: elsewhere, launchable: false };
  }
  return undefined;
}

export interface ResolvedLauncher {
  /** The catalog command, as the user knows it. */
  command: string;
  args: string[];
  /** Where it resolved to on PATH; what consent is recorded against. */
  path: string;
  /** What is actually spawned. Identical to the catalog entry except on Windows. */
  spawn: { command: string; args: string[] };
}

/** First launcher whose binary is on PATH, with the path it resolved to. */
async function resolveLauncher(
  entry: AgentCatalogEntry,
): Promise<ResolvedLauncher | undefined> {
  for (const launcher of entry.launchers) {
    const path = await which(launcher.command);
    if (path) {
      return {
        ...launcher,
        path,
        spawn: await spawnPlan(launcher.command, launcher.args, path),
      };
    }
  }
  return undefined;
}

/**
 * What to hand to Deno.Command so that this program actually starts.
 *
 * On Linux and macOS the name is enough: the kernel runs an npm shim through
 * its `#!/usr/bin/env node` line. On Windows it is not. An npm-installed
 * agent is `claude-agent-acp.cmd`, a batch file, and the runtime's process
 * spawner resolves a bare name by appending `.exe` -- so every agent installed
 * with `npm install -g` failed with "program not found" the moment it was
 * launched, however correctly it had been detected. This is why nothing
 * worked on Windows.
 *
 * The shim is npm's own, and its last line names the script it runs:
 * `"%_prog%" "%dp0%\node_modules\<pkg>\dist\index.js" %*`. Running that
 * script under `node` directly is what the shim would have done, with no
 * cmd.exe quoting in the way. A `.cmd` that is not an npm shim goes through
 * cmd.exe, which is the only thing that can start one.
 */
export async function spawnPlan(
  command: string,
  args: string[],
  resolvedPath: string,
  os: typeof Deno.build.os = Deno.build.os,
  readShim: (path: string) => Promise<string> = (path) =>
    Deno.readTextFile(path),
): Promise<{ command: string; args: string[] }> {
  if (os !== "windows") return { command, args };
  const lower = resolvedPath.toLowerCase();
  if (!lower.endsWith(".cmd") && !lower.endsWith(".bat")) {
    return { command, args };
  }
  const entry = await npmShimEntry(resolvedPath, readShim);
  if (entry) return { command: "node", args: [entry, ...args] };
  return { command: "cmd", args: ["/d", "/c", resolvedPath, ...args] };
}

/** The script an npm `.cmd` shim runs, as an absolute path, or undefined. */
export async function npmShimEntry(
  shimPath: string,
  readShim: (path: string) => Promise<string>,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readShim(shimPath);
  } catch {
    return undefined;
  }
  // Only an npm shim, recognised by its own idiom: it must run node, and it
  // must name exactly one script relative to its own directory.
  if (!/node(\.exe)?["\s]/i.test(text)) return undefined;
  const match = /"%dp0%\\([^"]+\.(?:c|m)?js)"/i.exec(text);
  if (!match) return undefined;
  // Joined by hand: this is a Windows path whatever platform the code runs
  // on, and @std/path's join would treat its backslashes as ordinary
  // characters anywhere else -- which is exactly where the tests run.
  const directory = shimPath.replace(/[\\/][^\\/]*$/, "");
  return `${directory}\\${match[1]}`;
}

/**
 * Where a command lives, or undefined.
 *
 * PATH is walked directly rather than shelling out to `which`, because
 * spawning a shell to find out what we are allowed to spawn is the wrong shape
 * — and `which` is not on the permitted list, correctly.
 */
async function which(
  command: string,
  dirs?: string[],
): Promise<string | undefined> {
  const isWindows = Deno.build.os === "windows";
  const separator = isWindows ? ";" : ":";

  // Reading an unlisted variable throws NotCapable rather than returning
  // undefined, and this is the only PATH read in the application; letting it
  // escape would reject acp.listAgents outright and show no agents at all,
  // with no clue why.
  let path: string | undefined;
  let pathext: string | undefined;
  try {
    path = Deno.env.get("PATH");
    pathext = isWindows ? Deno.env.get("PATHEXT") : undefined;
  } catch {
    path = undefined;
  }

  // Windows will not execute an extensionless file, so the bare name is not
  // a candidate there: an npm install leaves `gemini` (a POSIX shim for Git
  // Bash) beside `gemini.cmd`, and finding the former first reported a path
  // nothing could start.
  const extensions = isWindows ? windowsExtensions(pathext) : [""];

  for (const directory of dirs ?? path?.split(separator) ?? []) {
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

/** The extensions Windows tries, executables first, then batch shims. */
export function windowsExtensions(pathext: string | undefined): string[] {
  const preferred = [".exe", ".cmd", ".bat", ".com"];
  const listed = (pathext ?? "")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const rest = listed.filter((ext) => !preferred.includes(ext));
  return [...preferred, ...rest];
}
