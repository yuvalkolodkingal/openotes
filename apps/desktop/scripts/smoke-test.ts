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
 * WHY THIS READS THE LOG INSTEAD OF CURLING THE APPLICATION
 *
 * The obvious smoke test is to fetch the interface server's health route.
 * It cannot be relied on. Under `deno desktop` the runtime owns the
 * listening address: the port handed to `Deno.serve` is ignored, the
 * runtime substitutes its own and publishes it as DENO_SERVE_ADDRESS, and
 * apps/desktop/src/native/server.ts documents the socket as wired to the
 * embedded webview rather than to the machine. So there is no port this
 * script can predict, and no guarantee the one it discovers is reachable.
 *
 * Every assertion below therefore comes from the one thing the application
 * definitely publishes — its structured start-up log on stdout — and the
 * health route is probed afterwards, at whatever address the log reports,
 * purely as information. (On Linux/x86_64 with Deno 2.9.6 that probe does
 * get a 200; the check does not depend on it either way.)
 *
 * What is asserted, in order of how much it proves:
 *
 *   1. the process survives start-up and is still running afterwards;
 *   2. the interface server started, and the directory it serves is the
 *      `ui/` directory that travelled with this build — so packaging really
 *      did put the interface next to the binary;
 *   3. the bundled SQLite3MultipleCiphers library loaded from this build's
 *      `native/` directory and the runtime verified that the engine
 *      encrypts in-process — so the native libraries travelled too, and the
 *      vault is not silently plaintext;
 *   4. the application logged that it is ready and started;
 *   5. nothing in the output looks like a start-up failure.
 *
 * What is NOT asserted is printed at the end of every run: nothing inside
 * the window. This cannot see whether the interface rendered, whether a
 * note can be written, or whether sync works.
 *
 * The application runs against a throwaway HOME and XDG tree, so a smoke
 * test can never touch the data of a real installation.
 *
 *   deno task smoke                                   newest build in dist/
 *   deno run -A .../smoke-test.ts --app dist/Openotes-1.0.0-linux-x86_64
 *   deno run -A .../smoke-test.ts --app dist/Openotes-1.0.0-linux-x86_64.AppImage
 */

import { basename, fromFileUrl, join, resolve } from "@std/path";
import { exists } from "@std/fs";
import { APP_ID, APP_NAME } from "../src/constants.ts";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));
const DEFAULT_DIST = join(ROOT, "dist");
const HEALTH_PATH = "/__openotes/health";

interface Check {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
}

const checks: Check[] = [];

