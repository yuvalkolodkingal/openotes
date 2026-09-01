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

import {
  contentHashOfBytes,
  type RemoteEntry,
  type RemoteStorage,
  SyncError,
} from "@notesnook/sync-core";
import { type NoteCodec, PlaintextCodec } from "./codec.ts";
import { ManifestStore } from "./manifest.ts";
import { type FileSyncAction, resolveFileSync } from "./resolve.ts";
import type {
  IncomingNote,
  ManifestEntry,
  RenderedNote,
  SideState,
} from "./types.ts";

export const CONFLICTS_DIR = ".openotes/conflicts";
const RESERVED_PREFIX = ".openotes";

export interface FileSyncOptions {
  storage: RemoteStorage;
  manifest: ManifestStore;
  /**
   * How notes are written. Defaults to readable Markdown; an EncryptedCodec
   * makes the same protocol write opaque bytes under digest filenames.
   */
  codec?: NoteCodec;
  deviceName?: string;
  /** Called for each conflict so the interface can tell the user. */
  onConflict?: (info: ConflictInfo) => void;
  logger?: {
    info(message: string, context?: unknown): void;
    warn(message: string, context?: unknown): void;
  };
}

export interface ConflictInfo {
  noteId?: string;
  path: string;
  conflictPath: string;
  reason: string;
}

export interface FileSyncResult {
  pushed: number;
  pulled: number;
  deletedLocally: number;
  deletedRemotely: number;
  conflicts: number;
  /** Notes the renderer must apply: pulled content and adopted files. */
  incoming: IncomingNote[];
  /** Note ids whose local copy should be moved to trash. */
  removedNoteIds: string[];
}

/**
 * One-file-per-note synchronization against any RemoteStorage.
 *
 * WHAT THIS ENGINE DOES NOT DO
 *
 * It never renders a note and never parses one. Both need the renderer's
 * database, so the renderer hands over `RenderedNote`s and receives
 * `IncomingNote`s back. The engine owns bytes, paths, the merge base, and the
 * decision of what to do — nothing about Markdown or Notesnook's schema.
 */
export class FileSyncEngine {
  private readonly codec: NoteCodec;

  constructor(private readonly options: FileSyncOptions) {
    this.codec = options.codec ?? new PlaintextCodec();
  }

  private get log() {
    return this.options.logger ?? { info: () => {}, warn: () => {} };
  }

  /**
   * Run one cycle over the notes the renderer supplied.
   *
   * `local` is every note that should exist remotely, already rendered.
   * `deletedNoteIds` are notes deleted locally since the last cycle — they
   * cannot be inferred from `local`, because a note missing from the list
   * might simply not have been loaded.
   */
  async sync(
    local: RenderedNote[],
    deletedNoteIds: string[] = [],
  ): Promise<FileSyncResult> {
    const { storage, manifest } = this.options;
    await storage.probe();

    const result: FileSyncResult = {
      pushed: 0,
      pulled: 0,
      deletedLocally: 0,
      deletedRemotely: 0,
      conflicts: 0,
      incoming: [],
      removedNoteIds: [],
    };

    const remote = await this.listNotes();
    const localByNote = new Map(local.map((note) => [note.noteId, note]));
    const deleted = new Set(deletedNoteIds);

    // Every note this cycle must consider: known locally, remembered from a
    // previous sync, or discovered in the folder.
    const entries = await manifest.all();
    const considered = new Set<string>([
      ...localByNote.keys(),
      ...entries.map((entry) => entry.noteId),
      ...deleted,
    ]);

    // Remote files we have not matched to a note by the end are either new
    // files a person dropped in the folder, or notes from another device this
    // one has never seen. Both are adopted.
    const unmatched = new Map(remote);

    for (const noteId of considered) {
      const base = await manifest.entry(noteId);
      const localNote = deleted.has(noteId)
        ? undefined
        : localByNote.get(noteId);

      // A note's path can change when it is retitled or moved between
      // notebooks; the base remembers where it used to live.
      const path = localNote?.path ?? base?.remotePath;
      if (!path) continue;

      let remoteEntry = base?.remotePath
        ? remote.get(base.remotePath) ?? remote.get(path)
        : remote.get(path);

      // A retitle or a move between notebooks changes the path without
      // changing a byte of content. Rename the remote file *first*, so the
      // comparison below sees one file at one path. Doing it afterwards --
      // conditioned on the action -- meant a pure rename compared equal,
      // decided "none", and then deleted the old file without ever writing
      // the new one.
      // Only the readable codec derives a path from the title, so only it can
      // need a rename. Encrypted names are keyed on the note id and never move.
      const wantedPath = localNote
        ? await this.targetPath(noteId, localNote.path)
        : undefined;
      if (
        base && localNote && remoteEntry && wantedPath &&
        base.remotePath !== wantedPath
      ) {
        const previousPath = remoteEntry.path;
        remoteEntry = await this.relocate(remoteEntry, wantedPath, base);
        remote.delete(previousPath);
        // The file no longer lives at the old path, so it must not be left in
        // the unmatched set — adopting it would mean reading a file we just
        // moved away.
        unmatched.delete(previousPath);
        if (remoteEntry) remote.set(remoteEntry.path, remoteEntry);
      }

      if (remoteEntry) unmatched.delete(remoteEntry.path);

      const localSide: SideState | undefined = localNote
        ? { hash: contentHashOfBytes(localNote.content) }
        : undefined;
      const remoteSide = remoteEntry
        ? await this.remoteSideOf(remoteEntry, base)
        : undefined;

      const action = resolveFileSync(localSide, base, remoteSide);
      await this.apply(action, {
        noteId,
        path: localNote?.path ?? path,
        localNote,
        base,
        remoteEntry,
        result,
      });
    }

    // Files in the folder that belong to no note we know about.
    for (const entry of unmatched.values()) {
      const decoded = await this.readNote(entry.path);
      result.incoming.push({ path: decoded.path, content: decoded.content });
      result.pulled++;
      this.log.info("Adopting a file that is not yet a note", {
        path: entry.path,
      });
    }

    await manifest.save();
    return result;
  }

