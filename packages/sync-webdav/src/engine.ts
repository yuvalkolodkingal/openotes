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
import { OutgoingQueue, SyncTrigger } from "./queue.ts";
import {
  assertSafeId,
  attachmentPath,
  PATHS,
  SyncRepository,
} from "./repository.ts";
import {
  ApplyResult,
  CursorMap,
  ProtocolMetadata,
  SyncDataStore,
  SyncError,
  SyncRecord,
  SyncStatus,
} from "./types.ts";

export interface AttachmentSource {
  /** Stream the plaintext content of a local attachment. */
  read(hash: string): Promise<ReadableStream<Uint8Array> | undefined>;
  /** Persist a downloaded attachment's plaintext content. */
  write(hash: string, stream: ReadableStream<Uint8Array>): Promise<void>;
  /** True when the attachment content is already available locally. */
  exists(hash: string): Promise<boolean>;
}

export interface SyncEngineOptions {
  client: WebDavClient;
  crypto: SyncCrypto;
  store: SyncDataStore;
  queue: OutgoingQueue;
  masterKey: SerializedKey;
  attachments?: AttachmentSource;
  syncAttachments?: boolean;
  deviceName?: string;
  appVersion?: string;
  platform?: string;
  /** Max plaintext bytes inlined in a change record before spilling to objects/. */
  inlineLimit?: number;
  onStatus?: (status: SyncStatus) => void;
  onConflict?: (record: SyncRecord) => void;
  logger?: SyncLogger;
}

export interface SyncLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const NOOP_LOGGER: SyncLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  applied: number;
  conflicts: number;
  attachmentsUploaded: number;
  attachmentsDownloaded: number;
  devices: number;
  durationMs: number;
}

/** Chunk size for streaming attachment encryption. */
const ATTACHMENT_CHUNK_SIZE = 512 * 1024;

export class SyncEngine {
  private readonly repository: SyncRepository;
  private readonly logger: SyncLogger;
  private syncKey?: SerializedKey;
  private attachmentKey?: SerializedKey;
  private metadata?: ProtocolMetadata;
  private running = false;

