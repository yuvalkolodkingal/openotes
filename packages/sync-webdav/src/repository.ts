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
import { WebDavClient } from "./client.ts";
import { SyncCrypto } from "./crypto.ts";
import {
  ChangeBatchEnvelope,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  ProtocolMetadata,
  SyncError,
  SyncRecord
} from "./types.ts";

/**
 * Remote repository layout (all paths relative to the configured directory):
 *
 *   protocol.json                     — plaintext protocol metadata + key check
 *   devices/<deviceId>/device.json    — encrypted device descriptor
 *   devices/<deviceId>/changes/NNNNNNNNNN.bin  — immutable encrypted batches
 *   objects/<hash>.bin                — encrypted oversized record payloads
 *   attachments/<hash>.bin            — encrypted attachment content
 *   backups/<timestamp>.backup.enc    — encrypted backup snapshots
 *
 * Nothing in a path or filename is derived from plaintext note data: object
 * and attachment names are keyed BLAKE2b digests (see SyncCrypto).
 */

export const PATHS = {
  protocol: "protocol.json",
  devices: "devices",
  objects: "objects",
  attachments: "attachments",
  backups: "backups"
} as const;

const KEY_CHECK_PLAINTEXT = "notesnook-webdav-sync-key-check-v1";
const SEQUENCE_DIGITS = 10;

export function sequenceFileName(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new SyncError(`Invalid sequence number: ${sequence}`, "corrupt-data");
  }
  return `${String(sequence).padStart(SEQUENCE_DIGITS, "0")}.bin`;
}

export function parseSequenceFileName(name: string): number | undefined {
  const match = /^(\d{1,19})\.bin$/.exec(name);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function devicePath(deviceId: string): string {
  assertSafeId(deviceId);
  return `${PATHS.devices}/${deviceId}`;
}

export function changePath(deviceId: string, sequence: number): string {
  return `${devicePath(deviceId)}/changes/${sequenceFileName(sequence)}`;
}

export function objectPath(hash: string): string {
  assertSafeId(hash);
  return `${PATHS.objects}/${hash}.bin`;
}

export function attachmentPath(hash: string): string {
  assertSafeId(hash);
  return `${PATHS.attachments}/${hash}.bin`;
}

/** Reject anything that could escape the repository or confuse a server. */
export function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new SyncError(
      `Unsafe identifier: ${JSON.stringify(id)}`,
      "corrupt-data"
    );
  }
}

export class SyncRepository {
  constructor(
    private readonly client: WebDavClient,
    private readonly crypto: SyncCrypto
  ) {}

