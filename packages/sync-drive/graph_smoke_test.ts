// Throwaway verification of the OneDrive adapter against an in-memory fake.
import { assertEquals, assertRejects } from "@std/assert";
import { SyncError } from "@notesnook/sync-remote";
import { GraphStore } from "./src/microsoft/graph-store.ts";
import type {
  AuthorizedRequest,
  AuthorizedResponse,
} from "./src/http/authorized-fetch.ts";

const BASE = "https://graph.example/v1.0";
const ROOT = `${BASE}/me/drive/special/approot`;

type Item =
  | { kind: "folder" }
  | { kind: "file"; body: Uint8Array; modified: string };

class FakeGraph {
  readonly items = new Map<string, Item>([["", { kind: "folder" }]]);
  readonly sessions = new Map<
    string,
    { path: string; behavior: string; buffer: Uint8Array; received: number }
  >();
  calls: string[] = [];

  request = (request: AuthorizedRequest): Promise<AuthorizedResponse> => {
    const method = request.method ?? "GET";
    this.calls.push(`${method} ${request.url}`);
    return Promise.resolve(this.route(method, request));
  };

  private route(
    method: string,
    request: AuthorizedRequest,
  ): AuthorizedResponse {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/upload/")) {
      return this.session(method, request, url);
    }
    const raw = request.url.split("?")[0];
    if (!raw.startsWith(ROOT)) return this.fail(404, "itemNotFound", raw);
    let rest = raw.slice(ROOT.length);
    let path = "";
    if (rest.startsWith(":/")) {
      const end = rest.indexOf(":", 2);
      path = decodeURIComponent(rest.slice(2, end)).split("/").map(
        decodeURIComponent,
      ).join("/");
      // Segments were encoded individually; decode them the same way.
      path = rest.slice(2, end).split("/").map(decodeURIComponent).join("/");
      rest = rest.slice(end + 1);
    }