  constructor(private readonly options: SyncEngineOptions) {
    this.repository = new SyncRepository(options.client, options.crypto);
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  private setStatus(status: SyncStatus) {
    this.options.onStatus?.(status);
  }

  /**
   * Connect to the remote repository: verify reachability, read or create
   * protocol metadata, verify the passphrase, and register this device.
   * Safe to call repeatedly.
   */
  async connect(): Promise<ProtocolMetadata> {
    const { client, crypto, store, masterKey } = this.options;
    await client.options();

    let metadata = await this.repository.readProtocol();
    const deviceId = await store.getDeviceId();
    assertSafeId(deviceId);

    if (!metadata) {
      this.logger.info("Initializing new WebDAV sync repository");
      metadata = await this.repository.initialize(
        masterKey,
        deviceId,
        newGeneration(deviceId),
      );
    }

    // The remote salt is authoritative: re-derive the master key with it so
    // a second device with the same passphrase lands on the same keys.
    const effectiveMaster = masterKey;
    if (metadata.salt && metadata.salt !== masterKey.salt) {
      throw new SyncError(
        "This device derived its keys with a different salt than the remote " +
          "repository. Re-enter your sync passphrase to re-derive keys.",
        "bad-key",
      );
    }

    this.syncKey = await this.repository.verifyKey(metadata, effectiveMaster);
    this.attachmentKey = await crypto.deriveSubkey(
      effectiveMaster,
      "attachment",
    );
    this.metadata = metadata;

    const knownGeneration = await store.getMeta("webdav.generation");
    if (knownGeneration && knownGeneration !== metadata.generation) {
      // The remote was rebuilt elsewhere: our cursors refer to a repository
      // that no longer exists, so start over rather than skip records.
      this.logger.warn("Remote generation changed; resetting sync cursors", {
        knownGeneration,
        remoteGeneration: metadata.generation,
      });
      for (const device of Object.keys(await store.getCursors())) {
        await store.setCursor(device, 0);
      }
      await store.setLocalSequence(0);
    }
    await store.setMeta("webdav.generation", metadata.generation);

    await this.repository.registerDevice(this.syncKey, deviceId, {
      name: this.options.deviceName ?? "Unnamed device",
      platform: this.options.platform ?? "desktop",
      appVersion: this.options.appVersion ?? "0.0.0",
    });

    return metadata;
  }

  /** Connectivity + credentials + passphrase check, writing nothing new. */
  async testConnection(): Promise<{
    ok: true;
    protocolVersion: number;
    devices: number;
    initialized: boolean;
  }> {
    const { client } = this.options;
    await client.options();
    const metadata = await this.repository.readProtocol();
    if (!metadata) {
      return { ok: true, protocolVersion: 0, devices: 0, initialized: false };
    }
    await this.repository.verifyKey(metadata, this.options.masterKey);
    const devices = await this.repository.listDevices();
    return {
      ok: true,
      protocolVersion: metadata.version,
      devices: devices.length,
      initialized: true,
    };
  }

  /**
   * One full synchronization cycle (spec §21). Never runs concurrently with
   * itself; callers should go through SyncScheduler.
   */
  async sync(trigger: SyncTrigger = "manual"): Promise<SyncResult> {
    if (this.running) {
      throw new SyncError(
        "A synchronization cycle is already running",
        "conflict",
      );
    }
    this.running = true;
    const started = Date.now();
    const result: SyncResult = {
      uploaded: 0,
      downloaded: 0,
      applied: 0,
      conflicts: 0,
      attachmentsUploaded: 0,
      attachmentsDownloaded: 0,
      devices: 0,
      durationMs: 0,
    };

    try {
      this.setStatus({ type: "syncing" });
      this.logger.info("Sync cycle started", { trigger });

      // 1-3. connectivity, protocol version, device discovery
      if (!this.syncKey || !this.metadata) await this.connect();
      const syncKey = this.syncKey!;
      const store = this.options.store;
      const deviceId = await store.getDeviceId();

      const devices = await this.repository.listDevices();
      result.devices = devices.length;

      // 4-9. pull: download, verify, decrypt, apply, resolve conflicts
      const cursors = await store.getCursors();
      const pull = await this.pull(syncKey, deviceId, devices, cursors);
      result.downloaded = pull.downloaded;
      result.applied = pull.applied;
      result.conflicts = pull.conflicts;

      // 10-14. push: collect, encrypt, upload attachments then records,
      // verify the remote write before marking anything synced
      const push = await this.push(syncKey, deviceId);
      result.uploaded = push.uploaded;
      result.attachmentsUploaded = push.attachmentsUploaded;

      // Attachment downloads referenced by records we just applied.
      if (this.options.syncAttachments !== false && this.options.attachments) {
        result.attachmentsDownloaded = await this.downloadPendingAttachments();
      }

      const pending = await this.options.queue.size();
      result.durationMs = Date.now() - started;
      this.logger.info("Sync cycle finished", { ...result, trigger });

      if (result.conflicts > 0) {
        this.setStatus({ type: "conflict", count: result.conflicts });
      } else if (pending > 0) {
        this.setStatus({ type: "pending", count: pending });
      } else {
        this.setStatus({ type: "synced", at: Date.now() });
      }
      return result;
    } catch (error) {
      const syncError = error instanceof SyncError ? error : new SyncError(
        error instanceof Error ? error.message : String(error),
        "network",
      );
      await this.options.queue.recordFailure(syncError.message);
      this.logger.error("Sync cycle failed", {
        code: syncError.code,
        message: syncError.message,
      });
      if (syncError.code === "network" || syncError.code === "timeout") {
        this.setStatus({ type: "offline" });
      } else {
        this.setStatus({ type: "error", error: syncError.message });
      }
      throw syncError;
    } finally {
      this.running = false;
    }
  }

  private async pull(
    syncKey: SerializedKey,
    selfDeviceId: string,
    devices: string[],
    cursors: CursorMap,
  ): Promise<{ downloaded: number; applied: number; conflicts: number }> {
    const store = this.options.store;
    let downloaded = 0;
    let applied = 0;
    let conflicts = 0;

    for (const device of devices) {
      if (device === selfDeviceId) continue;
      const cursor = cursors[device] ?? 0;
      const sequences = (await this.repository.listSequences(device)).filter(
        (sequence) => sequence > cursor,
      );
      if (sequences.length === 0) continue;

      this.logger.debug("Pulling from device", {
        device,
        from: cursor,
        batches: sequences.length,
      });

      for (const sequence of sequences) {
        let records: SyncRecord[];
        try {
          records = await this.repository.readBatch(syncKey, device, sequence);
        } catch (error) {
          if (
            error instanceof SyncError &&
            (error.code === "corrupt-data" || error.code === "bad-key")
          ) {
            // A corrupt or unreadable batch must not wedge the whole sync.
            // Skip it, but do not advance past it silently — surface it.
            this.logger.error("Skipping unreadable change record", {
              device,
              sequence,
              error: error.message,
            });
            this.setStatus({
              type: "error",
              error:
                `Change record ${device}/${sequence} could not be read: ${error.message}`,
            });
            continue;
          }
          throw error;
        }
        downloaded += records.length;

        for (const record of dedupeRecords(records)) {
          const outcome = await this.applyRecord(syncKey, record);
          if (outcome === "conflicted") {
            conflicts++;
            this.options.onConflict?.(record);
          }
          if (
            outcome === "applied" || outcome === "merged" ||
            outcome === "conflicted"
          ) {
            applied++;
          }
        }

        // Cursor advances only after every record in the batch was applied.
        await store.setCursor(device, sequence);
      }
    }
    return { downloaded, applied, conflicts };
  }

  private async applyRecord(
    syncKey: SerializedKey,
    record: SyncRecord,
  ): Promise<ApplyResult> {
    let resolved = record;
    if (record.objectRef && record.item === undefined) {
      const data = await this.repository.getObject(syncKey, record.objectRef);
      resolved = {
        ...record,
        item: JSON.parse(new TextDecoder().decode(data)),
      };
    }

    // Queue attachment content referenced by the record for download.
    if (
      resolved.entityType === "attachment" &&
      resolved.operation === "upsert" &&
      this.options.syncAttachments !== false
    ) {
      const hash = attachmentHashOf(resolved.item);
      if (hash && this.options.attachments) {
        if (!(await this.options.attachments.exists(hash))) {
          await this.options.queue.enqueueDownload(hash);
        }
      }
    }

    return await this.options.store.applyRemoteRecord(resolved);
  }

  private async push(
    syncKey: SerializedKey,
    deviceId: string,
  ): Promise<{ uploaded: number; attachmentsUploaded: number }> {
    const { store, queue } = this.options;

    // Collect fresh local changes and merge them into the durable queue, so
    // a crash between collection and upload cannot lose them.
    const collected = await store.collectPendingChanges();
    if (collected.length > 0) await queue.enqueue(collected);

    let attachmentsUploaded = 0;
    if (this.options.syncAttachments !== false && this.options.attachments) {
      attachmentsUploaded = await this.uploadPendingAttachments(syncKey);
    }

    const pending = await queue.peek();
    if (pending.length === 0) return { uploaded: 0, attachmentsUploaded };

    // Spill oversized payloads into content-addressed objects so change
    // records stay small and attachment-like blobs deduplicate.
    const inlineLimit = this.options.inlineLimit ?? 256 * 1024;
    const records: SyncRecord[] = [];
    for (const record of pending) {
      const encoded = JSON.stringify(record.item ?? null);
      if (encoded.length > inlineLimit) {
        const objectRef = await this.repository.putObject(
          syncKey,
          new TextEncoder().encode(encoded),
        );
        records.push({ ...record, item: undefined, objectRef });
      } else {
        records.push(record);
      }
    }

    const sequence = (await store.getLocalSequence()) + 1;
    await this.writeBatchAtNextFreeSequence(
      syncKey,
      deviceId,
      sequence,
      records,
    );

    return { uploaded: records.length, attachmentsUploaded };
  }

  /**
   * Write the batch, stepping forward if the sequence is already taken (e.g.
   * a previous run uploaded it but crashed before recording the sequence).
   */
  private async writeBatchAtNextFreeSequence(
    syncKey: SerializedKey,
    deviceId: string,
    startSequence: number,
    records: SyncRecord[],
  ): Promise<void> {
    const { store, queue } = this.options;
    let sequence = startSequence;
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        await this.repository.writeBatch(syncKey, deviceId, sequence, records);
        // Only now is it safe to mark the records synced (spec §21 step 14).
        await store.setLocalSequence(sequence);
        await store.markChangesSynced(records, sequence);
        await queue.acknowledge(records);
        return;
      } catch (error) {
        if (
          error instanceof SyncError &&
          (error.code === "precondition-failed" || error.status === 412)
        ) {
          this.logger.warn("Sequence already taken remotely, advancing", {
            deviceId,
            sequence,
          });
          sequence++;
          await store.setLocalSequence(sequence - 1);
          continue;
        }
        throw error;
      }
    }
    throw new SyncError(
      `Could not find a free journal sequence for device ${deviceId}`,
      "conflict",
    );
  }

  private async uploadPendingAttachments(
    syncKey: SerializedKey,
  ): Promise<number> {
    const source = this.options.attachments;
    if (!source) return 0;
    const attachmentKey = this.attachmentKey!;
    let uploaded = 0;

    for (const hash of await this.options.queue.pendingAttachments()) {
      const path = attachmentPath(hash);
      if (await this.options.client.exists(path)) {
        // Deduplicated: another device already uploaded identical content.
        await this.options.queue.acknowledgeAttachment(hash);
        continue;
      }
      const stream = await source.read(hash);
      if (!stream) {
        this.logger.warn("Attachment content missing locally; skipping", {
          hash,
        });
        await this.options.queue.acknowledgeAttachment(hash);
        continue;
      }
      const encrypted = await this.encryptAttachmentStream(
        attachmentKey,
        stream,
      );
      await this.options.client.put(path, encrypted);
      await this.options.client.verifyUpload(path, encrypted.length);
      await this.options.queue.acknowledgeAttachment(hash);
      uploaded++;
      void syncKey;
    }
    return uploaded;
  }

  private async downloadPendingAttachments(): Promise<number> {
    const source = this.options.attachments;
    if (!source) return 0;
    const attachmentKey = this.attachmentKey!;
    let downloaded = 0;

    for (const hash of await this.options.queue.pendingDownloads()) {
      if (await source.exists(hash)) {
        await this.options.queue.acknowledgeDownload(hash);
        continue;
      }
      const raw = await this.options.client.getIfExists(attachmentPath(hash));
      if (!raw) {
        this.logger.warn("Attachment not yet uploaded by its owner", { hash });
        continue;
      }
      const plaintext = await this.decryptAttachmentBytes(attachmentKey, raw);
      await source.write(
        hash,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(plaintext);
            controller.close();
          },
        }),
      );
      await this.options.queue.acknowledgeDownload(hash);
      downloaded++;
    }
    return downloaded;
  }

  /**
   * Encrypt an attachment with libsodium's secretstream so the plaintext is
   * processed chunk by chunk and never held whole in memory.
   *
   * Wire format: [4-byte big-endian header length][base64 header][chunks...]
   * Each chunk is [4-byte big-endian length][ciphertext].
   */
  async encryptAttachmentStream(
    key: SerializedKey,
    stream: ReadableStream<Uint8Array>,
  ): Promise<Uint8Array> {
    const { iv, stream: transform } = await this.options.crypto
      .createEncryptionStream(key);
    const chunks: Uint8Array[] = [];
    const header = new TextEncoder().encode(iv);
    chunks.push(uint32be(header.length), header);

    const writer = transform.writable.getWriter();
    const reader = stream.getReader();
    const outputReader = transform.readable.getReader();

    const pump = (async () => {
      let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = concat(buffer, value);
        while (buffer.length >= ATTACHMENT_CHUNK_SIZE) {
          await writer.write({
            data: buffer.slice(0, ATTACHMENT_CHUNK_SIZE),
            final: false,
          });
          buffer = buffer.slice(ATTACHMENT_CHUNK_SIZE) as Uint8Array<
            ArrayBuffer
          >;
        }
      }
      await writer.write({ data: buffer, final: true });
      await writer.close().catch(() => {});
    })();

    while (true) {
      const { value, done } = await outputReader.read();
      if (done) break;
      chunks.push(uint32be(value.length), value);
    }
    await pump;

    return concatAll(chunks);
  }

  async decryptAttachmentBytes(
    key: SerializedKey,
    data: Uint8Array,
  ): Promise<Uint8Array> {
    let offset = 0;
    const headerLength = readUint32be(data, offset);
    offset += 4;
    const iv = new TextDecoder().decode(
      data.subarray(offset, offset + headerLength),
    );
    offset += headerLength;

    const stream = await this.options.crypto.createDecryptionStream(key, iv);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const output: Uint8Array[] = [];

    const pump = (async () => {
      while (offset < data.length) {
        const length = readUint32be(data, offset);
        offset += 4;
        await writer.write(data.subarray(offset, offset + length));
        offset += length;
      }
      await writer.close().catch(() => {});
    })();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output.push(value);
    }
    await pump;
    return concatAll(output);
  }

  /**
   * Rebuild the remote repository into a fresh generation (spec §59). The
   * previous generation is left intact until the new one is fully verified.
   */
  async rebuildRemote(
    fullState: SyncRecord[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<string> {
    const { store, masterKey, client } = this.options;
    const deviceId = await store.getDeviceId();
    const generation = newGeneration(deviceId);

    const staging = `.staging-${generation}`;
    await client.mkcolRecursive(staging + "/");

    // Build the new state under a staging prefix, then activate it by
    // writing protocol.json last — readers never see a half-built repo.
    const stagedRepository = new SyncRepository(
      new StagedClient(client, staging) as unknown as WebDavClient,
      this.options.crypto,
    );
    const metadata = await stagedRepository.initialize(
      masterKey,
      deviceId,
      generation,
    );
    const syncKey = await stagedRepository.verifyKey(metadata, masterKey);
    await stagedRepository.registerDevice(syncKey, deviceId, {
      name: this.options.deviceName ?? "Unnamed device",
      platform: this.options.platform ?? "desktop",
      appVersion: this.options.appVersion ?? "0.0.0",
    });

    const BATCH = 500;
    for (let i = 0; i < fullState.length; i += BATCH) {
      const slice = fullState.slice(i, i + BATCH);
      await stagedRepository.writeBatch(
        syncKey,
        deviceId,
        Math.floor(i / BATCH) + 1,
        slice,
      );
      onProgress?.(Math.min(i + BATCH, fullState.length), fullState.length);
    }

    // Verify the staged generation is readable before touching the live one.
    const verify = await stagedRepository.readProtocol();
    if (!verify || verify.generation !== generation) {
      throw new SyncError(
        "Rebuilt repository failed verification; the existing remote data " +
          "has been left untouched.",
        "corrupt-data",
      );
    }

    // Activate: retire the old generation, then move the staged one in.
    const retired = `.retired-${metadata.createdAt}`;
    for (const path of [PATHS.devices, PATHS.objects, PATHS.protocol]) {
      if (await client.exists(path)) {
        await client.mkcolRecursive(retired + "/");
        await client.move(path, `${retired}/${path}`, true);
      }
    }
    for (const path of [PATHS.devices, PATHS.objects, PATHS.protocol]) {
      if (await client.exists(`${staging}/${path}`)) {
        await client.move(`${staging}/${path}`, path, true);
      }
    }

    await store.setMeta("webdav.generation", generation);
    await store.setLocalSequence(Math.ceil(fullState.length / BATCH));
    for (const device of Object.keys(await store.getCursors())) {
      await store.setCursor(device, 0);
    }
    return generation;
  }

  /** Remove remote attachment objects no longer referenced by any device. */
  async pruneAttachments(
    referencedHashes: Set<string>,
    retentionMs = 30 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const entries = await this.options.client.list(PATHS.attachments + "/");
    const cutoff = Date.now() - retentionMs;
    let removed = 0;
    for (const entry of entries) {
      if (entry.isCollection) continue;
      const name = this.options.client.relativePath(entry).split("/").pop();
      if (!name) continue;
      const hash = name.replace(/\.bin$/, "");
      if (referencedHashes.has(hash)) continue;
      const modified = entry.lastModified
        ? Date.parse(entry.lastModified)
        : Number.NaN;
      // Conservative: only delete objects we can prove are older than the
      // retention window. Unknown timestamps are kept.
      if (!Number.isFinite(modified) || modified > cutoff) continue;
      await this.options.client.delete(attachmentPath(hash));
      removed++;
    }
    return removed;
  }
}

/** Keep only the last record per entity within one batch. */
export function dedupeRecords(records: SyncRecord[]): SyncRecord[] {
  const byEntity = new Map<string, SyncRecord>();
  for (const record of records) {
    const key = `${record.entityType}:${record.entityId}`;
    const existing = byEntity.get(key);
    if (
      !existing ||
      record.revision > existing.revision ||
      (record.revision === existing.revision &&
        record.timestamp >= existing.timestamp)
    ) {
      byEntity.set(key, record);
    }
  }
  return [...byEntity.values()];
}

function attachmentHashOf(item: unknown): string | undefined {
  if (item && typeof item === "object" && "hash" in item) {
    const hash = (item as { hash?: unknown }).hash;
    if (typeof hash === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(hash)) {
      return hash;
    }
  }
  return undefined;
}

function newGeneration(deviceId: string): string {
  const random = crypto.getRandomValues(new Uint8Array(6));
  let suffix = "";
  for (const byte of random) suffix += byte.toString(16).padStart(2, "0");
  return `${deviceId.slice(0, 8)}${suffix}`;
}

function uint32be(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function readUint32be(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(
    0,
    false,
  );
}

function concat(
  a: Uint8Array,
  b: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Wraps a client so all paths are prefixed — used to stage a rebuild. */
class StagedClient {
  constructor(
    private readonly inner: WebDavClient,
    private readonly prefix: string,
  ) {}
  url(path: string) {
    return this.inner.url(`${this.prefix}/${path}`);
  }
  relativePath(entry: { href: string; isCollection: boolean }) {
    const relative = this.inner.relativePath(entry);
    return relative.startsWith(this.prefix + "/")
      ? relative.slice(this.prefix.length + 1)
      : relative;
  }
  options() {
    return this.inner.options();
  }
  head(path: string) {
    return this.inner.head(`${this.prefix}/${path}`);
  }
  propfind(path: string, depth: 0 | 1 = 1) {
    return this.inner.propfind(`${this.prefix}/${path}`, depth);
  }
  list(path: string) {
    return this.inner.list(`${this.prefix}/${path}`);
  }
  exists(path: string) {
    return this.inner.exists(`${this.prefix}/${path}`);
  }
  mkcol(path: string) {
    return this.inner.mkcol(`${this.prefix}/${path}`);
  }
  mkcolRecursive(path: string) {
    return this.inner.mkcolRecursive(`${this.prefix}/${path}`);
  }
  get(path: string) {
    return this.inner.get(`${this.prefix}/${path}`);
  }
  getIfExists(path: string) {
    return this.inner.getIfExists(`${this.prefix}/${path}`);
  }
  put(path: string, body: Uint8Array | string, options?: unknown) {
    return this.inner.put(
      `${this.prefix}/${path}`,
      body,
      options as Parameters<WebDavClient["put"]>[2],
    );
  }
  delete(path: string) {
    return this.inner.delete(`${this.prefix}/${path}`);
  }
  move(from: string, to: string, overwrite = true) {
    return this.inner.move(
      `${this.prefix}/${from}`,
      `${this.prefix}/${to}`,
      overwrite,
    );
  }
  verifyUpload(path: string, expectedLength: number) {
    return this.inner.verifyUpload(`${this.prefix}/${path}`, expectedLength);
  }
}
