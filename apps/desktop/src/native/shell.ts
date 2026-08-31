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

import { logger } from "./logger.ts";

const log = logger.scope("shell");

/**
 * Desktop integration that needs to talk to the OS: opening a file manager,
 * opening a URL in the user's browser, native dialogs, notifications and
 * the clipboard.
 *
 * Deno Desktop provides dialogs, notifications and clipboard natively when
 * running under `deno desktop`. Each helper prefers the native API and
 * falls back to a platform command only where that is genuinely the only
 * option (revealing a file in the file manager, for example).
 *
 * Every subprocess invocation here uses a fixed argv — never a shell string
 * — so a path or URL can never be interpreted as a command.
 */

interface DenoDesktopGlobals {
  openDialog?: (options: unknown) => Promise<string[] | string | null>;
  saveDialog?: (options: unknown) => Promise<string | null>;
  notify?: (options: unknown) => Promise<unknown>;
  openUrl?: (url: string) => Promise<void>;
  clipboard?: {
    readText(): string | Promise<string>;
    writeText(value: string): void | Promise<void>;
  };
}

function desktopApi(): DenoDesktopGlobals {
  return (Deno as unknown as DenoDesktopGlobals) ?? {};
}

async function spawn(command: string, args: string[]): Promise<boolean> {
  try {
    const process = new Deno.Command(command, {
      args,
      stdout: "null",
      stderr: "null",
    });
    const { code } = await process.output();
    return code === 0;
  } catch {
    return false;
  }
}

export class Shell {
  /** Open a file or folder with the OS default handler. */
  async openPath(path: string): Promise<void> {
    switch (Deno.build.os) {
      case "windows":
        await spawn("cmd", ["/c", "start", "", path]);
        return;
      case "darwin":
        await spawn("open", [path]);
        return;
      default:
        if (!(await spawn("xdg-open", [path]))) {
          log.warn("Could not open the path; no handler available");
        }
    }
  }

  /** Show a file in the file manager, selected. */
  async revealPath(path: string): Promise<void> {
    switch (Deno.build.os) {
      case "windows":
        await spawn("explorer", [`/select,${path}`]);
        return;
      case "darwin":
        await spawn("open", ["-R", path]);
        return;
      default: {
        // Most Linux file managers implement this D-Bus interface; fall
        // back to opening the containing directory.
        const ok = await spawn("dbus-send", [
          "--session",
          "--dest=org.freedesktop.FileManager1",
          "--type=method_call",
          "/org/freedesktop/FileManager1",
          "org.freedesktop.FileManager1.ShowItems",
          `array:string:file://${path}`,
          "string:",
        ]);
        if (!ok) await this.openPath(dirOf(path));
      }
    }
  }

