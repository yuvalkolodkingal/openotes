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
 * Makes `Config` (utils/config.ts) survive restarts on the desktop.
 *
 * The desktop runtime serves the interface on a loopback port it assigns
 * per launch, so the page's origin — and with it localStorage — changes on
 * every start and everything stored there is orphaned (measured; see
 * apps/desktop/src/native/server.ts). Within one launch localStorage works
 * fine, so it stays the synchronous source of truth; this module makes it
 * durable by seeding it from the runtime's "settings" storage namespace at
 * boot and mirroring every mutation back, fire-and-forget.
 *
 * Deliberately dependency-free: it talks to `globalThis.bindings.rpc`
 * directly instead of importing the desktop bridge, because the bridge
 * imports application stores which read Config at module-evaluation time —
 * exactly what hydration has to happen before.
 */

type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error?: { message?: string } };

function rpc(path: string, input?: unknown): Promise<RpcResponse> | undefined {
  const bindings = (
    globalThis as {
      bindings?: {
        rpc?(request: { path: string; input?: unknown }): Promise<RpcResponse>;
      };
    }
  ).bindings;
  if (typeof bindings?.rpc !== "function") return undefined;
  return bindings.rpc({ path, input });
}

const NAMESPACE = "settings";

let mirroringEnabled = false;

/**
 * Seed localStorage from the runtime's durable settings store. Must finish
 * before any module that reads Config at import time is loaded — the entry
 * point awaits it before importing the app.
 */
export async function hydrateDesktopConfig(): Promise<void> {
  const call = rpc("storage.entries", { namespace: NAMESPACE });
  if (!call) return; // not running inside the desktop runtime

  try {
    const response = await call;
    if (!response.ok) throw new Error(response.error?.message);
    const entries = response.result as Record<string, string>;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === "string") window.localStorage.setItem(key, value);
    }
    mirroringEnabled = true;
  } catch (error) {
    // The app still works for this session; it just starts from defaults.
    console.error("Could not load persisted settings from the runtime", error);
  }
}

/** Mirror one localStorage write to the runtime. Fire-and-forget. */
export function persistConfigValue(key: string, rawValue: string): void {
  if (!mirroringEnabled) return;
  void rpc("storage.set", { namespace: NAMESPACE, key, value: rawValue })?.then(
    (response) => {
      if (response && !response.ok) {
        console.error(`Could not persist setting ${key}`);
      }
    },
    (error) => console.error(`Could not persist setting ${key}:`, error)
  );
}

/** Mirror one localStorage removal to the runtime. Fire-and-forget. */
export function removeConfigValue(key: string): void {
  if (!mirroringEnabled) return;
  void rpc("storage.remove", { namespace: NAMESPACE, key })?.catch((error) =>
    console.error(`Could not remove persisted setting ${key}:`, error)
  );
}

/** Mirror a full clear to the runtime. Fire-and-forget. */
export function clearConfigValues(): void {
  if (!mirroringEnabled) return;
  void rpc("storage.clear", { namespace: NAMESPACE, confirm: "clear" })?.catch(
    (error) => console.error("Could not clear persisted settings:", error)
  );
}
