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
 * Starts a built Openotes and checks that it actually comes up.
 *
 * Three assertions, in order of how much they prove:
 *
 *   1. the process is still running after start-up;
 *   2. the interface server answers on its health endpoint
 *      (`/__openotes/health`, see apps/desktop/src/native/server.ts) and
 *      returns the instance header, which only the real server sets;
 *   3. `index.html` is served from that origin — so the interface bundle
 *      really did travel with the binary;
 *   4. nothing in the output looks like a start-up failure.
 *
 * What it does NOT prove is stated in the summary at the end of every run:
 * this is a start-up check, not a UI test. It never opens a note, never
 * touches the database beyond whatever start-up does, and cannot see whether
 * anything was painted in the window.
 *
 * The app is run against a throwaway HOME and XDG directory tree and a free
 * port, so it can never read or write the data of a real installation and
 * never collides with one that is already running.
 *
 *   deno task smoke                                   newest build in dist/
 *   deno run -A .../smoke-test.ts --app dist/Openotes-1.0.0-linux-x86_64
 *   deno run -A .../smoke-test.ts --app dist/Openotes-1.0.0-linux-x86_64.AppImage
 */

import { basename, fromFileUrl, join } from "@std/path";
import { exists } from "@std/fs";
import { APP_ID, APP_NAME } from "../src/constants.ts";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const DEFAULT_DIST = join(ROOT, "dist");
const HEALTH_PATH = "/__openotes/health";
const INSTANCE_HEADER = "x-openotes-instance";

interface Check {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
}

const checks: Check[] = [];

function record(name: string, status: Check["status"], detail: string) {
  checks.push({ name, status, detail });
  const marker = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`  [${marker}] ${name}: ${detail}`);
}

async function which(command: string): Promise<boolean> {
  try {
    const probe = new Deno.Command(
      Deno.build.os === "windows" ? "where" : "which",
      { args: [command], stdout: "null", stderr: "null" }
    );
    return (await probe.output()).code === 0;
  } catch {
    return false;
  }
}

/** An unused TCP port, handed to the app through OPENOTES_UI_PORT. */
function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

/** Newest candidate in dist/: an application directory or an AppImage. */
async function findBuiltApp(distDirectory: string): Promise<string> {
  const candidates: { path: string; modified: number }[] = [];
  for await (const entry of Deno.readDir(distDirectory)) {
    const path = join(distDirectory, entry.name);
    if (entry.isDirectory && entry.name.startsWith(`${APP_NAME}-`)) {
      candidates.push({
        path,
        modified: (await Deno.stat(path)).mtime?.getTime() ?? 0
      });
    } else if (entry.isFile && entry.name.endsWith(".AppImage")) {
      candidates.push({
        path,
        modified: (await Deno.stat(path)).mtime?.getTime() ?? 0
      });
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `Nothing to smoke-test in ${distDirectory}. Run "deno task build" ` +
        `first, or point --app at a build.`
    );
  }
  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0].path;
}

interface Launchable {
  executable: string;
  /** Extra environment the launcher needs. */
  env: Record<string, string>;
  description: string;
  cleanup?: () => Promise<void>;
}

/**
 * Turns whatever `--app` pointed at into something executable.
 *
 * An AppImage is extracted rather than mounted: GitHub's runners have no
 * FUSE, and `--appimage-extract` is built into the runtime, so this works
 * everywhere and still exercises the real payload.
 */
async function resolveLaunchable(path: string): Promise<Launchable> {
  const info = await Deno.stat(path);

  if (info.isDirectory) {
    for (const name of [APP_ID, `${APP_NAME}.exe`, APP_NAME, `${APP_ID}.exe`]) {
      const candidate = join(path, name);
      if (await exists(candidate)) {
        return {
          executable: candidate,
          env: {},
          description: `application directory ${path}`
        };
      }
    }
    throw new Error(`No Openotes launcher inside ${path}`);
  }

  if (path.endsWith(".AppImage")) {
    await Deno.chmod(path, 0o755).catch(() => {});
    const workDirectory = await Deno.makeTempDir({ prefix: "openotes-smoke-" });
    const extract = new Deno.Command(path, {
      args: ["--appimage-extract"],
      cwd: workDirectory,
      stdout: "null",
      stderr: "piped"
    });
    const result = await extract.output();
    if (result.code !== 0) {
      throw new Error(
        `Could not extract ${basename(path)}: ${
          new TextDecoder().decode(result.stderr).trim()
        }`
      );
    }
    const root = join(workDirectory, "squashfs-root");
    return {
      executable: join(root, APP_ID),
      // Inside a real AppImage the runtime sets APPIMAGE; paths.ts uses it to
      // decide it is running from one. Keep that true for the extracted copy.
      env: { APPIMAGE: path, APPDIR: root },
      description: `AppImage ${basename(path)} (extracted to ${root})`,
      cleanup: () =>
        Deno.remove(workDirectory, { recursive: true }).catch(() => {})
    };
  }

  return { executable: path, env: {}, description: `executable ${path}` };
}

