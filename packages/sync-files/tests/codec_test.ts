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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { MemoryTextStore, SyncError } from "@notesnook/sync-core";
import {
  ENCRYPTED_DIR,
  EncryptedCodec,
  type NoteCrypto,
  PlaintextCodec,
} from "../src/codec.ts";
import { FileSyncEngine } from "../src/engine.ts";
import { ManifestStore } from "../src/manifest.ts";
import type { RenderedNote } from "../src/types.ts";
import { FolderStorage } from "./folder-storage.ts";

/**
 * The user chooses between a readable folder and an encrypted one, with
 * readable the default. These tests hold both halves of that promise: that
 * readable really is readable, and that encrypted really does hide the title
 * and the notebook structure as well as the text.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * Stand-in for SyncCrypto with the same shape.
 *
 * Deliberately reversible-but-opaque rather than real cryptography: these
 * tests are about whether the *engine* routes everything through the codec,
 * and the audited implementation is tested where it lives. Randomised output
 * is the property that matters here, because it is what would break a naive
 * hash-the-ciphertext comparison.
 */
function fakeCrypto(): NoteCrypto & { calls: number } {
  const box = new Map<string, unknown>();
  let nonce = 0;
  return {
    calls: 0,
    hashString(_key: unknown, value: string): Promise<string> {
      // Deterministic and one-way enough for a filename.
      let hash = 0x811c9dc5;
      for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return Promise.resolve(hash.toString(16).padStart(8, "0"));
    },
    encryptJson(_key: unknown, value: unknown): Promise<unknown> {
      // A fresh nonce every time, exactly as a real secretstream produces.
      const id = `c${nonce++}`;
      box.set(id, value);
      return Promise.resolve({ alg: "fake", id });
    },
    decryptJson<T>(_key: unknown, cipher: unknown): Promise<T> {
      const id = (cipher as { id?: string })?.id;
      if (!id || !box.has(id)) {
        return Promise.reject(new Error("cannot decrypt"));
      }
      return Promise.resolve(box.get(id) as T);
    },
  };
}

function note(id: string, path: string, body: string): RenderedNote {
  return { noteId: id, path, content: utf8(body) };
}

function engineWith(
  storage: FolderStorage,
  codec?: PlaintextCodec | EncryptedCodec,
  deviceId = "device-a",
) {
  const manifest = new ManifestStore(new MemoryTextStore(), deviceId);
  const conflicts: string[] = [];
  const engine = new FileSyncEngine({
    storage,
    manifest,
    codec,
    deviceName: deviceId,
    onConflict: (info) => conflicts.push(info.reason),
  });
  return { engine, manifest, conflicts };
}

// ---------------------------------------------------------------------------
// Readable, the default
// ---------------------------------------------------------------------------

Deno.test("the default is readable, and it really is readable", async () => {
  const storage = new FolderStorage();
  const { engine } = engineWith(storage); // no codec passed

  await engine.sync([note("n1", "Work/Q3 plan.md", "# Q3 plan\n\nship it")]);

  // The path is the note's own, and the bytes are the note's own.
  assertEquals(
    text(await storage.get("Work/Q3 plan.md")),
    "# Q3 plan\n\nship it",
  );
});

// ---------------------------------------------------------------------------
// Encrypted, opt-in
// ---------------------------------------------------------------------------

Deno.test("encryption hides the text", async () => {
  const storage = new FolderStorage();
  const codec = new EncryptedCodec(fakeCrypto(), "subkey");
  const { engine } = engineWith(storage, codec);

  await engine.sync([note("n1", "Work/Q3 plan.md", "the secret plan")]);

  const stored = storage.paths().filter((p) => !p.includes("conflicts"));
  assertEquals(stored.length, 1);
  const raw = text(await storage.get(stored[0]));
  assert(
    !raw.includes("the secret plan"),
    "note text must not be stored plainly",
  );
});

Deno.test("encryption hides the title and the notebook, not just the text", async () => {
  // A folder listing that reads "Work/Divorce paperwork.md" has already told
  // the provider most of what matters, so the *names* have to go too.
  const storage = new FolderStorage();
  const codec = new EncryptedCodec(fakeCrypto(), "subkey");
  const { engine } = engineWith(storage, codec);

  await engine.sync([note("n1", "Legal/Divorce paperwork.md", "body")]);

  const stored = storage.paths()[0];
  assert(!stored.includes("Divorce"), `title leaked in ${stored}`);
  assert(!stored.includes("Legal"), `notebook leaked in ${stored}`);
  assert(
    stored.startsWith(ENCRYPTED_DIR + "/"),
    `unexpected layout: ${stored}`,
  );
});

