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
 * JSON-RPC 2.0 framing, in both directions.
 *
 * ACP is bidirectional: the client calls the agent (`session/prompt`) and the
 * agent calls the client back mid-turn (`session/request_permission`,
 * `fs/read_text_file`). So this is a peer, not a client — it tracks outgoing
 * request ids *and* answers incoming ones.
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/** Standard codes, plus the one ACP adds for authentication. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** ACP: the agent needs `authenticate` before it can do this. */
  authRequired: -32000,
} as const;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }

  get isAuthRequired() {
    return this.code === JSON_RPC_ERRORS.authRequired;
  }
}

/**
 * These three classify a message; they are deliberately NOT used to narrow a
 * union by exclusion.
 *
 * JsonRpcRequest is structurally assignable to JsonRpcNotification — it has
 * everything a notification has, plus an id — so `if (isNotification(m))
 * return;` removes *both* from the union and leaves `never`. dispatch()
 * therefore branches on shape directly and casts once it knows.
 */
export function isRequest(m: JsonRpcMessage): boolean {
  const candidate = m as Partial<JsonRpcRequest>;
  return typeof candidate.method === "string" &&
    candidate.id !== undefined && candidate.id !== null;
}

export function isNotification(m: JsonRpcMessage): boolean {
  const candidate = m as Partial<JsonRpcRequest>;
  return typeof candidate.method === "string" &&
    (candidate.id === undefined || candidate.id === null);
}

export function isResponse(m: JsonRpcMessage): boolean {
  const candidate = m as Partial<JsonRpcRequest>;
  return typeof candidate.method !== "string";
}

/**
 * Moves messages. Newline-delimited JSON over a subprocess's stdio is the only
 * transport ACP defines, but keeping this an interface means a test can drive
 * a scripted agent through a pipe without spawning anything.
 */
export interface Transport {
  send(message: JsonRpcMessage): Promise<void>;
  /** Delivers parsed messages; a malformed line is reported, not thrown. */
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown) => void;

/**
 * A JSON-RPC peer over a transport.
 *
 * Every outgoing request is rejected if the transport closes first, because an
 * agent that crashes mid-turn would otherwise leave the interface waiting
 * forever on a promise that can never settle.
 */
export class RpcPeer {
  private nextId = 0;
  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler
  >();
  private closed = false;

  constructor(private readonly transport: Transport) {
    transport.onMessage((message) => void this.dispatch(message));
    transport.onClose(() =>
      this.failAllPending(new Error("Connection closed"))
    );
    transport.onError((error) => this.failAllPending(error));
  }

  /** Answer `method` when the other side calls it. */
  handle(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  notified(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error(`Cannot call ${method}: connection closed`);
    }
    const id = this.nextId++;
    const settled = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.transport.send({ jsonrpc: "2.0", id, method, params });
    return await settled as T;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return;
    await this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private async dispatch(message: JsonRpcMessage): Promise<void> {
    if (isResponse(message)) {
      const response = message as JsonRpcResponse;
      const entry = response.id === null
        ? undefined
        : this.pending.get(response.id);
      if (!entry) return; // A reply we never asked for, or already gave up on.
      this.pending.delete(response.id as number | string);
      if (response.error) {
        entry.reject(
          new RpcError(
            response.error.message,
            response.error.code,
            response.error.data,
          ),
        );
      } else {
        entry.resolve(response.result);
      }
      return;
    }

    if (isNotification(message)) {
      const notification = message as JsonRpcNotification;
      // A handler throwing must not take the connection down: a malformed
      // update is the agent's problem, not a reason to end the session.
      try {
        this.notificationHandlers.get(notification.method)?.(
          notification.params,
        );
      } catch {
        // Deliberately swallowed; see above.
      }
      return;
    }

    const request = message as JsonRpcRequest;
    const handler = this.requestHandlers.get(request.method);
    if (!handler) {
      await this.transport.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: JSON_RPC_ERRORS.methodNotFound,
          message: `Method not found: ${request.method}`,
        },
      });
      return;
    }
    try {
      const result = await handler(request.params);
      await this.transport.send({ jsonrpc: "2.0", id: request.id, result });
    } catch (e) {
      await this.transport.send({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: JSON_RPC_ERRORS.internalError,
          message: e instanceof Error ? e.message : String(e),
        },
      });
    }
  }

  private failAllPending(error: Error): void {
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(error);
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.failAllPending(new Error("Connection closed"));
    await this.transport.close();
  }
}
