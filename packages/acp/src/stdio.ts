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

import type { JsonRpcMessage, Transport } from "./jsonrpc.ts";

/**
 * Newline-delimited JSON over a pair of byte streams.
 *
 * Verified against @agentclientprotocol/claude-agent-acp v0.70.0: one JSON
 * document per line, no Content-Length headers, no LSP-style framing.
 *
 * Agents write diagnostics to stderr and protocol to stdout, so stderr is
 * never parsed here — the host drains it separately into a ring buffer, which
 * is the only way to explain a failed launch to the user.
 */
export class StreamTransport implements Transport {
  private messageHandler?: (message: JsonRpcMessage) => void;
  private errorHandler?: (error: Error) => void;
  private closeHandler?: () => void;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private closed = false;

  constructor(
    readable: ReadableStream<Uint8Array>,
    writable: WritableStream<Uint8Array>,
  ) {
    this.writer = writable.getWriter();
    void this.pump(readable);
  }

  private async pump(readable: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of readable) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: JsonRpcMessage;
          try {
            message = JSON.parse(line) as JsonRpcMessage;
          } catch {
            // One unparseable line is not a reason to end the session: an
            // agent that prints a stray banner to stdout should still work.
            this.errorHandler?.(
              new Error(
                `Ignoring unparseable line from agent: ${line.slice(0, 200)}`,
              ),
            );
            continue;
          }
          this.messageHandler?.(message);
        }
      }
    } catch (e) {
      if (!this.closed) {
        this.errorHandler?.(e instanceof Error ? e : new Error(String(e)));
      }
    } finally {
      this.closed = true;
      this.closeHandler?.();
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("Transport is closed");
    await this.writer.write(
      this.encoder.encode(JSON.stringify(message) + "\n"),
    );
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.writer.close();
    } catch {
      // Already closed, or the far end went away first.
    }
  }
}

/** Both ends of an in-memory pipe, for driving a scripted agent in tests. */
export function transportPair(): [Transport, Transport] {
  const a = new TransformStream<Uint8Array, Uint8Array>();
  const b = new TransformStream<Uint8Array, Uint8Array>();
  return [
    new StreamTransport(a.readable, b.writable),
    new StreamTransport(b.readable, a.writable),
  ];
}
