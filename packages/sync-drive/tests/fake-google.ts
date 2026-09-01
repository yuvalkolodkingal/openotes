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

/**
 * A loopback Google Drive, in as much detail as the adapter can tell.
 *
 * It is a real `Deno.serve` speaking the v3 endpoints the store uses, so the
 * adapter is exercised over the wire — its query strings, its multipart
 * bodies, its redirect and authorization handling — rather than against a
 * mock whose shape was copied from the same misunderstanding as the code.
 *
 * IT ALLOWS DUPLICATE NAMES, because Drive does. `files.create` never looks
 * at what is already in the folder, so a test can put two files called
 * "7.bin" side by side and watch the store reconcile them; `seedFile` does
 * the same thing directly, with a chosen id and createdTime, so the
 * tie-break can be pinned rather than raced.
 *
 * IT CAN LAG, because Drive does. `conceal` hides a file from `files.list`
 * while leaving it readable by id — a write that has landed but that this
 * replica's listing has not caught up with. That window is the only reason
 * two devices can both pass `create`'s pre-check, and without it the
 * emulated conditional create cannot be tested at all.
 *
 * The adapter's URLs are hard-coded to googleapis.com, so the way in is
 * `fetch`: pass it as the store's (and the token manager's) fetch and every
 * googleapis.com request lands here instead, with the paths and query
 * strings the adapter actually built.
 */

/** A folder is a file with this mime type and no content. */
export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/** The alias Drive accepts anywhere a folder id goes: "My Drive". */
const DRIVE_ROOT_ID = "root";

/** Google's token endpoint path; the host is rewritten onto the fake. */
const TOKEN_PATH = "/token";

const METADATA_PATH = "/drive/v3/files";
const UPLOAD_PATH = "/upload/drive/v3/files";

/**
 * Where a resumable session URI is claimed to live. It has to be https and
 * it has to be a googleapis.com host: the store refuses a plain-http
 * session, and only a googleapis.com URL is rewritten back onto the fake.
 */
const UPLOAD_ORIGIN = "https://www.googleapis.com";

/** One file as the fake holds it. Handed out as copies. */
export interface FakeDriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  /** RFC 3339, and the half of the duplicate tie-break that decides first. */
  createdTime: string;
  modifiedTime: string;
  content: Uint8Array;
}

/** One request the fake answered, for counting round trips. */
export interface FakeDriveRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  status: number;
  /**
   * Whether the request carried an Authorization header. A resumable
   * session URI carries its own credential and must arrive without one.
   */
  authorized: boolean;
}

/** A failure to inject, matched against the requests that follow. */
export interface FakeDriveFailure {
  status: number;
  /** Goes in `error.errors[0].reason` — what Drive actually keys on. */
  reason?: string;
  message?: string;
  /** Only fail requests whose path contains this. */
  pathIncludes?: string;
  /** Only fail this method. */
  method?: string;
  /** How many matching requests to fail. Defaults to one. */
  times?: number;
  /** Sent as `Retry-After`, in seconds. */
  retryAfterSeconds?: number;
}

export interface SeedOptions {
  name: string;
  /** Defaults to the account root. */
  parentId?: string;
  content?: Uint8Array;
  /** Chosen so a test can pin the tie-break rather than race it. */
  id?: string;
  createdTime?: string;
  mimeType?: string;
}

interface UploadSession {
  fileId?: string;
  name: string;
  parentId?: string;
  /** From X-Upload-Content-Length, checked against what actually arrives. */
  declaredLength: number;
}

interface UploadTarget {
  fileId?: string;
  name: string;
  parentId?: string;
}

export class FakeGoogleDrive {
  private server?: Deno.HttpServer;
  private readonly files = new Map<string, FakeDriveFile>();
  private readonly sessions = new Map<string, UploadSession>();
  private readonly concealed = new Set<string>();
  private readonly log: FakeDriveRequest[] = [];
  private failures: FakeDriveFailure[] = [];
  private accessToken?: string;
  private serial = 0;
  /**
   * Fixed and monotonic so createdTime ordering is a property of the test
   * rather than of how fast the machine ran it.
   */
  private clock = Date.parse("2026-01-01T00:00:00.000Z");

