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

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2i, argon2id } from "@noble/hashes/argon2.js";
import { blake2b } from "@noble/hashes/blake2.js";

/** libsodium's base64 variants, with libsodium's numbering. */
export enum base64_variants {
  ORIGINAL = 1,
  ORIGINAL_NO_PADDING = 3,
  URLSAFE = 5,
  URLSAFE_NO_PADDING = 7,
}

const ALG_ARGON2I13 = 1;
const ALG_ARGON2ID13 = 2;

/**
 * The slice of libsodium the sync engine touches, on @noble.
 *
 * Constants carry libsodium's values, so code that compares against them
 * (the algorithm ids, the salt length) behaves identically. The secretstream
 * functions -- attachment content -- are deliberately absent: attachments
 * are not synchronised on the phone, and a stub that silently produced the
 * wrong bytes would be worse than a method that is not there.
 */
export class JsSodium {
  initialize(): Promise<void> {
    return Promise.resolve();
  }

  readonly crypto_pwhash_SALTBYTES = 16;
  readonly crypto_pwhash_ALG_ARGON2I13 = ALG_ARGON2I13;
  readonly crypto_pwhash_ALG_ARGON2ID13 = ALG_ARGON2ID13;
  readonly crypto_pwhash_ALG_DEFAULT = ALG_ARGON2ID13;
  readonly crypto_pwhash_OPSLIMIT_INTERACTIVE = 2;
  readonly crypto_pwhash_OPSLIMIT_MODERATE = 3;
  readonly crypto_pwhash_OPSLIMIT_SENSITIVE = 4;
  readonly crypto_pwhash_MEMLIMIT_INTERACTIVE = 67108864;
  readonly crypto_pwhash_MEMLIMIT_MODERATE = 268435456;
  readonly crypto_pwhash_MEMLIMIT_SENSITIVE = 1073741824;
  readonly crypto_aead_xchacha20poly1305_ietf_KEYBYTES = 32;
  readonly crypto_aead_xchacha20poly1305_ietf_NPUBBYTES = 24;

  /**
   * libsodium's crypto_pwhash: opslimit is Argon2's iteration count and
   * memlimit is in bytes, which Argon2 counts in kibibytes.
   */
  crypto_pwhash(
    keyLength: number,
    password: string | Uint8Array,
    salt: Uint8Array,
    opsLimit: number,
    memLimit: number,
    algorithm: number,
  ): Uint8Array {
    const options = {
      t: opsLimit,
      m: Math.floor(memLimit / 1024),
      p: 1,
      dkLen: keyLength,
      version: 0x13,
    };
    const bytes = typeof password === "string"
      ? new TextEncoder().encode(password)
      : password;
    if (algorithm === ALG_ARGON2I13) return argon2i(bytes, salt, options);
    if (algorithm === ALG_ARGON2ID13) return argon2id(bytes, salt, options);
    throw new Error(`Unsupported password hashing algorithm ${algorithm}`);
  }

  /** BLAKE2b, keyed when a key is given -- libsodium's generichash. */
  crypto_generichash(
    hashLength: number,
    message: string | Uint8Array,
    key?: Uint8Array | null,
  ): Uint8Array {
    const bytes = typeof message === "string"
      ? new TextEncoder().encode(message)
      : message;
    return blake2b(bytes, {
      dkLen: hashLength,
      ...(key ? { key } : {}),
    });
  }

  crypto_aead_xchacha20poly1305_ietf_encrypt(
    message: string | Uint8Array,
    additionalData: string | Uint8Array | null,
    _secretNonce: Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array {
    const bytes = typeof message === "string"
      ? new TextEncoder().encode(message)
      : message;
    return xchacha20poly1305(key, publicNonce, toBytes(additionalData))
      .encrypt(bytes);
  }

  crypto_aead_xchacha20poly1305_ietf_decrypt(
    _secretNonce: Uint8Array | null,
    ciphertext: Uint8Array,
    additionalData: string | Uint8Array | null,
    publicNonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array {
    return xchacha20poly1305(key, publicNonce, toBytes(additionalData))
      .decrypt(ciphertext);
  }

  randombytes_buf(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  to_string(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
  }

  from_hex(hex: string): Uint8Array {
    if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
      throw new Error("Invalid hex");
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  /** libsodium's default variant is URL-safe without padding. */
  to_base64(
    input: string | Uint8Array,
    variant: base64_variants = base64_variants.URLSAFE_NO_PADDING,
  ): string {
    const bytes = typeof input === "string"
      ? new TextEncoder().encode(input)
      : input;
    return encodeBase64(bytes, variant);
  }

  from_base64(
    input: string,
    variant: base64_variants = base64_variants.URLSAFE_NO_PADDING,
  ): Uint8Array {
    return decodeBase64(input, variant);
  }
}

function toBytes(value: string | Uint8Array | null): Uint8Array | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

const STANDARD =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URLSAFE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64(
  bytes: Uint8Array,
  variant: base64_variants,
): string {
  const alphabet = variant === base64_variants.URLSAFE ||
      variant === base64_variants.URLSAFE_NO_PADDING
    ? URLSAFE
    : STANDARD;
  const pad = variant === base64_variants.ORIGINAL ||
    variant === base64_variants.URLSAFE;
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += alphabet[(triple >> 18) & 63];
    out += alphabet[(triple >> 12) & 63];
    out += b === undefined ? (pad ? "=" : "") : alphabet[(triple >> 6) & 63];
    out += c === undefined ? (pad ? "=" : "") : alphabet[triple & 63];
  }
  return out;
}

/**
 * Decode, accepting whichever of the two alphabets the variant names.
 *
 * libsodium is strict about the variant; this is strict about the alphabet
 * and lenient about padding, which is the safe direction: a value libsodium
 * wrote is always accepted, and a value from the wrong alphabet is refused
 * rather than silently misread.
 */
export function decodeBase64(
  input: string,
  variant: base64_variants,
): Uint8Array {
  const alphabet = variant === base64_variants.URLSAFE ||
      variant === base64_variants.URLSAFE_NO_PADDING
    ? URLSAFE
    : STANDARD;
  const clean = input.replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value === -1) throw new Error("Invalid base64 input");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
