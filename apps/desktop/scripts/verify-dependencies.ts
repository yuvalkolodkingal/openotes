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
 * CI guard: Electron and the mobile toolchain must stay gone (spec §10, §33).
 *
 * Openotes is a Deno Desktop application. Electron was removed wholesale, and
 * so were the React Native / Fastlane / Detox pieces that belonged to the
 * mobile app. This script fails the build if any of it comes back.
 *
 * Precision matters more than breadth here. Half of this repository's prose
 * *talks about* Electron — PORTING_NOTES.md is an audit of it, and several
 * source files carry comments explaining what replaced it. A grep for the
 * word "electron" would fail on all of them and would be turned off within a
 * week. So the checks are structural instead:
 *
 *   - manifests  (package.json)  — dependency **keys** are parsed out of the
 *                                  dependency maps and matched exactly; the
 *                                  `scripts` values are matched on whole
 *                                  command words only.
 *   - deno.json / deno.jsonc     — import-map values, matched as npm/jsr
 *                                  specifiers.
 *   - lockfiles                  — package identifiers, matched exactly.
 *   - source                     — only real module references:
 *                                  `import … from "x"`, `require("x")`,
 *                                  `import("x")`. A comment mentioning
 *                                  electron-trpc is not a dependency.
 *
 *   deno task verify:no-electron
 *   deno run -A .../verify-dependencies.ts --json
 */

import { fromFileUrl, join, relative, SEPARATOR } from "@std/path";

const ROOT = fromFileUrl(new URL("../../../", import.meta.url));

/**
 * Exact package names that must not appear anywhere in a dependency tree.
 * Matched case-insensitively against the whole name, and against scoped
 * names as a prefix where the scope itself is forbidden.
 */
const FORBIDDEN_PACKAGES = [
  // Electron runtime and its ecosystem.
  "electron",
  "electron-builder",
  "electron-updater",
  "electron-trpc",
  "electron-devtools-installer",
  "electron-log",
  "electron-store",
  "electron-window-state",
  "electron-context-menu",
  "electron-squirrel-startup",
  "app-builder-lib",
  "app-builder-bin",
  "builder-util",
  "asar",
  "@electron-forge/cli",
  "dmg-license",
  // React Native and the mobile build toolchain.
  "react-native",
  "react-native-cli",
  "metro",
  "metro-react-native-babel-preset",
  "@react-native-community/cli",
  "detox",
  "eslint-plugin-detox",
  "eslint-plugin-react-native",
  "jetifier",
  "expo",
  "expo-cli",
  "@notesnook/editor-mobile",
];

/** Forbidden scopes: every package under them is out. */
const FORBIDDEN_SCOPES = ["@electron", "@electron-forge", "@react-native"];

/**
 * Command words that must not appear in an npm `scripts` entry or a task.
 * Matched as whole words so "electron-builder" in a sentence inside a
 * description field is ignored — only script bodies are searched.
 */
const FORBIDDEN_COMMANDS = [
  "electron",
  "electron-builder",
  "electron-rebuild",
  "electron-forge",
  "react-native",
  "pod install",
  "gradlew",
  "fastlane",
  "detox",
  "xcodebuild",
];

/** Module specifiers a runtime source file must never reference. */
const FORBIDDEN_MODULES = [
  "electron",
  "electron/main",
  "electron/renderer",
  "electron-trpc",
  "electron-trpc/main",
  "electron-trpc/renderer",
  "electron-updater",
  "electron-log",
  "electron-store",
  "react-native",
  "@react-native-async-storage/async-storage",
  "react-native-webview",
];

/** Directories never walked: build output, caches, installed packages. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "ui",
  ".native-build",
  ".node-shim",
  ".taskcache",
  "coverage",
  "playwright-report",
  "test-results",
  ".vscode",
]);

/** Manifest keys whose values are dependency maps. */
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
  "overrides",
  "resolutions",
];

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

export interface Finding {
  file: string;
  detail: string;
  /** What kind of reference was found — used to group the report. */
  kind: "dependency" | "script" | "import-map" | "lockfile" | "import";
}

function isForbiddenPackage(name: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_PACKAGES.some((forbidden) => forbidden === lower)) return true;
  return FORBIDDEN_SCOPES.some(
    (scope) => lower === scope || lower.startsWith(`${scope}/`),
  );
}

/**
 * Pulls the bare package name out of an npm/jsr specifier so
 * `npm:electron@^37` and `npm:/electron/main` both resolve to `electron`.
 */