  /** Lowered by a test that wants `files.list` to page. */
  maxPageSize = 1_000;

  /** How many times the token endpoint has issued an access token. */
  tokenGrants = 0;

  get url(): string {
    const server = this.server;
    if (!server) throw new Error("the fake Drive has not been started");
    return `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  }

  /** Every request answered so far, oldest first. */
  get requests(): readonly FakeDriveRequest[] {
    return this.log;
  }

  /**
   * The store's `fetch`. Drive's hosts are hard-coded in the adapter — that
   * is the point, a base URL nobody can get wrong in production — so the
   * only seam a test has is the fetch it is handed.
   */
  readonly fetch: typeof fetch = (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    if (input instanceof Request) {
      // Rewriting a Request would mean rebuilding its method, headers and
      // body by hand, and silently dropping whichever one was forgotten.
      // Nothing in the adapter builds one, so say so instead.
      return Promise.reject(
        new TypeError("the fake Drive expects fetch(url, init)"),
      );
    }
    const original = new URL(String(input));
    const target = original.hostname.endsWith("googleapis.com")
      ? new URL(original.pathname + original.search, this.url)
      : original;
    return globalThis.fetch(target, init);
  };

  start(): Promise<void> {
    this.server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (request) => this.handle(request),
    );
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    await this.server?.shutdown();
    this.server = undefined;
  }

  /** Put a file in place directly, duplicate name and all. */
  seedFile(options: SeedOptions): FakeDriveFile {
    const file: FakeDriveFile = {
      id: options.id ?? this.nextId("file"),
      name: options.name,
      mimeType: options.mimeType ?? "application/octet-stream",
      parents: [options.parentId ?? DRIVE_ROOT_ID],
      createdTime: options.createdTime ?? this.nextTime(),
      modifiedTime: options.createdTime ?? this.nextTime(),
      content: options.content ?? new Uint8Array(),
    };
    this.files.set(file.id, file);
    return copy(file);
  }

  /**
   * Every file reachable by walking `path` from the account root by name.
   *
   * All branches are followed and every match at the leaf is returned,
   * deliberately: the fake must not encode the duplicate tie-break, or a
   * test would be asserting the fake's rule against the adapter's copy of
   * the same mistake.
   */
  lookup(path: string): FakeDriveFile[] {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return [];
    let parents = [DRIVE_ROOT_ID];
    for (const segment of segments.slice(0, -1)) {
      parents = this.childrenNamed(parents, segment)
        .filter((file) => file.mimeType === FOLDER_MIME_TYPE)
        .map((file) => file.id);
      if (parents.length === 0) return [];
    }
    return this.childrenNamed(parents, segments[segments.length - 1]);
  }

  /** The bytes held under an id, or undefined once it is gone. */
  contentOf(id: string): Uint8Array | undefined {
    const file = this.files.get(id);
    return file ? file.content.slice() : undefined;
  }

  /**
   * Hide a file from `files.list` while leaving it readable by id: a write
   * this replica's listing has not caught up with.
   */
  conceal(id: string): void {
    this.concealed.add(id);
  }

  /** The listing catches up. */
  reveal(id: string): void {
    this.concealed.delete(id);
  }

  injectFailure(failure: FakeDriveFailure): void {
    this.failures.push({ times: 1, ...failure });
  }

  clearFailures(): void {
    this.failures = [];
  }

  clearRequests(): void {
    this.log.length = 0;
  }

  private childrenNamed(parents: string[], name: string): FakeDriveFile[] {
    return [...this.files.values()]
      .filter((file) =>
        file.name === name && file.parents.some((id) => parents.includes(id))
      )
      .sort((left, right) => left.id < right.id ? -1 : 1)
      .map(copy);
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const authorized = request.headers.has("authorization");
    let response: Response;
    try {
      response = await this.route(request, url, method);
    } catch (error) {
      // A metadata document Drive cannot parse is a 400, not a dropped
      // connection; reporting it as a network failure would send the
      // adapter into a retry loop and hide the real mistake.
      response = errorResponse(400, "invalid", describe(error));
    }
    this.log.push({
      method,
      path: url.pathname,
      params: Object.fromEntries(url.searchParams),
      status: response.status,
      authorized,
    });
    return response;
  }

  private async route(
    request: Request,
    url: URL,
    method: string,
  ): Promise<Response> {
    const path = url.pathname;
    if (path === TOKEN_PATH) return this.issueToken(method);

    const failure = this.takeFailure(method, path);
    if (failure) return failureResponse(failure);

    // The resumable session URI carries its own credential in the query.
    // The store sends it anonymously on purpose — a session URI may point
    // at a host that is not the API — so no bearer token is expected here.
    if (!url.searchParams.has("upload_id")) {
      const refused = this.checkAuthorization(request);
      if (refused) return refused;
    }

    if (path === UPLOAD_PATH || path.startsWith(`${UPLOAD_PATH}/`)) {
      return await this.upload(request, url, method, path);
    }
    if (path === METADATA_PATH) {
      if (method === "GET") return this.listFiles(url);
      if (method === "POST") return await this.createMetadata(request);
    }
    if (path.startsWith(`${METADATA_PATH}/`)) {
      const id = decodeURIComponent(path.slice(METADATA_PATH.length + 1));
      if (method === "GET") return this.download(id, url);
      if (method === "PATCH") {
        return await this.updateMetadata(request, url, id);
      }
      if (method === "DELETE") return this.removeFile(id);
    }
    return errorResponse(
      404,
      "notFound",
      `No such endpoint: ${method} ${path}`,
    );
  }

  private issueToken(method: string): Response {
    if (method !== "POST") {
      return errorResponse(405, "invalid", "The token endpoint takes a POST");
    }
    this.tokenGrants++;
    this.accessToken = `drive-access-${this.tokenGrants}`;
    // No refresh_token: Google keeps the one it issued at consent, and the
    // token manager has to cope with a refresh response that omits it.
    return json({
      access_token: this.accessToken,
      token_type: "Bearer",
      expires_in: 3600,
    });
  }

  private checkAuthorization(request: Request): Response | undefined {
    const header = request.headers.get("authorization");
    if (
      this.accessToken !== undefined &&
      header === `Bearer ${this.accessToken}`
    ) {
      return undefined;
    }
    return errorResponse(401, "authError", "Invalid Credentials");
  }

  private takeFailure(
    method: string,
    path: string,
  ): FakeDriveFailure | undefined {
    const index = this.failures.findIndex((failure) =>
      (!failure.method || failure.method === method) &&
      (!failure.pathIncludes || path.includes(failure.pathIncludes)) &&
      (failure.times ?? 1) > 0
    );
    if (index < 0) return undefined;
    const failure = this.failures[index];
    failure.times = (failure.times ?? 1) - 1;
    if (failure.times <= 0) this.failures.splice(index, 1);
    return failure;
  }

  private listFiles(url: URL): Response {
    const query = parseDriveQuery(url.searchParams.get("q") ?? "");
    // Nothing here is ever trashed: the adapter deletes permanently, so
    // `trashed=false` matches everything the fake holds.
    const matches = [...this.files.values()]
      .filter((file) =>
        !this.concealed.has(file.id) &&
        (query.parent === undefined || file.parents.includes(query.parent)) &&
        (query.name === undefined || file.name === query.name)
      )
      .sort((left, right) => left.id < right.id ? -1 : 1);

    const requested = Number(url.searchParams.get("pageSize") ?? "100");
    const pageSize = Math.max(1, Math.min(requested, this.maxPageSize));
    const from = Number(url.searchParams.get("pageToken") ?? "0");
    const page = matches.slice(from, from + pageSize);
    const next = from + pageSize < matches.length
      ? String(from + pageSize)
      : undefined;
    return json({
      files: page.map(resource),
      ...(next === undefined ? {} : { nextPageToken: next }),
    });
  }

  private async createMetadata(request: Request): Promise<Response> {
    const body = asRecord(JSON.parse(await request.text()));
    const name = typeof body?.name === "string" ? body.name : "";
    const mimeType = typeof body?.mimeType === "string" ? body.mimeType : "";
    const parents = Array.isArray(body?.parents) ? body.parents : [];
    const parentId = typeof parents[0] === "string"
      ? parents[0]
      : DRIVE_ROOT_ID;
    if (parentId !== DRIVE_ROOT_ID && !this.files.has(parentId)) {
      return errorResponse(404, "notFound", `No such parent: ${parentId}`);
    }
    // No duplicate check anywhere in here. That absence is the whole reason
    // the store has to emulate a conditional create.
    return json(resource(this.insert(name, mimeType, parentId)));
  }

  private async updateMetadata(
    request: Request,
    url: URL,
    id: string,
  ): Promise<Response> {
    const file = this.files.get(id);
    if (!file) return errorResponse(404, "notFound", `No such file: ${id}`);
    const text = await request.text();
    const body = text.length === 0 ? {} : asRecord(JSON.parse(text)) ?? {};
    if (typeof body.name === "string") file.name = body.name;

    const removed = url.searchParams.get("removeParents");
    if (removed) {
      const gone = new Set(removed.split(","));
      file.parents = file.parents.filter((parent) => !gone.has(parent));
    }
    for (
      const parent of (url.searchParams.get("addParents") ?? "").split(",")
    ) {
      if (parent.length > 0 && !file.parents.includes(parent)) {
        file.parents.push(parent);
      }
    }
    if (file.parents.length !== 1) {
      // Drive allows exactly one parent, so adding one without naming the
      // one to drop is refused rather than quietly leaving the file where
      // it was.
      return errorResponse(
        400,
        "invalid",
        `A file has exactly one parent, not ${file.parents.length}`,
      );
    }
    file.modifiedTime = this.nextTime();
    return json(resource(file));
  }

  private download(id: string, url: URL): Response {
    const file = this.files.get(id);
    if (!file) return errorResponse(404, "notFound", `No such file: ${id}`);
    if (url.searchParams.get("alt") !== "media") return json(resource(file));
    return new Response(file.content.slice() as BodyInit, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  private removeFile(id: string): Response {
    if (!this.files.delete(id)) {
      return errorResponse(404, "notFound", `No such file: ${id}`);
    }
    this.concealed.delete(id);
    return new Response(null, { status: 204 });
  }

  private async upload(
    request: Request,
    url: URL,
    method: string,
    path: string,
  ): Promise<Response> {
    const sessionId = url.searchParams.get("upload_id");
    if (sessionId !== null) return await this.fillSession(request, sessionId);

    const fileId = path.length > UPLOAD_PATH.length
      ? decodeURIComponent(path.slice(UPLOAD_PATH.length + 1))
      : undefined;
    if (method !== "POST" && method !== "PATCH") {
      return errorResponse(405, "invalid", `Cannot ${method} an upload`);
    }
    const uploadType = url.searchParams.get("uploadType");
    if (uploadType === "resumable") {
      return await this.openSession(request, fileId);
    }
    if (uploadType === "multipart") {
      return await this.multipartUpload(request, fileId);
    }
    return errorResponse(400, "invalid", `Unknown uploadType: ${uploadType}`);
  }

  private async openSession(
    request: Request,
    fileId: string | undefined,
  ): Promise<Response> {
    const declared = request.headers.get("x-upload-content-length");
    if (declared === null) {
      // Declaring the length up front is what lets Drive refuse an upload
      // that cannot fit before the bytes are sent, so a session opened
      // without it is a bug worth failing on.
      return errorResponse(
        400,
        "invalid",
        "A resumable session must declare X-Upload-Content-Length",
      );
    }
    const target = parseUploadMetadata(await request.text(), fileId);
    const id = this.nextId("session");
    this.sessions.set(id, { ...target, declaredLength: Number(declared) });
    return new Response(null, {
      status: 200,
      headers: {
        location: `${UPLOAD_ORIGIN}${UPLOAD_PATH}` +
          `?uploadType=resumable&upload_id=${id}`,
      },
    });
  }

  private async fillSession(
    request: Request,
    sessionId: string,
  ): Promise<Response> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return errorResponse(404, "notFound", `No such session: ${sessionId}`);
    }
    const content = new Uint8Array(await request.arrayBuffer());
    if (content.length !== session.declaredLength) {
      return errorResponse(
        400,
        "invalid",
        `Session declared ${session.declaredLength} bytes and received ` +
          `${content.length}`,
      );
    }
    this.sessions.delete(sessionId);
    return this.store(session, content);
  }

  private async multipartUpload(
    request: Request,
    fileId: string | undefined,
  ): Promise<Response> {
    const boundary = /boundary=([^;]+)/.exec(
      request.headers.get("content-type") ?? "",
    )?.[1];
    if (!boundary) {
      return errorResponse(
        400,
        "invalid",
        "A multipart upload needs a boundary",
      );
    }
    const parts = multipartParts(
      new Uint8Array(await request.arrayBuffer()),
      boundary,
    );
    if (parts.length !== 2) {
      return errorResponse(
        400,
        "invalid",
        `A multipart upload has a metadata part and a content part, not ` +
          `${parts.length} parts`,
      );
    }
    const target = parseUploadMetadata(
      new TextDecoder().decode(parts[0]),
      fileId,
    );
    return this.store(target, parts[1]);
  }

  private store(target: UploadTarget, content: Uint8Array): Response {
    if (target.fileId !== undefined) {
      const file = this.files.get(target.fileId);
      if (!file) {
        return errorResponse(404, "notFound", `No such file: ${target.fileId}`);
      }
      file.name = target.name;
      file.content = content;
      file.modifiedTime = this.nextTime();
      return json(resource(file));
    }
    const parentId = target.parentId ?? DRIVE_ROOT_ID;
    if (parentId !== DRIVE_ROOT_ID && !this.files.has(parentId)) {
      return errorResponse(404, "notFound", `No such parent: ${parentId}`);
    }
    const file = this.insert(
      target.name,
      "application/octet-stream",
      parentId,
      content,
    );
    return json(resource(file));
  }

  private insert(
    name: string,
    mimeType: string,
    parentId: string,
    content: Uint8Array = new Uint8Array(),
  ): FakeDriveFile {
    const at = this.nextTime();
    const file: FakeDriveFile = {
      id: this.nextId("file"),
      name,
      mimeType,
      parents: [parentId],
      createdTime: at,
      modifiedTime: at,
      content,
    };
    this.files.set(file.id, file);
    return file;
  }

  /**
   * Zero-padded so ids sort in creation order. A test that needs the
   * tie-break to disagree with creation order passes its own.
   */
  private nextId(prefix: string): string {
    return `${prefix}-${String(++this.serial).padStart(4, "0")}`;
  }

  private nextTime(): string {
    this.clock += 1_000;
    return new Date(this.clock).toISOString();
  }
}

/** The subset of Drive's `q` grammar the adapter builds. */
interface DriveQuery {
  parent?: string;
  name?: string;
}

/**
 * Read `'<id>' in parents and name='<name>' and trashed=false`.
 *
 * The quoted values are unescaped rather than taken literally, so a name
 * with an apostrophe in it only resolves if the adapter escaped it the way
 * Drive requires.
 */
function parseDriveQuery(query: string): DriveQuery {
  const parsed: DriveQuery = {};
  let at = 0;
  while (at < query.length) {
    if (query[at] !== "'") {
      at++;
      continue;
    }
    const literal = readQuoted(query, at);
    if (/^\s*in\s+parents/.test(query.slice(literal.end))) {
      parsed.parent = literal.value;
    } else if (/name\s*=\s*$/.test(query.slice(0, at))) {
      parsed.name = literal.value;
    }
    at = literal.end;
  }
  return parsed;
}

function readQuoted(
  text: string,
  from: number,
): { value: string; end: number } {
  let value = "";
  let at = from + 1;
  while (at < text.length) {
    const character = text[at];
    if (character === "\\") {
      value += text[at + 1] ?? "";
      at += 2;
      continue;
    }
    if (character === "'") return { value, end: at + 1 };
    value += character;
    at++;
  }
  return { value, end: text.length };
}

/**
 * The content of each part of a multipart/related body.
 *
 * Split on the delimiter as bytes, not as text: the content part is
 * arbitrary encrypted data and decoding it as UTF-8 to find the boundary
 * would corrupt every byte above 0x7f.
 */
function multipartParts(
  body: Uint8Array,
  boundary: string,
): Uint8Array[] {
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const separator = encoder.encode("\r\n\r\n");
  const marks: number[] = [];
  for (
    let at = indexOfBytes(body, delimiter, 0);
    at >= 0;
    at = indexOfBytes(body, delimiter, at + delimiter.length)
  ) {
    marks.push(at);
  }

  const parts: Uint8Array[] = [];
  for (let index = 0; index + 1 < marks.length; index++) {
    let chunk = body.subarray(
      marks[index] + delimiter.length,
      marks[index + 1],
    );
    chunk = trimCrlf(chunk);
    const blank = indexOfBytes(chunk, separator, 0);
    parts.push(blank < 0 ? chunk : chunk.subarray(blank + separator.length));
  }
  return parts;
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
): number {
  outer: for (let at = from; at + needle.length <= haystack.length; at++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[at + offset] !== needle[offset]) continue outer;
    }
    return at;
  }
  return -1;
}

function trimCrlf(chunk: Uint8Array): Uint8Array {
  let start = 0;
  let end = chunk.length;
  if (chunk[start] === 0x0d && chunk[start + 1] === 0x0a) start += 2;
  if (chunk[end - 2] === 0x0d && chunk[end - 1] === 0x0a) end -= 2;
  return chunk.subarray(start, end);
}

function parseUploadMetadata(
  text: string,
  fileId: string | undefined,
): UploadTarget {
  const body = asRecord(JSON.parse(text));
  const parents = Array.isArray(body?.parents) ? body.parents : [];
  return {
    fileId,
    name: typeof body?.name === "string" ? body.name : "",
    parentId: typeof parents[0] === "string" ? parents[0] : undefined,
  };
}

/** A file as Drive describes it on the wire. */
function resource(file: FakeDriveFile): Record<string, unknown> {
  const folder = file.mimeType === FOLDER_MIME_TYPE;
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parents: [...file.parents],
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    // Drive sends size as a decimal string, because a file can be bigger
    // than JSON's safe integer range, and omits it entirely for folders.
    ...(folder ? {} : { size: String(file.content.length) }),
  };
}

function failureResponse(failure: FakeDriveFailure): Response {
  return errorResponse(
    failure.status,
    failure.reason,
    failure.message ?? `Injected HTTP ${failure.status}`,
    failure.retryAfterSeconds,
  );
}

function errorResponse(
  status: number,
  reason: string | undefined,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=UTF-8",
  };
  if (retryAfterSeconds !== undefined) {
    headers["retry-after"] = String(retryAfterSeconds);
  }
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message,
        errors: reason === undefined
          ? []
          : [{ domain: "global", reason, message }],
      },
    }),
    { status, headers },
  );
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

function copy(file: FakeDriveFile): FakeDriveFile {
  return { ...file, parents: [...file.parents], content: file.content.slice() };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
