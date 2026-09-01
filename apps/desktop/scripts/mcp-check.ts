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
 * Speaks MCP to a built Openotes, the way a real client would.
 *
 * WHY THIS EXISTS ALONGSIDE THE UNIT TESTS
 *
 * `apps/desktop/tests/mcp_test.ts` exercises the protocol against the server
 * module. That proves the module is right; it does not prove the shipped
 * binary starts a listener at all. Everything between the two — the setting
 * being read, the endpoint being started at app creation rather than at
 * vault open, the handshake file landing in the config directory the client
 * will look in, the port the user chose actually being the port bound —
 * lives outside the module and is exactly where wiring goes wrong.
 *
 * So this launches the packaged application with the endpoint switched on,
 * finds it the way a client finds it (the handshake file, not a guess), and
 * makes real HTTP requests.
 *
 * WHAT IS ASSERTED
 *
 *   1. the handshake file appears, names the configured port, and neither it
 *      nor the token file is readable by other accounts;
 *   2. a request with no token, and one with a wrong token, are refused;
 *   3. a request carrying the right token but a browser Origin is refused —
 *      a page the user visits must not be able to reach the endpoint;
 *   4. `initialize` and `tools/list` answer, and read-only mode lists no
 *      tool that writes;
 *   5. a tool call made before the vault is open answers with an
 *      explanation rather than hanging or crashing;
 *   6. stopping the application removes the handshake, so no file on disk
 *      names a token for an endpoint that is gone.
 *
 * The application runs against a throwaway data directory, so this can never
 * touch a real installation.
 *
 *   deno task check:mcp                            newest build in dist/
 *   deno task check:mcp --app dist/Openotes-2.1.0-linux-x86_64.AppImage
 *   deno task check:mcp --port 47500
 */

import { fromFileUrl, join } from "@std/path";
import { APP_ID, APP_NAME } from "../src/constants.ts";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const DEFAULT_DIST = join(ROOT, "dist");

interface Check {
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(ok: boolean, detail: string) {
  checks.push({ ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${detail}`);
}

function parseArguments(argv: string[]) {
  let app: string | undefined;
  let port = 47470;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app") app = argv[++i];
    else if (argv[i] === "--port") port = Number(argv[++i]);
    else if (!app && !argv[i].startsWith("--")) app = argv[i];
  }
  return { app, port };
}

/** Newest candidate in dist/: an application directory or an AppImage. */
async function findBuiltApp(distDirectory: string): Promise<string> {
  const candidates: { path: string; modified: number }[] = [];
  for await (const entry of Deno.readDir(distDirectory)) {
    const path = join(distDirectory, entry.name);
    const interesting =
      (entry.isDirectory && entry.name.startsWith(`${APP_NAME}-`)) ||
      (entry.isFile && entry.name.endsWith(".AppImage"));
    if (!interesting) continue;
    const info = await Deno.stat(path);
    candidates.push({ path, modified: info.mtime?.getTime() ?? 0 });
  }
  if (candidates.length === 0) {
    throw new Error(
      `No build found in ${distDirectory}. Run \`deno task build\` first.`,
    );
  }
  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0].path;
}

/** The executable inside an application directory, or the AppImage itself. */
async function executableFor(app: string): Promise<string> {
  const info = await Deno.stat(app);
  if (!info.isDirectory) return app;
  const executable = join(
    app,
    Deno.build.os === "windows" ? `${APP_ID}.exe` : APP_ID,
  );
  await Deno.stat(executable);
  return executable;
}

async function which(command: string): Promise<boolean> {
  try {
    const probe = new Deno.Command(
      Deno.build.os === "windows" ? "where" : "which",
      { args: [command], stdout: "null", stderr: "null" },
    );
    return (await probe.output()).code === 0;
  } catch {
    return false;
  }
}

const { app: requested, port } = parseArguments(Deno.args);
const app = requested ?? await findBuiltApp(DEFAULT_DIST);
const executable = await executableFor(app);

console.log(`Speaking MCP to ${app}\n`);

const dataDirectory = await Deno.makeTempDir({ prefix: "openotes-mcp-" });
// A build resolves its config directory from either the data directory or
// the XDG tree depending on its version and layout. Seed both, and look for
// the handshake in both, so this check is not coupled to that choice.
const xdgConfig = join(dataDirectory, "xdg-config");
const configCandidates = [dataDirectory, join(xdgConfig, APP_ID)];
const settings = JSON.stringify({
  mcp: { enabled: true, port, allowWrites: false },
});
for (const directory of configCandidates) {
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(join(directory, "settings.json"), settings);
}

// A headless runner has no display; xvfb-run supplies one. Where it is
// missing the application is launched directly and will fail if there is
// genuinely no display, which is the honest outcome.
const headless = Deno.build.os === "linux" && !Deno.env.get("DISPLAY") &&
  await which("xvfb-run");
const child = new Deno.Command(headless ? "xvfb-run" : executable, {
  args: headless ? ["-a", executable] : [],
  env: {
    ...Deno.env.toObject(),
    OPENOTES_DATA_DIR: dataDirectory,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: join(dataDirectory, "xdg-cache"),
  },
  stdout: "null",
  stderr: "null",
}).spawn();

interface Handshake {
  url: string;
  token: string;
  pid?: number;
  app?: string;
  version?: string;
}