interface DisplayWrapper {
  command: string;
  prefix: string[];
  note: string;
}

/**
 * On Linux the window needs a display server. If one is present it is used;
 * otherwise xvfb-run supplies a headless X server. Without either, the app
 * cannot start at all and the test says so rather than reporting a failure
 * that is really a missing dependency.
 */
async function resolveDisplay(executable: string): Promise<DisplayWrapper> {
  if (Deno.build.os !== "linux") {
    return { command: executable, prefix: [], note: "native display" };
  }
  if (Deno.env.get("DISPLAY") || Deno.env.get("WAYLAND_DISPLAY")) {
    return { command: executable, prefix: [], note: "existing display" };
  }
  if (await which("xvfb-run")) {
    return {
      command: "xvfb-run",
      prefix: ["-a", "--server-args=-screen 0 1280x800x24", executable],
      note: "xvfb-run"
    };
  }
  throw new Error(
    `No display and no xvfb-run. Install xvfb (apt-get install xvfb) or run ` +
      `the smoke test on a machine with a display.`
  );
}

/** Isolated HOME/XDG so a smoke test can never touch real notes. */
async function isolatedEnvironment(port: number): Promise<{
  env: Record<string, string>;
  home: string;
  cleanup: () => Promise<void>;
}> {
  const home = await Deno.makeTempDir({ prefix: "openotes-smoke-home-" });
  for (const sub of ["data", "config", "cache", "documents"]) {
    await Deno.mkdir(join(home, sub), { recursive: true });
  }
  return {
    home,
    env: {
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "data"),
      LOCALAPPDATA: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_DOCUMENTS_DIR: join(home, "documents"),
      OPENOTES_DATA_DIR: join(home, "data", APP_ID),
      OPENOTES_UI_PORT: String(port),
      OPENOTES_LOG_LEVEL: "debug"
    },
    cleanup: () => Deno.remove(home, { recursive: true }).catch(() => {})
  };
}

const FAILURE_MARKERS = [
  `${APP_NAME} could not start`,
  "Startup failed",
  "could not find the built user interface",
  "The encrypted SQLite library was not found",
  "PortUnavailableError",
  "Uncaught",
  "panicked at",
  "error while loading shared libraries"
];

export interface SmokeOptions {
  app?: string;
  timeoutSeconds?: number;
  distDirectory?: string;
}

