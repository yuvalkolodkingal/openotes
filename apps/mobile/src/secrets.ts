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

import * as SecureStore from "expo-secure-store";

/**
 * Where the phone keeps what must not be readable: the connection to the
 * database and the sync passphrase. The OS keychain (iOS) or keystore
 * (Android) holds them; the app's own database holds only ciphertext and
 * the notes it has decrypted for display.
 */
export type Connection =
  | {
      provider: "neon";
      /** Full connection string, password included. */
      connectionString: string;
      directory: string;
    }
  | {
      provider: "supabase";
      projectUrl: string;
      serviceKey: string;
      directory: string;
    };

const CONNECTION_KEY = "openotes.connection";
const PASSPHRASE_KEY = "openotes.passphrase";

export async function readConnection(): Promise<Connection | undefined> {
  const raw = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Connection;
  } catch {
    return undefined;
  }
}

export async function writeConnection(
  connection: Connection | undefined
): Promise<void> {
  if (!connection) {
    await SecureStore.deleteItemAsync(CONNECTION_KEY);
    return;
  }
  await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection));
}

export async function readPassphrase(): Promise<string | undefined> {
  return (await SecureStore.getItemAsync(PASSPHRASE_KEY)) ?? undefined;
}

export async function writePassphrase(
  passphrase: string | undefined
): Promise<void> {
  if (!passphrase) {
    await SecureStore.deleteItemAsync(PASSPHRASE_KEY);
    return;
  }
  await SecureStore.setItemAsync(PASSPHRASE_KEY, passphrase);
}
