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

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AcpClient,
  AcpProtocolError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type SessionNotification,
  type Transport,
  transportPair,
} from "../src/index.ts";

/**
 * A scripted agent on the far end of a pipe.
 *
 * Deliberately hand-written rather than a mock: the point is to exercise the
 * real framing and the real request/response pairing, so a change that breaks
 * either shows up here rather than against a live agent.
 */
class FakeAgent {
  readonly received: JsonRpcRequest[] = [];
  private send!: (message: JsonRpcMessage) => Promise<void>;

  /** Answers keyed by method. Return undefined to leave a call unanswered. */
  responders: Record<string, (request: JsonRpcRequest) => unknown> = {};
  /** Errors keyed by method, taking precedence over responders. */
  errors: Record<string, { code: number; message: string }> = {};

  /** Responses the client sent back to us, keyed by request id. */
  readonly answers = new Map<number | string, JsonRpcMessage>();

  attach(transport: {
    send(m: JsonRpcMessage): Promise<void>;
    onMessage(h: (m: JsonRpcMessage) => void): void;
  }) {
    this.send = (m) => transport.send(m);
    transport.onMessage((message) => {
      const request = message as JsonRpcRequest;
      if (typeof request.method !== "string") {
        const response = message as { id?: number | string };
        if (response.id !== undefined) this.answers.set(response.id, message);
        return;
      }
      this.received.push(request);
      if (request.id === undefined || request.id === null) return;

      const error = this.errors[request.method];
      if (error) {
        void this.send({ jsonrpc: "2.0", id: request.id, error });
        return;
      }
      const responder = this.responders[request.method];
      if (!responder) return;
      const result = responder(request);
      if (result !== undefined) {
        void this.send({ jsonrpc: "2.0", id: request.id, result });
      }
    });
  }

  /** Push a session/update the way a real agent streams output. */
  update(notification: SessionNotification) {
    return this.send({
      jsonrpc: "2.0",
      method: "session/update",
      params: notification,
    });
  }

  /** Call back into the client, as an agent does mid-turn. */
  call(method: string, params: unknown, id: number) {
    return this.send({ jsonrpc: "2.0", id, method, params });
  }
}

function connect(
  overrides: Partial<Parameters<typeof makeHandlers>[0]> = {},
) {
  const [clientSide, agentSide] = transportPair();
  const agent = new FakeAgent();
  agent.attach(agentSide);

  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const handlers = makeHandlers({ updates, permissions, ...overrides });

  const client = new AcpClient({
    transport: clientSide,
    handlers,
    clientInfo: { name: "openotes", version: "2.0.0" },
    capabilities: { readNotes: true, writeNotes: true },
  });

  agent.responders["initialize"] = () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentInfo: { name: "fake", version: "1.0.0" },
    agentCapabilities: { loadSession: true },
    authMethods: [],
  });

  return { client, agent, updates, permissions, agentSide };
}

function makeHandlers(opts: {
  updates: SessionNotification[];
  permissions: RequestPermissionRequest[];
  notes?: Record<string, string>;
  permissionOutcome?: "selected" | "cancelled";
}) {
  const notes = opts.notes ?? {};
  return {
    onUpdate: (n: SessionNotification) => opts.updates.push(n),
    onPermission: (request: RequestPermissionRequest) => {
      opts.permissions.push(request);
      return Promise.resolve(
        opts.permissionOutcome === "cancelled"
          ? { outcome: { outcome: "cancelled" } as const }
          : {
            outcome: {
              outcome: "selected" as const,
              optionId: request.options[0]?.optionId ?? "allow",
            },
          },
      );
    },
    readTextFile: (r: { path: string }) => {
      const content = notes[r.path];
      if (content === undefined) throw new Error(`No note at ${r.path}`);
      return Promise.resolve(content);
    },
    writeTextFile: (r: { path: string; content: string }) => {
      notes[r.path] = r.content;
      return Promise.resolve();
    },
    notes,
  };
}

