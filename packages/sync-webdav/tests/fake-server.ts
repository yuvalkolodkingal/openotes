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
 * An in-memory WebDAV server used by the test suite.
 *
 * It is a real HTTP server speaking the subset of WebDAV the client uses, so
 * the client is exercised over the wire rather than against a mock object.
 * On top of that it can inject the failure modes a hosted server will not
 * reproduce on demand: 401/403/404/409/412/500, timeouts, truncated PUTs,
 * malformed PROPFIND bodies and wrong ETags (spec §49).
 *
 * The same suite also runs against a real third-party server (dufs / Apache
 * mod_dav) in CI — see run-integration.ts.
 */

export interface FaultConfig {
  /** Force this status for the next N matching requests. */
  status?: number;
  /** Match only this method (default: any). */
  method?: string;
  /** Match only paths containing this substring. */
  pathIncludes?: string;
  /** How many times to apply, then the fault expires. */
  times?: number;
  /** Never send a response (client should time out). */
  hang?: boolean;
  /** Truncate a PUT body to this many bytes before storing. */
  truncatePutTo?: number;
  /** Return a body that is not valid multistatus XML. */
  malformedPropfind?: boolean;
  /** Return this ETag regardless of content. */
  wrongEtag?: string;
  /** Drop the connection mid-response. */
  abort?: boolean;
}

interface StoredFile {
  data: Uint8Array;
  etag: string;
  lastModified: Date;
}

export class FakeWebDavServer {
  private server?: Deno.HttpServer;
  private readonly files = new Map<string, StoredFile>();
  private readonly dirs = new Set<string>(["/"]);
  private faults: FaultConfig[] = [];
  private etagCounter = 0;
  private readonly stopping = new AbortController();

  readonly requestLog: { method: string; path: string; status: number }[] = [];

  constructor(
    private readonly options: {
      username?: string;
      password?: string;
      /** Server does not advertise/support MOVE (compat fallback test). */
      noMove?: boolean;
      /** Server ignores If-None-Match (compat test). */
      ignoreConditionalHeaders?: boolean;
      /** Omit getcontentlength from PROPFIND (compat test). */
      minimalProps?: boolean;
      /** Prefix every href with the full absolute URL (compat test). */
      absoluteHrefs?: boolean;
    } = {},
  ) {}

  get url(): string {
    const addr = this.server?.addr as Deno.NetAddr;
    return `http://127.0.0.1:${addr.port}/`;
  }

