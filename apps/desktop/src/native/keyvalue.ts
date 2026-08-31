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
import { appDataDir, ensureDir } from "./paths.ts";
import { logger } from "./logger.ts";

const log = logger.scope("kv");

/**
 * Durable key-value storage for the renderer.
 *
 * WHY THIS EXISTS — this is the load-bearing consequence of how Deno
 * Desktop serves the interface, and getting it wrong loses the vault.
 *
 * The webview reaches the interface over an HTTP address the *runtime*
 * chooses; `Deno.serve`'s requested port is overridden and the assigned
 * port differs on every launch. Measured: `location.origin` was
 * http://127.0.0.1:34265 on one run and http://127.0.0.1:42857 on the
 * next. Browser storage is partitioned by origin, so anything the page
 * puts in localStorage or IndexedDB is unreachable after a restart — a
 * value written in the first run read back as null in the second.
 *
 * Upstream keeps the *database key* in IndexedDB. Carried over unchanged,
 * every launch would find no key, generate a fresh one, and leave the
 * existing vault permanently unopenable. So the renderer's durable storage
 * is served from here instead, where it is keyed by the application's data
 * directory rather than by a port number.
 *
 * Two namespaces, with different durability guarantees:
 *
 *   "keys"     — key material. Encrypted at rest through the credential
 *                store, and never returned in bulk.
 *   "settings" — ordinary preferences, the localStorage replacement. Plain
 *                JSON: these are not secret and being readable makes them
 *                debuggable.
 */

export type KvNamespace = "keys" | "settings";

const FILES: Record<KvNamespace, string> = {
  keys: "keystore.json",
  settings: "renderer-settings.json"
};

/** Rejects keys that could escape the namespace or bloat the file. */
function assertValidKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > 512) {
    throw new Error("A storage key must be a string of 1-512 characters");
  }
  if (key.includes("\0")) {
    throw new Error("A storage key may not contain a null byte");
  }
  return key;
}

function assertValidNamespace(value: unknown): KvNamespace {
  if (value === "keys" || value === "settings") return value;
  throw new Error(
    `Unknown storage namespace: ${JSON.stringify(value)}. ` +
      `Expected "keys" or "settings".`
  );
}

const MAX_VALUE_BYTES = 4 * 1024 * 1024;

export class KeyValueStore {
  private readonly cache = new Map<KvNamespace, Record<string, string>>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string = appDataDir()) {}

  private path(namespace: KvNamespace): string {
    return join(this.directory, FILES[namespace]);
  }

  private async load(namespace: KvNamespace): Promise<Record<string, string>> {
    const cached = this.cache.get(namespace);
    if (cached) return cached;

    let record: Record<string, string> = {};
    try {
      const parsed = JSON.parse(await Deno.readTextFile(this.path(namespace)));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") record[key] = value;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        // Losing the key store means losing the vault, so a damaged file is
        // preserved for recovery rather than silently replaced.
        const backup = `${this.path(namespace)}.corrupt-${Date.now()}`;
        log.error("Storage file unreadable; keeping a copy for recovery", {
          namespace,
          backup,
          error: error instanceof Error ? error.message : String(error)
        });
        try {
          await Deno.rename(this.path(namespace), backup);
        } catch {
          /* best effort */
        }
        record = {};
      }
    }
    this.cache.set(namespace, record);
    return record;
  }

  private persist(namespace: KvNamespace): Promise<void> {
    const snapshot = JSON.stringify(this.cache.get(namespace) ?? {}, null, 2);
    this.writeChain = this.writeChain
      .then(async () => {
        await ensureDir(this.directory);
        const target = this.path(namespace);
        const temporary = `${target}.tmp`;
        await Deno.writeTextFile(temporary, snapshot);
        if (namespace === "keys" && Deno.build.os !== "windows") {
          await Deno.chmod(temporary, 0o600).catch(() => {});
        }
        // Rename so a crash mid-write cannot truncate the key store.
        await Deno.rename(temporary, target);
      })
      .catch((error) => {
        log.error("Could not persist renderer storage", {
          namespace,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return this.writeChain;
  }

  async get(namespace: unknown, key: unknown): Promise<string | null> {
    const space = assertValidNamespace(namespace);
    const name = assertValidKey(key);
    const record = await this.load(space);
    return record[name] ?? null;
  }

  async set(namespace: unknown, key: unknown, value: unknown): Promise<void> {
    const space = assertValidNamespace(namespace);
    const name = assertValidKey(key);
    if (typeof value !== "string") {
      throw new Error("A stored value must be a string");
    }
    if (value.length > MAX_VALUE_BYTES) {
      throw new Error(
        `Value for "${name}" is too large (${value.length} bytes, max ${MAX_VALUE_BYTES})`
      );
    }
    const record = await this.load(space);
    record[name] = value;
    await this.persist(space);
  }

  async remove(namespace: unknown, key: unknown): Promise<void> {
    const space = assertValidNamespace(namespace);
    const name = assertValidKey(key);
    const record = await this.load(space);
    if (name in record) {
      delete record[name];
      await this.persist(space);
    }
  }

  async keys(namespace: unknown): Promise<string[]> {
    const space = assertValidNamespace(namespace);
    return Object.keys(await this.load(space));
  }

  /**
   * Every entry in a namespace. Allowed for settings, which the interface
   * needs in bulk at start-up; refused for keys, so a compromised renderer
   * cannot exfiltrate the whole key store in one call.
   */
  async entries(namespace: unknown): Promise<Record<string, string>> {
    const space = assertValidNamespace(namespace);
    if (space === "keys") {
      throw new Error(
        "Key material cannot be read in bulk; request keys individually"
      );
    }
    return { ...(await this.load(space)) };
  }

  async clear(namespace: unknown): Promise<void> {
    const space = assertValidNamespace(namespace);
    this.cache.set(space, {});
    await this.persist(space);
  }

  flush(): Promise<void> {
    return this.writeChain;
  }
}
