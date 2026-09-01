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

import { ManifestEntry, SideState } from "./types.ts";

/**
 * What to do with one note, given local state, the remembered merge base, and
 * remote state.
 *
 * THE ONE RULE
 *
 * Never silently discard user content. Every branch below that could lose an
 * edit produces a conflict instead, and a conflict keeps both sides.
 *
 * WHY THREE-WAY AND NOT LAST-WRITE-WINS
 *
 * Timestamps across devices are not comparable — clocks drift, Drive reports
 * server time, a phone may be hours off — so "newest wins" silently destroys
 * work. Comparing both sides against the base they were last equal at asks a
 * question that does not depend on any clock: did *this* side move?
 */
export type FileSyncAction =
  /** Neither side moved. */
  | { action: "none" }
  /** Local moved, remote did not: upload. */
  | { action: "push" }
  /** Remote moved, local did not: download and apply. */
  | { action: "pull" }
  /** Never synced and only local has it: first upload. */
  | { action: "create" }
  /** Never synced and only remote has it: import. */
  | { action: "adopt" }
  /** Remote is gone and local is unchanged: delete locally. */
  | { action: "delete-local" }
  /** Local is gone and remote is unchanged: delete remotely. */
  | { action: "delete-remote" }
  /** Both moved, or one deleted while the other edited. Keep both. */
  | { action: "conflict"; reason: ConflictReason };

export type ConflictReason =
  | "both-edited"
  | "deleted-remotely-edited-locally"
  | "deleted-locally-edited-remotely"
  | "untracked-both-sides";

/**
 * Has the remote moved since we last saw it?
 *
 * Version is preferred — it is what the backend itself considers a change, and
 * it is cheap, since listing returns it. Some backends report no version for
 * some objects, so a hash of the bytes is the fallback. When neither is
 * available we must assume it moved: claiming "unchanged" without evidence is
 * how an overwrite happens.
 */
function remoteMoved(base: ManifestEntry, remote: SideState): boolean {
  if (remote.version !== undefined && base.baseRemoteVersion !== undefined) {
    return remote.version !== base.baseRemoteVersion;
  }
  if (remote.hash !== undefined && base.baseRemoteHash !== undefined) {
    return remote.hash !== base.baseRemoteHash;
  }
  return true;
}

export function resolveFileSync(
  local: SideState | undefined,
  base: ManifestEntry | undefined,
  remote: SideState | undefined,
): FileSyncAction {
  // ---- Never synced before -------------------------------------------
  if (!base) {
    if (local && !remote) return { action: "create" };
    if (!local && remote) return { action: "adopt" };
    if (!local && !remote) return { action: "none" };
    // Both sides have a file we have never reconciled. Identical content is
    // the common case — two devices exported the same note — and adopting it
    // simply records the base. Differing content is a real collision.
    if (local!.hash !== undefined && local!.hash === remote!.hash) {
      return { action: "adopt" };
    }
    return { action: "conflict", reason: "untracked-both-sides" };
  }

  const localGone = !local;
  const remoteGone = !remote;
  const localMoved = localGone || local.hash !== base.baseHash;

  // ---- Both sides deleted --------------------------------------------
  if (localGone && remoteGone) return { action: "none" };

  // ---- Remote deleted -------------------------------------------------
  if (remoteGone) {
    // A local edit outranks someone else's delete: the edit is work that
    // exists nowhere else, the delete is reproducible.
    if (localMoved) {
      return { action: "conflict", reason: "deleted-remotely-edited-locally" };
    }
    return { action: "delete-local" };
  }

  // ---- Local deleted --------------------------------------------------
  if (localGone) {
    if (remoteMoved(base, remote)) {
      return { action: "conflict", reason: "deleted-locally-edited-remotely" };
    }
    return { action: "delete-remote" };
  }

  // ---- Both present ---------------------------------------------------
  const movedRemotely = remoteMoved(base, remote);

  if (!localMoved && !movedRemotely) return { action: "none" };
  if (localMoved && !movedRemotely) return { action: "push" };
  if (!localMoved && movedRemotely) return { action: "pull" };

  // Both moved. If they moved to the *same* content, there is nothing to
  // reconcile — two devices made the same edit, or one already applied the
  // other's. Recording the new base is enough.
  if (
    local.hash !== undefined && remote.hash !== undefined &&
    local.hash === remote.hash
  ) {
    return { action: "none" };
  }

  return { action: "conflict", reason: "both-edited" };
}