    if (rest === "/content") return this.content(method, request, path);
    if (rest === "/children") return this.children(method, request, path);
    if (rest === "/createUploadSession") {
      return this.createSession(request, path);
    }
    if (rest === "") return this.item(method, path);
    return this.fail(400, "invalidRequest", raw);
  }

  private item(method: string, path: string): AuthorizedResponse {
    const item = this.items.get(path);
    if (method === "DELETE") {
      if (!item) return this.fail(404, "itemNotFound", path);
      for (const key of [...this.items.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) this.items.delete(key);
      }
      return { status: 204, headers: {}, body: new Uint8Array(), url: path };
    }
    if (!item) return this.fail(404, "itemNotFound", path);
    return this.json(200, describe(path, item));
  }

  private content(
    method: string,
    request: AuthorizedRequest,
    path: string,
  ): AuthorizedResponse {
    if (method === "GET") {
      const item = this.items.get(path);
      if (!item || item.kind !== "file") {
        return this.fail(404, "itemNotFound", path);
      }
      return { status: 200, headers: {}, body: item.body, url: path };
    }
    if (method !== "PUT") return this.fail(405, "notAllowed", path);
    const behavior =
      new URL(request.url).searchParams.get("@microsoft.graph.conflictBehavior");
    if (behavior === "fail" && this.items.has(path)) {
      return this.fail(409, "nameAlreadyExists", path);
    }
    const parent = path.split("/").slice(0, -1).join("/");
    if (!this.items.has(parent)) return this.fail(404, "itemNotFound", parent);
    const body = typeof request.body === "string"
      ? new TextEncoder().encode(request.body)
      : request.body ?? new Uint8Array();
    this.items.set(path, {
      kind: "file",
      body: new Uint8Array(body),
      modified: "2026-01-02T03:04:05Z",
    });
    return this.json(201, describe(path, this.items.get(path)!));
  }

  private children(
    method: string,
    request: AuthorizedRequest,
    path: string,
  ): AuthorizedResponse {
    if (method === "POST") {
      const payload = JSON.parse(String(request.body));
      const child = path === "" ? payload.name : `${path}/${payload.name}`;
      if (this.items.has(child)) {
        return this.fail(409, "nameAlreadyExists", child);
      }
      if (!this.items.has(path)) return this.fail(404, "itemNotFound", path);
      this.items.set(child, { kind: "folder" });
      return this.json(201, describe(child, { kind: "folder" }));
    }
    if (!this.items.has(path)) return this.fail(404, "itemNotFound", path);
    const prefix = path === "" ? "" : `${path}/`;
    const value = [];
    for (const [key, item] of this.items) {
      if (key === "" || !key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (name.includes("/")) continue;
      value.push(describe(key, item));
    }
    return this.json(200, { value });
  }

  private createSession(
    request: AuthorizedRequest,
    path: string,
  ): AuthorizedResponse {
    const payload = JSON.parse(String(request.body));
    const behavior = payload.item["@microsoft.graph.conflictBehavior"];
    if (behavior === "fail" && this.items.has(path)) {
      return this.fail(409, "nameAlreadyExists", path);
    }
    const id = `s${this.sessions.size}`;
    this.sessions.set(id, {
      path,
      behavior,
      buffer: new Uint8Array(0),
      received: 0,
    });
    return this.json(200, {
      uploadUrl: `https://upload.example/upload/${id}?tok=secret`,
    });
  }

  private session(
    method: string,
    request: AuthorizedRequest,
    url: URL,
  ): AuthorizedResponse {
    if (request.headers?.["Authorization"]) {
      throw new Error("bearer token leaked to the upload host");
    }
    const id = url.pathname.slice("/upload/".length);
    const session = this.sessions.get(id);
    if (!session) return this.fail(404, "itemNotFound", id);
    if (method === "DELETE") {
      this.sessions.delete(id);
      return { status: 204, headers: {}, body: new Uint8Array(), url: id };
    }
    if (method === "GET") {
      return this.json(200, { nextExpectedRanges: [`${session.received}-`] });
    }
    const range = request.headers?.["Content-Range"] ?? "";
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!match) return this.fail(400, "invalidRange", range);
    const [start, , total] = [+match[1], +match[2], +match[3]];
    if (start !== session.received) return this.fail(416, "invalidRange", range);
    const chunk = request.body as Uint8Array;
    const grown = new Uint8Array(session.received + chunk.length);
    grown.set(session.buffer);
    grown.set(chunk, session.received);
    session.buffer = grown;
    session.received = grown.length;
    if (session.received < total) {
      return this.json(202, { nextExpectedRanges: [`${session.received}-`] });
    }
    this.sessions.delete(id);
    this.items.set(session.path, {
      kind: "file",
      body: session.buffer,
      modified: "2026-01-02T03:04:05Z",
    });
    return this.json(201, describe(session.path, this.items.get(session.path)!));
  }

  private json(status: number, payload: unknown): AuthorizedResponse {
    return {
      status,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify(payload)),
      url: "fake",
    };
  }

  private fail(status: number, code: string, where: string): AuthorizedResponse {
    return {
      status,
      headers: {},
      body: new TextEncoder().encode(
        JSON.stringify({ error: { code, message: where } }),
      ),
      url: where,
    };
  }
}

function describe(path: string, item: Item) {
  const name = path.split("/").pop() ?? "";
  return item.kind === "folder"
    ? { name, folder: { childCount: 0 }, id: `id:${path}` }
    : {
      name,
      id: `id:${path}`,
      size: item.body.length,
      file: {},
      lastModifiedDateTime: item.modified,
    };
}