Deno.test("an encrypted note round-trips through a second device", async () => {
  const storage = new FolderStorage();
  const crypto = fakeCrypto();
  const a = engineWith(
    storage,
    new EncryptedCodec(crypto, "subkey"),
    "device-a",
  );
  await a.engine.sync([note("n1", "Work/Plan.md", "# Plan\n\nbody")]);

  // A second device with the same key sees the note, path and all.
  const b = engineWith(
    storage,
    new EncryptedCodec(crypto, "subkey"),
    "device-b",
  );
  const result = await b.engine.sync([]);

  assertEquals(result.pulled, 1);
  assertEquals(result.incoming[0].path, "Work/Plan.md");
  assertEquals(text(result.incoming[0].content), "# Plan\n\nbody");
});

Deno.test("a randomised cipher does not make every note look edited", async () => {
  // Encryption produces different bytes each time, so comparing stored bytes
  // would report every note as changed on every cycle. The comparison is of
  // the note, not the ciphertext.
  const storage = new FolderStorage();
  const codec = new EncryptedCodec(fakeCrypto(), "subkey");
  const { engine } = engineWith(storage, codec);
  const notes = [note("n1", "Plan.md", "unchanged")];

  await engine.sync(notes);
  storage.writes.length = 0;
  const second = await engine.sync(notes);

  assertEquals(second.pushed, 0);
  assertEquals(storage.writes, []);
});

Deno.test("retitling an encrypted note does not move its file", async () => {
  // The filename is keyed on the note id, so a rename is not even observable
  // to someone watching the folder.
  const storage = new FolderStorage();
  const codec = new EncryptedCodec(fakeCrypto(), "subkey");
  const { engine } = engineWith(storage, codec);

  await engine.sync([note("n1", "Old title.md", "body")]);
  const before = storage.paths();

  await engine.sync([note("n1", "New title.md", "body")]);
  assertEquals(storage.paths(), before);
});

Deno.test("the wrong key is reported as a passphrase problem, not corruption", async () => {
  const storage = new FolderStorage();
  const writer = engineWith(storage, new EncryptedCodec(fakeCrypto(), "k1"));
  await writer.engine.sync([note("n1", "Plan.md", "body")]);

  // A different device with a different passphrase.
  const reader = engineWith(storage, new EncryptedCodec(fakeCrypto(), "k2"));
  const error = await assertRejects(() => reader.engine.sync([]), SyncError);

  assertEquals(error.code, "bad-key");
  assert(error.message.includes("passphrase"));
});

Deno.test("a file from a newer Openotes is refused rather than half-read", async () => {
  const crypto = fakeCrypto();
  const codec = new EncryptedCodec(crypto, "subkey");
  const cipher = await crypto.encryptJson("subkey", { version: 2, path: "x" });

  const error = await assertRejects(
    () =>
      codec.decode(
        "notes/abc.bin",
        utf8(JSON.stringify(cipher)),
      ),
    SyncError,
  );
  assertEquals(error.code, "protocol-mismatch");
});

Deno.test("garbage in the folder is corrupt data, not a key problem", async () => {
  const codec = new EncryptedCodec(fakeCrypto(), "subkey");
  const error = await assertRejects(
    () => codec.decode("notes/abc.bin", utf8("this is not json")),
    SyncError,
  );
  assertEquals(error.code, "corrupt-data");
});

// ---------------------------------------------------------------------------
// The two modes do not see each other
// ---------------------------------------------------------------------------

Deno.test("each mode ignores the other's files", async () => {
  // Switching modes rewrites everything, so a folder holding both is a
  // half-finished switch. Neither codec should try to read the other's files
  // and report them as corrupt.
  const storage = new FolderStorage();
  const plain = new PlaintextCodec();
  const encrypted = new EncryptedCodec(fakeCrypto(), "subkey");

  assertEquals(plain.claims("Work/Plan.md"), true);
  assertEquals(plain.claims("notes/abcdef12.bin"), false);
  assertEquals(encrypted.claims("notes/abcdef12.bin"), true);
  assertEquals(encrypted.claims("Work/Plan.md"), false);

  await engineWith(storage, plain).engine.sync([
    note("n1", "Plan.md", "readable"),
  ]);
  const seen = await engineWith(storage, encrypted).engine.sync([]);
  // The encrypted engine sees no notes at all, rather than choking on one.
  assertEquals(seen.pulled, 0);
});