  /** Read protocol.json. Returns undefined when the remote is empty. */
  async readProtocol(): Promise<ProtocolMetadata | undefined> {
    const raw = await this.client.getIfExists(PATHS.protocol);
    if (!raw) return undefined;
    let parsed: ProtocolMetadata;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new SyncError(
        "protocol.json on the server is not valid JSON",
        "corrupt-data"
      );
    }
    if (parsed.protocol !== PROTOCOL_NAME) {
      throw new SyncError(
        `The remote directory holds a different application's data ` +
          `(protocol "${parsed.protocol}"). Choose an empty directory.`,
        "protocol-mismatch"
      );
    }
    if (typeof parsed.version !== "number") {
      throw new SyncError(
        "protocol.json is missing a version field",
        "corrupt-data"
      );
    }
    if (parsed.version > PROTOCOL_VERSION) {
      throw new SyncError(
        `The remote repository uses sync protocol version ${parsed.version}, ` +
          `but this app only supports version ${PROTOCOL_VERSION}. Update the ` +
          `app before syncing — writing now could corrupt your data.`,
        "protocol-mismatch"
      );
    }
    return parsed;
  }

  /**
   * Create the remote repository skeleton. Uses If-None-Match to avoid
   * clobbering a repository another device created concurrently.
   */
  async initialize(
    masterKey: SerializedKey,
    deviceId: string,
    generation: string
  ): Promise<ProtocolMetadata> {
    await this.client.mkcolRecursive(PATHS.devices + "/");
    await this.client.mkcolRecursive(PATHS.objects + "/");
    await this.client.mkcolRecursive(PATHS.attachments + "/");
    await this.client.mkcolRecursive(PATHS.backups + "/");

    const syncKey = await this.crypto.deriveSubkey(masterKey, "sync");
    const metadata: ProtocolMetadata = {
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      salt: masterKey.salt!,
      keyCheck: await this.crypto.encryptJson(syncKey, KEY_CHECK_PLAINTEXT),
      createdAt: Date.now(),
      createdBy: deviceId,
      generation
    };

    const body = new TextEncoder().encode(JSON.stringify(metadata, null, 2));
    try {
      await this.client.put(PATHS.protocol, body, {
        ifNoneMatch: true,
        contentType: "application/json"
      });
    } catch (e) {
      if (e instanceof SyncError && e.code === "precondition-failed") {
        // Another device won the race; adopt its repository.
        const existing = await this.readProtocol();
        if (existing) return existing;
      }
      // Servers that ignore If-None-Match: re-read and adopt if present.
      const existing = await this.readProtocol();
      if (existing) return existing;
      throw e;
    }
    await this.client.verifyUpload(PATHS.protocol, body.length);
    return metadata;
  }

  /**
   * Confirm the passphrase matches the repository before writing anything.
   * Throws SyncError("bad-key") on mismatch.
   */
  async verifyKey(
    metadata: ProtocolMetadata,
    masterKey: SerializedKey
  ): Promise<SerializedKey> {
    const syncKey = await this.crypto.deriveSubkey(masterKey, "sync");
    const value = await this.crypto.decryptJson<string>(
      syncKey,
      metadata.keyCheck
    );
    if (value !== KEY_CHECK_PLAINTEXT) {
      throw new SyncError(
        "The sync passphrase does not match this remote repository",
        "bad-key"
      );
    }
    return syncKey;
  }

  /** List device ids present in the remote repository. */
  async listDevices(): Promise<string[]> {
    const entries = await this.client.list(PATHS.devices + "/");
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isCollection) continue;
      const relative = this.client.relativePath(entry);
      const id = relative.split("/").filter(Boolean).pop();
      if (!id) continue;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
      ids.push(id);
    }
    return ids.sort();
  }

  async registerDevice(
    syncKey: SerializedKey,
    deviceId: string,
    info: { name: string; platform: string; appVersion: string }
  ): Promise<void> {
    const path = `${devicePath(deviceId)}/device.json`;
    await this.client.mkcolRecursive(`${devicePath(deviceId)}/changes/`);
    const payload = JSON.stringify({
      id: deviceId,
      info: await this.crypto.encryptJson(syncKey, {
        ...info,
        registeredAt: Date.now()
      })
    });
    const body = new TextEncoder().encode(payload);
    await this.client.put(path, body, { contentType: "application/json" });
  }

  async readDeviceInfo(
    syncKey: SerializedKey,
    deviceId: string
  ): Promise<{ name: string; platform: string } | undefined> {
    const raw = await this.client.getIfExists(
      `${devicePath(deviceId)}/device.json`
    );
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw));
      return await this.crypto.decryptJson(syncKey, parsed.info);
    } catch {
      return undefined;
    }
  }

  /** Sequence numbers present in a device's journal, ascending. */
  async listSequences(deviceId: string): Promise<number[]> {
    const entries = await this.client.list(
      `${devicePath(deviceId)}/changes/`
    );
    const sequences: number[] = [];
    for (const entry of entries) {
      if (entry.isCollection) continue;
      const name = this.client.relativePath(entry).split("/").pop();
      if (!name) continue;
      const sequence = parseSequenceFileName(name);
      if (sequence !== undefined) sequences.push(sequence);
    }
    return sequences.sort((a, b) => a - b);
  }

  /**
   * Append one immutable batch to this device's journal. Refuses to
   * overwrite an existing sequence file (If-None-Match), so two processes
   * writing the same sequence cannot silently destroy each other's records.
   */
  async writeBatch(
    syncKey: SerializedKey,
    deviceId: string,
    sequence: number,
    records: SyncRecord[]
  ): Promise<void> {
    const envelope: ChangeBatchEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      sequence,
      cipher: await this.crypto.encryptJson(syncKey, records)
    };
    const body = new TextEncoder().encode(JSON.stringify(envelope));
    const path = changePath(deviceId, sequence);
    await this.client.put(path, body, { ifNoneMatch: true });
    // Verify the remote object before the caller marks anything synced.
    await this.client.verifyUpload(path, body.length);
  }

  async readBatch(
    syncKey: SerializedKey,
    deviceId: string,
    sequence: number
  ): Promise<SyncRecord[]> {
    const raw = await this.client.get(changePath(deviceId, sequence));
    let envelope: ChangeBatchEnvelope;
    try {
      envelope = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new SyncError(
        `Change record ${deviceId}/${sequence} is corrupt (invalid JSON)`,
        "corrupt-data"
      );
    }
    if (envelope.protocolVersion > PROTOCOL_VERSION) {
      throw new SyncError(
        `Change record ${deviceId}/${sequence} uses protocol version ` +
          `${envelope.protocolVersion}, which this app cannot read`,
        "protocol-mismatch"
      );
    }
    if (envelope.deviceId !== deviceId || envelope.sequence !== sequence) {
      throw new SyncError(
        `Change record ${deviceId}/${sequence} has mismatched envelope ` +
          `metadata (${envelope.deviceId}/${envelope.sequence})`,
        "corrupt-data"
      );
    }
    const records = await this.crypto.decryptJson<SyncRecord[]>(
      syncKey,
      envelope.cipher
    );
    if (!Array.isArray(records)) {
      throw new SyncError(
        `Change record ${deviceId}/${sequence} does not contain a record list`,
        "corrupt-data"
      );
    }
    return records;
  }

  /** Store an oversized payload as a content-addressed object. */
  async putObject(
    syncKey: SerializedKey,
    data: Uint8Array
  ): Promise<string> {
    const hash = await this.crypto.contentAddress(syncKey, data);
    const path = objectPath(hash);
    if (await this.client.exists(path)) return hash; // deduplicated
    const cipher = await this.crypto.encryptBytes(syncKey, data);
    const body = new TextEncoder().encode(JSON.stringify(cipher));
    await this.client.put(path, body);
    await this.client.verifyUpload(path, body.length);
    return hash;
  }

  async getObject(
    syncKey: SerializedKey,
    hash: string
  ): Promise<Uint8Array> {
    const raw = await this.client.get(objectPath(hash));
    const cipher = JSON.parse(new TextDecoder().decode(raw));
    const data = await this.crypto.decryptBytes(syncKey, cipher);
    const actual = await this.crypto.contentAddress(syncKey, data);
    if (actual !== hash) {
      throw new SyncError(
        `Integrity check failed for object ${hash}`,
        "corrupt-data"
      );
    }
    return data;
  }
}