  /**
   * How the remote side looks for comparison.
   *
   * A version alone answers "did it move?" only when we have a version to
   * compare it against. With no base -- a fresh device, or one that lost its
   * manifest -- the only way to know whether the remote copy is the same note
   * is to read it. That costs one GET per untracked file, which is the rare
   * case, and skipping it turned an identical file into a spurious conflict.
   */
  private async remoteSideOf(
    entry: RemoteEntry,
    base: ManifestEntry | undefined,
  ): Promise<SideState> {
    const canCompareVersions = entry.version !== undefined &&
      base?.baseRemoteVersion !== undefined;
    if (base && canCompareVersions) return { version: entry.version };

    // Hash the note, not the stored bytes: encryption is randomised, so
    // ciphertext hashes would never match and every file would look changed.
    const decoded = await this.readNote(entry.path);
    return {
      version: entry.version,
      hash: contentHashOfBytes(decoded.content),
    };
  }

  /** The remote path a note's bytes occupy under the current codec. */
  private targetPath(noteId: string, logicalPath: string): Promise<string> {
    return this.codec.remotePath(noteId, logicalPath);
  }

  /** Read a note's bytes back as its logical path and content. */
  private async readNote(
    remotePath: string,
  ): Promise<{ path: string; content: Uint8Array }> {
    const stored = await this.options.storage.get(remotePath);
    return await this.codec.decode(remotePath, stored);
  }

