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
 * The behaviour every RemoteStore must have, as executable assertions.
 *
 * store.ts states the contract in prose. This is the same contract in a
 * form a backend can be held to, so "the new store is finished" means it
 * passes this rather than that it compiles. The engine is never told which
 * store it is driving, so the only thing a backend is allowed to differ on
 * is `capabilities` — everything asserted below has to be true everywhere,
 * and a case that has to be relaxed for one backend belongs in that
 * backend's own test file, not here.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import type { RemoteEntry, RemoteStore } from "../src/store.ts";
import { SyncError } from "../src/types.ts";

/** One store, plus whatever has to be torn down to release it. */
export interface OpenedStore {
  store: RemoteStore;
  dispose(): Promise<void>;
}

/**
 * `open` is called once per test rather than once per suite: these cases
 * assert on whole listings ("the root holds exactly this"), which only
 * means anything when no earlier test has left something behind.
 */
export function runStoreConformance(
  name: string,
  open: () => Promise<OpenedStore>,
): void {
  const behaviour = (
    title: string,
    body: (store: RemoteStore) => Promise<void>,
  ) => {
    Deno.test(`${name}: ${title}`, async () => {
      const opened = await open();
      try {
        // connect() first, always: it is the only state the engine ever
        // uses a store in, and a backend that provisions its root there
        // would otherwise be tested in a state no caller can reach.
        await opened.store.connect();
        await body(opened.store);
      } finally {
        await opened.dispose();
      }
    });
  };

  behaviour("put and get round-trip the exact bytes", async (store) => {
    const hello = bytes("hello");
    await store.put("hello.bin", hello);
    assertEquals(await store.get("hello.bin"), hello);
    assertEquals(await store.exists("hello.bin"), true);

    // Zero bytes is a legitimate object, and it is the one a store that
    // reports "did anything come back?" instead of "was it there?" gets
    // wrong.
    await store.put("empty.bin", new Uint8Array(0));
    assertEquals(await store.get("empty.bin"), new Uint8Array(0));

    // Every payload the protocol writes is ciphertext, so anything that
    // routes content through a string — a text-mode read, a UTF-8 round
    // trip, base64 with the wrong padding — has to fail here.
    await store.put("binary.bin", everyByteValue());
    assertEquals(await store.get("binary.bin"), everyByteValue());

    // put overwrites, which is the whole difference from create.
    await store.put("hello.bin", bytes("replaced"));
    assertEquals(await store.get("hello.bin"), bytes("replaced"));
  });

  behaviour("a path that is not there reads as missing", async (store) => {
    await assertFails("not-found", () => store.get("nothing.bin"));
    await assertFails("not-found", () => store.get("nowhere/nothing.bin"));

    // getIfExists exists so the caller does not have to tell "absent" from
    // "unreachable" by inspecting an error code.
    assertEquals(await store.getIfExists("nothing.bin"), undefined);
    assertEquals(await store.getIfExists("nowhere/nothing.bin"), undefined);
    assertEquals(await store.exists("nothing.bin"), false);
  });

  behaviour("create refuses a taken path untouched", async (store) => {
    const original = bytes("the original batch");
    await store.create("journal.bin", original);
    assertEquals(await store.get("journal.bin"), original);

    await assertFails(
      "precondition-failed",
      () => store.create("journal.bin", bytes("clobbered")),
    );
    // A create that overwrites and then reports failure is worse than one
    // that never ran: the caller retries at the next sequence number and
    // the batch that was already there is gone for good.
    assertEquals(await store.get("journal.bin"), original);
  });

  behaviour("two concurrent creates leave one winner", async (store) => {
    const first = bytes("first writer");
    const second = bytes("second writer");
    const results = await Promise.allSettled([
      store.create("contested.bin", first),
      store.create("contested.bin", second),
    ]);

    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
      "exactly one of two racing creates may succeed",
    );
    const rejection = results.find((result) => result.status === "rejected");
    assert(rejection?.status === "rejected");
    const reason: unknown = rejection.reason;
    assert(reason instanceof SyncError, `not a SyncError: ${reason}`);
    assertEquals(reason.code, "precondition-failed");

    // The surviving bytes are one writer's, whole. Two creates interleaving
    // into one file is how a journal entry decrypts to garbage on every
    // other device.
    assertEquals(
      await store.get("contested.bin"),
      results[0].status === "fulfilled" ? first : second,
    );
  });

  behaviour("list gives immediate children, marked", async (store) => {
    await store.makeDirectory("tree/nested");
    await store.put("tree/one.bin", bytes("one"));
    await store.put("tree/two.bin", bytes("two"));
    await store.put("tree/nested/three.bin", bytes("three"));

    // Both spellings: the protocol builds directory paths with and without
    // the trailing slash, and they have to name the same directory.
    for (const path of ["tree", "tree/"]) {
      const entries = await store.list(path);
      // Nothing from the level below, and not the directory itself — a
      // self entry reaching moveRecursive sends it into the same directory
      // forever.
      assertEquals(pathsOf(entries), [
        "tree/nested",
        "tree/one.bin",
        "tree/two.bin",
      ]);

      const byPath = new Map(entries.map((entry) => [entry.path, entry]));
      assertEquals(byPath.get("tree/nested")?.isDirectory, true);
      assertEquals(byPath.get("tree/one.bin")?.isDirectory, false);
      // size is optional in the interface, but a store that reports one is
      // reporting it to callers that decide what to download by it.
      const one = byPath.get("tree/one.bin");
      if (one?.size !== undefined) assertEquals(one.size, 3);
    }

    const root = await store.list("");
    assertEquals(pathsOf(root), ["tree"]);
    assertEquals(root[0].isDirectory, true);
  });

  behaviour("a directory that is not there lists empty", async (store) => {
    // Every device starts by listing directories another device has not
    // created yet, so this is the common path and not an edge case.
    assertEquals(await store.list("absent"), []);
    assertEquals(await store.list("absent/deeper/"), []);
  });

  behaviour("delete is idempotent", async (store) => {
    await store.put("doomed.bin", bytes("doomed"));
    await store.delete("doomed.bin");
    assertEquals(await store.exists("doomed.bin"), false);

    // Every retry of a cleanup that half succeeded ends here, so removing
    // what is already gone cannot be an error.
    await store.delete("doomed.bin");
    await store.delete("never-existed.bin");
    await store.delete("absent/never-existed.bin");
  });

  behaviour("makeDirectory fills in parents, repeatably", async (store) => {
    await store.makeDirectory("a/b/c");
    assertEquals(pathsOf(await store.list("a")), ["a/b"]);
    assertEquals(pathsOf(await store.list("a/b")), ["a/b/c"]);
    assertEquals((await store.list("a/b"))[0].isDirectory, true);

    // The engine calls this on every sync for directories that already
    // exist rather than checking first.
    await store.makeDirectory("a/b/c");
    await store.makeDirectory("a/b/c/");
    assertEquals(pathsOf(await store.list("a/b")), ["a/b/c"]);
  });

  behaviour("move renames one file", async (store) => {
    await store.makeDirectory("box");
    const cargo = bytes("cargo");
    await store.put("box/before.bin", cargo);

    await store.move("box/before.bin", "box/after.bin");
    assertEquals(await store.get("box/after.bin"), cargo);
    assertEquals(await store.getIfExists("box/before.bin"), undefined);
    assertEquals(pathsOf(await store.list("box")), ["box/after.bin"]);
  });

  behaviour("moveRecursive moves a whole subtree", async (store) => {
    await store.makeDirectory("from/sub/deeper");
    await store.put("from/top.bin", bytes("top"));
    await store.put("from/sub/middle.bin", bytes("middle"));
    await store.put("from/sub/deeper/bottom.bin", bytes("bottom"));

    await store.moveRecursive("from", "to");

    // Nesting is the part that separates a real subtree move from a copy
    // of the top level: getting it wrong writes a directory listing into a
    // file named after the directory.
    assertEquals(await store.get("to/top.bin"), bytes("top"));
    assertEquals(await store.get("to/sub/middle.bin"), bytes("middle"));
    assertEquals(await store.get("to/sub/deeper/bottom.bin"), bytes("bottom"));
    assertEquals(pathsOf(await store.list("to")), ["to/sub", "to/top.bin"]);

    // The source has to be gone, not merely emptied: a rebuild swaps a
    // staged generation into place with this, and a surviving copy of the
    // old one is a second repository for the next device to find.
    assertEquals(await store.list("from"), []);
    assertEquals(await store.exists("from/top.bin"), false);
    assertEquals(await store.getIfExists("from/sub/middle.bin"), undefined);
  });

  behaviour("verifyUpload checks the length that landed", async (store) => {
    await store.put("upload.bin", bytes("12345"));
    await store.verifyUpload("upload.bin", 5);

    // Nothing is marked synchronized until this passes, so a short write
    // has to be caught here rather than one device later.
    await assertFails(
      "corrupt-data",
      () => store.verifyUpload("upload.bin", 4),
    );
    await assertFails("corrupt-data", () => store.verifyUpload("gone.bin", 0));
  });

  behaviour("a scoped store cannot see past its prefix", async (store) => {
    await store.makeDirectory("outside");
    const theirs = bytes("theirs");
    await store.put("outside/shared.bin", theirs);

    const scoped = store.scope("inside");
    // The same relative name that is occupied outside the scope is simply
    // not there inside it.
    assertEquals(await scoped.getIfExists("shared.bin"), undefined);

    await scoped.makeDirectory("nested");
    const ours = bytes("ours");
    await scoped.put("shared.bin", ours);
    await scoped.put("nested/deep.bin", bytes("deep"));

    assertEquals(await scoped.get("shared.bin"), ours);
    assertEquals(await store.get("inside/shared.bin"), ours);
    assertEquals(await store.get("outside/shared.bin"), theirs);

    // Listings come back in the scope's own coordinates, because the
    // repository code driving a staged rebuild does not know it is scoped
    // and feeds the paths it is given straight back to the store.
    assertEquals(pathsOf(await scoped.list("")), ["nested", "shared.bin"]);
    assertEquals(pathsOf(await scoped.list("nested")), ["nested/deep.bin"]);

    // The scope is a boundary, not a convenience: a staging area that can
    // be walked out of with ".." is a staging area that can overwrite the
    // live generation it was built to replace.
    await assertFails(
      "corrupt-data",
      () => scoped.get("../outside/shared.bin"),
    );
  });

  behaviour("unsafe paths are refused by every verb", async (store) => {
    const safe = bytes("safe");
    await store.put("safe.bin", safe);
    const payload = bytes("payload");

    for (const path of UNSAFE_PATHS) {
      await assertFails("corrupt-data", () => store.list(path));
      await assertFails("corrupt-data", () => store.exists(path));
      await assertFails("corrupt-data", () => store.get(path));
      await assertFails("corrupt-data", () => store.getIfExists(path));
      await assertFails("corrupt-data", () => store.put(path, payload));
      await assertFails("corrupt-data", () => store.create(path, payload));
      await assertFails("corrupt-data", () => store.delete(path));
      await assertFails("corrupt-data", () => store.move(path, "safe.bin"));
      await assertFails("corrupt-data", () => store.move("safe.bin", path));
      await assertFails(
        "corrupt-data",
        () => store.moveRecursive(path, "elsewhere"),
      );
      await assertFails(
        "corrupt-data",
        () => store.moveRecursive("safe.bin", path),
      );
      await assertFails("corrupt-data", () => store.makeDirectory(path));
      await assertFails("corrupt-data", () => store.verifyUpload(path, 1));
      // scope() has no I/O to defer, so it refuses on the spot.
      assertThrows(() => store.scope(path), SyncError);
    }

    // A refusal that still moved or wrote something would be worse than no
    // check at all, so the store has to look untouched afterwards.
    assertEquals(await store.get("safe.bin"), safe);
    assertEquals(pathsOf(await store.list("")), ["safe.bin"]);
  });
}

