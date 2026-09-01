/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited
Copyright (C) 2026 Openotes contributors

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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  handleMessage,
  LATEST_PROTOCOL_VERSION,
  TOOLS,
} from "../src/mcp/protocol.ts";
import {
  createId,
  NoteError,
  type NoteRepository,
  toMatchExpression,
} from "../src/mcp/notes.ts";
import {
  generateToken,
  isLoopbackHostname,
  timingSafeEqual,
} from "../src/mcp/server.ts";

// ---------------------------------------------------------------------------
// A repository stub. The protocol layer is pure, so the tools can be checked
// without a database: what matters here is dispatch, capability gating and
// error shape.
// ---------------------------------------------------------------------------

function stubRepository(overrides: Partial<NoteRepository> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = <T>(method: string, result: T) => (...args: unknown[]) => {
    calls.push({ method, args });
    return result;
  };
  const repository = {
    available: true,
    listNotes: record("listNotes", []),
    searchNotes: record("searchNotes", []),
    readNote: record("readNote", {
      id: "n1",
      title: "A note",
      content: "body",
      format: "markdown",
      headline: "body",
      dateCreated: 1,
      dateEdited: 2,
      pinned: false,
      favorite: false,
      locked: false,
      readonly: false,
      notebooks: [],
      tags: [],
    }),
    listNotebooks: record("listNotebooks", []),
    listTags: record("listTags", []),
    createNote: record("createNote", { id: "new" }),
    updateNote: record("updateNote", { id: "n1" }),
    trashNote: record("trashNote", { id: "n1", title: "A note" }),
    createNotebook: record("createNotebook", { id: "nb1" }),
    setTags: record("setTags", { id: "n1" }),
    moveToNotebook: record("moveToNotebook", { id: "n1" }),
    ...overrides,
  } as unknown as NoteRepository;
  return { repository, calls };
}

function options(allowWrites: boolean, repository?: NoteRepository) {
  return {
    repository: repository ?? stubRepository().repository,
    allowWrites,
    serverName: "openotes",
    serverVersion: "2.1.0",
  };
}

Deno.test("initialize agrees on a protocol version", () => {
  const answer = handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    },
    options(false),
  );
  assert(answer && "result" in answer);
  const result = answer.result as Record<string, unknown>;
  assertEquals(result.protocolVersion, "2025-03-26");

  // An unknown revision falls back to the newest one we speak rather than
  // failing the handshake.
  const future = handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2999-01-01" },
    },
    options(false),
  );
  assert(future && "result" in future);
  assertEquals(
    (future.result as Record<string, unknown>).protocolVersion,
    LATEST_PROTOCOL_VERSION,
  );
});

Deno.test("notifications get no response at all", () => {
  assertEquals(
    handleMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      options(false),
    ),
    undefined,
  );
  // An unknown *notification* is also silent — only requests get errors.
  assertEquals(
    handleMessage(
      { jsonrpc: "2.0", method: "notifications/nope" },
      options(false),
    ),
    undefined,
  );
});

Deno.test("write tools are hidden until editing is allowed", () => {
  const readOnly = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    options(false),
  );
  assert(readOnly && "result" in readOnly);
  const names = (readOnly.result as { tools: { name: string }[] }).tools.map(
    (tool) => tool.name,
  );
  assertEquals(names.includes("create_note"), false);
  assertEquals(names.includes("update_note"), false);
  assertEquals(names.includes("trash_note"), false);
  assert(names.includes("read_note"));
  assert(names.includes("search_notes"));

  const writable = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    options(true),
  );
  assert(writable && "result" in writable);
  assertEquals(
    (writable.result as { tools: unknown[] }).tools.length,
    TOOLS.length,
  );
});

Deno.test("calling a write tool with editing off is refused", () => {
  const { repository, calls } = stubRepository();
  const answer = handleMessage(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "create_note", arguments: { title: "x" } },
    },
    options(false, repository),
  );
  assert(answer && "error" in answer);
  assertStringIncludes(
    answer.error.message,
    "editing from an assistant is turned",
  );
  assertEquals(calls.length, 0, "the repository must not be touched");
});

Deno.test("a tool that fails on its input reports through the result", () => {
  const { repository } = stubRepository({
    readNote: (() => {
      throw new NoteError("Note x is in a vault.", "locked");
    }) as NoteRepository["readNote"],
  });
  const answer = handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_note", arguments: { id: "x" } },
    },
    options(false, repository),
  );
  // isError on the result, not a JSON-RPC error: the model is meant to read
  // it and change what it asked for.
  assert(answer && "result" in answer);
  const result = answer.result as {
    isError: boolean;
    content: { text: string }[];
  };
  assertEquals(result.isError, true);
  assertStringIncludes(result.content[0].text, "vault");
});