  /** Every file in the folder this codec claims, excluding our own state. */
  private async listNotes(): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>();
    const walk = async (prefix: string) => {
      const entries = await this.options.storage.list(prefix);
      for (const entry of entries) {
        if (entry.path.startsWith(RESERVED_PREFIX)) continue;
        if (entry.isCollection) {
          await walk(entry.path + "/");
          continue;
        }
        if (!this.codec.claims(entry.path)) continue;
        out.set(entry.path, entry);
      }
    };
    await walk("");
    return out;
  }

  private async apply(
    action: FileSyncAction,
    ctx: {
      noteId: string;
      path: string;
      localNote?: RenderedNote;
      base?: ManifestEntry;
      remoteEntry?: RemoteEntry;
      result: FileSyncResult;
    },
  ): Promise<void> {
    const { storage, manifest } = this.options;
    const { noteId, path, localNote, base, remoteEntry, result } = ctx;

    switch (action.action) {
      case "none":
        return;

      case "create":
      case "push": {
        if (!localNote) return;
        const target = await this.targetPath(noteId, localNote.path);
        const stored = await this.codec.encode(
          localNote.path,
          localNote.content,
        );
        const written = action.action === "create"
          ? await this.createOrAdopt(target, stored)
          : await storage.putUpdate(
            target,
            stored,
            // Only assert a version when the backend gave us one to assert.
            base?.baseRemoteVersion,
          );
        await storage.verifyUpload(target, stored.length);
        await manifest.record({
          noteId,
          remotePath: target,
          baseHash: contentHashOfBytes(localNote.content),
          baseRemoteVersion: written.version,
          // Hashes describe the *note*, not the stored bytes, because
          // encryption is randomised: the same note encrypts differently every
          // time, so hashing ciphertext would report every note as changed.
          baseRemoteHash: contentHashOfBytes(localNote.content),
          lastSyncedAt: Date.now(),
        });
        result.pushed++;
        return;
      }

      case "pull":
      case "adopt": {
        if (!remoteEntry) return;
        const bytes = await storage.get(remoteEntry.path);
        result.incoming.push({
          noteId,
          path: remoteEntry.path,
          content: bytes,
        });
        await manifest.record({
          noteId,
          remotePath: remoteEntry.path,
          baseHash: contentHashOfBytes(bytes),
          baseRemoteVersion: remoteEntry.version,
          baseRemoteHash: contentHashOfBytes(bytes),
          lastSyncedAt: Date.now(),
        });
        result.pulled++;
        return;
      }

      case "delete-local":
        result.removedNoteIds.push(noteId);
        await manifest.forget(noteId);
        result.deletedLocally++;
        return;

      case "delete-remote":
        await storage.delete(base?.remotePath ?? path);
        await manifest.forget(noteId);
        result.deletedRemotely++;
        return;

      case "conflict":
        await this.keepBothSides(action.reason, {
          noteId,
          path,
          localNote,
          remoteEntry,
          result,
        });
        result.conflicts++;
        return;
    }
  }

  /**
   * Both sides survive: the remote version is copied aside under
   * `.openotes/conflicts/`, the local version takes the note's own path, and
   * the user is told. Nothing is overwritten before the copy is verified.
   */
  private async keepBothSides(
    reason: string,
    ctx: {
      noteId: string;
      path: string;
      localNote?: RenderedNote;
      remoteEntry?: RemoteEntry;
      result: FileSyncResult;
    },
  ): Promise<void> {
    const { storage, manifest } = this.options;
    const { noteId, path, localNote, remoteEntry, result } = ctx;

    let conflictPath = "";
    if (remoteEntry) {
      const decoded = await this.readNote(remoteEntry.path);
      conflictPath = conflictFileName(decoded.path, this.options.deviceName);
      const stored = await this.codec.encode(conflictPath, decoded.content);
      await storage.mkdirp(CONFLICTS_DIR + "/");
      await storage.putUpdate(conflictPath, stored);
      await storage.verifyUpload(conflictPath, stored.length);
      // The copy is on the server before anything is overwritten. Surfacing it
      // to the renderer too means the user sees it as a note, not only as a
      // file they would have to go looking for.
      result.incoming.push({
        path: conflictPath,
        content: decoded.content,
        conflictOf: noteId,
      });
    }

    if (localNote) {
      const target = await this.targetPath(noteId, localNote.path);
      const stored = await this.codec.encode(localNote.path, localNote.content);
      const written = await storage.putUpdate(target, stored);
      await storage.verifyUpload(target, stored.length);
      await manifest.record({
        noteId,
        remotePath: target,
        baseHash: contentHashOfBytes(localNote.content),
        baseRemoteVersion: written.version,
        baseRemoteHash: contentHashOfBytes(localNote.content),
        lastSyncedAt: Date.now(),
      });
    } else {
      // Local is gone but the remote moved: keep the remote copy as the note
      // rather than honouring a delete against content we have never seen.
      await manifest.forget(noteId);
    }

    this.options.onConflict?.({ noteId, path, conflictPath, reason });
    this.log.warn("Conflict: both versions kept", { noteId, path, reason });
  }

  /** Create, tolerating a backend that lets a racing writer win. */
  private async createOrAdopt(
    path: string,
    body: Uint8Array,
  ): Promise<RemoteEntry> {
    try {
      return await this.options.storage.putNew(path, body);
    } catch (e) {
      if (e instanceof SyncError && e.code === "precondition-failed") {
        // Someone else created it between our listing and our write. Do not
        // clobber: the next cycle sees it as a normal three-way comparison.
        const existing = await this.options.storage.stat(path);
        if (existing) return existing;
      }
      throw e;
    }
  }

  /**
   * Follow a note that was retitled or moved to another notebook.
   *
   * Returns where the file now lives. On failure the old file is left exactly
   * where it was and the caller carries on with it: a folder with the note
   * under its previous name is a cosmetic problem, losing the file is not.
   */
  private async relocate(
    entry: RemoteEntry,
    to: string,
    base: ManifestEntry,
  ): Promise<RemoteEntry | undefined> {
    const from = entry.path;
    if (from === to) return entry;
    try {
      await this.options.storage.move(from, to, false);
      const moved = await this.options.storage.stat(to);
      base.remotePath = to;
      this.log.info("Note renamed; moved its file", { from, to });
      return moved ?? { ...entry, path: to };
    } catch (e) {
      this.log.warn("Could not move a note's file; keeping the old name", {
        from,
        to,
        error: e instanceof Error ? e.message : String(e),
      });
      return entry;
    }
  }
}

/**
 * `Work/Notes.md` → `.openotes/conflicts/Notes (conflict from Laptop 2026-09-01).md`
 *
 * The name says which device and which day, because "conflicted copy 2" tells
 * a user nothing about which one to keep.
 */
export function conflictFileName(path: string, deviceName?: string): string {
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.md$/i, "");
  const date = new Date().toISOString().slice(0, 10);
  const who = deviceName ? `from ${deviceName} ` : "";
  return `${CONFLICTS_DIR}/${stem} (conflict ${who}${date}).md`;
}
