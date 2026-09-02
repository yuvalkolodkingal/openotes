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
 * Runs the SQL storage suite against a real Postgres.
 *
 *   deno task test:sql                      uses POSTGRES_TEST_URL, or the
 *                                           conventional local default
 *   deno task test:sql --require-server     fail rather than skip when no
 *                                           server answers (CI)
 */

const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const requireServer = Deno.args.includes("--require-server");
const url = Deno.env.get("POSTGRES_TEST_URL") ?? DEFAULT_URL;

const { PostgresExecutor } = await import("../src/postgres.ts");
const probe = new PostgresExecutor(url, { timeoutSeconds: 5 });
let reachable = false;
try {
  await probe.query("SELECT 1");
  reachable = true;
} catch (error) {
  console.error(
    `No Postgres at ${url.replace(/:[^:@/]+@/, ":***@")}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
} finally {
  await probe.close().catch(() => {});
}

if (!reachable) {
  if (requireServer) {
    console.error("--require-server was given; refusing to skip.");
    Deno.exit(1);
  }
  console.log("Skipping the SQL integration suite.");
  Deno.exit(0);
}

const test = new Deno.Command(Deno.execPath(), {
  args: ["test", "-A", new URL("./postgres_test.ts", import.meta.url).pathname],
  env: { POSTGRES_TEST_URL: url },
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
Deno.exit((await test.status).code);
