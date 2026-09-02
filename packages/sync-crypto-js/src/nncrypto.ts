/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited
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

import { base64_variants, JsSodium } from "./sodium.ts";

/** The shapes @notesnook/crypto uses, reproduced so callers need no change. */
export type DataFormat = "uint8array" | "text" | "base64" | "hex";

export type Cipher<TFormat extends DataFormat> = {
  format: TFormat;
  alg: string;
  cipher: TFormat extends "uint8array" ? Uint8Array : string;
  iv: string;
  salt: string;
  length: number;
};

export type SerializedKey = {
  password?: string;
  key?: string;
  salt?: string;
};

export type Chunk = { data: Uint8Array; final: boolean };
export type EncryptionStream = TransformStream<Chunk, Uint8Array>;

/**
 * @notesnook/crypto's NNCrypto, byte for byte.
 *
 * The parameters are the ones KeyUtils.deriveKey and Encryption.encrypt in
 * packages/crypto use: Argon2i, three passes, eight mebibytes, a 16-byte
 * salt; XChaCha20-Poly1305 with a fresh 24-byte nonce; the `alg` string
 * `xcha-argon2i13-7`, where 7 is libsodium's URL-safe unpadded base64. A
 * change to either side without the other breaks the compatibility test.
 */
export class JsNNCrypto {
  private readonly sodium = new JsSodium();

  private deriveKey(
    password: string,
    salt?: string,
  ): { key: Uint8Array; salt: string } {
    const saltBytes = salt
      ? this.sodium.from_base64(salt)
      : this.sodium.randombytes_buf(this.sodium.crypto_pwhash_SALTBYTES);
    const key = this.sodium.crypto_pwhash(
      this.sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
      password,
      saltBytes,
      3,
      1024 * 1024 * 8,
      this.sodium.crypto_pwhash_ALG_ARGON2I13,
    );
    return { key, salt: salt ?? this.sodium.to_base64(saltBytes) };
  }

  private transform(key: SerializedKey): { key: Uint8Array; salt: string } {
    if (key.password) return this.deriveKey(key.password, key.salt);
    if (key.key && key.salt) {
      return { key: this.sodium.from_base64(key.key), salt: key.salt };
    }
    throw new Error("Invalid key: neither a password nor a derived key.");
  }

  exportKey(password: string, salt?: string): Promise<SerializedKey> {
    const derived = this.deriveKey(password, salt);
    return Promise.resolve({
      key: this.sodium.to_base64(derived.key),
      salt: derived.salt,
    });
  }

  encrypt<TOutputFormat extends DataFormat>(
    key: SerializedKey,
    input: string | Uint8Array,
    format: DataFormat,
    outputFormat: TOutputFormat = "uint8array" as TOutputFormat,
  ): Promise<Cipher<TOutputFormat>> {
    const encryptionKey = this.transform(key);
    let data: Uint8Array;
    if (typeof input === "string" && format === "base64") {
      data = this.sodium.from_base64(input, base64_variants.ORIGINAL);
    } else if (typeof input === "string") {
      data = new TextEncoder().encode(input);
    } else {
      data = input;
    }
    const nonce = this.sodium.randombytes_buf(
      this.sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
    );
    const cipher = this.sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      data,
      null,
      null,
      nonce,
      encryptionKey.key,
    );
    const output = outputFormat === "base64"
      ? this.sodium.to_base64(cipher, base64_variants.URLSAFE_NO_PADDING)
      : cipher;
    return Promise.resolve({
      format: outputFormat,
      alg: `xcha-argon2i13-${base64_variants.URLSAFE_NO_PADDING}`,
      cipher: output,
      iv: this.sodium.to_base64(nonce),
      salt: encryptionKey.salt,
      length: data.length,
    } as Cipher<TOutputFormat>);
  }

  decrypt<TOutputFormat extends DataFormat>(
    key: SerializedKey,
    cipherData: Cipher<DataFormat>,
    outputFormat: TOutputFormat = "text" as TOutputFormat,
  ): Promise<TOutputFormat extends "uint8array" ? Uint8Array : string> {
    if (!key.salt && cipherData.salt) key = { ...key, salt: cipherData.salt };
    const encryptionKey = this.transform(key);
    let input: Uint8Array;
    if (
      typeof cipherData.cipher === "string" && cipherData.format === "base64"
    ) {
      input = this.sodium.from_base64(
        cipherData.cipher,
        base64_variants.URLSAFE_NO_PADDING,
      );
    } else if (
      typeof cipherData.cipher === "string" && cipherData.format === "hex"
    ) {
      input = this.sodium.from_hex(cipherData.cipher);
    } else if (cipherData.cipher instanceof Uint8Array) {
      input = cipherData.cipher;
    } else {
      throw new Error("Data cannot be null.");
    }
    const plaintext = this.sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      input,
      null,
      this.sodium.from_base64(cipherData.iv),
      encryptionKey.key,
    );
    const output = outputFormat === "base64"
      ? this.sodium.to_base64(plaintext, base64_variants.ORIGINAL)
      : outputFormat === "text"
      ? this.sodium.to_string(plaintext)
      : plaintext;
    return Promise.resolve(
      output as TOutputFormat extends "uint8array" ? Uint8Array : string,
    );
  }

  /**
   * Attachments are not synchronised on the phone; say so, loudly. The
   * signatures match @notesnook/crypto so the engine compiles against this
   * build unchanged, and the rejection is what it gets if it ever asks.
   */
  createEncryptionStream(
    _key: SerializedKey,
  ): Promise<{ iv: string; stream: EncryptionStream }> {
    return Promise.reject(
      new Error("Streaming encryption is not available in the JS build."),
    );
  }

  createDecryptionStream(
    _key: SerializedKey,
    _iv: string,
  ): Promise<TransformStream<Uint8Array, Uint8Array>> {
    return Promise.reject(
      new Error("Streaming decryption is not available in the JS build."),
    );
  }
}