async function smokeTest(options: SmokeOptions): Promise<number> {
  const timeout = (options.timeoutSeconds ?? 60) * 1000;
  const appPath = options.app ??
    (await findBuiltApp(options.distDirectory ?? DEFAULT_DIST));
  console.log(`Smoke-testing ${appPath}\n`);

  const launchable = await resolveLaunchable(appPath);
  const display = await resolveDisplay(launchable.executable);
  const port = freePort();
  const isolated = await isolatedEnvironment(port);
  const origin = `http://127.0.0.1:${port}`;

  if (Deno.build.os !== "windows") {
    await Deno.chmod(launchable.executable, 0o755).catch(() => {});
  }

  console.log(`  launching via ${display.note} on port ${port}`);
  const child = new Deno.Command(display.command, {
    args: display.prefix,
    env: { ...isolated.env, ...launchable.env },
    stdout: "piped",
    stderr: "piped",
    stdin: "null"
  }).spawn();

  // Both pipes have to be drained while the app runs, or a chatty start-up
  // fills the pipe buffer and the process blocks on its own logging.
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    append: (text: string) => void
  ) => {
    for await (const chunk of stream) append(decoder.decode(chunk, { stream: true }));
  };
  const stdoutDrained = drain(child.stdout, (text) => {
    stdout += text;
  });
  const stderrDrained = drain(child.stderr, (text) => {
    stderr += text;
  });

  let exited: { code: number; signal: Deno.Signal | null } | undefined;
  const exitPromise = child.status.then((status) => {
    exited = { code: status.code, signal: status.signal };
    return status;
  });

  // ---- 2. the health endpoint -------------------------------------------
  const deadline = Date.now() + timeout;
  let healthy = false;
  let instanceId: string | null = null;
  let lastError = "no attempt made";
  while (Date.now() < deadline && !exited) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`${origin}${HEALTH_PATH}`, {
        signal: controller.signal
      });
      clearTimeout(timer);
      instanceId = response.headers.get(INSTANCE_HEADER);
      const body = (await response.text()).trim();
      if (response.ok && instanceId && body === "ok") {
        healthy = true;
        break;
      }
      lastError = `HTTP ${response.status}, body "${body}", header ${instanceId}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // ---- 1. the process is still alive ------------------------------------
  if (exited) {
    record(
      "process stays alive",
      "fail",
      `exited with code ${exited.code}${
        exited.signal ? ` (signal ${exited.signal})` : ""
      } before the health check finished`
    );
  } else {
    record("process stays alive", "pass", `pid ${child.pid} still running`);
  }

  if (healthy) {
    record(
      "health endpoint answers",
      "pass",
      `${origin}${HEALTH_PATH} -> 200 "ok", instance ${instanceId}`
    );
  } else {
    record(
      "health endpoint answers",
      "fail",
      `no healthy response within ${timeout / 1000}s (${lastError})`
    );
  }

  // ---- 3. the interface is really there ---------------------------------
  if (healthy) {
    try {
      const response = await fetch(`${origin}/index.html`);
      const html = await response.text();
      if (response.ok && /<html/i.test(html)) {
        record(
          "interface is served",
          "pass",
          `GET /index.html -> 200, ${html.length} bytes of HTML`
        );
      } else {
        record(
          "interface is served",
          "fail",
          `GET /index.html -> ${response.status}, ${html.length} bytes`
        );
      }
    } catch (error) {
      record(
        "interface is served",
        "fail",
        error instanceof Error ? error.message : String(error)
      );
    }
  } else {
    record(
      "interface is served",
      "skipped",
      "the health endpoint never answered"
    );
  }

  // ---- shut down ---------------------------------------------------------
  if (!exited) {
    try {
      child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM");
    } catch {
      // already gone
    }
    const grace = new Promise((resolve) => setTimeout(resolve, 5000));
    await Promise.race([exitPromise, grace]);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      await exitPromise;
    }
  } else {
    await exitPromise;
  }

  // ---- 4. the output ------------------------------------------------------
  await Promise.allSettled([stdoutDrained, stderrDrained]);
  const combined = `${stdout}\n${stderr}`;
  const hits = FAILURE_MARKERS.filter((marker) => combined.includes(marker));
  if (hits.length === 0) {
    record(
      "no start-up errors logged",
      "pass",
      `${stdout.length + stderr.length} bytes of output, no failure markers`
    );
  } else {
    record(
      "no start-up errors logged",
      "fail",
      `output contains: ${hits.join("; ")}`
    );
  }

  const failed = checks.filter((check) => check.status === "fail");
  if (failed.length > 0) {
    console.log("\n----- captured output -----");
    console.log(combined.trim() || "(the process produced no output)");
    console.log("---------------------------");
  }

  await launchable.cleanup?.();
  await isolated.cleanup();

  console.log(`\nSmoke test of ${launchable.description}`);
  console.log(
    `  checked:     the process survives start-up, the interface server\n` +
      `               answers on ${HEALTH_PATH} with its instance header, the\n` +
      `               bundled index.html is served from that origin, and the\n` +
      `               output carries no start-up failure.\n` +
      `  not checked: nothing inside the window. This test cannot see whether\n` +
      `               the interface rendered, whether the database opened, or\n` +
      `               whether sync works — it only proves the application\n` +
      `               starts and serves its own interface.`
  );

  if (failed.length === 0) {
    console.log(`\nOK — ${checks.length} checks passed.`);
    return 0;
  }
  console.error(
    `\nFAILED — ${failed.length} of ${checks.length} checks failed: ${
      failed.map((check) => check.name).join(", ")
    }`
  );
  return 1;
}

function usage() {
  console.log(
    `Usage: deno run -A apps/desktop/scripts/smoke-test.ts [options]

  --app <path>      application directory, launcher or .AppImage to test
                    (default: the newest build in dist/)
  --dist <dir>      where to look for a build (default: dist/)
  --timeout <secs>  how long to wait for the health endpoint (default: 60)
  -h, --help        show this message`
  );
}

if (import.meta.main) {
  let app: string | undefined;
  let distDirectory: string | undefined;
  let timeoutSeconds: number | undefined;
  let help = false;

  for (let index = 0; index < Deno.args.length; index++) {
    const argument = Deno.args[index];
    if (argument === "--app") app = Deno.args[++index];
    else if (argument === "--dist") distDirectory = Deno.args[++index];
    else if (argument === "--timeout") {
      timeoutSeconds = Number.parseInt(Deno.args[++index], 10);
    } else if (argument === "-h" || argument === "--help") help = true;
    else {
      console.error(`Unknown option: ${argument}`);
      Deno.exit(2);
    }
  }

  if (help) {
    usage();
  } else {
    try {
      Deno.exit(await smokeTest({ app, distDirectory, timeoutSeconds }));
    } catch (error) {
      console.error(
        `\nSmoke test could not run: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      Deno.exit(1);
    }
  }
}
