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
 * Measures the things the spec asks to be measured (§30): startup, memory,
 * package size, note-open and search latency, sync latency.
 *
 * The rule this script exists to enforce is "do not claim a performance
 * improvement without measurement". So:
 *
 *  - every number is measured on the machine running it, now;
 *  - anything that cannot be measured here is reported as "not measured"
 *    rather than estimated, guessed, or quietly omitted;
 *  - there is no baseline comparison built in, because this repository has
 *    no Electron build to compare against. Comparing requires running the
 *    upstream build yourself and recording both, which is what the
 *    --baseline flag is for.
 *
 *   deno task bench                     run and print a report
 *   deno task bench -- --json out.json  also write machine-readable results
 *   deno task bench -- --baseline b.json  compare against a previous run
 */

import { join } from "@std/path";
import { appDataDir } from "../src/native/paths.ts";
import { configureNativeLibrary, SqliteService } from "../src/native/sqlite.ts";
import { APP_NAME, APP_VERSION } from "../src/constants.ts";

interface Measurement {
  name: string;
  unit: "ms" | "MB" | "count";
  value: number | null;
  samples?: number;
  note?: string;
}

const results: Measurement[] = [];

function record(measurement: Measurement) {
  results.push(measurement);
  const value = measurement.value === null
    ? "not measured"
    : `${
      measurement.value.toFixed(measurement.unit === "ms" ? 1 : 2)
    } ${measurement.unit}`;
  const samples = measurement.samples ? ` (n=${measurement.samples})` : "";
  console.log(`  ${measurement.name.padEnd(38)} ${value}${samples}`);
  if (measurement.note) console.log(`      ${measurement.note}`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

async function time(fn: () => unknown | Promise<unknown>): Promise<number> {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}

// ---------------------------------------------------------------------------
// Database benchmarks — the operations a user actually waits on.
// ---------------------------------------------------------------------------

async function benchmarkDatabase(noteCount: number) {
  console.log(`\nDatabase (${noteCount} notes, encrypted, FTS5)`);

  const directory = await Deno.makeTempDir({ prefix: "openotes-bench-" });
  const previousDataDir = Deno.env.get("OPENOTES_DATA_DIR");
  Deno.env.set("OPENOTES_DATA_DIR", directory);

  try {
    configureNativeLibrary();
  } catch (error) {
    record({
      name: "database benchmarks",
      unit: "ms",
      value: null,
      note: `skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    if (previousDataDir) Deno.env.set("OPENOTES_DATA_DIR", previousDataDir);
    return;
  }

  const sqlite = new SqliteService();
  const key = "ab".repeat(32);
  const path = join(directory, "bench.db");

  const openMs = await time(() =>
    sqlite.open({ filePath: path, password: key })
  );
  const handle = sqlite.open({ filePath: path, password: key });

  sqlite.run(
    handle,
    `CREATE TABLE notes (
       id TEXT PRIMARY KEY, title TEXT, dateModified INTEGER, synced INTEGER
     )`,
    [],
  );
  sqlite.run(
    handle,
    `CREATE TABLE content (
       id TEXT PRIMARY KEY, noteId TEXT, data TEXT, dateModified INTEGER,
       synced INTEGER
     )`,
    [],
  );
  sqlite.run(
    handle,
    `CREATE VIRTUAL TABLE content_fts USING fts5(
       id, noteId, data, tokenize='html better_trigram remove_diacritics 1'
     )`,
    [],
  );

  const words = [
    "meeting",
    "invoice",
    "recipe",
    "journal",
    "research",
    "quarterly",
    "budget",
    "travel",
    "reading",
    "interview",
    "prototype",
    "retrospective",
  ];
  const body = (index: number) =>
    `<p>${words[index % words.length]} note ${index}. ` +
    `${words[(index * 7) % words.length]} ${
      words[(index * 3) % words.length]
    } ` +
    `Some additional body text so the index has something to chew on.</p>`;

  const insertMs = await time(() => {
    sqlite.run(handle, "BEGIN", []);
    for (let index = 0; index < noteCount; index++) {
      sqlite.run(
        handle,
        "INSERT INTO notes (id, title, dateModified, synced) VALUES (?, ?, ?, 1)",
        [
          `n${index}`,
          `Note ${index} about ${words[index % words.length]}`,
          Date.now(),
        ],
      );
      sqlite.run(
        handle,
        "INSERT INTO content (id, noteId, data, dateModified, synced) VALUES (?, ?, ?, ?, 1)",
        [`c${index}`, `n${index}`, body(index), Date.now()],
      );
      sqlite.run(
        handle,
        "INSERT INTO content_fts (id, noteId, data) VALUES (?, ?, ?)",
        [`c${index}`, `n${index}`, body(index)],
      );
    }
    sqlite.run(handle, "COMMIT", []);
  });

  record({ name: "open encrypted database", unit: "ms", value: openMs });
  record({
    name: `insert ${noteCount} notes + index`,
    unit: "ms",
    value: insertMs,
  });
  record({
    name: "insert throughput",
    unit: "count",
    value: Math.round(noteCount / (insertMs / 1000)),
    note: "notes per second",
  });

  const openSamples: number[] = [];
  for (let index = 0; index < 50; index++) {
    const target = Math.floor((index * noteCount) / 50);
    openSamples.push(
      await time(() =>
        sqlite.run(
          handle,
          "SELECT n.*, c.data FROM notes n JOIN content c ON c.noteId = n.id WHERE n.id = ?",
          [`n${target}`],
        )
      ),
    );
  }
  record({
    name: "open one note",
    unit: "ms",
    value: median(openSamples),
    samples: openSamples.length,
    note: "median",
  });

  const searchSamples: number[] = [];
  for (const word of words) {
    searchSamples.push(
      await time(() =>
        sqlite.run(
          handle,
          "SELECT noteId FROM content_fts WHERE content_fts MATCH ? LIMIT 50",
          [word],
        )
      ),
    );
  }
  record({
    name: "full-text search",
    unit: "ms",
    value: median(searchSamples),
    samples: searchSamples.length,
    note: "median across distinct terms",
  });

  const listMs = await time(() =>
    sqlite.run(
      handle,
      "SELECT id, title FROM notes ORDER BY dateModified DESC LIMIT 100",
      [],
    )
  );
  record({ name: "list 100 most recent notes", unit: "ms", value: listMs });

  const dbSize = (await Deno.stat(path)).size / 1024 / 1024;
  record({
    name: `database size for ${noteCount} notes`,
    unit: "MB",
    value: dbSize,
  });

  sqlite.closeAll();
  await Deno.remove(directory, { recursive: true }).catch(() => {});
  if (previousDataDir) Deno.env.set("OPENOTES_DATA_DIR", previousDataDir);
  else Deno.env.delete("OPENOTES_DATA_DIR");
}

// ---------------------------------------------------------------------------
// Crypto and sync benchmarks
// ---------------------------------------------------------------------------

async function benchmarkCrypto() {
  console.log("\nCryptography");
  const { SyncCrypto } = await import("@notesnook/sync-webdav");
  const crypto_ = new SyncCrypto();

  const deriveMs = await time(() =>
    crypto_.deriveMasterKey(
      "a reasonably long test passphrase",
      "AAAAAAAAAAAAAAAAAAAAAA",
    )
  );
  record({
    name: "derive master key (argon2)",
    unit: "ms",
    value: deriveMs,
    note: "deliberately slow; happens once per unlock",
  });

  const master = await crypto_.deriveMasterKey(
    "a reasonably long test passphrase",
    "AAAAAAAAAAAAAAAAAAAAAA",
  );
  const syncKey = await crypto_.deriveSubkey(master, "sync");

  const note = { id: "n1", title: "Benchmark", data: "x".repeat(4096) };
  const encryptSamples: number[] = [];
  for (let index = 0; index < 200; index++) {
    encryptSamples.push(await time(() => crypto_.encryptJson(syncKey, note)));
  }
  record({
    name: "encrypt one 4 KB record",
    unit: "ms",
    value: median(encryptSamples),
    samples: encryptSamples.length,
    note: "median",
  });

  const payload = new Uint8Array(5 * 1024 * 1024);
  crypto.getRandomValues(payload.subarray(0, 65536));
  const bulkMs = await time(() => crypto_.encryptBytes(syncKey, payload));
  record({
    name: "encrypt 5 MB attachment",
    unit: "ms",
    value: bulkMs,
    note: `${(5 / (bulkMs / 1000)).toFixed(1)} MB/s`,
  });
}

async function benchmarkSync() {
  console.log("\nSynchronization (against a local WebDAV server)");

  const { FakeWebDavServer } = await import(
    "../../../packages/sync-webdav/tests/fake-server.ts"
  );
  const { createDevice } = await import(
    "../../../packages/sync-webdav/tests/harness.ts"
  );

  const server = new FakeWebDavServer();
  await server.start();
  try {
    const a = await createDevice({ id: "BENCHDEVA", baseUrl: server.url });
    const connectMs = await time(() => a.engine.connect());
    record({
      name: "connect and verify repository",
      unit: "ms",
      value: connectMs,
    });

    for (let index = 0; index < 200; index++) {
      a.store.put({
        id: `n${index}`,
        type: "note",
        title: `Note ${index}`,
        content: "some content here",
      });
    }
    const pushMs = await time(() => a.engine.sync());
    record({
      name: "first sync, 200 notes (upload)",
      unit: "ms",
      value: pushMs,
    });

    const b = await createDevice({ id: "BENCHDEVB", baseUrl: server.url });
    const pullMs = await time(() => b.engine.sync());
    record({
      name: "first sync, 200 notes (download)",
      unit: "ms",
      value: pullMs,
    });

    const idleMs = await time(() => a.engine.sync());
    record({
      name: "sync with no changes",
      unit: "ms",
      value: idleMs,
      note: "what a periodic sync costs when nothing happened",
    });

    a.store.put({
      id: "n5",
      type: "note",
      title: "Edited",
      content: "changed",
    });
    const incrementalMs = await time(() => a.engine.sync());
    record({
      name: "sync one changed note",
      unit: "ms",
      value: incrementalMs,
    });
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------------
// Footprint
// ---------------------------------------------------------------------------

async function benchmarkFootprint() {
  console.log("\nFootprint");

  const memory = Deno.memoryUsage();
  record({
    name: "runtime heap after benchmarks",
    unit: "MB",
    value: memory.heapUsed / 1024 / 1024,
    note: "this process only; not the webview's memory",
  });
  record({
    name: "runtime RSS after benchmarks",
    unit: "MB",
    value: memory.rss / 1024 / 1024,
  });

  const uiRoot = Deno.env.get("OPENOTES_UI_ROOT") ??
    join(Deno.cwd(), "apps", "web", "build");
  const uiSize = await directorySize(uiRoot);
  record({
    name: "built interface size",
    unit: "MB",
    value: uiSize === null ? null : uiSize / 1024 / 1024,
    note: uiSize === null ? "not built; run deno task build:ui" : undefined,
  });

  const nativeSize = await directorySize(
    join(Deno.cwd(), "apps", "desktop", "native"),
  );
  record({
    name: "native libraries size",
    unit: "MB",
    value: nativeSize === null ? null : nativeSize / 1024 / 1024,
    note: nativeSize === null
      ? "not built; run deno task build:native"
      : undefined,
  });

  const distSize = await directorySize(
    join(Deno.cwd(), "apps", "desktop", "dist"),
  );
  record({
    name: "packaged artifacts size",
    unit: "MB",
    value: distSize === null ? null : distSize / 1024 / 1024,
    note: distSize === null ? "not built; run deno task build" : undefined,
  });

  // Cold and warm application startup need a built binary and a display;
  // the CI smoke test measures those where it can. Claiming a number here
  // that was not measured would be exactly the thing the spec forbids.
  record({
    name: "cold application startup",
    unit: "ms",
    value: null,
    note: "measured by the smoke test against a built binary, not here",
  });
  record({
    name: "warm application startup",
    unit: "ms",
    value: null,
    note: "measured by the smoke test against a built binary, not here",
  });
  record({
    name: "idle / active editor RSS",
    unit: "MB",
    value: null,
    note: "needs a running window; not measurable from this process",
  });
}

async function directorySize(path: string): Promise<number | null> {
  let total = 0;
  let found = false;
  const walk = async (directory: string) => {
    try {
      for await (const entry of Deno.readDir(directory)) {
        const child = join(directory, entry.name);
        if (entry.isDirectory) await walk(child);
        else {
          total += (await Deno.stat(child)).size;
          found = true;
        }
      }
    } catch {
      /* missing directory */
    }
  };
  await walk(path);
  return found ? total : null;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = Deno.args;
  const noteCount = Number(
    args.find((arg) => arg.startsWith("--notes="))?.split("=")[1] ?? 2000,
  );

  console.log(`${APP_NAME} ${APP_VERSION} benchmarks`);
  console.log(
    `Deno ${Deno.version.deno} · ${Deno.build.target} · ${
      new Date().toISOString()
    }`,
  );
  console.log(`Data directory: ${appDataDir()}`);

  await benchmarkDatabase(Number.isFinite(noteCount) ? noteCount : 2000);
  await benchmarkCrypto();
  await benchmarkSync();
  await benchmarkFootprint();

  const notMeasured = results.filter((result) => result.value === null);
  console.log(
    `\n${results.length - notMeasured.length} measured, ` +
      `${notMeasured.length} not measurable in this environment.`,
  );

  const jsonFlag = args.findIndex((arg) => arg === "--json");
  if (jsonFlag >= 0) {
    const path = args[jsonFlag + 1] ?? "benchmark-results.json";
    await Deno.writeTextFile(
      path,
      JSON.stringify(
        {
          app: APP_NAME,
          version: APP_VERSION,
          deno: Deno.version.deno,
          target: Deno.build.target,
          timestamp: new Date().toISOString(),
          results,
        },
        null,
        2,
      ),
    );
    console.log(`Wrote ${path}`);
  }

  const baselineFlag = args.findIndex((arg) => arg === "--baseline");
  if (baselineFlag >= 0) {
    const path = args[baselineFlag + 1];
    if (!path) {
      console.error("--baseline needs a file path");
      Deno.exit(2);
    }
    await compareWithBaseline(path);
  }
}

async function compareWithBaseline(path: string) {
  let baseline: { results: Measurement[]; version?: string };
  try {
    baseline = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    console.error(
      `Could not read the baseline: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(2);
  }

  console.log(
    `\nCompared with ${path} (${baseline.version ?? "unknown version"})`,
  );
  const byName = new Map(
    baseline.results.map((result) => [result.name, result]),
  );
  for (const current of results) {
    const previous = byName.get(current.name);
    if (!previous || previous.value === null || current.value === null) {
      continue;
    }
    const delta = current.value - previous.value;
    const percent = previous.value === 0 ? 0 : (delta / previous.value) * 100;
    const direction = delta === 0 ? "=" : delta < 0 ? "faster" : "slower";
    console.log(
      `  ${current.name.padEnd(38)} ${previous.value.toFixed(1)} → ` +
        `${current.value.toFixed(1)} ${current.unit} ` +
        `(${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%, ${direction})`,
    );
  }
}

if (import.meta.main) await main();
