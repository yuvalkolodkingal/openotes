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

import Config from "../utils/config";

export interface IKVStore {
  /**
   * Get a value by its key.
   *
   * @param key
   */
  get<T>(key: string): Promise<T | undefined>;

  /**
   * Set a value with a key.
   *
   * @param key
   * @param value
   */
  set<T>(key: string, value: T): Promise<void>;

  /**
   * Set multiple values at once. This is faster than calling set() multiple times.
   * It's also atomic – if one of the pairs can't be added, none will be added.
   *
   * @param entries Array of entries, where each entry is an array of `[key, value]`.
   */
  setMany(entries: [string, unknown][]): Promise<void>;

  /**
   * Get multiple values by their keys
   *
   * @param keys
   */
  getMany<T>(keys: string[]): Promise<[string, T][]>;

  /**
   * Delete a particular key from the store.
   *
   * @param key
   */
  delete(key: string): Promise<void>;

  /**
   * Delete multiple keys at once.
   *
   * @param keys List of keys to delete.
   */
  deleteMany(keys: string[]): Promise<void>;

  /**
   * Clear all values in the store.
   *
   */
  clear(): Promise<void>;

  keys(): Promise<string[]>;
  values<T>(): Promise<T[]>;
  entries<T>(): Promise<[string, T][]>;
}

export class LocalStorageKVStore implements IKVStore {
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(Config.get(key));
  }
  set(key: string, value: any): Promise<void> {
    return Promise.resolve(Config.set(key, value));
  }
  setMany(entries: [string, any][]): Promise<void> {
    for (const entry of entries) {
      Config.set(entry[0], entry[1]);
    }
    return Promise.resolve();
  }
  getMany<T>(keys: string[]): Promise<[string, T][]> {
    const entries: [string, T][] = [];
    for (const key of keys) {
      entries.push([key, Config.get(key)]);
    }
    return Promise.resolve(entries);
  }
  delete(key: string): Promise<void> {
    return Promise.resolve(Config.remove(key));
  }
  deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      Config.remove(key);
    }
    return Promise.resolve();
  }
  clear(): Promise<void> {
    Config.clear();
    return Promise.resolve();
  }
  keys(): Promise<string[]> {
    return Promise.resolve(Object.keys(Config.all()));
  }
  values<T>(): Promise<T[]> {
    return Promise.resolve(Object.values<T>(Config.all()));
  }
  entries<T>(): Promise<[string, T][]> {
    return Promise.resolve(Object.entries<T>(Config.all()));
  }
}

export class MemoryKVStore implements IKVStore {
  private storage: Record<string, any> = {};
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.storage[key]);
  }
  set(key: string, value: any): Promise<void> {
    this.storage[key] = value;
    return Promise.resolve();
  }
  setMany(entries: [string, any][]): Promise<void> {
    for (const entry of entries) {
      this.storage[entry[0]] = entry[1];
    }
    return Promise.resolve();
  }
  getMany<T>(keys: string[]): Promise<[string, T][]> {
    const entries: [string, T][] = [];
    for (const key of keys) {
      entries.push([key, this.storage[key]]);
    }
    return Promise.resolve(entries);
  }
  delete(key: string): Promise<void> {
    delete this.storage[key];
    return Promise.resolve();
  }
  deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) {
      delete this.storage[key];
    }
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.storage = {};
    return Promise.resolve();
  }
  keys(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.storage));
  }
  values<T>(): Promise<T[]> {
    return Promise.resolve(Object.values<T>(this.storage));
  }
  entries<T>(): Promise<[string, T][]> {
    return Promise.resolve(Object.entries<T>(this.storage));
  }
}

export type UseStore = <T>(
  txMode: IDBTransactionMode,
  callback: (store: IDBObjectStore) => T | PromiseLike<T>
) => Promise<T>;

export class IndexedDBKVStore implements IKVStore {
  store: UseStore;

  constructor(databaseName: string, storeName: string) {
    this.store = this.createStore(databaseName, storeName);
  }

  private createStore(dbName: string, storeName: string): UseStore {
    const request = indexedDB.open(dbName);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    const dbp = promisifyIDBRequest(request);

    return (txMode, callback) =>
      dbp.then((db) =>
        callback(db.transaction(storeName, txMode).objectStore(storeName))
      );
  }

