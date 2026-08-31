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

import { join } from "@std/path";
import { ensureDirSync, logDir } from "./paths.ts";

/**
 * Structured logging with mandatory redaction (spec §29).
 *
 * Nothing that could carry note content or a secret reaches the log file:
 * values are passed as a context object and every value is scrubbed before
 * it is serialized. There is no "log the raw object" escape hatch.
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

/** Context keys whose values are always replaced with "[redacted]". */
const REDACTED_KEYS = new Set([
  "password",
  "passphrase",
  "pass",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "auth",
  "cookie",
  "key",
  "masterkey",
  "synckey",
  "backupkey",
  "attachmentkey",
  "databasekey",
  "recoverykey",
  "cipher",
  "plaintext",
  "content",
  "data",
  "body",
  "title",
  "note",
  "credentials",
  "basic",
]);

const MAX_VALUE_LENGTH = 512;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;

export interface LogRecord {
  time: string;
  level: LogLevel;
  scope: string;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Remove credentials embedded in a URL and strip the query string, which
 * some servers use to carry tokens.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    url.search = "";
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/@\s]*@/g, "//[redacted]@");
  }
}

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (REDACTED_KEYS.has(key.toLowerCase())) return "[redacted]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const scrubbed = /^https?:\/\//i.test(value) ? redactUrl(value) : value;
    // Anything that looks like a bearer/basic credential goes, wherever it is.
    const withoutAuth = scrubbed.replace(
      /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
      "$1 [redacted]",
    );
    return withoutAuth.length > MAX_VALUE_LENGTH
      ? withoutAuth.slice(0, MAX_VALUE_LENGTH) + "…"
      : withoutAuth;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactValue("message", value.message, depth + 1),
    };
  }
  if (depth >= 3) return "[nested]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue("", item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key2, value2] of Object.entries(value)) {
      out[key2] = redactValue(key2, value2, depth + 1);
    }
    return out;
  }
  return "[unserializable]";
}

export class Logger {
  private level: LogLevel;
  private file?: Deno.FsFile;
  private bytesWritten = 0;
  private readonly directory: string;
  private readonly encoder = new TextEncoder();

  constructor(
    options: { level?: LogLevel; directory?: string; toFile?: boolean } = {},
  ) {
    this.level = options.level ?? "info";
    this.directory = options.directory ?? logDir();
    if (options.toFile !== false) this.openFile();
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  get logDirectory(): string {
    return this.directory;
  }

  private openFile(): void {
    try {
      ensureDirSync(this.directory);
      const path = join(this.directory, "app.log");
      try {
        const stat = Deno.statSync(path);
        this.bytesWritten = stat.size;
        if (stat.size > MAX_FILE_BYTES) this.rotate(path);
      } catch {
        this.bytesWritten = 0;
      }
      this.file = Deno.openSync(path, {
        create: true,
        append: true,
        write: true,
      });
    } catch (error) {
      // Logging must never prevent the app from starting.
      console.error("Could not open the log file:", error);
    }
  }

  private rotate(path: string): void {
    try {
      for (let index = MAX_FILES - 1; index >= 1; index--) {
        const from = index === 1 ? path : `${path}.${index - 1}`;
        const to = `${path}.${index}`;
        try {
          Deno.renameSync(from, to);
        } catch {
          /* the rotated file may not exist yet */
        }
      }
      this.bytesWritten = 0;
    } catch {
      /* rotation is best-effort */
    }
  }

  private write(record: LogRecord): void {
    const line = JSON.stringify(record) + "\n";
    if (record.level === "error" || record.level === "warn") {
      console.error(line.trimEnd());
    } else if (this.level === "debug" || this.level === "trace") {
      console.log(line.trimEnd());
    }
    if (!this.file) return;
    try {
      const bytes = this.encoder.encode(line);
      this.file.writeSync(bytes);
      this.bytesWritten += bytes.length;
      if (this.bytesWritten > MAX_FILE_BYTES) {
        this.file.close();
        this.file = undefined;
        this.rotate(join(this.directory, "app.log"));
        this.openFile();
      }
    } catch {
      /* a failed log write must never break the caller */
    }
  }

  log(
    level: LogLevel,
    scope: string,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.level]) return;
    this.write({
      time: new Date().toISOString(),
      level,
      scope,
      message,
      context: context
        ? (redactValue("", context) as Record<string, unknown>)
        : undefined,
    });
  }

  scope(name: string) {
    return {
      error: (message: string, context?: Record<string, unknown>) =>
        this.log("error", name, message, context),
      warn: (message: string, context?: Record<string, unknown>) =>
        this.log("warn", name, message, context),
      info: (message: string, context?: Record<string, unknown>) =>
        this.log("info", name, message, context),
      debug: (message: string, context?: Record<string, unknown>) =>
        this.log("debug", name, message, context),
      trace: (message: string, context?: Record<string, unknown>) =>
        this.log("trace", name, message, context),
    };
  }

  /** Recent log lines, for Help -> Logs in the UI. */
  async tail(lines = 500): Promise<string[]> {
    try {
      const text = await Deno.readTextFile(join(this.directory, "app.log"));
      return text.split("\n").filter(Boolean).slice(-lines);
    } catch {
      return [];
    }
  }

  close(): void {
    try {
      this.file?.close();
    } catch {
      /* already closed */
    }
    this.file = undefined;
  }
}

const envLevel = Deno.env.get("OPENOTES_LOG_LEVEL") as LogLevel | undefined;

/** Production default is `info` (spec §29). */
export const logger = new Logger({
  level: envLevel && envLevel in LEVEL_ORDER
    ? envLevel
    : Deno.env.get("OPENOTES_DEV") === "1"
    ? "debug"
    : "info",
});
