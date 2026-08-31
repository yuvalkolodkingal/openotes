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

import { NNCrypto, SerializedKey, Cipher } from "@notesnook/crypto";
import { Sodium } from "@notesnook/sodium";
import { SerializedCipher, SyncError } from "./types.ts";

/**
 * Key hierarchy (see SECURITY.md):
 *
 *   User passphrase
 *         │  argon2i (libsodium crypto_pwhash, via @notesnook/crypto)
 *         ▼
 *     Master key ──┬── "nn-sync-v1"        → synchronization key
 *                  ├── "nn-attachment-v1"  → attachment key
 *                  └── "nn-backup-v1"      → backup key
 *
 * Subkeys are derived with keyed BLAKE2b (libsodium crypto_generichash with
 * the master key as the hash key), which is the same construction libsodium's
 * own crypto_kdf uses. The master key never leaves the process and is never
 * written to disk in plaintext; only the argon2 salt is stored remotely so
 * another device can re-derive it from the same passphrase.
 */

export const KEY_CONTEXTS = {
  sync: "nn-sync-v1",
  attachment: "nn-attachment-v1",
  backup: "nn-backup-v1",
  database: "nn-database-v1"
} as const;

export type KeyPurpose = keyof typeof KEY_CONTEXTS;

const KEY_BYTES = 32;

export class SyncCrypto {
  private sodium?: Sodium;
  private readonly crypto = new NNCrypto();

  private async getSodium(): Promise<Sodium> {
    if (!this.sodium) {
      const sodium = new Sodium();
      await sodium.initialize();
      this.sodium = sodium;
    }
    return this.sodium;
  }

  /** Derive the master key from a passphrase. Salt is base64. */
  async deriveMasterKey(
    passphrase: string,
    salt?: string
  ): Promise<SerializedKey> {
    if (!passphrase) {
      throw new SyncError("A sync passphrase is required", "bad-key");
    }
    return await this.crypto.exportKey(passphrase, salt);
  }

  /** Generate a fresh random salt (base64) for a new remote repository. */
  async generateSalt(): Promise<string> {
    const sodium = await this.getSodium();
    return sodium.to_base64(
      sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
    );
  }

  /** Derive a purpose-specific subkey from the master key. */
  async deriveSubkey(
    masterKey: SerializedKey,
    purpose: KeyPurpose
  ): Promise<SerializedKey> {
    const sodium = await this.getSodium();
    if (!masterKey.key || !masterKey.salt) {
      throw new SyncError(
        "Master key must be a derived key, not a raw password",
        "bad-key"
      );
    }
    const keyBytes = sodium.from_base64(masterKey.key);
    const subkey = sodium.crypto_generichash(
      KEY_BYTES,
      new TextEncoder().encode(KEY_CONTEXTS[purpose]),
      keyBytes
    );
    return { key: sodium.to_base64(subkey), salt: masterKey.salt };
  }

  async encryptJson(key: SerializedKey, value: unknown): Promise<SerializedCipher> {
    const cipher = await this.crypto.encrypt(
      key,
      JSON.stringify(value),
      "text",
      "base64"
    );
    return toSerializedCipher(cipher);
  }

  async decryptJson<T>(key: SerializedKey, cipher: SerializedCipher): Promise<T> {
    const text = await this.decryptText(key, cipher);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SyncError(
        "Decrypted payload is not valid JSON — the record is corrupt",
        "corrupt-data"
      );
    }
  }

  async decryptText(
    key: SerializedKey,
    cipher: SerializedCipher
  ): Promise<string> {
    try {
      return await this.crypto.decrypt(
        key,
        cipher as unknown as Cipher<"base64">,
        "text"
      );
    } catch (e) {
      throw new SyncError(
        `Failed to decrypt: ${e instanceof Error ? e.message : String(e)}. ` +
          "The passphrase may be wrong or the data may be corrupt.",
        "bad-key"
      );
    }
  }

  async encryptBytes(
    key: SerializedKey,
    data: Uint8Array
  ): Promise<SerializedCipher> {
    const cipher = await this.crypto.encrypt(key, data, "uint8array", "base64");
    return toSerializedCipher(cipher);
  }

  async decryptBytes(
    key: SerializedKey,
    cipher: SerializedCipher
  ): Promise<Uint8Array> {
    try {
      return await this.crypto.decrypt(
        key,
        cipher as unknown as Cipher<"base64">,
        "uint8array"
      );
    } catch (e) {
      throw new SyncError(
        `Failed to decrypt binary payload: ${
          e instanceof Error ? e.message : String(e)
        }`,
        "bad-key"
      );
    }
  }

  /**
   * Streaming encryption for attachments — never materializes the whole
   * plaintext in memory. Returns the stream header (iv) and a TransformStream
   * that consumes {data, final} chunks.
   */
  async createEncryptionStream(key: SerializedKey) {
    return await this.crypto.createEncryptionStream(key);
  }

  async createDecryptionStream(key: SerializedKey, iv: string) {
    return await this.crypto.createDecryptionStream(key, iv);
  }

  /**
   * Content-addressed name for an object. The hash is keyed with the sync
   * key so the server cannot correlate identical plaintext across accounts,
   * and no plaintext-derived value ever appears in a filename.
   */
  async contentAddress(
    key: SerializedKey,
    data: Uint8Array
  ): Promise<string> {
    const sodium = await this.getSodium();
    if (!key.key) throw new SyncError("Invalid key", "bad-key");
    const digest = sodium.crypto_generichash(
      32,
      data,
      sodium.from_base64(key.key)
    );
    return toHex(digest);
  }

  async hashString(key: SerializedKey, value: string): Promise<string> {
    return await this.contentAddress(key, new TextEncoder().encode(value));
  }
}

export function toSerializedCipher(
  cipher: Cipher<"base64">
): SerializedCipher {
  return {
    format: "base64",
    alg: cipher.alg,
    cipher: cipher.cipher,
    iv: cipher.iv,
    salt: cipher.salt,
    length: cipher.length
  };
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time comparison for hashes/digests. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
