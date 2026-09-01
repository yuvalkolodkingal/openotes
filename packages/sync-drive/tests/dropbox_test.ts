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
 * The Dropbox store, against a fake of the parts of the API it depends on.
 *
 * These are claims about behaviour the sync protocol rests on, not coverage
 * for its own sake: that an exclusive create really refuses, that a listing
 * does not stop at the first page, and that a header the service parses as
 * ASCII is produced as ASCII.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { SyncError } from "@notesnook/sync-remote";
import { DropboxStore } from "../src/dropbox/dropbox-store.ts";
import { apiArg, contentHash } from "../src/dropbox/upload.ts";
import { TokenManager } from "../src/oauth/token-manager.ts";
import { FakeDropbox } from "./fake-dropbox.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A token manager that hands out a fixed token and never refreshes. */
function fixedTokens(): TokenManager {
  return {
    provider: "dropbox",
    label: "Dropbox",
    isConnected: () => Promise.resolve(true),
    getAccessToken: () => Promise.resolve("test-access-token"),
    exchangeCode: () => Promise.resolve(),
    disconnect: () => Promise.resolve(),
  } as unknown as TokenManager;
}

async function withStore(
  body: (store: DropboxStore, fake: FakeDropbox) => Promise<void>,
  options: { pageSize?: number; sessionThreshold?: number } = {},
) {
  const fake = new FakeDropbox();
  if (options.pageSize) fake.pageSize = options.pageSize;
  await fake.start();
  try {
    const store = new DropboxStore({
      client: { provider: "dropbox", clientId: "test-client" },
      tokens: fixedTokens(),
      directory: "Openotes",
      apiUrl: fake.apiUrl,
      contentUrl: fake.contentUrl,
      sessionThreshold: options.sessionThreshold,
    });
    await body(store, fake);
  } finally {
    await fake.stop();
  }
}

Deno.test("bytes round-trip through put and get", async () => {
  await withStore(async (store) => {
    const body = encoder.encode("hello dropbox");
    await store.put("devices/A/changes/0000000001.bin", body);
    const read = await store.get("devices/A/changes/0000000001.bin");
    assertEquals(decoder.decode(read), "hello dropbox");
    assertEquals(await store.exists("devices/A/changes/0000000001.bin"), true);
    assertEquals(await store.exists("devices/A/changes/0000000002.bin"), false);
    assertEquals(
      await store.getIfExists("devices/A/changes/0000000002.bin"),
      undefined,
    );
  });
});

Deno.test("get on a missing path is not-found, getIfExists is undefined", async () => {
  await withStore(async (store) => {
    const error = await assertRejects(
      () => store.get("nope.bin"),
      SyncError,
    );
    assertEquals(error.code, "not-found");
  });
});

Deno.test("create refuses an occupied path and leaves it untouched", async () => {
  await withStore(async (store, fake) => {
    await store.create("protocol.json", encoder.encode("first"));
    const error = await assertRejects(
      () => store.create("protocol.json", encoder.encode("second")),
      SyncError,
    );
    assertEquals(error.code, "precondition-failed");
    // The whole journal rests on this: a create that clobbers and then
    // reports failure is worse than one that does not refuse at all.
    assertEquals(decoder.decode(await store.get("protocol.json")), "first");
    assert(
      fake.text("/Openotes/protocol.json") === "first",
      "the service still holds the first write",
    );
  });
});

Deno.test("put overwrites where create refuses", async () => {
  await withStore(async (store) => {
    await store.put("cursor.bin", encoder.encode("one"));
    await store.put("cursor.bin", encoder.encode("two"));
    assertEquals(decoder.decode(await store.get("cursor.bin")), "two");
  });
});

Deno.test("a listing does not stop at the first page", async () => {
  // A repository with more than one page of journal batches is ordinary, and
  // stopping at the first page loses the rest silently — the engine would
  // simply never see those sequences.
  await withStore(async (store) => {
    for (let index = 1; index <= 5; index++) {
      await store.put(
        `devices/A/changes/000000000${index}.bin`,
        encoder.encode(`batch ${index}`),
      );
    }
    const entries = await store.list("devices/A/changes/");
    assertEquals(entries.length, 5);
    assertEquals(
      entries.map((entry) => entry.path.split("/").pop()).sort(),
      [
        "0000000001.bin",
        "0000000002.bin",
        "0000000003.bin",
        "0000000004.bin",
        "0000000005.bin",
      ],
    );
    assertEquals(entries.every((entry) => !entry.isDirectory), true);
  }, { pageSize: 2 });
});

Deno.test("listing a directory that is not there is empty, not an error", async () => {
  await withStore(async (store) => {
    assertEquals(await store.list("devices/NOBODY/changes/"), []);
  });
});

Deno.test("deleting something that is not there is not an error", async () => {
  await withStore(async (store) => {
    await store.put("gone.bin", encoder.encode("x"));
    await store.delete("gone.bin");
    // Idempotent by contract: the engine deletes optimistically.
    await store.delete("gone.bin");
    assertEquals(await store.exists("gone.bin"), false);
  });
});

