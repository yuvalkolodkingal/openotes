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

import { assertEquals } from "@std/assert";
import { resolveFileSync } from "../src/resolve.ts";
import type { ManifestEntry, SideState } from "../src/types.ts";

const base = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  noteId: "n1",
  remotePath: "Note.md",
  baseHash: "AAAA",
  baseRemoteVersion: "v1",
  lastSyncedAt: 1,
  ...over,
});

const side = (hash?: string, version?: string): SideState => ({
  hash,
  version,
});

// --------------------------------------------------------------------------
// Never synced
// --------------------------------------------------------------------------

Deno.test("a new local note is created remotely", () => {
  assertEquals(resolveFileSync(side("A"), undefined, undefined), {
    action: "create",
  });
});

Deno.test("a file that only exists remotely is adopted", () => {
  assertEquals(resolveFileSync(undefined, undefined, side("A", "v1")), {
    action: "adopt",
  });
});

Deno.test("nothing anywhere is a no-op", () => {
  assertEquals(resolveFileSync(undefined, undefined, undefined), {
    action: "none",
  });
});

Deno.test("untracked on both sides with identical content just records the base", () => {
  assertEquals(resolveFileSync(side("A"), undefined, side("A", "v1")), {
    action: "adopt",
  });
});

Deno.test("untracked on both sides with different content is a conflict", () => {
  assertEquals(resolveFileSync(side("A"), undefined, side("B", "v1")), {
    action: "conflict",
    reason: "untracked-both-sides",
  });
});

// --------------------------------------------------------------------------
// The ordinary cases
// --------------------------------------------------------------------------

Deno.test("neither side moved", () => {
  assertEquals(resolveFileSync(side("AAAA"), base(), side("x", "v1")), {
    action: "none",
  });
});

Deno.test("local moved alone: push", () => {
  assertEquals(resolveFileSync(side("BBBB"), base(), side("x", "v1")), {
    action: "push",
  });
});

Deno.test("remote moved alone: pull", () => {
  assertEquals(resolveFileSync(side("AAAA"), base(), side("x", "v2")), {
    action: "pull",
  });
});

Deno.test("both moved to different content: conflict", () => {
  assertEquals(resolveFileSync(side("BBBB"), base(), side("CCCC", "v2")), {
    action: "conflict",
    reason: "both-edited",
  });
});

Deno.test("both moved to the SAME content is not a conflict", () => {
  // Two devices made the same edit, or one already applied the other's.
  assertEquals(resolveFileSync(side("BBBB"), base(), side("BBBB", "v2")), {
    action: "none",
  });
});

// --------------------------------------------------------------------------
// Deletes — where content is easiest to lose
// --------------------------------------------------------------------------

Deno.test("remote deleted, local untouched: delete locally", () => {
  assertEquals(resolveFileSync(side("AAAA"), base(), undefined), {
    action: "delete-local",
  });
});

Deno.test("remote deleted but local was edited: the edit wins a conflict", () => {
  assertEquals(resolveFileSync(side("BBBB"), base(), undefined), {
    action: "conflict",
    reason: "deleted-remotely-edited-locally",
  });
});

Deno.test("local deleted, remote untouched: delete remotely", () => {
  assertEquals(resolveFileSync(undefined, base(), side("x", "v1")), {
    action: "delete-remote",
  });
});

Deno.test("local deleted but remote was edited: conflict, not a delete", () => {
  assertEquals(resolveFileSync(undefined, base(), side("x", "v2")), {
    action: "conflict",
    reason: "deleted-locally-edited-remotely",
  });
});

Deno.test("deleted on both sides is a no-op", () => {
  assertEquals(resolveFileSync(undefined, base(), undefined), {
    action: "none",
  });
});

// --------------------------------------------------------------------------
// Evidence, and the absence of it
// --------------------------------------------------------------------------

Deno.test("no version and no hash means we must assume the remote moved", () => {
  // Claiming "unchanged" without evidence is how an overwrite happens.
  assertEquals(
    resolveFileSync(side("AAAA"), base(), side(undefined, undefined)),
    {
      action: "pull",
    },
  );
});

Deno.test("a hash stands in when the backend reports no version", () => {
  const b = base({ baseRemoteVersion: undefined, baseRemoteHash: "RRRR" });
  assertEquals(resolveFileSync(side("AAAA"), b, side("RRRR", undefined)), {
    action: "none",
  });
  assertEquals(resolveFileSync(side("AAAA"), b, side("SSSS", undefined)), {
    action: "pull",
  });
});

Deno.test("a version is preferred over a hash when both are available", () => {
  // Drive rewrites bytes on its own (normalising newlines, say) without the
  // note changing; the version is the backend's own answer and wins.
  const b = base({ baseRemoteVersion: "v1", baseRemoteHash: "RRRR" });
  assertEquals(resolveFileSync(side("AAAA"), b, side("DIFFERENT", "v1")), {
    action: "none",
  });
});

Deno.test("a local edit is never silently dropped in any branch", () => {
  // Sweep every shape where local has moved and assert the action preserves it.
  const preserving = new Set(["push", "conflict", "create"]);
  for (const remote of [undefined, side("x", "v1"), side("y", "v9")]) {
    const action = resolveFileSync(side("EDITED"), base(), remote);
    assertEquals(
      preserving.has(action.action),
      true,
      `local edit lost via "${action.action}" (remote=${
        JSON.stringify(remote)
      })`,
    );
  }
});