function makeStore(graph: FakeGraph, directory = "Openotes") {
  return new GraphStore({
    client: { provider: "onedrive", clientId: "x" },
    // deno-lint-ignore no-explicit-any
    tokens: undefined as any,
    directory,
    http: graph,
    baseUrl: BASE,
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("round trip", async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  await store.connect();

  await store.makeDirectory("devices/dev1/changes/");
  assertEquals(graph.items.has("Openotes"), true);
  assertEquals(graph.items.has("Openotes/devices/dev1/changes"), true);
  // Idempotent.
  await store.makeDirectory("devices/dev1/changes/");

  await store.create("devices/dev1/changes/0000000001.bin", bytes("hello"));
  assertEquals(
    new TextDecoder().decode(
      await store.get("devices/dev1/changes/0000000001.bin"),
    ),
    "hello",
  );
  await store.verifyUpload("devices/dev1/changes/0000000001.bin", 5);

  const clash = await assertRejects(
    () => store.create("devices/dev1/changes/0000000001.bin", bytes("x")),
    SyncError,
  );
  assertEquals(clash.code, "precondition-failed");

  await store.put("devices/dev1/changes/0000000001.bin", bytes("bigger"));
  await store.verifyUpload("devices/dev1/changes/0000000001.bin", 6);

  assertEquals(await store.exists("devices/dev1/changes/0000000001.bin"), true);
  assertEquals(await store.exists("devices/dev1/changes/0000000002.bin"), false);
  assertEquals(await store.getIfExists("nope.bin"), undefined);

  const listed = await store.list("devices/dev1/changes/");
  assertEquals(listed.map((entry) => entry.path), [
    "devices/dev1/changes/0000000001.bin",
  ]);
  assertEquals(listed[0].size, 6);
  assertEquals(listed[0].isDirectory, false);
  assertEquals(listed[0].modifiedAt, Date.parse("2026-01-02T03:04:05Z"));
  assertEquals(await store.list("missing/"), []);

  await store.delete("devices/dev1/changes/0000000001.bin");
  assertEquals(await store.exists("devices/dev1/changes/0000000001.bin"), false);
  await store.delete("devices/dev1/changes/0000000001.bin");
});

Deno.test("percent-encoded segments", async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  await store.makeDirectory("a b/");
  await store.create("a b/c#d.bin", bytes("x"));
  assertEquals(graph.items.has("Openotes/a b/c#d.bin"), true);
  assertEquals(
    graph.calls.some((call) => call.includes("a%20b/c%23d.bin")),
    true,
  );
  assertEquals(new TextDecoder().decode(await store.get("a b/c#d.bin")), "x");
});

Deno.test("large upload uses a session and never sends the token", async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph, "");
  await store.makeDirectory("objects/");
  const big = new Uint8Array(9 * 1024 * 1024).fill(7);
  await store.put("objects/big.bin", big);
  await store.verifyUpload("objects/big.bin", big.length);
  assertEquals((await store.get("objects/big.bin")).length, big.length);
  assertEquals(graph.sessions.size, 0);

  const clash = await assertRejects(
    () => store.create("objects/big.bin", big),
    SyncError,
  );
  assertEquals(clash.code, "precondition-failed");
});

Deno.test("root deletes are refused", async () => {
  const store = makeStore(new FakeGraph());
  const error = await assertRejects(() => store.delete(""), SyncError);
  assertEquals(error.code, "corrupt-data");
});

Deno.test("move relocates a whole subtree", async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  await store.makeDirectory("staging/devices/");
  await store.create("staging/devices/a.bin", bytes("a"));

  // The fake implements PATCH by hand, since only the store builds it.
  const inner = graph.request;
  graph.request = (request) => {
    if ((request.method ?? "GET") !== "PATCH") return inner(request);
    const from = decodeURIComponent(
      request.url.slice(`${ROOT}:/`.length, request.url.length - 1),
    ).split("/").join("/");
    const payload = JSON.parse(String(request.body));
    const parent = String(payload.parentReference.id).slice("id:".length);
    const to = parent === "" ? payload.name : `${parent}/${payload.name}`;
    for (const [key, item] of [...graph.items]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      graph.items.delete(key);
      graph.items.set(to + key.slice(from.length), item);
    }
    return Promise.resolve({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ id: `id:${to}` })),
      url: to,
    });
  };

  await store.moveRecursive("staging/devices/", "devices");
  assertEquals(graph.items.has("Openotes/devices/a.bin"), true);
  assertEquals(graph.items.has("Openotes/staging/devices/a.bin"), false);
});

Deno.test("scope() reroots the store", async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  const staged = store.scope("staging");
  await staged.makeDirectory("objects/");
  await staged.create("objects/x.bin", bytes("x"));
  assertEquals(graph.items.has("Openotes/staging/objects/x.bin"), true);
  assertEquals((await staged.list("objects/"))[0].path, "objects/x.bin");
});

Deno.test("quota and throttling classification", async () => {
  const graph = new FakeGraph();
  const store = makeStore(graph);
  graph.request = (request) =>
    Promise.resolve({
      status: 507,
      headers: {},
      body: new TextEncoder().encode(
        JSON.stringify({ error: { code: "quotaLimitReached", message: "full" } }),
      ),
      url: request.url,
    });
  const error = await assertRejects(() => store.exists("a.bin"), SyncError);
  assertEquals(error.code, "forbidden");
  assertEquals(error.isRetryable, false);

  graph.request = (request) =>
    Promise.resolve({
      status: 429,
      headers: { "retry-after": "3" },
      body: new TextEncoder().encode(
        JSON.stringify({ error: { code: "activityLimitReached" } }),
      ),
      url: request.url,
    });
  const throttled = await assertRejects(() => store.exists("a.bin"), SyncError);
  assertEquals(throttled.code, "server-error");
  assertEquals(throttled.isRetryable, true);
});
