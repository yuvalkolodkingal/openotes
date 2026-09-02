/*
This file is part of the Notesnook project (https://notesnook.com/)

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

import { PrefixedRemoteStorage, type RemoteStorage } from "@notesnook/sync-core";
import {
  NeonHttpExecutor,
  SqlRemoteStorage,
  SupabaseRestStorage
} from "@notesnook/sync-sql";
import { SyncEngine } from "../../../packages/sync-webdav/src/engine.ts";
import { SyncCrypto } from "../../../packages/sync-webdav/src/crypto.ts";
import { OutgoingQueue } from "../../../packages/sync-webdav/src/queue.ts";
import type { SyncStatus } from "../../../packages/sync-webdav/src/types.ts";
import type { MobileDatabase } from "./database.ts";
import type { Connection } from "./secrets.ts";

/**
 * The desktop's sync engine, assembled for a phone.
 *
 * Every piece is the desktop's own: the journal engine, its crypto (on the
 * pure-JS build, see packages/sync-crypto-js), the SQL storage. What differs
 * is the transport -- only the two that need nothing but fetch -- and that
 * attachments stay off: their streaming cipher needs libsodium, and a phone
 * with the notes but not the images is a better outcome than one with a
 * broken cipher.
 */

export const APP_VERSION = "2.2.2";

export function storageFor(connection: Connection): RemoteStorage {
  const inner: RemoteStorage =
    connection.provider === "neon"
      ? new SqlRemoteStorage(new NeonHttpExecutor(connection.connectionString))
      : new SupabaseRestStorage(connection.projectUrl, connection.serviceKey);
  return new PrefixedRemoteStorage(
    inner,
    connection.directory.replace(/^\/+|\/+$/g, "") || "Openotes"
  );
}

/**
 * The salt the passphrase is stretched with lives in the repository's
 * protocol.json; a phone joining a repository the desktop created has to
 * use that one. Only a repository nobody has created yet gets a fresh salt.
 */
async function resolveSalt(
  storage: RemoteStorage,
  database: MobileDatabase,
  crypto: SyncCrypto
): Promise<string> {
  const known = await database.getMeta("webdav.salt");
  let remote: string | undefined;
  try {
    const raw = await storage.getIfExists("protocol.json");
    if (raw) {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as { salt?: unknown };
      if (typeof parsed.salt === "string" && parsed.salt) remote = parsed.salt;
    }
  } catch {
    // The engine reports an unreadable repository properly; this only
    // answers "which salt".
  }
  if (remote && remote !== known) {
    await database.setMeta("webdav.salt", remote);
    return remote;
  }
  if (known) return known;
  const fresh = await crypto.generateSalt();
  await database.setMeta("webdav.salt", fresh);
  return fresh;
}

export async function buildEngine(options: {
  connection: Connection;
  passphrase: string;
  database: MobileDatabase;
  onStatus: (status: SyncStatus) => void;
  deviceName?: string;
}): Promise<SyncEngine> {
  const crypto = new SyncCrypto();
  const storage = storageFor(options.connection);
  await storage.probe();
  const salt = await resolveSalt(storage, options.database, crypto);
  const masterKey = await crypto.deriveMasterKey(options.passphrase, salt);

  return new SyncEngine({
    storage,
    crypto,
    store: options.database,
    queue: new OutgoingQueue(options.database.textStore("sync-queue")),
    masterKey,
    syncAttachments: false,
    deviceName: options.deviceName ?? "Phone",
    appVersion: APP_VERSION,
    platform: "mobile",
    onStatus: options.onStatus
  });
}

/**
 * Check a connection and a passphrase before saving either: reachable, and
 * the passphrase opens whatever repository is there.
 */
export async function testConnection(
  connection: Connection,
  passphrase: string,
  database: MobileDatabase
): Promise<{ initialized: boolean; devices: number }> {
  const engine = await buildEngine({
    connection,
    passphrase,
    database,
    onStatus: () => {}
  });
  const result = await engine.testConnection();
  return { initialized: result.initialized, devices: result.devices };
}
