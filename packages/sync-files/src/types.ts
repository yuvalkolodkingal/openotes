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

/**
 * Types for file-per-note synchronization.
 *
 * HOW THIS DIFFERS FROM THE JOURNAL
 *
 * The WebDAV engine appends encrypted, immutable batches to per-device
 * journals: nothing is ever rewritten, so "what changed" is a cursor into an
 * append-only log and conflicts are decided by comparing revision numbers.
 *
 * This engine writes one readable Markdown file per note into a folder the
 * user can open in Drive, Dropbox or their phone. Files are *mutable* and
 * anyone — including a person editing in Drive's web UI — can change them. So
 * "what changed" is a three-way comparison against a remembered merge base,
 * and the manifest is what remembers it.
 *
 * The two engines coexist. A WebDAV user keeps the journal; a cloud-drive user
 * gets files. Neither is a migration of the other.
 */

/** What the last successful sync of one note looked like. */
export interface ManifestEntry {
  noteId: string;
  /** Repository-relative path, e.g. "Work/Q3/Meeting notes.md". */
  remotePath: string;
  /**
   * Provider object id, for backends that address by id rather than path
   * (Drive). Absent for path-addressed backends.
   */
  remoteId?: string;
  /**
   * Hash of the rendered note content as last synced. This is the merge base:
   * local content that still hashes to this has not been edited since.
   */
  baseHash: string;
  /**
   * Remote version as last synced — ETag, `rev`, `eTag`, `headRevisionId`.
   * Compared for equality only.
   */
  baseRemoteVersion?: string;
  /**
   * Hash of the remote bytes as last synced. Used only when a backend cannot
   * supply a version, so equality still means something.
   */
  baseRemoteHash?: string;
  lastSyncedAt: number;
}

/**
 * Per-device sync state. **Local only — never uploaded.**
 *
 * A merge base is a statement about what *this* device last saw, so it cannot
 * be shared: device A's base for a note is not device B's, and a manifest in
 * the remote folder would need locking and would itself conflict.
 *
 * Nothing is lost by keeping it local, because note identity does not live
 * here — it lives in each file's own front matter `id`. A fresh device with no
 * manifest reads the folder, finds the ids, and binds them to notes. That is
 * also what makes the folder survive being moved, copied or restored from a
 * backup by hand.
 */
export interface Manifest {
  version: 1;
  /** Which device this state belongs to. */
  deviceId: string;
  /** Opaque provider delta cursor. Persisted verbatim. */
  cursor?: string;
  /** Keyed by note id. */
  notes: Record<string, ManifestEntry>;
}

export function emptyManifest(deviceId: string): Manifest {
  return { version: 1, deviceId, notes: {} };
}

/** One side of the three-way comparison. Absent means "not there". */
export interface SideState {
  hash?: string;
  /** Remote only. */
  version?: string;
}

/**
 * A note as the renderer handed it over: already converted to Markdown,
 * already assigned a path, already checked against the vault.
 *
 * The host never renders a note itself — the export machinery needs the
 * renderer's database singleton — so these arrive over RPC.
 */
export interface RenderedNote {
  noteId: string;
  /** Repository-relative path including the .md extension. */
  path: string;
  /** UTF-8 Markdown with YAML front matter. */
  content: Uint8Array;
  /** Note's own modified time, for setting file mtime where supported. */
  modifiedAt?: number;
}

/** A note the engine pulled and the renderer must apply. */
export interface IncomingNote {
  /** Present when front matter carried an id; absent for a foreign file. */
  noteId?: string;
  path: string;
  content: Uint8Array;
  /** Set when this arrived as the losing half of a conflict. */
  conflictOf?: string;
}
