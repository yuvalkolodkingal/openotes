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

import { ConflictDecision } from "@notesnook/sync-core";
import { SyncRecord } from "./types.ts";

// The decision union and the conflict-copy title are shared with the file
// engine; only the revision-based *detection* below is specific to journals.
export { type ConflictDecision, conflictTitle } from "@notesnook/sync-core";

/**
 * Conflict policy (spec §22). The single rule that outranks everything else
 * here: *never silently discard user content*. When two devices edited the
 * same note in ways that cannot be merged, both versions survive — one as
 * the note, one as a conflict copy the user is told about.
 */

export interface LocalItemState {
  /** Local revision counter for the entity. */
  revision: number;
  /** Local last-modified time (ms). */
  dateModified: number;
  /** True when the local item has unsynced modifications. */
  dirty: boolean;
  /** True when the item is locally deleted (tombstone present). */
  deleted: boolean;
  /** Content fingerprint used to detect "same edit applied twice". */
  contentHash?: string;
}

/**
 * Decide what to do with one incoming remote record given local state.
 *
 * Ordering rules:
 *  1. A delete always wins over an *older* update — tombstones are sticky, a
 *     stale device cannot resurrect a deleted item just because it still has
 *     an old copy (spec §22).
 *  2. If the local item is clean (no unsynced edits), the remote version is
 *     simply applied — newer revision wins, equal revision is a no-op.
 *  3. If the local item is dirty and the remote content differs, we do NOT
 *     pick a winner: a conflict copy is created and the user is notified.
 */
export function resolveConflict(
  record: SyncRecord,
  local: LocalItemState | undefined,
): ConflictDecision {
  // Item does not exist locally.
  if (!local) {
    if (record.operation === "delete") {
      // Record the tombstone anyway so a later stale update cannot recreate it.
      return { action: "apply-tombstone" };
    }
    return { action: "apply-remote" };
  }

  if (record.operation === "delete") {
    if (local.dirty && !local.deleted) {
      // The user edited locally while another device deleted the item.
      // Preserve their work rather than honouring the delete blindly.
      return {
        action: "create-conflict-copy",
        reason: "deleted-remotely-edited-locally",
      };
    }
    return { action: "apply-tombstone" };
  }

  // Remote wants to (re)create/update an item we deleted locally.
  if (local.deleted) {
    // Only a strictly newer revision may resurrect a deleted item; a stale
    // device replaying an old copy must not.
    if (record.revision > local.revision) return { action: "apply-remote" };
    return { action: "ignore-stale-resurrect" };
  }

  if (record.revision < local.revision) return { action: "keep-local" };

  if (record.revision === local.revision) {
    // Same revision: identical content is a no-op, differing content means
    // two devices independently produced the same revision number.
    if (
      local.contentHash &&
      record.item &&
      local.contentHash === contentHashOf(record.item)
    ) {
      return { action: "keep-local" };
    }
    if (!local.dirty) return { action: "apply-remote" };
    return { action: "create-conflict-copy", reason: "same-revision-diverged" };
  }

  // record.revision > local.revision
  if (!local.dirty) return { action: "apply-remote" };

  if (
    local.contentHash &&
    record.item &&
    local.contentHash === contentHashOf(record.item)
  ) {
    // Our unsynced edit happens to match the remote one exactly.
    return { action: "apply-remote" };
  }

  return { action: "create-conflict-copy", reason: "concurrent-edit" };
}

/**
 * Non-cryptographic fingerprint used only for "is this the same content"
 * comparisons in conflict detection. FNV-1a over the stable JSON encoding.
 */
export function contentHashOf(item: unknown): string {
  const json = stableStringify(item);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** JSON.stringify with deterministic key ordering and volatile keys dropped. */
export function stableStringify(
  value: unknown,
  skipKeys: string[] = ["dateModified", "dateEdited", "synced", "remote"],
): string {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input as object)) return "[circular]";
    seen.add(input as object);
    if (Array.isArray(input)) return input.map(walk);
    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (skipKeys.includes(key)) continue;
      out[key] = walk(record[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}