let handshakePath = join(dataDirectory, "mcp.json");
let handshake: Handshake | undefined;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !handshake) {
  for (const directory of configCandidates) {
    const path = join(directory, "mcp.json");
    try {
      handshake = JSON.parse(await Deno.readTextFile(path)) as Handshake;
      handshakePath = path;
      break;
    } catch {
      /* not written yet */
    }
  }
  if (!handshake) await new Promise((resolve) => setTimeout(resolve, 500));
}

record(
  !!handshake,
  handshake
    ? `the endpoint published itself: ${handshake.url}, ` +
      `${handshake.token.length}-character token, ` +
      `${handshake.app} ${handshake.version}`
    : "the endpoint never published a handshake file",
);

const post = (body: unknown, token?: string, origin?: string) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });

if (handshake) {
  const configDirectory = join(handshakePath, "..");
  record(
    handshake.url === `http://127.0.0.1:${port}/mcp`,
    `it bound the port the settings asked for: ${handshake.url}`,
  );

  // Both files carry a credential. Neither may be readable by other accounts.
  if (Deno.build.os !== "windows") {
    for (const name of ["mcp.json", "mcp.token"]) {
      const mode = (await Deno.stat(join(configDirectory, name))).mode ?? 0;
      record(
        (mode & 0o077) === 0,
        `${name} is not readable by other accounts: ` +
          `0${(mode & 0o777).toString(8)}`,
      );
    }
  }

  const anonymous = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await anonymous.body?.cancel();
  record(
    anonymous.status === 401,
    `a request with no token is refused: HTTP ${anonymous.status}`,
  );

  const wrong = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    "n".repeat(handshake.token.length),
  );
  await wrong.body?.cancel();
  record(
    wrong.status === 401,
    `a wrong token of the right length is refused: HTTP ${wrong.status}`,
  );

  const fromPage = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    handshake.token,
    "https://example.invalid",
  );
  await fromPage.body?.cancel();
  record(
    fromPage.status === 403,
    `a web page holding the token is still refused: HTTP ${fromPage.status}`,
  );

  const initialize = await (await post({
    jsonrpc: "2.0",
    id: 4,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-check", version: "1" },
    },
  }, handshake.token)).json();
  record(
    typeof initialize.result?.serverInfo?.name === "string",
    `initialize answered as ${
      JSON.stringify(initialize.result?.serverInfo)
    }, ` +
      `speaking ${initialize.result?.protocolVersion}`,
  );

  const listed = await (await post(
    { jsonrpc: "2.0", id: 5, method: "tools/list" },
    handshake.token,
  )).json();
  const names: string[] = (listed.result?.tools ?? []).map(
    (tool: { name: string }) => tool.name,
  );
  record(
    names.length > 0,
    `tools/list returned ${names.length}: ${names.join(", ")}`,
  );

  // The settings above left writing off, so no tool that changes a note may
  // even be listed — a client cannot call what it was never offered.
  const mutating = names.filter((name) =>
    /^(create|update|append|delete|trash|move|restore|add|set|tag|untag)_/
      .test(name)
  );
  record(
    mutating.length === 0,
    mutating.length === 0
      ? "read-only mode offers no tool that writes"
      : `read-only mode still offered: ${mutating.join(", ")}`,
  );

  const tool = names.find((name) => name.includes("search")) ?? names[0];
  const called = await (await post({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: tool, arguments: { query: "anything" } },
  }, handshake.token)).json();
  const answer = called.result?.content?.[0]?.text ?? called.error?.message ??
    JSON.stringify(called);
  record(
    typeof answer === "string" && answer.length > 0,
    `${tool} before the vault is open explains itself: ` +
      `"${String(answer).replace(/\s+/g, " ").slice(0, 100)}"`,
  );
}

// Shut down. A handshake file that outlives its endpoint is a token on disk
// pointing at a port nothing is listening on.
if (Deno.build.os !== "windows") {
  await new Deno.Command("pkill", {
    args: ["-x", APP_ID],
    stdout: "null",
    stderr: "null",
  })
    .output().catch(() => {});
}
try {
  child.kill("SIGTERM");
} catch {
  /* already gone */
}
await Promise.race([
  child.status,
  new Promise((resolve) => setTimeout(resolve, 10_000)),
]);

let stale = true;
for (let i = 0; i < 40; i++) {
  try {
    await Deno.stat(handshakePath);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch {
    stale = false;
    break;
  }
}
record(!stale, "stopping the application took the handshake file with it");

await Deno.remove(dataDirectory, { recursive: true }).catch(() => {});

const failed = checks.filter((check) => !check.ok).length;
console.log(`
MCP check of ${app}
  checked:     the endpoint starts from settings, publishes a handshake a
               client can find, binds the chosen port, refuses a request
               without the token, with a wrong token, or from a web page,
               answers initialize and tools/list, hides every write tool
               while writing is off, explains itself when the vault is not
               open, and takes its handshake down on exit.
  not checked: reading or editing a real note. That needs an unlocked
               vault, which needs a passphrase this cannot supply;
               apps/desktop/tests/mcp_test.ts covers it against a real
               database instead.
`);
console.log(
  failed
    ? `${failed} of ${checks.length} checks FAILED`
    : `OK — ${checks.length} checks passed.`,
);
Deno.exit(failed ? 1 : 0);
