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

const log = logger.scope("credentials");

/**
 * Encrypted storage for secrets that must survive a restart — today that
 * is the WebDAV password and the sync passphrase verifier (spec §19).
 *
 * Threat model, stated plainly:
 *
 *  - Secrets are never written in plaintext. The store file holds only
 *    AES-256-GCM ciphertext.
 *  - The wrapping key comes from the user's vault passphrase when the vault
 *    is unlocked. That is the only mode in which secrets are readable, so
 *    automatic synchronization requires an unlocked vault — which the spec
 *    explicitly allows (§19).
 *  - When the user opts into "remember without unlocking", the wrapping key
 *    is derived from a machine-local secret stored with 0600 permissions in
 *    the app data directory. This protects against a stolen backup or a
 *    synced home directory, NOT against someone with read access to the
 *    running user's own files. That trade-off is surfaced in the UI rather
 *    than hidden here.
 *
 * There is no OS keychain integration: no Deno-native, cross-platform
 * keychain binding exists that would not mean shelling out to platform
 * tools, and a subprocess permission for that is a worse trade than this.
 * The spec permits exactly this fallback.
 */

const STORE_FILE = "credentials.enc";
const MACHINE_KEY_FILE = "machine.key";
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

interface StoredEnvelope {
  version: 1;
  /** "vault" = unlocked by the vault passphrase, "machine" = machine key. */
  mode: "vault" | "machine";
  salt: string;
  iv: string;
  ciphertext: string;
}

export type CredentialRecord = Record<string, string>;

export class CredentialStore {
  private cache?: CredentialRecord;
  private wrappingKey?: CryptoKey;
  private mode: "vault" | "machine" = "machine";
  private readonly path: string;

  constructor(directory: string = appDataDir()) {
    this.path = join(directory, STORE_FILE);
  }

  get isUnlocked(): boolean {
    return !!this.wrappingKey;
  }

  get unlockMode(): "vault" | "machine" {
    return this.mode;
  }

  /**
   * Unlock with the user's vault passphrase. Preferred: nothing on disk can
   * decrypt the secrets without the passphrase.
   */
  async unlockWithPassphrase(passphrase: string): Promise<void> {
    if (!passphrase) throw new Error("A passphrase is required");
    this.mode = "vault";
    const salt = await this.saltFor("vault");
    this.wrappingKey = await deriveKey(passphrase, salt);
    this.cache = undefined;
    log.info("Credential store unlocked with the vault passphrase");
  }

  /**
   * Unlock with the machine-local key. Weaker, and only used when the user
   * asked for background sync without unlocking the vault.
   */
  async unlockWithMachineKey(): Promise<void> {
    this.mode = "machine";
    const secret = await this.machineSecret();
    const salt = await this.saltFor("machine");
    this.wrappingKey = await deriveKey(secret, salt);
    this.cache = undefined;
    log.info("Credential store unlocked with the machine key");
  }

  lock(): void {
    this.wrappingKey = undefined;
    this.cache = undefined;
    log.info("Credential store locked");
  }

  async get(key: string): Promise<string | undefined> {
    const record = await this.read();
    return record[key];
  }

  async set(key: string, value: string | undefined): Promise<void> {
    const record = await this.read();
    if (value === undefined) delete record[key];
    else record[key] = value;
    await this.write(record);
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  /** Key names only — never values. Safe to show in diagnostics. */
  async keys(): Promise<string[]> {
    return Object.keys(await this.read());
  }

  async clear(): Promise<void> {
    this.cache = {};
    try {
      await Deno.remove(this.path);
    } catch {
      /* nothing stored yet */
    }
  }

  /** Re-wrap every secret under a new passphrase. */
  async rewrap(
    newPassphrase: string | undefined,
    newMode: "vault" | "machine"
  ): Promise<void> {
    const record = await this.read();
    this.mode = newMode;
    const salt = await this.saltFor(newMode);
    this.wrappingKey = await deriveKey(
      newMode === "vault"
        ? requirePassphrase(newPassphrase)
        : await this.machineSecret(),
      salt
    );
    await this.write(record);
  }

  private async read(): Promise<CredentialRecord> {
    if (this.cache) return this.cache;
    if (!this.wrappingKey) {
      throw new Error(
        "The credential store is locked. Unlock the vault before reading " +
          "stored credentials."
      );
    }

    let raw: string;
    try {
      raw = await Deno.readTextFile(this.path);
    } catch {
      this.cache = {};
      return this.cache;
    }

    let envelope: StoredEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(
        "The stored credentials file is corrupt. Re-enter your WebDAV " +
          "password in Settings to recreate it."
      );
    }
    if (envelope.mode !== this.mode) {
      throw new Error(
        `The stored credentials were locked with the ${envelope.mode} key, ` +
          `but the store was unlocked with the ${this.mode} key.`
      );
    }

    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(fromBase64(envelope.iv)) },
        this.wrappingKey,
        toArrayBuffer(fromBase64(envelope.ciphertext))
      );
      this.cache = JSON.parse(new TextDecoder().decode(plaintext));
      return this.cache!;
    } catch {
      throw new Error(
        "Stored credentials could not be decrypted. If you changed your " +
          "vault passphrase, re-enter your WebDAV password in Settings."
      );
    }
  }

  private async write(record: CredentialRecord): Promise<void> {
    if (!this.wrappingKey) {
      throw new Error("The credential store is locked");
    }
    await ensureDir(dirOf(this.path));

    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(record));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        this.wrappingKey,
        toArrayBuffer(plaintext)
      )
    );

    const envelope: StoredEnvelope = {
      version: 1,
      mode: this.mode,
      salt: toBase64(await this.saltFor(this.mode)),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext)
    };

    // Write through a temp file so a crash cannot leave a truncated store.
    const tempPath = `${this.path}.tmp`;
    await Deno.writeTextFile(tempPath, JSON.stringify(envelope));
    await restrictPermissions(tempPath);
    await Deno.rename(tempPath, this.path);
    this.cache = record;
  }

  /** Per-mode salt, created once and stored beside the credentials. */
  private async saltFor(mode: "vault" | "machine"): Promise<Uint8Array> {
    const saltPath = join(dirOf(this.path), `salt.${mode}`);
    try {
      const existing = await Deno.readFile(saltPath);
      if (existing.length === SALT_BYTES) return existing;
    } catch {
      /* create it below */
    }
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    await ensureDir(dirOf(saltPath));
    await Deno.writeFile(saltPath, salt);
    await restrictPermissions(saltPath);
    return salt;
  }

  /** A random per-installation secret, readable only by this user. */
  private async machineSecret(): Promise<string> {
    const path = join(dirOf(this.path), MACHINE_KEY_FILE);
    try {
      const existing = await Deno.readTextFile(path);
      if (existing.length >= 32) return existing;
    } catch {
      /* create it below */
    }
    const secret = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await ensureDir(dirOf(path));
    await Deno.writeTextFile(path, secret);
    await restrictPermissions(path);
    return secret;
  }
}

function requirePassphrase(passphrase: string | undefined): string {
  if (!passphrase) {
    throw new Error("A passphrase is required to re-wrap stored credentials");
  }
  return passphrase;
}

async function deriveKey(
  secret: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(secret)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function restrictPermissions(path: string): Promise<void> {
  if (Deno.build.os === "windows") return; // ACLs inherit from the user profile
  try {
    await Deno.chmod(path, 0o600);
  } catch {
    log.warn("Could not restrict permissions on a credential file");
  }
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index <= 0 ? path : path.slice(0, index);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