Deno.test("the handshake negotiates version 1 and reports the agent", async () => {
  const { client } = connect();
  const response = await client.initialize();

  assertEquals(response.protocolVersion, PROTOCOL_VERSION);
  assertEquals(client.agentInfo?.name, "fake");
  await client.close();
});

Deno.test("terminal is never advertised, so no agent tries to use one", async () => {
  const { client, agent } = connect();
  await client.initialize();

  const init = agent.received.find((r) => r.method === "initialize");
  const params = init?.params as { clientCapabilities: { terminal: boolean } };
  assertEquals(params.clientCapabilities.terminal, false);
  await client.close();
});

Deno.test("an empty authMethods list is the one-click path", async () => {
  const { client } = connect();
  await client.initialize();
  assertEquals(client.isAuthenticated, true);
  await client.close();
});

Deno.test("an agent that wants a sign-in says so", async () => {
  const { client, agent } = connect();
  agent.responders["initialize"] = () => ({
    protocolVersion: PROTOCOL_VERSION,
    authMethods: [{ id: "oauth", name: "Sign in with your account" }],
  });
  const response = await client.initialize();

  assertEquals(client.isAuthenticated, false);
  assertEquals(response.authMethods?.[0].id, "oauth");
  await client.close();
});

Deno.test("a version mismatch is refused with an actionable message", async () => {
  const { client, agent } = connect();
  agent.responders["initialize"] = () => ({ protocolVersion: 99 });

  const error = await assertRejects(
    () => client.initialize(),
    AcpProtocolError,
  );
  assert(error.message.includes("99"));
  assertEquals(error.agentVersion, 99);
  await client.close();
});

Deno.test("vendor extensions under _meta are not stripped", async () => {
  // Real agents negotiate through _meta at several levels; dropping unknown
  // keys would quietly break them.
  const { client, agent } = connect();
  agent.responders["initialize"] = () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { fork: {}, resume: {} },
      _meta: { claudeCode: { promptQueueing: true } },
    },
    authMethods: [],
  });

  const response = await client.initialize();
  const meta = response.agentCapabilities?._meta as {
    claudeCode: { promptQueueing: boolean };
  };
  assertEquals(meta.claudeCode.promptQueueing, true);
  assert(response.agentCapabilities?.sessionCapabilities?.fork !== undefined);
  await client.close();
});