  private eachCursor(
    store: IDBObjectStore,
    callback: (cursor: IDBCursorWithValue) => void
  ): Promise<void> {
    store.openCursor().onsuccess = function () {
      if (!this.result) return;
      callback(this.result);
      this.result.continue();
    };
    return promisifyIDBRequest(store.transaction);
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.store("readonly", (store) =>
      promisifyIDBRequest(store.get(key))
    );
  }

  set(key: string, value: any): Promise<void> {
    return this.store("readwrite", (store) => {
      store.put(value, key);
      return promisifyIDBRequest(store.transaction);
    });
  }

  setMany(entries: [string, any][]): Promise<void> {
    return this.store("readwrite", (store) => {
      entries.forEach((entry) => store.put(entry[1], entry[0]));
      return promisifyIDBRequest(store.transaction);
    });
  }

  getMany<T>(keys: string[]): Promise<[string, T][]> {
    return this.store("readonly", (store) =>
      Promise.all(
        keys.map(async (key) => [
          key,
          await promisifyIDBRequest(store.get(key))
        ])
      )
    );
  }

  delete(key: string): Promise<void> {
    return this.store("readwrite", (store) => {
      store.delete(key);
      return promisifyIDBRequest(store.transaction);
    });
  }

  deleteMany(keys: string[]): Promise<void> {
    return this.store("readwrite", (store: IDBObjectStore) => {
      keys.forEach((key: IDBValidKey) => store.delete(key));
      return promisifyIDBRequest(store.transaction);
    });
  }

  clear(): Promise<void> {
    return this.store("readwrite", (store) => {
      store.clear();
      return promisifyIDBRequest(store.transaction);
    });
  }

  keys<KeyType extends IDBValidKey>(): Promise<KeyType[]> {
    return this.store("readonly", (store) => {
      // Fast path for modern browsers
      if (store.getAllKeys) {
        return promisifyIDBRequest(
          store.getAllKeys() as unknown as IDBRequest<KeyType[]>
        );
      }

      const items: KeyType[] = [];

      return this.eachCursor(store, (cursor) =>
        items.push(cursor.key as KeyType)
      ).then(() => items);
    });
  }

  values<T = any>(): Promise<T[]> {
    return this.store("readonly", (store) => {
      // Fast path for modern browsers
      if (store.getAll) {
        return promisifyIDBRequest(store.getAll() as IDBRequest<T[]>);
      }

      const items: T[] = [];

      return this.eachCursor(store, (cursor) =>
        items.push(cursor.value as T)
      ).then(() => items);
    });
  }

  entries<KeyType extends IDBValidKey, ValueType = any>(): Promise<
    [KeyType, ValueType][]
  > {
    return this.store("readonly", (store) => {
      // Fast path for modern browsers
      // (although, hopefully we'll get a simpler path some day)
      if (store.getAll && store.getAllKeys) {
        return Promise.all([
          promisifyIDBRequest(
            store.getAllKeys() as unknown as IDBRequest<KeyType[]>
          ),
          promisifyIDBRequest(store.getAll() as IDBRequest<ValueType[]>)
        ]).then(([keys, values]) => keys.map((key, i) => [key, values[i]]));
      }

      const items: [KeyType, ValueType][] = [];

      return this.store("readonly", (store) =>
        this.eachCursor(store, (cursor) =>
          items.push([cursor.key as KeyType, cursor.value])
        ).then(() => items)
      );
    });
  }
}

function promisifyIDBRequest<T = undefined>(
  request: IDBRequest<T> | IDBTransaction
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - file size hacks
    request.oncomplete = request.onsuccess = () => resolve(request.result);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - file size hacks
    request.onabort = request.onerror = () => reject(request.error);
  });
}

/**
 * KV store backed by the desktop runtime (Openotes).
 *
 * The runtime assigns the interface a different loopback port on every
 * launch, so the page's origin — and with it everything in localStorage
 * and IndexedDB — changes between runs. Anything that must survive a
 * restart therefore has to live on the runtime side of the bindings; the
 * key store's metadata and secrets are exactly that, and losing them means
 * losing the vault.
 *
 * Values are structured-clone-ish data holding ArrayBuffers and typed
 * arrays (wrapped keys, encrypted secrets), which JSON cannot carry, so
 * they are encoded with a small tagged format. CryptoKey objects are
 * deliberately NOT supported: on this platform the key store takes the
 * safeStorage path, which never persists one — hitting a CryptoKey here
 * means that assumption broke, and the loud error is the point.
 */
