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
import { injectBootTheme } from "../src/native/server.ts";

const DOCUMENT = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Openotes</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

Deno.test("the boot theme is stamped into the served document", () => {
  const dark = injectBootTheme(DOCUMENT, "dark");
  assertStringIncludes(dark, '<html data-theme="dark" lang="en">');
  assertStringIncludes(dark, "color-scheme:dark");
  assertStringIncludes(dark, "background-color:#171412");
  assert(
    dark.indexOf("boot-theme") < dark.indexOf("</head>"),
    "the boot style must land inside <head>, before the body paints",
  );

  const light = injectBootTheme(DOCUMENT, "light");
  assertStringIncludes(light, '<html data-theme="light" lang="en">');
  assertStringIncludes(light, "background-color:#fafaf9");
});

Deno.test("an existing data-theme is replaced, not duplicated", () => {
  const once = injectBootTheme(
    `<html data-theme="light"><head></head><body></body></html>`,
    "dark",
  );
  assertStringIncludes(once, 'data-theme="dark"');
  assert(
    once.match(/data-theme=/g)?.length === 1,
    `expected exactly one data-theme attribute, got: ${once}`,
  );
});

Deno.test("a document without a head still gets the boot theme", () => {
  const out = injectBootTheme("<html><body>hi</body></html>", "dark");
  assertStringIncludes(out, "boot-theme");
});

/**
 * The request guard, against a real listener.
 *
 * These exist because the first version of the guard refused every request
 * that carried an Origin header, on the reasoning that the webview never
 * sends one. Vite marks the entry script and the stylesheet `crossorigin`,
 * so the webview fetches its own bundle in CORS mode and does send one —
 * and the application 403'd its own JavaScript. Every window stopped at the
 * splash screen, and nothing in the suite noticed, because nothing here
 * asked the server for a subresource the way a browser asks for it.
 */

import { startUiServer } from "../src/native/server.ts";
import { join } from "@std/path";

async function withServer(
  body: (base: string) => Promise<void>,
  files: Record<string, string> = {
    "index.html": "<!DOCTYPE html><html><head></head><body></body></html>",
    "assets/app.js": "export const ok = 1;",
    "assets/app.css": ":root{}",
  },
) {
  const root = await Deno.makeTempDir({ prefix: "openotes-ui-" });
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await Deno.mkdir(join(path, ".."), { recursive: true });
    await Deno.writeTextFile(path, content);
  }
  const server = await startUiServer({ root, instanceId: "test" });
  try {
    await body(server.origin);
  } finally {
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
}

/** What a browser sends for a `crossorigin` subresource of its own page. */
function sameOrigin(base: string): HeadersInit {
  return { origin: base };
}

Deno.test("the interface can load its own crossorigin bundle", async () => {
  await withServer(async (base) => {
    for (const path of ["/assets/app.js", "/assets/app.css"]) {
      const response = await fetch(base + path, { headers: sameOrigin(base) });
      await response.body?.cancel();
      assert(
        response.status === 200,
        `${path} with its own Origin answered ${response.status}; the ` +
          `window would never get past the splash`,
      );
    }
  });
});

Deno.test("a subresource with no Origin is served too", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/assets/app.js");
    await response.body?.cancel();
    assertEquals(response.status, 200);
  });
});

Deno.test("a page on another origin is still refused", async () => {
  await withServer(async (base) => {
    for (
      const origin of ["https://example.invalid", "http://127.0.0.1:1", "null"]
    ) {
      const response = await fetch(base + "/assets/app.js", {
        headers: { origin },
      });
      await response.body?.cancel();
      assertEquals(response.status, 403, origin);
    }
  });
});

/**
 * Speak HTTP down a socket, because `fetch` refuses to set Host — and Host
 * is exactly what a DNS-rebinding attack controls.
 */
async function rawStatus(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  const { hostname, port } = new URL(base);
  const connection = await Deno.connect({
    hostname,
    port: Number(port),
  });
  try {
    const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
    await connection.write(
      new TextEncoder().encode(
        `GET ${path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n` +
          `Connection: close\r\n\r\n`,
      ),
    );
    const buffer = new Uint8Array(4096);
    const read = await connection.read(buffer);
    const status = new TextDecoder().decode(buffer.subarray(0, read ?? 0))
      .split(" ")[1];
    return Number(status);
  } finally {
    try {
      connection.close();
    } catch {
      // already closed
    }
  }
}

Deno.test("a request routed through a DNS name is refused", async () => {
  // DNS rebinding: a name the attacker controls, resolved to 127.0.0.1.
  await withServer(async (base) => {
    const { host } = new URL(base);
    assertEquals(
      await rawStatus(base, "/assets/app.js", { Host: "attacker.example" }),
      403,
    );
    assertEquals(await rawStatus(base, "/assets/app.js", { Host: host }), 200);
  });
});

Deno.test("an Origin naming a different loopback port is refused", async () => {
  // Another application on this machine, served on its own port, is not
  // this one — and comparing against the Host is what tells them apart.
  await withServer(async (base) => {
    const { host, port } = new URL(base);
    const other = `http://127.0.0.1:${
      Number(port) === 1 ? 2 : Number(port) + 1
    }`;
    assertEquals(
      await rawStatus(base, "/assets/app.js", { Host: host, Origin: other }),
      403,
    );
    assertEquals(
      await rawStatus(base, "/assets/app.js", {
        Host: host,
        Origin: `http://${host}`,
      }),
      200,
    );
  });
});

Deno.test("the document is served, and carries the boot theme", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/", { headers: sameOrigin(base) });
    const html = await response.text();
    assertEquals(response.status, 200);
    assertStringIncludes(html, 'data-theme="light"');
    assertStringIncludes(html, 'id="boot-theme"');
  });
});

Deno.test("a rewritten document's content-length matches its bytes", async () => {
  // injectBootTheme makes the body longer than the file on disk. A stale
  // content-length would truncate the document and boot would die exactly
  // as it did for the Origin bug, with no error anywhere.
  await withServer(async (base) => {
    const response = await fetch(base + "/", { headers: sameOrigin(base) });
    const declared = Number(response.headers.get("content-length"));
    const body = new Uint8Array(await response.arrayBuffer());
    assertEquals(declared, body.byteLength);
  });
});

Deno.test("only GET and HEAD are answered", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/assets/app.js", { method: "POST" });
    await response.body?.cancel();
    assertEquals(response.status, 405);
  });
});

Deno.test("the health route is behind the same guards as everything else", async () => {
  // It used to return before them, so a page at a DNS name rebound to
  // 127.0.0.1 could still learn that Openotes is running here and which
  // launch this is — the one thing the rest of the guard exists to deny.
  await withServer(async (base) => {
    const { host } = new URL(base);
    const health = "/__openotes/health";

    assertEquals(await rawStatus(base, health, { Host: host }), 200);
    assertEquals(
      await rawStatus(base, health, { Host: "attacker.example" }),
      403,
    );
    assertEquals(
      await rawStatus(base, health, {
        Host: host,
        Origin: "https://example.invalid",
      }),
      403,
    );

    // And it is a GET route, not a method-agnostic one.
    const posted = await fetch(base + health, { method: "POST" });
    await posted.body?.cancel();
    assertEquals(posted.status, 405);
  });
});

Deno.test("the health route still answers the application itself", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/__openotes/health", {
      headers: sameOrigin(base),
    });
    const body = await response.json();
    assertEquals(response.status, 200);
    assertEquals(body.ok, true);
    assertEquals(body.instance, "test");
  });
});
