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

import { RpcError, RpcPeer, type Transport } from "./jsonrpc.ts";
import {
  type AuthenticateRequest,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  PROTOCOL_VERSION,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
} from "./types.ts";

/**
 * What the host must supply for Openotes to act as an ACP client.
 *
 * Note the shape of the filesystem hooks: ACP describes files, Openotes has
 * notes. The mapping lives above this class (a note is addressed as
 * `openotes://note/<id>`), so the protocol never learns about notes and the
 * note layer never learns about JSON-RPC.
 */
export interface AcpClientHandlers {
  /** Streamed output: message chunks, thoughts, tool calls, plans. */
  onUpdate(notification: SessionNotification): void;
  /**
   * The agent wants to do something that needs consent. Returning
   * `{outcome: "cancelled"}` refuses without ending the turn.
   *
   * This blocks the agent until it resolves, which is the point: a permission
   * prompt that the agent can race past is not a permission prompt.
   */
  onPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
  readTextFile?(request: ReadTextFileRequest): Promise<string>;
  writeTextFile?(request: WriteTextFileRequest): Promise<void>;
  /** Diagnostics; never protocol traffic. */
  onError?(error: Error): void;
}

export interface AcpClientOptions {
  transport: Transport;
  handlers: AcpClientHandlers;
  clientInfo?: { name: string; title?: string; version?: string };
  /**
   * Whether the client offers note reading and writing. Off means the agent is
   * told so at initialize and will not attempt it.
   */
  capabilities?: { readNotes?: boolean; writeNotes?: boolean };
}

export class AcpProtocolError extends Error {
  constructor(message: string, readonly agentVersion?: number) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

/**
 * The client half of the Agent Client Protocol.
 *
 * Openotes hosts agents; it is never an agent itself, so only this half
 * exists. Terminal support is deliberately absent rather than declared and
 * refused: an agent that is told `terminal: false` will not try to run
 * commands, and a notes application has no business granting a shell.
 */
export class AcpClient {
  private readonly peer: RpcPeer;
  private initialized?: InitializeResponse;

  constructor(private readonly options: AcpClientOptions) {
    this.peer = new RpcPeer(options.transport);
    const { handlers } = options;

    this.peer.notified("session/update", (params) => {
      handlers.onUpdate(params as SessionNotification);
    });

    this.peer.handle("session/request_permission", async (params) => {
      return await handlers.onPermission(params as RequestPermissionRequest);
    });

    this.peer.handle("fs/read_text_file", async (params) => {
      const request = params as ReadTextFileRequest;
      if (!handlers.readTextFile) {
        throw new Error("This client does not provide file reading");
      }
      const content = await handlers.readTextFile(request);
      return { content } satisfies ReadTextFileResponse;
    });

    this.peer.handle("fs/write_text_file", async (params) => {
      const request = params as WriteTextFileRequest;
      if (!handlers.writeTextFile) {
        throw new Error("This client does not provide file writing");
      }
      await handlers.writeTextFile(request);
      return {};
    });

    options.transport.onError((error) => handlers.onError?.(error));
  }

  /**
   * Negotiate. Returns what the agent reported, including `authMethods` —
   * an empty array means no sign-in step is needed, which is the common case
   * when the agent's own CLI is already authenticated.
   */
  async initialize(): Promise<InitializeResponse> {
    const capabilities = this.options.capabilities ?? {};
    const response = await this.peer.request<InitializeResponse>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: capabilities.readNotes ?? false,
          writeTextFile: capabilities.writeNotes ?? false,
        },
        terminal: false,
      },
      clientInfo: this.options.clientInfo,
    });

    // The spec says an agent that cannot speak our version answers with the
    // latest it supports. There is only version 1 today, so anything else is
    // a mismatch we must surface rather than guess at.
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      throw new AcpProtocolError(
        `This agent speaks Agent Client Protocol version ` +
          `${response.protocolVersion}; Openotes speaks ${PROTOCOL_VERSION}. ` +
          `Updating either one should resolve it.`,
        response.protocolVersion,
      );
    }

    this.initialized = response;
    return response;
  }

  get agentInfo() {
    return this.initialized?.agentInfo;
  }

  get agentCapabilities() {
    return this.initialized?.agentCapabilities;
  }

  /** True when the agent asked for no sign-in — the one-click path. */
  get isAuthenticated(): boolean {
    return (this.initialized?.authMethods?.length ?? 0) === 0;
  }

  async authenticate(methodId: string): Promise<void> {
    await this.peer.request<unknown>(
      "authenticate",
      {
        methodId,
      } satisfies AuthenticateRequest,
    );
  }

  /**
   * Start a session. `cwd` must be absolute per the spec; Openotes passes an
   * `openotes://` URI, which satisfies that and cannot be mistaken for a real
   * directory on disk.
   */
  async newSession(cwd: string): Promise<NewSessionResponse> {
    return await this.peer.request<NewSessionResponse>("session/new", {
      cwd,
      mcpServers: [],
    });
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await this.peer.request<unknown>("session/load", { sessionId, cwd });
  }

  /**
   * Run one turn. Resolves when the agent stops; everything it produced on the
   * way arrived through `onUpdate`.
   *
   * An `authRequired` error is translated, because "-32000" tells a user
   * nothing and this is the one protocol error they can actually act on.
   */
  async prompt(request: PromptRequest): Promise<PromptResponse> {
    try {
      return await this.peer.request<PromptResponse>("session/prompt", request);
    } catch (e) {
      if (e instanceof RpcError && e.isAuthRequired) {
        throw new AcpProtocolError(
          "This agent needs you to sign in before it can answer.",
        );
      }
      throw e;
    }
  }

  /**
   * Ask the agent to stop. A notification, not a request: the turn's own
   * promise is what resolves, with stopReason "cancelled".
   */
  async cancel(sessionId: string): Promise<void> {
    await this.peer.notify("session/cancel", { sessionId });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.peer.request<unknown>("session/set_mode", { sessionId, modeId });
  }

  async close(): Promise<void> {
    await this.peer.close();
  }
}