export class DesktopKVStore implements IKVStore {
  constructor(private readonly prefix: string) {}

  private async call(path: string, input: unknown): Promise<unknown> {
    const bindings = (
      globalThis as {
        bindings?: {
          rpc(request: { path: string; input?: unknown }): Promise<
            | { ok: true; result: unknown }
            | { ok: false; error: { message: string } }
          >;
        };
      }
    ).bindings;
    if (!bindings) throw new Error("The desktop runtime is not available");
    const response = await bindings.rpc({ path, input });
    if (!response.ok) throw new Error(response.error.message);
    return response.result;
  }

  private name(key: string) {
    return `${this.prefix}.${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = (await this.call("storage.get", {
      namespace: "keys",
      key: this.name(key)
    })) as string | null;
    return raw === null ? undefined : (decodeTagged(raw) as T);
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.call("storage.set", {
      namespace: "keys",
      key: this.name(key),
      value: encodeTagged(value)
    });
  }

  async setMany(entries: [string, unknown][]): Promise<void> {
    for (const [key, value] of entries) await this.set(key, value);
  }

  async getMany<T>(keys: string[]): Promise<[string, T][]> {
    const result: [string, T][] = [];
    for (const key of keys) {
      const value = await this.get<T>(key);
      if (value !== undefined) result.push([key, value]);
    }
    return result;
  }

  async delete(key: string): Promise<void> {
    await this.call("storage.remove", {
      namespace: "keys",
      key: this.name(key)
    });
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) await this.delete(key);
  }

  private async ownKeys(): Promise<string[]> {
    const all = (await this.call("storage.keys", {
      namespace: "keys"
    })) as string[];
    return all
      .filter((key) => key.startsWith(this.prefix + "."))
      .map((key) => key.slice(this.prefix.length + 1));
  }

  async clear(): Promise<void> {
    await this.deleteMany(await this.ownKeys());
  }

  keys(): Promise<string[]> {
    return this.ownKeys();
  }

  async values<T>(): Promise<T[]> {
    return (await this.entries<T>()).map(([, value]) => value);
  }

  async entries<T>(): Promise<[string, T][]> {
    // The runtime's "keys" namespace has no bulk read, on purpose — a
    // compromised page must not exfiltrate the key store in one call — so
    // entries are fetched one by one.
    return await this.getMany<T>(await this.ownKeys());
  }
}

type TaggedValue =
  | { $type: "json"; value: unknown }
  | { $type: "bytes"; encoding: "ArrayBuffer" | "Uint8Array"; data: string };

function encodeTagged(value: unknown): string {
  const encode = (input: unknown): unknown => {
    if (input instanceof ArrayBuffer) {
      return {
        $type: "bytes",
        encoding: "ArrayBuffer",
        data: bytesToBase64(new Uint8Array(input))
      } satisfies TaggedValue;
    }
    if (input instanceof Uint8Array) {
      return {
        $type: "bytes",
        encoding: "Uint8Array",
        data: bytesToBase64(input)
      } satisfies TaggedValue;
    }
    if (typeof CryptoKey !== "undefined" && input instanceof CryptoKey) {
      throw new Error(
        "A CryptoKey cannot be persisted through the desktop runtime. " +
          "The key store must use its safeStorage wrapping path here."
      );
    }
    if (Array.isArray(input)) return input.map(encode);
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) out[key] = encode(entry);
      return out;
    }
    return input;
  };
  return JSON.stringify({ $type: "json", value: encode(value) });
}

function decodeTagged(raw: string): unknown {
  const decode = (input: unknown): unknown => {
    if (input !== null && typeof input === "object") {
      const tagged = input as TaggedValue;
      if (tagged.$type === "bytes") {
        const bytes = base64ToBytes(tagged.data);
        return tagged.encoding === "ArrayBuffer" ? toArrayBuffer(bytes) : bytes;
      }
      if (Array.isArray(input)) return input.map(decode);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(input)) out[key] = decode(entry);
      return out;
    }
    return input;
  };
  const parsed = JSON.parse(raw) as TaggedValue;
  if (parsed?.$type !== "json") throw new Error("Malformed stored value");
  return decode(parsed.value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}