Deno.test("streamed updates arrive in order", async () => {
  const { client, agent, updates } = connect();
  await client.initialize();

  for (const text of ["Hel", "lo ", "there"]) {
    await agent.update({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }
  await new Promise((r) => setTimeout(r, 10));

  const chunks = updates.map((u) =>
    (u.update as { content: { text: string } }).content.text
  );
  assertEquals(chunks.join(""), "Hello there");
  await client.close();
});

Deno.test("a permission grant is sent back to the agent", async () => {
  const { client, agent, permissions } = connect();
  await client.initialize();

  await agent.call("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "Edit note" },
    options: [
      { optionId: "yes", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  }, 500);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(permissions.length, 1);
  assertEquals(permissions[0].toolCall.title, "Edit note");

  const answer = agent.answers.get(500) as { result: { outcome: unknown } };
  assertEquals(answer.result.outcome, { outcome: "selected", optionId: "yes" });
  await client.close();
});

Deno.test("a refusal reaches the agent as cancelled, not as an error", async () => {
  const { client, agent } = connect({ permissionOutcome: "cancelled" });
  await client.initialize();

  await agent.call("session/request_permission", {
    sessionId: "s1",
    toolCall: { toolCallId: "t1", title: "Delete everything" },
    options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
  }, 501);
  await new Promise((r) => setTimeout(r, 20));

  const answer = agent.answers.get(501) as {
    result: { outcome: unknown };
    error?: unknown;
  };
  assertEquals(answer.error, undefined);
  assertEquals(answer.result.outcome, { outcome: "cancelled" });
  await client.close();
});

Deno.test("a note is read through the fs methods and returned verbatim", async () => {
  const notes = { "openotes://note/abc": "# Hello\n\nbody" };
  const { client, agent } = connect({ notes });
  await client.initialize();

  await agent.call("fs/read_text_file", {
    sessionId: "s1",
    path: "openotes://note/abc",
  }, 600);
  await new Promise((r) => setTimeout(r, 20));

  const answer = agent.answers.get(600) as { result: { content: string } };
  assertEquals(answer.result.content, "# Hello\n\nbody");
  await client.close();
});

Deno.test("asking for a note that does not exist is an error, not empty content", async () => {
  const { client, agent } = connect({ notes: {} });
  await client.initialize();

  await agent.call("fs/read_text_file", {
    sessionId: "s1",
    path: "openotes://note/missing",
  }, 601);
  await new Promise((r) => setTimeout(r, 20));

  const answer = agent.answers.get(601) as {
    error?: { message: string };
    result?: unknown;
  };
  assert(answer.error !== undefined, "expected an error response");
  assert(answer.error.message.includes("missing"));
  await client.close();
});

Deno.test("a note write reaches the handler and is applied", async () => {
  const notes: Record<string, string> = {};
  const { client, agent } = connect({ notes });
  await client.initialize();

  await agent.call("fs/write_text_file", {
    sessionId: "s1",
    path: "openotes://note/new",
    content: "written by the agent",
  }, 602);
  await new Promise((r) => setTimeout(r, 20));

  assertEquals(notes["openotes://note/new"], "written by the agent");
  await client.close();
});

Deno.test("cancel is a notification, so the turn's own promise resolves it", async () => {
  const { client, agent } = connect();
  await client.initialize();

  await client.cancel("s1");
  await new Promise((r) => setTimeout(r, 10));

  const cancel = agent.received.find((r) => r.method === "session/cancel");
  assert(cancel !== undefined);
  assertEquals(cancel.id, undefined);
  await client.close();
});

Deno.test("authRequired becomes a sentence a user can act on", async () => {
  const { client, agent } = connect();
  await client.initialize();
  agent.errors["session/prompt"] = {
    code: -32000,
    message: "authentication required",
  };

  const error = await assertRejects(
    () =>
      client.prompt({
        sessionId: "s1",
        prompt: [{ type: "text", text: "hi" }],
      }),
    AcpProtocolError,
  );
  assert(error.message.includes("sign in"));
  await client.close();
});

Deno.test("a crashed agent rejects the pending turn instead of hanging", async () => {
  const { client, agentSide } = connect();
  await client.initialize();

  const turn = client.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "hi" }],
  });
  // The agent dies mid-turn.
  await agentSide.close();

  await assertRejects(() => turn);
  await client.close();
});

Deno.test("a stray non-JSON line does not end the session", async () => {
  const [clientSide, agentSide] = transportPair();
  const updates: SessionNotification[] = [];
  const errors: Error[] = [];
  const client = new AcpClient({
    transport: clientSide,
    handlers: {
      onUpdate: (n) => updates.push(n),
      onPermission: () =>
        Promise.resolve({ outcome: { outcome: "cancelled" as const } }),
      onError: (e) => errors.push(e),
    },
  });

  // Agents sometimes print a banner to stdout before the protocol starts.
  // Writing raw bytes is the only way to reproduce that: the transport's own
  // send() would serialise valid JSON.
  const raw = new TextEncoder().encode("Starting agent v1.2.3...\n");
  await (agentSide as unknown as {
    writer: WritableStreamDefaultWriter<Uint8Array>;
  }).writer.write(raw);

  await agentSide.send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "still here" },
      },
    },
  });
  await new Promise((r) => setTimeout(r, 20));

  // The banner was reported as a diagnostic, and the protocol carried on.
  assertEquals(errors.length, 1);
  assert(errors[0].message.includes("unparseable"));
  assertEquals(updates.length, 1);
  await client.close();
});

