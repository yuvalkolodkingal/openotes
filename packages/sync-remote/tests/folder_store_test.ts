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

/**
 * FolderStore against a real directory: the shared conformance suite, plus
 * the three things only a filesystem backend can get wrong — its own
 * in-flight writes showing up as content, a symbolic link planted by
 * whoever else writes to a shared folder, and the folder disappearing
 * mid-session.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { FolderStore } from "../src/folder-store.ts";
import { SyncError } from "../src/types.ts";
import { runStoreConformance } from "./conformance.ts";

runStoreConformance("FolderStore", async () => {
  const root = await Deno.makeTempDir({ prefix: "openotes-folder-store-" });
  return {
    // "immediate": a temp directory is a plain local disk, and the grace
    // periods an "eventual" folder declares would only make the suite wait
    // for a drive client that is not there.
    store: new FolderStore({ root, consistency: "immediate" }),
    dispose: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
});

Deno.test("FolderStore: a temp file is not a store entry", async () => {
  await withFolder(async (store, root) => {
    await store.put("real.bin", encoder.encode("real"));
    // Exactly the name put() gives its own half-written file before the
    // rename. A drive client uploads one of these the moment it appears,
    // so a store that listed it would hand another device a truncated
    // journal entry and let it skip the real one.
    await Deno.writeTextFile(
      join(root, ".real.bin.0123456789abcdef.tmp"),
      "half a batch",
    );

    assertEquals(pathsOf(await store.list("")), ["real.bin"]);
  });
});

Deno.test("FolderStore: a symlink is refused, not followed", async () => {
  const outside = await Deno.makeTempDir({ prefix: "openotes-outside-" });
  try {
    const secret = join(outside, "secret.bin");
    await Deno.writeTextFile(secret, "not ours to read");

    await withFolder(async (store, root) => {
      await Deno.symlink(secret, join(root, "link.bin"));

      // A shared Dropbox or NAS folder is written by people who are not
      // us. A link is the one entry whose content lives somewhere the root
      // does not cover, so it is neither listed, read through, nor written
      // through — following one would hand the decryptor a file the user
      // never put in the repository, or scribble over it.
      assertEquals(await store.list(""), []);

      const read = await assertRejects(() => store.get("link.bin"), SyncError);
      assertEquals(read.code, "corrupt-data");

      const written = await assertRejects(
        () => store.put("link.bin", encoder.encode("ours")),
        SyncError,
      );
      assertEquals(written.code, "forbidden");
      assertEquals(await Deno.readTextFile(secret), "not ours to read");

      // The name is still taken, though, and exists() answers the question
      // create() is really asking: is this name free to write to?
      assertEquals(await store.exists("link.bin"), true);
    });
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("FolderStore: a root that vanished is an error", async () => {
  const parent = await Deno.makeTempDir({ prefix: "openotes-folder-mount-" });
  try {
    const root = join(parent, "repository");
    const store = new FolderStore({ root, consistency: "immediate" });
    await store.connect();
    await store.put("kept.bin", encoder.encode("kept"));

    // The share was unmounted, or the stick was pulled. Answering "the
    // repository is empty" here is how a device talks itself into
    // initializing a fresh generation over live data it can no longer see.
    await Deno.remove(root, { recursive: true });

    const error = await assertRejects(() => store.list(""), SyncError);
    assertEquals(error.code, "network");
    assert(error.isRetryable, "a folder that may come back stays retryable");
  } finally {
    await Deno.remove(parent, { recursive: true }).catch(() => {});
  }
});

const encoder = new TextEncoder();

function pathsOf(entries: { path: string }[]): string[] {
  return entries.map((entry) => entry.path).sort();
}

async function withFolder(
  body: (store: FolderStore, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "openotes-folder-store-" });
  try {
    const store = new FolderStore({ root, consistency: "immediate" });
    await store.connect();
    await body(store, root);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}