  async start(): Promise<void> {
    this.server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (request) => this.handle(request),
    );
    // Give the listener a tick to bind.
    await Promise.resolve();
  }

  async stop(): Promise<void> {
    // Release any request parked by a `hang` fault so shutdown is prompt.
    this.stopping.abort();
    await this.server?.shutdown();
    this.server = undefined;
  }

  injectFault(fault: FaultConfig): void {
    this.faults.push({ times: 1, ...fault });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /** Directly seed/inspect content (for corruption tests). */
  setFile(path: string, data: Uint8Array): void {
    this.ensureParents(path);
    this.files.set(normalize(path), {
      data,
      etag: `"${++this.etagCounter}"`,
      lastModified: new Date(),
    });
  }

  getFile(path: string): Uint8Array | undefined {
    return this.files.get(normalize(path))?.data;
  }

  deleteFile(path: string): void {
    this.files.delete(normalize(path));
  }

  listPaths(): string[] {
    return [...this.files.keys()].sort();
  }

  private takeFault(method: string, path: string): FaultConfig | undefined {
    const index = this.faults.findIndex(
      (fault) =>
        (!fault.method || fault.method === method) &&
        (!fault.pathIncludes || path.includes(fault.pathIncludes)) &&
        (fault.times ?? 1) > 0,
    );
    if (index < 0) return undefined;
    const fault = this.faults[index];
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault;
  }

  private ensureParents(path: string): void {
    const parts = normalize(path).split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      this.dirs.add(current + "/");
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const method = request.method.toUpperCase();

    const log = (status: number) => {
      this.requestLog.push({ method, path, status });
      return status;
    };

    if (this.options.username) {
      const auth = request.headers.get("authorization");
      const expected = "Basic " +
        btoa(`${this.options.username}:${this.options.password ?? ""}`);
      if (auth !== expected) {
        log(401);
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="test"' },
        });
      }
    }

    const fault = this.takeFault(method, path);
    if (fault?.hang) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        this.stopping.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (fault?.abort) {
      log(0);
      throw new Error("connection reset by peer (injected)");
    }
    if (fault?.status) {
      log(fault.status);
      return new Response(`Injected ${fault.status}`, {
        status: fault.status,
      });
    }
    if (fault?.malformedPropfind && method === "PROPFIND") {
      log(207);
      return new Response("<not-xml>{{{", {
        status: 207,
        headers: { "Content-Type": "application/xml" },
      });
    }

    switch (method) {
      case "OPTIONS":
        log(200);
        return new Response(null, {
          status: 200,
          headers: {
            DAV: "1,2",
            Allow: this.options.noMove
              ? "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL"
              : "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY",
          },
        });

      case "HEAD": {
        const file = this.files.get(normalize(path));
        if (!file) {
          if (this.dirs.has(dirKey(path))) {
            log(200);
            return new Response(null, { status: 200 });
          }
          log(404);
          return new Response(null, { status: 404 });
        }
        log(200);
        return new Response(null, {
          status: 200,
          headers: {
            "Content-Length": String(file.data.length),
            ETag: fault?.wrongEtag ?? file.etag,
            "Last-Modified": file.lastModified.toUTCString(),
          },
        });
      }

      case "GET": {
        const file = this.files.get(normalize(path));
        if (!file) {
          log(404);
          return new Response("Not Found", { status: 404 });
        }
        log(200);
        return new Response(file.data as BodyInit, {
          status: 200,
          headers: {
            ETag: fault?.wrongEtag ?? file.etag,
            "Content-Length": String(file.data.length),
          },
        });
      }

      case "PUT": {
        const parent = parentDir(path);
        if (parent !== "/" && !this.dirs.has(parent)) {
          log(409);
          return new Response("Parent collection missing", { status: 409 });
        }
        const existing = this.files.get(normalize(path));
        if (!this.options.ignoreConditionalHeaders) {
          const ifNoneMatch = request.headers.get("if-none-match");
          if (ifNoneMatch === "*" && existing) {
            log(412);
            return new Response("Precondition Failed", { status: 412 });
          }
          const ifMatch = request.headers.get("if-match");
          if (ifMatch && (!existing || existing.etag !== ifMatch)) {
            log(412);
            return new Response("Precondition Failed", { status: 412 });
          }
        }
        let data = new Uint8Array(await request.arrayBuffer());
        if (fault?.truncatePutTo !== undefined) {
          data = data.slice(0, fault.truncatePutTo);
        }
        const etag = `"${++this.etagCounter}"`;
        this.files.set(normalize(path), {
          data,
          etag,
          lastModified: new Date(),
        });
        log(existing ? 204 : 201);
        return new Response(null, {
          status: existing ? 204 : 201,
          headers: { ETag: etag },
        });
      }

      case "DELETE": {
        const key = normalize(path);
        if (this.files.delete(key)) {
          log(204);
          return new Response(null, { status: 204 });
        }
        if (this.dirs.has(dirKey(path))) {
          this.dirs.delete(dirKey(path));
          for (const existing of [...this.files.keys()]) {
            if (existing.startsWith(dirKey(path))) this.files.delete(existing);
          }
          log(204);
          return new Response(null, { status: 204 });
        }
        log(404);
        return new Response("Not Found", { status: 404 });
      }

      case "MKCOL": {
        const key = dirKey(path);
        if (this.dirs.has(key) || this.files.has(normalize(path))) {
          log(405);
          return new Response("Method Not Allowed", { status: 405 });
        }
        if (!this.dirs.has(parentDir(path))) {
          log(409);
          return new Response("Conflict", { status: 409 });
        }
        this.dirs.add(key);
        log(201);
        return new Response(null, { status: 201 });
      }

      case "MOVE": {
        if (this.options.noMove) {
          log(405);
          return new Response("Method Not Allowed", { status: 405 });
        }
        const destination = request.headers.get("destination");
        if (!destination) {
          log(400);
          return new Response("Missing Destination", { status: 400 });
        }
        const to = decodeURIComponent(new URL(destination).pathname);
        const overwrite = request.headers.get("overwrite") !== "F";
        const source = this.files.get(normalize(path));
        if (source) {
          if (!overwrite && this.files.has(normalize(to))) {
            log(412);
            return new Response("Precondition Failed", { status: 412 });
          }
          this.ensureParents(to);
          this.files.delete(normalize(path));
          this.files.set(normalize(to), source);
          log(201);
          return new Response(null, { status: 201 });
        }
        if (this.dirs.has(dirKey(path))) {
          const from = dirKey(path);
          const target = dirKey(to);
          this.dirs.delete(from);
          this.dirs.add(target);
          for (const [key, value] of [...this.files]) {
            if (key.startsWith(from)) {
              this.files.delete(key);
              this.files.set(target + key.slice(from.length), value);
            }
          }
          for (const dir of [...this.dirs]) {
            if (dir !== from && dir.startsWith(from)) {
              this.dirs.delete(dir);
              this.dirs.add(target + dir.slice(from.length));
            }
          }
          log(201);
          return new Response(null, { status: 201 });
        }
        log(404);
        return new Response("Not Found", { status: 404 });
      }

      case "PROPFIND": {
        const depth = request.headers.get("depth") ?? "1";
        const key = dirKey(path);
        const isDir = this.dirs.has(key);
        const file = this.files.get(normalize(path));
        if (!isDir && !file) {
          log(404);
          return new Response("Not Found", { status: 404 });
        }

        const origin = `${url.protocol}//${url.host}`;
        const href = (p: string) =>
          this.options.absoluteHrefs ? origin + encodeURI(p) : encodeURI(p);

        const entries: string[] = [];
        if (isDir) {
          entries.push(collectionXml(href(key)));
          if (depth !== "0") {
            for (const dir of this.dirs) {
              if (dir !== key && isDirectChildDir(key, dir)) {
                entries.push(collectionXml(href(dir)));
              }
            }
            for (const [filePath, stored] of this.files) {
              if (isDirectChildFile(key, filePath)) {
                entries.push(
                  fileXml(
                    href(filePath),
                    stored,
                    this.options.minimalProps ?? false,
                  ),
                );
              }
            }
          }
        } else if (file) {
          entries.push(
            fileXml(
              href(normalize(path)),
              file,
              this.options.minimalProps ?? false,
            ),
          );
        }

        log(207);
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${
            entries.join(
              "\n",
            )
          }\n</D:multistatus>`,
          {
            status: 207,
            headers: { "Content-Type": 'application/xml; charset="utf-8"' },
          },
        );
      }

      default:
        log(501);
        return new Response("Not Implemented", { status: 501 });
    }
  }
}

function normalize(path: string): string {
  return "/" + path.split("/").filter(Boolean).join("/");
}

function dirKey(path: string): string {
  const normalized = normalize(path);
  return normalized === "/" ? "/" : normalized + "/";
}

function parentDir(path: string): string {
  const parts = normalize(path).split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : "/" + parts.join("/") + "/";
}

function isDirectChildDir(parent: string, dir: string): boolean {
  if (!dir.startsWith(parent)) return false;
  const rest = dir.slice(parent.length);
  return rest.split("/").filter(Boolean).length === 1;
}

function isDirectChildFile(parent: string, file: string): boolean {
  if (!file.startsWith(parent)) return false;
  const rest = file.slice(parent.length);
  return rest.length > 0 && !rest.includes("/");
}

function collectionXml(href: string): string {
  return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function fileXml(
  href: string,
  file: StoredFile,
  minimal: boolean,
): string {
  const extra = minimal ? "" : `
        <D:getcontentlength>${file.data.length}</D:getcontentlength>
        <D:getetag>${file.etag}</D:getetag>
        <D:getlastmodified>${file.lastModified.toUTCString()}</D:getlastmodified>`;
  return `  <D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>${extra}
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}