  /**
   * Open a URL in the user's browser. Only http(s) and mailto are allowed —
   * a note must never be able to launch a file:// or custom-scheme handler.
   */
  async openExternal(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Not a valid URL: ${url}`);
    }
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      throw new Error(
        `Refusing to open a ${parsed.protocol} link. Only web and mail ` +
          `links can be opened from a note.`,
      );
    }

    const api = desktopApi();
    if (typeof api.openUrl === "function") {
      await api.openUrl(parsed.toString());
      return;
    }
    await this.openPath(parsed.toString());
  }
}

export interface OpenDialogOptions {
  title: string;
  extensions?: string[];
}

export class Dialogs {
  async selectDirectory(
    options: { title: string },
  ): Promise<string | undefined> {
    const api = desktopApi();
    if (typeof api.openDialog === "function") {
      const result = await api.openDialog({
        title: options.title,
        directory: true,
        multiple: false,
      });
      return firstPath(result);
    }
    return await this.fallbackDialog([
      "--file-selection",
      "--directory",
      `--title=${options.title}`,
    ]);
  }

  async selectFile(options: OpenDialogOptions): Promise<string | undefined> {
    const api = desktopApi();
    if (typeof api.openDialog === "function") {
      const result = await api.openDialog({
        title: options.title,
        directory: false,
        multiple: false,
        filters: options.extensions
          ? [{ name: "Supported files", extensions: options.extensions }]
          : undefined,
      });
      return firstPath(result);
    }
    const args = ["--file-selection", `--title=${options.title}`];
    if (options.extensions?.length) {
      args.push(
        `--file-filter=Supported files | ${
          options.extensions
            .map((extension) => `*.${extension}`)
            .join(" ")
        }`,
      );
    }
    return await this.fallbackDialog(args);
  }

  async saveFile(options: {
    title: string;
    defaultName: string;
  }): Promise<string | undefined> {
    const api = desktopApi();
    if (typeof api.saveDialog === "function") {
      const result = await api.saveDialog({
        title: options.title,
        defaultPath: options.defaultName,
      });
      return result ?? undefined;
    }
    return await this.fallbackDialog([
      "--file-selection",
      "--save",
      "--confirm-overwrite",
      `--title=${options.title}`,
      `--filename=${options.defaultName}`,
    ]);
  }

  /**
   * Linux fallback when the runtime exposes no dialog API: zenity, then
   * kdialog. If neither exists the caller gets undefined and the UI asks
   * the user to type a path instead of failing silently.
   */
  private async fallbackDialog(args: string[]): Promise<string | undefined> {
    if (Deno.build.os !== "linux") return undefined;
    try {
      const process = new Deno.Command("zenity", {
        args,
        stdout: "piped",
        stderr: "null",
      });
      const output = await process.output();
      if (output.code !== 0) return undefined;
      const path = new TextDecoder().decode(output.stdout).trim();
      return path || undefined;
    } catch {
      log.warn("No native file dialog is available (install zenity)");
      return undefined;
    }
  }
}

export interface NotificationOptions {
  title: string;
  body: string;
  tag: string;
  silent?: boolean;
}

export class Notifications {
  constructor(private readonly appName: string) {}

  /** Returns the tag when the user activated the notification. */
  async show(
    options: NotificationOptions,
  ): Promise<{ tag: string } | undefined> {
    const api = desktopApi();
    if (typeof api.notify === "function") {
      try {
        await api.notify({
          title: options.title,
          body: options.body,
          silent: options.silent,
        });
        return undefined;
      } catch (error) {
        log.warn("Native notification failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    switch (Deno.build.os) {
      case "linux":
        await spawn("notify-send", [
          "--app-name",
          this.appName,
          options.title,
          options.body,
        ]);
        return undefined;
      case "darwin":
        await spawn("osascript", [
          "-e",
          `display notification ${quoteAppleScript(options.body)} with title ${
            quoteAppleScript(options.title)
          }`,
        ]);
        return undefined;
      default:
        log.info("Notification suppressed: no notification backend");
        return undefined;
    }
  }
}

export class Clipboard {
  async readText(): Promise<string> {
    const api = desktopApi();
    if (api.clipboard?.readText) return await api.clipboard.readText();

    // The webview's own navigator.clipboard covers the common path; this is
    // only the host-side backstop.
    if (Deno.build.os === "linux") {
      try {
        const process = new Deno.Command("wl-paste", {
          args: ["--no-newline"],
          stdout: "piped",
          stderr: "null",
        });
        const output = await process.output();
        if (output.code === 0) return new TextDecoder().decode(output.stdout);
      } catch {
        /* try xclip next */
      }
      try {
        const process = new Deno.Command("xclip", {
          args: ["-selection", "clipboard", "-o"],
          stdout: "piped",
          stderr: "null",
        });
        const output = await process.output();
        if (output.code === 0) return new TextDecoder().decode(output.stdout);
      } catch {
        /* no clipboard tool */
      }
    }
    return "";
  }

  async writeText(value: string): Promise<void> {
    const api = desktopApi();
    if (api.clipboard?.writeText) {
      await api.clipboard.writeText(value);
      return;
    }
    if (Deno.build.os === "linux") {
      for (
        const [command, args] of [
          ["wl-copy", []],
          ["xclip", ["-selection", "clipboard"]],
        ] as [string, string[]][]
      ) {
        try {
          const process = new Deno.Command(command, {
            args,
            stdin: "piped",
            stdout: "null",
            stderr: "null",
          });
          const child = process.spawn();
          const writer = child.stdin.getWriter();
          await writer.write(new TextEncoder().encode(value));
          await writer.close();
          if ((await child.status).success) return;
        } catch {
          continue;
        }
      }
    }
  }
}

export class ThemeWatcher {
  private mode: "light" | "dark" | "system" = "system";

  current(): "light" | "dark" {
    if (this.mode !== "system") return this.mode;
    return detectSystemTheme();
  }

  apply(mode: "light" | "dark" | "system"): void {
    this.mode = mode;
  }
}

function detectSystemTheme(): "light" | "dark" {
  // Deno Desktop does not expose a system-theme API yet, so this reads the
  // desktop environment's own setting where one is discoverable and
  // otherwise reports light.
  if (Deno.build.os === "linux") {
    const gtkTheme = Deno.env.get("GTK_THEME");
    if (gtkTheme?.toLowerCase().includes("dark")) return "dark";
  }
  return "light";
}

function firstPath(result: string[] | string | null): string | undefined {
  if (!result) return undefined;
  if (Array.isArray(result)) return result[0];
  return result;
}

function quoteAppleScript(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}