Deno.test("tool arguments are validated before the repository sees them", () => {
  const { repository, calls } = stubRepository();
  const answer = handleMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search_notes", arguments: { query: 42 } },
    },
    options(false, repository),
  );
  assert(answer && "result" in answer);
  assertEquals((answer.result as { isError: boolean }).isError, true);
  assertEquals(calls.length, 0);
});

Deno.test("a change through a write tool notifies the app", () => {
  const { repository } = stubRepository();
  let changed = 0;
  handleMessage(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "create_note", arguments: { title: "hello" } },
    },
    { ...options(true, repository), onChanged: () => changed++ },
  );
  assertEquals(changed, 1);

  // A read must not claim anything changed, or sync churns for nothing.
  handleMessage(
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "read_note", arguments: { id: "n1" } },
    },
    { ...options(true, repository), onChanged: () => changed++ },
  );
  assertEquals(changed, 1);
});

Deno.test("resources expose notes by uri", () => {
  const { repository } = stubRepository();
  const listed = handleMessage(
    { jsonrpc: "2.0", id: 1, method: "resources/templates/list" },
    options(false, repository),
  );
  assert(listed && "result" in listed);
  assertStringIncludes(JSON.stringify(listed.result), "openotes://note/{id}");

  const read = handleMessage(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: "openotes://note/n1" },
    },
    options(false, repository),
  );
  assert(read && "result" in read);
  assertStringIncludes(JSON.stringify(read.result), "# A note");

  const bad = handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "file:///etc/passwd" },
    },
    options(false, repository),
  );
  assert(bad && "error" in bad);
});

Deno.test("malformed and unknown requests answer correctly", () => {
  const notRpc = handleMessage({ hello: "world" }, options(false));
  assert(notRpc && "error" in notRpc);
  assertEquals(notRpc.error.code, -32600);

  const unknown = handleMessage(
    { jsonrpc: "2.0", id: 9, method: "does/not/exist" },
    options(false),
  );
  assert(unknown && "error" in unknown);
  assertEquals(unknown.error.code, -32601);
});

Deno.test("every tool declares a usable schema", () => {
  for (const tool of TOOLS) {
    assert(tool.name.match(/^[a-z][a-z0-9_]*$/), `bad tool name: ${tool.name}`);
    assert(tool.description.length > 20, `${tool.name} needs a description`);
    const schema = tool.inputSchema as Record<string, unknown>;
    assertEquals(
      schema.type,
      "object",
      `${tool.name} schema must be an object`,
    );
    assertEquals(
      schema.additionalProperties,
      false,
      `${tool.name} must reject unknown arguments`,
    );
    for (const required of (schema.required as string[] | undefined) ?? []) {
      assert(
        Object.hasOwn(schema.properties as object, required),
        `${tool.name} requires "${required}" but does not describe it`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Transport guards
// ---------------------------------------------------------------------------

Deno.test("the bearer comparison does not short-circuit", () => {
  const token = generateToken();
  assert(timingSafeEqual(token, token));
  assertEquals(timingSafeEqual(token, token.slice(0, -1) + "x"), false);
  assertEquals(timingSafeEqual(token, token + "x"), false);
  assertEquals(timingSafeEqual("", ""), false);
  assertEquals(timingSafeEqual(token, ""), false);
});

Deno.test("tokens are long, unique and url-safe", () => {
  const seen = new Set<string>();
  for (let index = 0; index < 100; index++) {
    const token = generateToken();
    assert(/^[A-Za-z0-9_-]{43}$/.test(token), `unexpected token: ${token}`);
    assertEquals(seen.has(token), false);
    seen.add(token);
  }
});

Deno.test("only loopback hostnames are accepted", () => {
  for (const good of ["localhost", "127.0.0.1", "127.1.2.3", "::1"]) {
    assert(isLoopbackHostname(good), good);
  }
  for (
    const bad of [
      "example.com",
      "0.0.0.0",
      "127.0.0.1.evil.com",
      "169.254.169.254",
      "10.0.0.1",
      "",
    ]
  ) {
    assertEquals(isLoopbackHostname(bad), false, bad);
  }
});

// ---------------------------------------------------------------------------
// Small pieces of the repository that need no database
// ---------------------------------------------------------------------------

Deno.test("ids look like the ones the interface makes", () => {
  const id = createId(1_700_000_000_000);
  assertEquals(id.length, 24);
  assert(/^[0-9a-f]{24}$/.test(id), id);
  // The leading eight hex digits are the second-resolution timestamp, which
  // is what core's trash view and sort orders read.
  assertEquals(parseInt(id.slice(0, 8), 16), 1_700_000_000);
  assert(createId(1_700_000_000_000) !== id, "ids must not repeat");
});

Deno.test("a search query can never be read as FTS syntax", () => {
  assertEquals(toMatchExpression("hello world"), '"hello" "world"');
  assertEquals(toMatchExpression('a" OR b'), '"a" "OR" "b"');
  assertEquals(toMatchExpression("foo: bar*"), '"foo:" "bar*"');
  assertEquals(toMatchExpression("   "), "");
});