/**
 * The shapes assertSafePath exists for. Each one, let through, resolves
 * against the root as some *other* valid path — which is a read or a write
 * outside the repository with no error anywhere to notice it by.
 */
const UNSAFE_PATHS = [
  "../escape.bin",
  "nested/../../escape.bin",
  "/absolute.bin",
  "null\u0000byte.bin",
];

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function everyByteValue(): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_unused, index) => index);
}

/** Sorted, because no store promises a listing order. */
function pathsOf(entries: RemoteEntry[]): string[] {
  return entries.map((entry) => entry.path).sort();
}

/**
 * Both the class and the code: the engine branches on `code`, so a store
 * that fails with the right class and the wrong code is sent down the wrong
 * path — retrying forever on what was really a permanent refusal.
 *
 * A synchronous throw counts as a refusal here, rather than being held to
 * "a method returning Promise must reject". scopedStore validates its
 * argument before it has a promise to reject into, and it is part of the
 * interface's own toolkit — so demanding a rejection would fail the shipped
 * wrapper rather than any store. What has to be true is only that the
 * operation did not happen.
 */
async function assertFails(
  code: SyncError["code"],
  operation: () => Promise<unknown>,
): Promise<void> {
  let refused = false;
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    refused = true;
    failure = error;
  }
  assert(refused, `expected SyncError("${code}"), but the call succeeded`);
  assert(
    failure instanceof SyncError,
    `expected SyncError("${code}"), got ${failure}`,
  );
  assertEquals(failure.code, code, `wrong code for: ${failure.message}`);
}
