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
 * Vocabulary shared by every sync engine.
 *
 * There are two engines with genuinely different conflict *detection* — the
 * journal compares revisions, the file engine compares content hashes against
 * a merge base — but they must produce the same *decisions*, because one user
 * interface renders both. Keeping the decision union here is what stops the
 * two drifting apart.
 *
 * The rule that outranks everything else in either engine: never silently
 * discard user content. When two devices edited the same note in ways that
 * cannot be merged, both versions survive — one as the note, one as a conflict
 * copy the user is told about.
 */

export type ConflictDecision =
  | { action: "apply-remote" }
  | { action: "keep-local" }
  | { action: "apply-tombstone" }
  | { action: "ignore-stale-resurrect" }
  | { action: "create-conflict-copy"; reason: string };

/**
 * Title for a conflict copy, e.g.
 *   "Shopping List — Conflict from Laptop (2026-08-31)"
 */
export function conflictTitle(
  originalTitle: string,
  deviceName: string,
  timestamp: number,
): string {
  const date = new Date(timestamp).toISOString().slice(0, 10);
  return `${originalTitle} — Conflict from ${deviceName} (${date})`;
}

/**
 * Non-cryptographic fingerprint of a byte range, used only for "is this the
 * same content" comparisons. FNV-1a, matching contentHashOf's algorithm so
 * the two engines produce comparable-looking values.
 *
 * Not a security primitive: an attacker who can choose content can collide it.
 * Nothing here depends on collision resistance — a collision costs a missed
 * conflict copy, not a disclosure.
 */
export function contentHashOfBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
