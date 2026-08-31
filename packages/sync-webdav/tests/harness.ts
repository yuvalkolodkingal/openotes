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

import { SerializedKey } from "@notesnook/crypto";
import { WebDavClient } from "../src/client.ts";
import { SyncCrypto } from "../src/crypto.ts";
import { FetchTransport, toBasicAuth } from "../src/http.ts";
import { MemoryQueueStorage, OutgoingQueue } from "../src/queue.ts";
import { SyncEngine } from "../src/engine.ts";
import { MemoryAttachments, MemorySyncStore } from "./memory-store.ts";

/**
 * Builds a complete "device": store + queue + engine, pointed at a WebDAV
 * base URL. Two devices sharing a URL and passphrase is exactly the
 * multi-device scenario the spec requires.
 */

export const TEST_PASSPHRASE = "correct horse battery staple";

/**
 * Argon2 is deliberately slow. Deriving once per test run and reusing the
 * result keeps the suite fast without weakening what is under test (the
 * protocol), because every device still derives the *same* key the same way.
 */
let cachedMaster: Promise<SerializedKey> | undefined;
const sharedCrypto = new SyncCrypto();

export function masterKeyFor(
  passphrase = TEST_PASSPHRASE,
  salt = "AAAAAAAAAAAAAAAAAAAAAA"
): Promise<SerializedKey> {
  if (passphrase === TEST_PASSPHRASE && salt === "AAAAAAAAAAAAAAAAAAAAAA") {
    cachedMaster ??= sharedCrypto.deriveMasterKey(passphrase, salt);
    return cachedMaster;
  }
  return sharedCrypto.deriveMasterKey(passphrase, salt);
}

export interface TestDevice {
  id: string;
  store: MemorySyncStore;
  queue: OutgoingQueue;
  engine: SyncEngine;
  client: WebDavClient;
  attachments: MemoryAttachments;
  crypto: SyncCrypto;
}

export async function createDevice(options: {
  id: string;
  baseUrl: string;
  username?: string;
  password?: string;
  passphrase?: string;
  salt?: string;
  syncAttachments?: boolean;
  maxRetries?: number;
  requestTimeout?: number;
  store?: MemorySyncStore;
  attachments?: MemoryAttachments;
  queueStorage?: MemoryQueueStorage;
  onConflict?: (id: string) => void;
}): Promise<TestDevice> {
  const crypto = new SyncCrypto();
  const masterKey = await masterKeyFor(options.passphrase, options.salt);

  const transport = new FetchTransport(
    options.username
      ? {
          getBasicAuth: () =>
            Promise.resolve(
              toBasicAuth(options.username!, options.password ?? "")
            )
        }
      : undefined
  );

  const client = new WebDavClient(transport, {
    baseUrl: options.baseUrl,
    allowInsecureHttp: true,
    maxRetries: options.maxRetries ?? 2,
    requestTimeout: options.requestTimeout ?? 5000,
    delay: () => Promise.resolve()
  });

  const store = options.store ?? new MemorySyncStore(options.id);
  const attachments = options.attachments ?? new MemoryAttachments();
  const queue = new OutgoingQueue(
    options.queueStorage ?? new MemoryQueueStorage()
  );

  const engine = new SyncEngine({
    client,
    crypto,
    store,
    queue,
    masterKey,
    attachments,
    syncAttachments: options.syncAttachments ?? true,
    deviceName: options.id,
    appVersion: "1.0.0-test",
    platform: "linux",
    onConflict: (record) => options.onConflict?.(record.entityId)
  });

  return { id: options.id, store, queue, engine, client, attachments, crypto };
}

/** Deterministic bytes for attachment tests. */
export function testBytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
