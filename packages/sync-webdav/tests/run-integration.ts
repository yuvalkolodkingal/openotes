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
 * Runs the WebDAV suite against a REAL, third-party WebDAV server rather
 * than the in-process test double (spec §49).
 *
 * The unit suite uses a fake server because it can inject failures a real
 * server will not produce on demand. This runner exists for the other half
 * of the question: does the client actually interoperate with a WebDAV
 * implementation nobody on this project wrote?
 *
 * Server selection, in order:
 *   1. WEBDAV_TEST_URL — an already-running server (CI service container,
 *      or a Nextcloud instance you point it at).
 *   2. A `dufs` binary on PATH or at DUFS_BINARY.
 *   3. Downloaded dufs release (verified against a pinned SHA-256) unless
 *      --no-download is passed.
 *
 * Exits non-zero if the tests fail, or if no server could be obtained and
 * --require-server was passed (which CI does, so a silently skipped
 * integration run cannot be mistaken for a passing one).
 */

import { join } from "@std/path";
import { encodeHex } from "@std/encoding/hex";

const DUFS_VERSION = "0.43.0";
const DUFS_ASSETS: Record<string, { file: string; sha256: string }> = {
  "linux-x86_64": {
    file: `dufs-v${DUFS_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "e41a21fd11d1cbbc7fcaba8c6d246d878dfab5a5d12be48db84d8067c3f1c995",
  },
  "linux-aarch64": {
    file: `dufs-v${DUFS_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    sha256: "",
  },
  "darwin-x86_64": {
    file: `dufs-v${DUFS_VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "",
  },
  "darwin-aarch64": {
    file: `dufs-v${DUFS_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "",
  },
  "windows-x86_64": {
    file: `dufs-v${DUFS_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "",
  },
};

const TEST_USER = "openotes";
const TEST_PASSWORD = "integration-test-password";

interface RunningServer {
  url: string;
  username?: string;
  password?: string;
  description: string;
  stop(): Promise<void>;
}

async function sha256(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
  );
}

function platformKey(): string {
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  return `${Deno.build.os}-${arch}`;
}

async function commandExists(command: string): Promise<boolean> {
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

function freePort(): number {
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

async function waitForServer(
  url: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Authorization: "Basic " + btoa(`${TEST_USER}:${TEST_PASSWORD}`),
        },
      });
      await response.body?.cancel();
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** An externally provided server (CI service container, Nextcloud, ...). */
async function useExternalServer(): Promise<RunningServer | undefined> {
  const url = Deno.env.get("WEBDAV_TEST_URL");
  if (!url) return undefined;
  const username = Deno.env.get("WEBDAV_TEST_USER") ?? TEST_USER;
  const password = Deno.env.get("WEBDAV_TEST_PASSWORD") ?? TEST_PASSWORD;

  const reachable = await waitForServer(url);
  if (!reachable) {
    throw new Error(
      `WEBDAV_TEST_URL is set to ${url} but the server did not respond to ` +
        `OPTIONS within 20s.`,
    );
  }
  return {
    url,
    username,
    password,
    description: `external server at ${url}`,
    stop: () => Promise.resolve(),
  };
}

async function startDufs(binary: string): Promise<RunningServer> {
  const port = freePort();
  const root = await Deno.makeTempDir({ prefix: "openotes-webdav-" });

  const child = new Deno.Command(binary, {
    args: [
      root,
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--allow-all",
      "--auth",
      `${TEST_USER}:${TEST_PASSWORD}@/:rw`,
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();

  const url = `http://127.0.0.1:${port}/`;
  if (!(await waitForServer(url))) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    const stderr = await new Response(child.stderr).text();
    throw new Error(`dufs did not start.\n${stderr.slice(0, 2000)}`);
  }

  return {
    url,
    username: TEST_USER,
    password: TEST_PASSWORD,
    description: `dufs ${DUFS_VERSION} on ${url}`,
    async stop() {
      try {
        child.kill();
        await child.status;
      } catch {
        /* already exited */
      }
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

async function downloadDufs(): Promise<string | undefined> {
  const key = platformKey();
  const asset = DUFS_ASSETS[key];
  if (!asset) {
    console.error(`  no dufs release is published for ${key}`);
    return undefined;
  }

  const cacheDir = join(
    Deno.env.get("TMPDIR") ?? "/tmp",
    "openotes-webdav-tools",
  );
  await Deno.mkdir(cacheDir, { recursive: true });
  const binaryPath = join(
    cacheDir,
    Deno.build.os === "windows" ? "dufs.exe" : "dufs",
  );
  try {
    await Deno.stat(binaryPath);
    return binaryPath;
  } catch {
    /* download below */
  }

  const url =
    `https://github.com/sigoden/dufs/releases/download/v${DUFS_VERSION}/${asset.file}`;
  console.log(`  downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`  download failed: HTTP ${response.status}`);
    return undefined;
  }
  const archive = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256(archive);
  console.log(`  sha256 ${digest}`);

  // A pinned hash is enforced when we have recorded one. Where we have not
  // (the platforms this project cannot test on), the hash is printed so it
  // can be recorded, and the download proceeds only outside CI.
  if (asset.sha256 && digest !== asset.sha256) {
    throw new Error(
      `dufs checksum mismatch for ${asset.file}\n` +
        `  expected ${asset.sha256}\n  actual   ${digest}`,
    );
  }
  if (!asset.sha256 && Deno.env.get("CI")) {
    throw new Error(
      `No pinned checksum is recorded for ${asset.file}; refusing to run an ` +
        `unverified binary in CI. Record the hash above in DUFS_ASSETS.`,
    );
  }

  const archivePath = join(cacheDir, asset.file);
  await Deno.writeFile(archivePath, archive);
  const extract = asset.file.endsWith(".zip")
    ? new Deno.Command("unzip", { args: ["-o", archivePath, "-d", cacheDir] })
    : new Deno.Command("tar", { args: ["xzf", archivePath, "-C", cacheDir] });
  const { code } = await extract.output();
  if (code !== 0) {
    console.error("  could not extract the dufs archive");
    return undefined;
  }
  if (Deno.build.os !== "windows") await Deno.chmod(binaryPath, 0o755);
  return binaryPath;
}

async function obtainServer(
  allowDownload: boolean,
): Promise<RunningServer | undefined> {
  const external = await useExternalServer();
  if (external) return external;

  const configured = Deno.env.get("DUFS_BINARY");
  if (configured) return await startDufs(configured);

  if (await commandExists("dufs")) return await startDufs("dufs");

  if (!allowDownload) return undefined;
  const downloaded = await downloadDufs();
  if (!downloaded) return undefined;
  return await startDufs(downloaded);
}

async function main() {
  const args = new Set(Deno.args);
  const requireServer = args.has("--require-server") || !!Deno.env.get("CI");

  console.log("WebDAV integration tests");
  console.log("------------------------");

  let server: RunningServer | undefined;
  try {
    server = await obtainServer(!args.has("--no-download"));
  } catch (error) {
    console.error(
      `\nCould not start a WebDAV server: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(requireServer ? 1 : 0);
  }

  if (!server) {
    const message =
      "No real WebDAV server is available. Set WEBDAV_TEST_URL, install " +
      "dufs, or allow the download.";
    if (requireServer) {
      console.error(`\nFAILED: ${message}`);
      console.error(
        "These tests are required, so a missing server is a failure rather " +
          "than a skip.",
      );
      Deno.exit(1);
    }
    console.warn(`\nSKIPPED: ${message}`);
    Deno.exit(0);
  }

  console.log(`Using ${server.description}\n`);

  const testFile =
    new URL("./integration/integration_test.ts", import.meta.url).pathname;
  const test = new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--no-check", testFile],
    env: {
      WEBDAV_INTEGRATION_URL: server.url,
      WEBDAV_INTEGRATION_USER: server.username ?? "",
      WEBDAV_INTEGRATION_PASSWORD: server.password ?? "",
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await test.output();
  await server.stop();

  if (code !== 0) {
    console.error("\nWebDAV integration tests FAILED");
    Deno.exit(code);
  }
  console.log("\nWebDAV integration tests passed");
}

if (import.meta.main) await main();