function record(name: string, status: Check["status"], detail: string) {
  checks.push({ name, status, detail });
  const marker = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "INFO";
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

/** Newest candidate in dist/: an application directory or an AppImage. */
async function findBuiltApp(distDirectory: string): Promise<string> {
  const candidates: { path: string; modified: number }[] = [];
  for await (const entry of Deno.readDir(distDirectory)) {
    const path = join(distDirectory, entry.name);
    const interesting =
      (entry.isDirectory && entry.name.startsWith(`${APP_NAME}-`)) ||
      (entry.isFile && entry.name.endsWith(".AppImage"));
    if (!interesting) continue;
    candidates.push({
      path,
      modified: (await Deno.stat(path)).mtime?.getTime() ?? 0
    });
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
  /** Directory the bundled resources are expected to sit in. */
  payloadRoot: string;
  /** Extra environment the launcher needs. */
  env: Record<string, string>;
  description: string;
  cleanup?: () => Promise<void>;
}

/**
 * Turns whatever `--app` pointed at into something executable.
 *
 * An AppImage is extracted rather than mounted: GitHub's runners have no
 * FUSE, and `--appimage-extract` is built into the AppImage runtime, so this
 * works everywhere and still exercises the real payload.
 */
async function resolveLaunchable(path: string): Promise<Launchable> {
  const info = await Deno.stat(path);

  if (info.isDirectory) {
    for (const name of [APP_ID, `${APP_NAME}.exe`, APP_NAME, `${APP_ID}.exe`]) {
      const candidate = join(path, name);
      if (await exists(candidate)) {
        return {
          executable: candidate,
          payloadRoot: path,
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
    const result = await new Deno.Command(path, {
      args: ["--appimage-extract"],
      cwd: workDirectory,
      stdout: "null",
      stderr: "piped"
    }).output();
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
      payloadRoot: root,
      // Inside a real AppImage the runtime sets APPIMAGE and APPDIR;
      // paths.ts reads APPIMAGE to decide it is running from one.
      env: { APPIMAGE: path, APPDIR: root },
      description: `AppImage ${basename(path)} (extracted to ${root})`,
      cleanup: () =>
        Deno.remove(workDirectory, { recursive: true }).catch(() => {})
    };
  }

  return {
    executable: path,
    payloadRoot: resolve(path, ".."),
    env: {},
    description: `executable ${path}`
  };
}

interface DisplayWrapper {
  command: string;
  prefix: string[];
  note: string;
}

/**
 * On Linux the window needs a display server. If one is present it is used;
 * otherwise xvfb-run supplies a headless X server. Without either, the app
 * cannot start at all, and the test says so rather than reporting a failure
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
async function isolatedEnvironment(): Promise<{
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const home = await Deno.makeTempDir({ prefix: "openotes-smoke-home-" });
  for (const sub of ["data", "config", "cache", "documents"]) {
    await Deno.mkdir(join(home, sub), { recursive: true });
  }
  return {
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
      OPENOTES_LOG_LEVEL: "debug"
    },
    cleanup: () => Deno.remove(home, { recursive: true }).catch(() => {})
  };
}

const FAILURE_MARKERS = [
  `${APP_NAME} could not start`,
  "Startup failed",
  "Could not find the built user interface",
  "The encrypted SQLite library was not found",
  "is already running",
  "Uncaught",
  "panicked at",
  "error while loading shared libraries",
  "Segmentation fault"
];

interface LogLine {
  level?: string;
  scope?: string;
  message?: string;
  context?: Record<string, unknown>;
}

/** The application logs one JSON object per line; other output is ignored. */
function parseLogLines(output: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of output.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      lines.push(JSON.parse(trimmed) as LogLine);
    } catch {
      // Not one of ours.
    }
  }
  return lines;
}

function findLine(
  lines: LogLine[],
  scope: string,
  fragment: string
): LogLine | undefined {
  return lines.find(
    (line) => line.scope === scope && (line.message ?? "").includes(fragment)
  );
}

/**
 * Is the interface port reachable from this process? Expected to be "no";
 * reported for information, never as a failure. See the file header.
 */
async function probeInterfacePort(origin: string): Promise<string> {
  const match = /^http:\/\/([^:/]+):(\d+)/.exec(origin);
  if (!match) return `could not parse an address out of "${origin}"`;
  const [, hostname, port] = match;
  try {
    const connection = await Deno.connect({
      hostname,
      port: Number.parseInt(port, 10)
    });
    try {
      await connection.write(
        new TextEncoder().encode(
          `GET ${HEALTH_PATH} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
            `Connection: close\r\n\r\n`
        )
      );
      const buffer = new Uint8Array(4096);
      const read = await connection.read(buffer);
      const response = new TextDecoder().decode(buffer.subarray(0, read ?? 0));
      const status = /^HTTP\/1\.[01] (\d+)/.exec(response)?.[1] ?? "?";
      return `reachable from outside — ${HEALTH_PATH} answered ${status}`;
    } finally {
      connection.close();
    }
  } catch (error) {
    return (
      `not reachable from outside the process (${
        error instanceof Error ? error.message : String(error)
      }) — the documented behaviour of deno desktop's serve socket, not a fault`
    );
  }
}

export interface SmokeOptions {
  app?: string;
  timeoutSeconds?: number;
  distDirectory?: string;
}

async function smokeTest(options: SmokeOptions): Promise<number> {
  const timeout = (options.timeoutSeconds ?? 90) * 1000;
  const appPath = options.app ??
    (await findBuiltApp(options.distDirectory ?? DEFAULT_DIST));
  console.log(`Smoke-testing ${appPath}\n`);

  const launchable = await resolveLaunchable(appPath);
  const display = await resolveDisplay(launchable.executable);
  const isolated = await isolatedEnvironment();

  if (Deno.build.os !== "windows") {
    await Deno.chmod(launchable.executable, 0o755).catch(() => {});
  }

  console.log(`  launching via ${display.note}`);
  const child = new Deno.Command(display.command, {
    args: display.prefix,
    env: { ...isolated.env, ...launchable.env },
    stdout: "piped",
    stderr: "piped",
    stdin: "null"
  }).spawn();

  // Both pipes have to be drained while the application runs, or a chatty
  // start-up fills the pipe buffer and the process blocks on its own log.
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    append: (text: string) => void
  ) => {
    for await (const chunk of stream) {
      append(decoder.decode(chunk, { stream: true }));
    }
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

  // Wait for the line the application prints once everything is up.
  const deadline = Date.now() + timeout;
  let ready = false;
  while (Date.now() < deadline && !exited) {
    if (findLine(parseLogLines(`${stdout}\n${stderr}`), "main", "started")) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Give a started application a moment to fall over on its own before
  // declaring that it survived start-up.
  if (ready && !exited) {
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }

  const lines = parseLogLines(`${stdout}\n${stderr}`);
  const serverLine = findLine(lines, "server", "Interface server started");
  const sqliteLine = findLine(lines, "sqlite", "Using bundled SQLite");
  const encryptionLine = findLine(lines, "sqlite", "encrypts in this process");
  const readyLine = findLine(lines, "app", "Application ready");
  const startedLine = findLine(lines, "main", "started");

  // ---- 1 -------------------------------------------------------------------
  if (exited) {
    record(
      "process survives start-up",
      "fail",
      `exited with code ${exited.code}${
        exited.signal ? ` (signal ${exited.signal})` : ""
      } after ${timeout / 1000}s`
    );
  } else {
    record("process survives start-up", "pass", `pid ${child.pid} still running`);
  }

  // ---- 2 -------------------------------------------------------------------
  const servedRoot = serverLine?.context?.root;
  const expectedUi = join(launchable.payloadRoot, "ui");
  if (typeof servedRoot === "string" && resolve(servedRoot) === resolve(expectedUi)) {
    record("interface travelled with the build", "pass", `serving ${servedRoot}`);
  } else if (typeof servedRoot === "string") {
    record(
      "interface travelled with the build",
      "fail",
      `serving ${servedRoot}, expected ${expectedUi}`
    );
  } else {
    record(
      "interface travelled with the build",
      "fail",
      "the interface server never reported a root directory"
    );
  }

  // ---- 3 -------------------------------------------------------------------
  const libraryPath = sqliteLine?.context?.path;
  const expectedNative = join(launchable.payloadRoot, "native");
  if (
    typeof libraryPath === "string" &&
    resolve(libraryPath).startsWith(resolve(expectedNative))
  ) {
    if (encryptionLine) {
      record(
        "native libraries travelled, encryption is live",
        "pass",
        `${libraryPath}; the runtime verified the engine encrypts in-process`
      );
    } else {
      record(
        "native libraries travelled, encryption is live",
        "fail",
        `loaded ${libraryPath} but the encryption check never reported`
      );
    }
  } else {
    record(
      "native libraries travelled, encryption is live",
      "fail",
      typeof libraryPath === "string"
        ? `loaded ${libraryPath}, expected something under ${expectedNative}`
        : `no bundled SQLite library was reported (expected one under ${expectedNative})`
    );
  }

  // ---- 4 -------------------------------------------------------------------
  if (readyLine && startedLine) {
    const version = (readyLine.context as { version?: string } | undefined)
      ?.version;
    record(
      "application reports itself started",
      "pass",
      `"${startedLine.message}"${version ? `, version ${version}` : ""}`
    );
  } else {
    record(
      "application reports itself started",
      "fail",
      `the log is missing ${
        [!readyLine && '"Application ready"', !startedLine && "the start-up line"]
          .filter(Boolean)
          .join(" and ")
      }`
    );
  }

  // ---- shut down -----------------------------------------------------------
  if (!exited) {
    try {
      child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM");
    } catch {
      // already gone
    }
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 5000))
    ]);
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

  // Bounded: under xvfb-run the X server inherits these pipes and can hold
  // them open after the application is gone, so waiting for the streams to
  // end would wait forever.
  await Promise.race([
    Promise.allSettled([stdoutDrained, stderrDrained]),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);

  // ---- 5 -------------------------------------------------------------------
  const combined = `${stdout}\n${stderr}`;
  const hits = FAILURE_MARKERS.filter((marker) => combined.includes(marker));
  if (hits.length === 0) {
    record(
      "no start-up errors logged",
      "pass",
      `${combined.length} bytes of output, no failure markers`
    );
  } else {
    record(
      "no start-up errors logged",
      "fail",
      `output contains: ${hits.join("; ")}`
    );
  }

  // ---- informational -------------------------------------------------------
  const origin = typeof serverLine?.context?.origin === "string"
    ? serverLine.context.origin
    : undefined;
  record(
    "interface port from outside",
    "skipped",
    origin
      ? await probeInterfacePort(origin)
      : "no origin was reported, so there was nothing to probe"
  );

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
    `  checked:     the process survives start-up; the interface server is\n` +
      `               serving this build's own ui/ directory; the encrypted\n` +
      `               SQLite library loaded from this build's own native/\n` +
      `               directory and the engine was verified to encrypt; the\n` +
      `               application logged that it started; and the output\n` +
      `               carries no start-up failure.\n` +
      `  not checked: anything inside the window. This cannot see whether the\n` +
      `               interface rendered, whether a note can be written, or\n` +
      `               whether sync works. It also cannot reach the interface\n` +
      `               server over the network: deno desktop wires that socket\n` +
      `               to the webview, not to the machine.`
  );

  if (failed.length === 0) {
    const passed = checks.filter((check) => check.status === "pass").length;
    console.log(`\nOK — ${passed} checks passed.`);
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
  --timeout <secs>  how long to wait for the start-up line (default: 90)
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