Deno.test("move relocates a file, moveRecursive a whole tree", async () => {
  await withStore(async (store) => {
    await store.put("devices/A/device.json", encoder.encode("a"));
    await store.put("devices/A/changes/0000000001.bin", encoder.encode("b"));

    await store.move("devices/A/device.json", "devices/A/moved.json");
    assertEquals(decoder.decode(await store.get("devices/A/moved.json")), "a");
    assertEquals(await store.exists("devices/A/device.json"), false);

    await store.moveRecursive("devices", ".retired/devices");
    assertEquals(
      decoder.decode(
        await store.get(".retired/devices/A/changes/0000000001.bin"),
      ),
      "b",
    );
    assertEquals(await store.exists("devices/A/changes/0000000001.bin"), false);
  });
});

Deno.test("verifyUpload accepts the right length and rejects the wrong one", async () => {
  await withStore(async (store) => {
    const body = encoder.encode("0123456789");
    await store.put("objects/abc.bin", body);
    await store.verifyUpload("objects/abc.bin", body.length);
    await assertRejects(
      () => store.verifyUpload("objects/abc.bin", body.length + 1),
      SyncError,
    );
  });
});

Deno.test("a scoped store cannot see outside its prefix", async () => {
  await withStore(async (store) => {
    await store.put("outside.bin", encoder.encode("out"));
    const staged = store.scope(".staging-1");
    await staged.put("inside.bin", encoder.encode("in"));

    assertEquals(await staged.exists("outside.bin"), false);
    assertEquals(decoder.decode(await staged.get("inside.bin")), "in");
    assertEquals(
      decoder.decode(await store.get(".staging-1/inside.bin")),
      "in",
    );
    assertEquals(
      (await staged.list("")).map((entry) => entry.path),
      ["inside.bin"],
    );
  });
});

Deno.test("a large body goes through an upload session", async () => {
  await withStore(async (store, fake) => {
    const body = encoder.encode("x".repeat(64));
    await store.put("objects/big.bin", body);
    assert(
      fake.calls.some((route) => route === "files/upload_session/start"),
      `expected a session upload, saw: ${fake.calls.join(", ")}`,
    );
    assertEquals(
      decoder.decode(await store.get("objects/big.bin")),
      "x".repeat(64),
    );

    // ...and a small one does not.
    fake.calls.length = 0;
    await store.put("objects/small.bin", encoder.encode("tiny"));
    assertEquals(
      fake.calls.some((route) => route.startsWith("files/upload_session")),
      false,
    );
  }, { sessionThreshold: 32 });
});

Deno.test("every request carries the bearer token", async () => {
  await withStore(async (store, fake) => {
    await store.put("a.bin", encoder.encode("a"));
    await store.get("a.bin");
    assert(fake.authorizations.length > 0);
    for (const call of fake.authorizations) {
      assertEquals(
        call.header,
        "Bearer test-access-token",
        `${call.route} was called without the token`,
      );
    }
  });
});

Deno.test("a path segment is refused if it could escape the repository", async () => {
  await withStore(async (store) => {
    await assertRejects(() => store.get("../secrets"), SyncError);
    await assertRejects(
      () => store.put("/absolute", encoder.encode("x")),
      SyncError,
    );
  });
});

// --- the two pure pieces --------------------------------------------------

Deno.test("the API argument header is ASCII", () => {
  // Dropbox rejects the request outright when a raw non-ASCII byte reaches
  // the header, and a device id or directory name is user-influenced.
  const encoded = apiArg({ path: "/Openotes/notes — café/日本.bin" });
  for (const character of encoded) {
    assert(
      character.charCodeAt(0) <= 0x7e,
      `non-ASCII character in the header: ${JSON.stringify(character)}`,
    );
  }
  // Escaped, not mangled: it must parse back to the string we meant.
  assertEquals(JSON.parse(encoded).path, "/Openotes/notes — café/日本.bin");
});

Deno.test("a character outside the BMP survives the header escaping", () => {
  const encoded = apiArg({ path: "/Openotes/\u{1F5C2}.bin" });
  assertEquals(JSON.parse(encoded).path, "/Openotes/\u{1F5C2}.bin");
});

Deno.test("content_hash matches Dropbox's block digest", async () => {
  // The documented algorithm: SHA-256 of each 4 MiB block, concatenated,
  // then SHA-256 of that, in hex. An empty file is the digest of nothing.
  const empty = await contentHash(new Uint8Array(0));
  assertEquals(
    empty,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );

  const body = encoder.encode("hello");
  const block = new Uint8Array(
    await crypto.subtle.digest("SHA-256", body as BufferSource),
  );
  const root = new Uint8Array(
    await crypto.subtle.digest("SHA-256", block as BufferSource),
  );
  assertEquals(
    await contentHash(body),
    [...root].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
});
