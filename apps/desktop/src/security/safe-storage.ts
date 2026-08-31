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
import { appDataDir, ensureDir } from "../native/paths.ts";
import { logger } from "../native/logger.ts";

const log = logger.scope("safe-storage");

/**
 * The runtime half of the renderer's key wrapping.
 *
 * Upstream's key store has a desktop path built around Electron's
 * `safeStorage`: it generates its AES key, hands the raw bytes to the host
 * to encrypt, and persists only the ciphertext; on start-up the host
 * decrypts and the key is imported back. Implementing the same two calls
 * here lets that shipped, tested path run unchanged.
 *
 * The encryption is AES-256-GCM under a random per-installation secret
 * stored `0600` in the data directory. Stated plainly, as SECURITY.md does:
 * this protects the wrapped key against a stolen backup, a synced home
 * directory or another machine's disk — not against an attacker who can
 * already read this user's files, who could read the secret too. That is
 * the same boundary Electron's safeStorage has on Linux without a keyring,
 * where it famously encrypts with a fixed well-known password; a random
 * per-install secret is strictly stronger than that.
 *
 * The user's actual protection against local attackers is the app lock,
 * which wraps the same key under a password instead.
 */

const SECRET_FILE = "safe-storage.key";
const IV_BYTES = 12;

export class SafeStorage {
  private key?: CryptoKey;

  constructor(private readonly directory: string = appDataDir()) {}

  isAvailable(): boolean {
    return true;
  }

  private async getKey(): Promise<CryptoKey> {
    if (this.key) return this.key;

    const path = join(this.directory, SECRET_FILE);
    let secret: Uint8Array;
    try {
      secret = await Deno.readFile(path);
      if (secret.length !== 32) throw new Error("wrong length");
    } catch {
      secret = crypto.getRandomValues(new Uint8Array(32));
      await ensureDir(this.directory);
      await Deno.writeFile(path, secret);
      if (Deno.build.os !== "windows") {
        await Deno.chmod(path, 0o600).catch(() => {});
      }
      log.info("Created a new safe-storage secret");
    }

    this.key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(secret),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return this.key;
  }

  /** base64 plaintext in, base64(iv || ciphertext) out. */
  async encryptString(plaintextBase64: string): Promise<string> {
    const key = await this.getKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        key,
        toArrayBuffer(fromBase64(plaintextBase64))
      )
    );
    const combined = new Uint8Array(iv.length + ciphertext.length);
    combined.set(iv, 0);
    combined.set(ciphertext, iv.length);
    return toBase64(combined);
  }

  async decryptString(payloadBase64: string): Promise<string> {
    const key = await this.getKey();
    const combined = fromBase64(payloadBase64);
    if (combined.length <= IV_BYTES) {
      throw new Error("The encrypted payload is too short to be valid");
    }
    try {
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: toArrayBuffer(combined.subarray(0, IV_BYTES)) },
          key,
          toArrayBuffer(combined.subarray(IV_BYTES))
        )
      );
      return toBase64(plaintext);
    } catch {
      throw new Error(
        "The stored key could not be decrypted. The safe-storage secret may " +
          "have been deleted or restored from a different installation."
      );
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}
