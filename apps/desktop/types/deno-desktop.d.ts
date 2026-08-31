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
 * Ambient declarations for the `deno desktop` runtime API.
 *
 * These globals exist only when the program runs under `deno desktop`, so
 * `deno check` against the plain runtime types does not know about them.
 * The declarations here mirror the documented surface
 * (https://docs.deno.com/runtime/desktop/) and let the app type-check with
 * ordinary `deno check`, while `deno desktop` supplies the implementation.
 *
 * Anything used from this surface must also degrade gracefully — see
 * src/native/shell.ts, which feature-detects each optional API rather than
 * assuming it is present.
 */

declare namespace Deno {
  export interface BrowserWindowOptions {
    title?: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    resizable?: boolean;
    alwaysOnTop?: boolean;
    frameless?: boolean;
    noActivate?: boolean;
    transparentTitlebar?: boolean;
  }

  export interface BrowserWindowResizeEvent extends Event {
    detail: { width: number; height: number };
  }

  export interface BrowserWindowMoveEvent extends Event {
    detail: { x: number; y: number };
  }

  export interface DevtoolsOptions {
    deno?: boolean;
    renderer?: boolean;
  }

  /**
   * A native OS window. The first construction adopts the implicit startup
   * window; later constructions open additional windows sharing this
   * runtime.
   */
  export class BrowserWindow extends EventTarget {
    constructor(options?: BrowserWindowOptions);

    readonly windowId: number;

    show(): void;
    hide(): void;
    focus(): void;
    close(): void;
    reload(): void;

    isClosed(): boolean;
    isVisible(): boolean;

    getSize(): [number, number];
    setSize(width: number, height: number): void;
    getPosition(): [number, number];
    setPosition(x: number, y: number): void;

    isResizable(): boolean;
    setResizable(resizable: boolean): void;
    isAlwaysOnTop(): boolean;
    setAlwaysOnTop(alwaysOnTop: boolean): void;

    setTitle(title: string): void;
    navigate(url: string): void;

    /** Evaluate JavaScript in the webview; the result must be JSON-safe. */
    executeJs<T = unknown>(script: string): Promise<T>;

    /** Expose a function to the webview as `bindings.<name>()`. */
    bind(
      name: string,
      handler: (...args: any[]) => unknown | Promise<unknown>,
    ): void;
    unbind(name: string): void;

    openDevtools(options?: DevtoolsOptions): void;
    getNativeWindow(): unknown;

    onfocus: ((event: Event) => void) | null;
    onblur: ((event: Event) => void) | null;
    onclose: ((event: Event) => void) | null;

    addEventListener(
      type: "resize",
      listener: (event: BrowserWindowResizeEvent) => void,
    ): void;
    addEventListener(
      type: "move",
      listener: (event: BrowserWindowMoveEvent) => void,
    ): void;
    addEventListener(
      type: "close" | "focus" | "blur",
      listener: (event: Event) => void,
    ): void;
    addEventListener(
      type: string,
      listener: (event: any) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }

  export interface TrayOptions {
    icon?: string | Uint8Array;
    tooltip?: string;
    menu?: TrayMenuItem[];
  }

  export interface TrayMenuItem {
    id?: string;
    label?: string;
    enabled?: boolean;
    checked?: boolean;
    separator?: boolean;
    submenu?: TrayMenuItem[];
  }

  export class Tray extends EventTarget {
    constructor(options?: TrayOptions);
    setTooltip(tooltip: string): void;
    setMenu(menu: TrayMenuItem[]): void;
    setIcon(icon: string | Uint8Array): void;
    dispose(): void;
  }

  export interface OpenDialogOptions {
    title?: string;
    directory?: boolean;
    multiple?: boolean;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }

  export interface SaveDialogOptions {
    title?: string;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }

  export interface NotifyOptions {
    title?: string;
    body?: string;
    silent?: boolean;
    icon?: string;
  }

  /** Optional platform APIs — always feature-detect before calling. */
  export function openDialog(
    options?: OpenDialogOptions,
  ): Promise<string[] | string | null>;
  export function saveDialog(
    options?: SaveDialogOptions,
  ): Promise<string | null>;
  export function notify(options?: NotifyOptions): Promise<void>;
  export function openUrl(url: string): Promise<void>;

  export const clipboard: {
    readText(): Promise<string>;
    writeText(value: string): Promise<void>;
  };

  export const autoUpdate: {
    check(): Promise<{ available: boolean; version?: string }>;
    apply(): Promise<void>;
  };
}