export function packageNameFromSpecifier(
  specifier: string,
): string | undefined {
  let rest = specifier;
  for (const prefix of ["npm:", "jsr:", "node:"]) {
    if (rest.startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  if (rest.startsWith("/")) rest = rest.slice(1);
  if (!rest || rest.startsWith(".") || rest.includes("://")) return undefined;

  const parts = rest.split("/");
  let name = parts[0].startsWith("@") && parts.length > 1
    ? `${parts[0]}/${parts[1]}`
    : parts[0];
  // Strip a version range: electron@^37.10.3 -> electron
  const at = name.lastIndexOf("@");
  if (at > 0) name = name.slice(0, at);
  return name || undefined;
}

function scriptMentionsForbiddenCommand(script: string): string | undefined {
  for (const command of FORBIDDEN_COMMANDS) {
    // Whole-word match: `electron` matches `electron .` but not
    // `electron-to-chromium` and not `no-electron`.
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`(^|[\\s;&|"'\`/=])${escaped}($|[\\s;&|"'\`.])`).test(script)
    ) {
      return command;
    }
  }
  return undefined;
}

async function readJsonIfPossible(path: string): Promise<unknown | undefined> {
  try {
    const text = await Deno.readTextFile(path);
    // deno.jsonc may carry comments; strip the easy cases before parsing.
    const stripped = path.endsWith(".jsonc")
      ? text.replace(/^\s*\/\/.*$/gm, "")
      : text;
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

function checkManifest(path: string, manifest: unknown): Finding[] {
  const findings: Finding[] = [];
  if (typeof manifest !== "object" || manifest === null) return findings;
  const record = manifest as Record<string, unknown>;

  for (const section of DEPENDENCY_SECTIONS) {
    const value = record[section];
    if (!value) continue;
    const names = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : typeof value === "object"
      ? Object.keys(value as Record<string, unknown>)
      : [];
    for (const name of names) {
      if (isForbiddenPackage(name)) {
        findings.push({
          file: path,
          kind: "dependency",
          detail: `${section}.${name}`,
        });
      }
    }
  }

  const scripts = record.scripts;
  if (scripts && typeof scripts === "object") {
    for (
      const [name, body] of Object.entries(scripts as Record<string, unknown>)
    ) {
      if (typeof body !== "string") continue;
      const command = scriptMentionsForbiddenCommand(body);
      if (command) {
        findings.push({
          file: path,
          kind: "script",
          detail: `scripts.${name} runs "${command}"`,
        });
      }
    }
  }

  return findings;
}

function checkDenoConfig(path: string, config: unknown): Finding[] {
  const findings: Finding[] = [];
  if (typeof config !== "object" || config === null) return findings;
  const record = config as Record<string, unknown>;

  const imports = record.imports;
  if (imports && typeof imports === "object") {
    for (
      const [alias, specifier] of Object.entries(
        imports as Record<string, unknown>,
      )
    ) {
      if (typeof specifier !== "string") continue;
      const name = packageNameFromSpecifier(specifier);
      if ((name && isForbiddenPackage(name)) || isForbiddenPackage(alias)) {
        findings.push({
          file: path,
          kind: "import-map",
          detail: `imports["${alias}"] = "${specifier}"`,
        });
      }
    }
  }

  const tasks = record.tasks;
  if (tasks && typeof tasks === "object") {
    for (
      const [name, body] of Object.entries(tasks as Record<string, unknown>)
    ) {
      const command = typeof body === "string"
        ? body
        : typeof (body as { command?: unknown })?.command === "string"
        ? (body as { command: string }).command
        : undefined;
      if (!command) continue;
      const forbidden = scriptMentionsForbiddenCommand(command);
      if (forbidden) {
        findings.push({
          file: path,
          kind: "script",
          detail: `tasks.${name} runs "${forbidden}"`,
        });
      }
    }
  }

  return findings;
}

/** deno.lock: every package identifier in the graph. */
function checkDenoLock(path: string, lock: unknown): Finding[] {
  const findings: Finding[] = [];
  if (typeof lock !== "object" || lock === null) return findings;
  const record = lock as Record<string, unknown>;
  const seen = new Set<string>();

  const collect = (identifier: string) => {
    const name = packageNameFromSpecifier(identifier);
    if (!name || !isForbiddenPackage(name) || seen.has(name)) return;
    seen.add(name);
    findings.push({ file: path, kind: "lockfile", detail: identifier });
  };

  const npm =
    (record.npm ?? (record.packages as Record<string, unknown>)?.npm) as
      | Record<string, unknown>
      | undefined;
  if (npm && typeof npm === "object") Object.keys(npm).forEach(collect);

  const specifiers = (record.specifiers ??
    (record.packages as Record<string, unknown>)?.specifiers) as
      | Record<string, unknown>
      | undefined;
  if (specifiers && typeof specifiers === "object") {
    Object.keys(specifiers).forEach(collect);
  }

  const workspace = record.workspace as Record<string, unknown> | undefined;
  if (workspace) {
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      for (
        const [key, value] of Object.entries(node as Record<string, unknown>)
      ) {
        if (key === "dependencies" && Array.isArray(value)) {
          value.forEach((entry) => {
            if (typeof entry === "string") collect(entry);
          });
        } else walk(value);
      }
    };
    walk(workspace);
  }

  return findings;
}

/** package-lock.json: the `packages` and legacy `dependencies` maps. */
function checkNpmLock(path: string, lock: unknown): Finding[] {
  const findings: Finding[] = [];
  if (typeof lock !== "object" || lock === null) return findings;
  const record = lock as Record<string, unknown>;
  const seen = new Set<string>();

  const report = (name: string, where: string) => {
    if (!isForbiddenPackage(name) || seen.has(name)) return;
    seen.add(name);
    findings.push({
      file: path,
      kind: "lockfile",
      detail: `${where}: ${name}`,
    });
  };

  const packages = record.packages as Record<string, unknown> | undefined;
  if (packages) {
    for (const location of Object.keys(packages)) {
      // "node_modules/electron" and "node_modules/a/node_modules/electron".
      const marker = "node_modules/";
      const index = location.lastIndexOf(marker);
      if (index === -1) continue;
      report(location.slice(index + marker.length), "packages");
    }
  }

  const dependencies = record.dependencies as
    | Record<string, unknown>
    | undefined;
  if (dependencies) {
    for (const name of Object.keys(dependencies)) report(name, "dependencies");
  }

  return findings;
}

/** Real module references in a source file — imports, not prose. */
export function findForbiddenImports(source: string): string[] {
  const found = new Set<string>();
  const alternation = FORBIDDEN_MODULES.map((module) =>
    module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("|");
  const patterns = [
    // import x from "m";  import "m";  export * from "m";
    new RegExp(`\\bfrom\\s*["'\`](${alternation})["'\`]`, "g"),
    new RegExp(`\\bimport\\s*["'\`](${alternation})["'\`]`, "g"),
    // require("m") and dynamic import("m")
    new RegExp(`\\brequire\\s*\\(\\s*["'\`](${alternation})["'\`]`, "g"),
    new RegExp(`\\bimport\\s*\\(\\s*["'\`](${alternation})["'\`]`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

async function* walk(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    if (entry.isDirectory) yield* walk(join(directory, entry.name));
    else if (entry.isFile) yield join(directory, entry.name);
  }
}

export async function verifyDependencies(root = ROOT): Promise<Finding[]> {
  const findings: Finding[] = [];
  let manifests = 0;
  let sources = 0;

  for await (const path of walk(root)) {
    const name = path.slice(path.lastIndexOf(SEPARATOR) + 1);
    const relativePath = relative(root, path);

    if (name === "package.json") {
      manifests++;
      findings.push(
        ...checkManifest(relativePath, await readJsonIfPossible(path)),
      );
    } else if (name === "deno.json" || name === "deno.jsonc") {
      manifests++;
      findings.push(
        ...checkDenoConfig(relativePath, await readJsonIfPossible(path)),
      );
    } else if (name === "deno.lock") {
      manifests++;
      findings.push(
        ...checkDenoLock(relativePath, await readJsonIfPossible(path)),
      );
    } else if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
      manifests++;
      findings.push(
        ...checkNpmLock(relativePath, await readJsonIfPossible(path)),
      );
    } else {
      const dot = name.lastIndexOf(".");
      if (dot === -1) continue;
      if (!SOURCE_EXTENSIONS.has(name.slice(dot))) continue;
      sources++;
      let text: string;
      try {
        text = await Deno.readTextFile(path);
      } catch {
        continue;
      }
      for (const module of findForbiddenImports(text)) {
        findings.push({
          file: relativePath,
          kind: "import",
          detail: `imports "${module}"`,
        });
      }
    }
  }

  console.log(
    `Scanned ${manifests} manifest/lock files and ${sources} source files ` +
      `under ${root}`,
  );
  return findings;
}

const KIND_LABEL: Record<Finding["kind"], string> = {
  dependency: "declared dependency",
  script: "package script",
  "import-map": "import map entry",
  lockfile: "lockfile entry",
  import: "source import",
};

if (import.meta.main) {
  const args = new Set(Deno.args);
  const findings = await verifyDependencies();

  if (args.has("--json")) {
    console.log(
      JSON.stringify({ ok: findings.length === 0, findings }, null, 2),
    );
    Deno.exit(findings.length === 0 ? 0 : 1);
  }

  if (findings.length === 0) {
    console.log(
      "\nOK — no Electron, electron-builder, electron-updater, electron-trpc,\n" +
        "react-native or mobile build tooling in the dependency tree.",
    );
    Deno.exit(0);
  }

  console.error(
    `\nFAILED — ${findings.length} forbidden ${
      findings.length === 1 ? "reference" : "references"
    } found.\n`,
  );
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.file) ?? [];
    list.push(finding);
    byFile.set(finding.file, list);
  }
  for (const [file, list] of [...byFile].sort()) {
    console.error(`  ${file}`);
    for (const finding of list) {
      console.error(`      ${KIND_LABEL[finding.kind]}: ${finding.detail}`);
    }
  }
  console.error(
    `\nOpenotes is a Deno Desktop application (PORTING_NOTES.md §10). Remove\n` +
      `these entries, or the runtime they belong to comes back with them.`,
  );
  Deno.exit(1);
}