/**
 * A transport whose `onError` slot holds exactly one handler, replacing on a
 * second registration -- the same semantics as `StreamTransport`, which is
 * where this bit.
 */
class SingleSlotTransport implements Transport {
  sent: JsonRpcMessage[] = [];
  private messageHandler?: (message: JsonRpcMessage) => void;
  private errorHandler?: (error: Error) => void;
  private closeHandler?: () => void;

  send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
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
  close(): Promise<void> {
    this.closeHandler?.();
    return Promise.resolve();
  }

  /** Pretend the pipe failed mid-read. */
  fail(error: Error): void {
    this.errorHandler?.(error);
  }
  deliver(message: JsonRpcMessage): void {
    this.messageHandler?.(message);
  }
}

Deno.test("a transport read error rejects the pending turn", async () => {
  // A stream that errors without reaching EOF never fires onClose, so this is
  // the only thing standing between the user and a turn that hangs forever.
  const transport = new SingleSlotTransport();
  const seen: Error[] = [];
  const client = new AcpClient({
    transport,
    clientInfo: { name: "openotes", title: "Openotes", version: "0" },
    handlers: {
      onUpdate: () => {},
      onPermission: () =>
        Promise.resolve({ outcome: { outcome: "cancelled" } }),
      onError: (error) => seen.push(error),
    },
  });

  const initialize = client.initialize();
  // Answer whatever id the peer actually used rather than assuming one: ids
  // start at 0, and hardcoding 1 here left initialize unresolved and made
  // this test hang for a reason that had nothing to do with what it tests.
  const handshake = transport.sent.at(-1) as { id: number | string };
  transport.deliver({
    jsonrpc: "2.0",
    id: handshake.id,
    result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
  });
  await initialize;

  const turn = client.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "hi" }],
  });
  transport.fail(new Error("pipe died"));

  await assertRejects(() => turn, Error, "pipe died");
  // The client's own observer must still be told, not displaced by the fix.
  assertEquals(seen.length, 1);
});

Deno.test("a handshake that never answers gives up instead of hanging", async () => {
  const transport = new SingleSlotTransport();
  const client = new AcpClient({
    transport,
    clientInfo: { name: "openotes", title: "Openotes", version: "0" },
    handshakeTimeoutMs: 30,
    handlers: {
      onUpdate: () => {},
      onPermission: () =>
        Promise.resolve({ outcome: { outcome: "cancelled" } }),
    },
  });

  // Nothing is ever delivered: the binary started but does not speak ACP.
  await assertRejects(
    () => client.initialize(),
    Error,
    "initialize did not answer",
  );
});

Deno.test("a long turn is not cut short by the handshake deadline", async () => {
  const transport = new SingleSlotTransport();
  const client = new AcpClient({
    transport,
    clientInfo: { name: "openotes", title: "Openotes", version: "0" },
    handshakeTimeoutMs: 30,
    handlers: {
      onUpdate: () => {},
      onPermission: () =>
        Promise.resolve({ outcome: { outcome: "cancelled" } }),
    },
  });

  const initialize = client.initialize();
  const handshake = transport.sent.at(-1) as { id: number | string };
  transport.deliver({
    jsonrpc: "2.0",
    id: handshake.id,
    result: { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
  });
  await initialize;

  // An agent thinking for longer than the handshake bound must not be
  // cancelled: only calls with a known bound carry a deadline.
  const turn = client.prompt({
    sessionId: "s1",
    prompt: [{ type: "text", text: "think hard" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const asked = transport.sent.at(-1) as { id: number | string };
  transport.deliver({
    jsonrpc: "2.0",
    id: asked.id,
    result: { stopReason: "end_turn" },
  });
  assertEquals((await turn).stopReason, "end_turn");
});
