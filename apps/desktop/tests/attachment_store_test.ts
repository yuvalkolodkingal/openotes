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
 * Tests for the chunked attachment store: the exact chunk-key naming the
 * renderer's streamable-fs layer uses, frame-boundary preservation through
 * the sync-facing whole-file views, traversal rejection, and crash cleanup.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  AttachmentChunkStore,
  ENCRYPTED_CHUNK_SIZE,
  parseChunkName,
  SECRETSTREAM_ABYTES,
} from "../src/native/attachment-store.ts";
import { createHandlers, dispatch } from "../src/rpc/handlers.ts";
import type { AppContext } from "../src/app.ts";

async function withStore(
  fn: (store: AttachmentChunkStore, root: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "openotes-attachments-" });
  try {
    await fn(new AttachmentChunkStore(root), await Deno.realPath(root));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

function patternBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const HASH = "d1c2b3a495867700";

// ---------------------------------------------------------------------------
// The streamable-fs contract
// ---------------------------------------------------------------------------

Deno.test("chunks round-trip under the exact keys streamable-fs uses", async () => {
  await withStore(async (store) => {
    // 13 chunks so a lexicographic sort ("10" < "2") would be caught.
    const chunks = Array.from(
      { length: 13 },
      (_, i) => patternBytes(100 + i, i + 1),
    );
    await store.setMetadata(HASH, {
      filename: HASH,
      size: 1234,
      type: "image/png",
    });
    for (let i = 0; i < chunks.length; i++) {
      await store.writeChunk(`${HASH}-chunk-${i}`, chunks[i]);
    }

    assertEquals(await store.listChunks(`${HASH}-chunk-`), [
      ...chunks.map((_, i) => `${HASH}-chunk-${i}`),
    ]);
    for (let i = 0; i < chunks.length; i++) {
      const read = await store.readChunk(`${HASH}-chunk-${i}`);
      assert(read && bytesEqual(read, chunks[i]), `chunk ${i} differs`);
      assertEquals(await store.chunkSize(`${HASH}-chunk-${i}`), 100 + i);
    }

    const metadata = await store.getMetadata(HASH);
    assertEquals(metadata?.size, 1234);
    assertEquals(metadata?.type, "image/png");

    // list() exposes the metadata key and every chunk key.
    const listed = await store.list();
    assert(listed.includes(HASH));
    assert(listed.includes(`${HASH}-chunk-12`));
    assertEquals(listed.length, 1 + chunks.length);

    // Deleting everything prunes the attachment's directory tree.
    assert(await store.deleteFile(HASH));
    assertEquals(await store.getMetadata(HASH), undefined);
    assertEquals(await store.list(), []);
  });
});

Deno.test("missing chunks and metadata read as absent, not as errors", async () => {
  await withStore(async (store) => {
    assertEquals(await store.getMetadata(HASH), undefined);
    assertEquals(await store.readChunk(`${HASH}-chunk-0`), undefined);
    assertEquals(await store.chunkSize(`${HASH}-chunk-0`), 0);
    assertEquals(await store.listChunks(`${HASH}-chunk-`), []);
    assertEquals(await store.exists(HASH), false);
    await store.deleteMetadata(HASH);
    await store.deleteChunk(`${HASH}-chunk-0`);
  });
});

Deno.test("clear requires nothing but removes everything", async () => {
  await withStore(async (store) => {
    await store.setMetadata(HASH, { filename: HASH, size: 1, type: "x" });
    await store.writeChunk(`${HASH}-chunk-0`, patternBytes(10, 1));
    await store.clear();
    assertEquals(await store.list(), []);
    assertEquals(await store.exists(HASH), false);
  });
});

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

Deno.test("traversal and malformed names are rejected before any I/O", async () => {
  await withStore(async (store, root) => {
    const badChunkNames = [
      "../../../etc/passwd-chunk-0",
      "aaaa/bbbb-chunk-0",
      "..-chunk-0",
      "aa-chunk-0", // file name shorter than the fan-out needs
      `${HASH}-chunk-01`, // non-canonical index
      `${HASH}-chunk--1`,
      `${HASH}-chunk-1e3`,
      `${HASH}-chunk-`,
      `${HASH}-chunk-9999999`, // out of range
      `meta.json-chunk-0`,
      `${HASH}.part-chunk-0`,
      "-chunk-0",
    ];
    for (const name of badChunkNames) {
      await assertRejects(
        () => store.writeChunk(name, patternBytes(4, 1)),
        Error,
        undefined,
        `expected ${name} to be rejected`,
      );
    }

    for (const name of ["", ".", "..", "a/b", "aa", "x".repeat(129)]) {
      await assertRejects(
        () => store.setMetadata(name, { filename: name, size: 0, type: "x" }),
        Error,
        undefined,
        `expected ${JSON.stringify(name)} to be rejected`,
      );
    }

    // Nothing may have been created inside (or outside) the root.
    const entries: string[] = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry.name);
    assertEquals(entries, []);
  });
});

Deno.test("chunk names parse on the last -chunk- infix", () => {
  assertEquals(parseChunkName("abcd-chunk-1-chunk-0"), {
    filename: "abcd-chunk-1",
    index: 0,
  });
  assertEquals(parseChunkName(`${HASH}-chunk-12`), {
    filename: HASH,
    index: 12,
  });
});

// ---------------------------------------------------------------------------
// Whole-file views used by sync and backups
// ---------------------------------------------------------------------------

Deno.test("readStream emits one chunk per stored chunk file, in order", async () => {
  await withStore(async (store) => {
    const frames = [
      patternBytes(1000 + SECRETSTREAM_ABYTES, 1),
      patternBytes(1000 + SECRETSTREAM_ABYTES, 2),
      patternBytes(77 + SECRETSTREAM_ABYTES, 3),
    ];
    await store.setMetadata(HASH, { filename: HASH, size: 2077, type: "x" });
    for (let i = 0; i < frames.length; i++) {
      await store.writeChunk(`${HASH}-chunk-${i}`, frames[i]);
    }

    const stream = await store.readStream(HASH);
    assert(stream);
    const emitted = await collect(stream);
    assertEquals(emitted.length, frames.length);
    for (let i = 0; i < frames.length; i++) {
      assert(bytesEqual(emitted[i], frames[i]), `frame ${i} differs`);
    }

    assertEquals(await store.readStream("ffffeeeeddddcccc"), undefined);
  });
});

Deno.test("a simulated sync download preserves frame boundaries", async () => {
  await withStore(async (uploader) => {
    await withStore(async (downloader) => {
      // The uploader holds renderer-written frames.
      const frames = [
        patternBytes(500 + SECRETSTREAM_ABYTES, 4),
        patternBytes(500 + SECRETSTREAM_ABYTES, 5),
        patternBytes(9 + SECRETSTREAM_ABYTES, 6),
      ];
      await uploader.setMetadata(HASH, {
        filename: HASH,
        size: 1009,
        type: "x",
      });
      for (let i = 0; i < frames.length; i++) {
        await uploader.writeChunk(`${HASH}-chunk-${i}`, frames[i]);
      }

      // Sync moves the content: read on one device, write on the other.
      const stream = await uploader.readStream(HASH);
      assert(stream);
      await downloader.writeStream(HASH, stream);

      const emitted = await collect((await downloader.readStream(HASH))!);
      assertEquals(emitted.length, frames.length);
      for (let i = 0; i < frames.length; i++) {
        assert(bytesEqual(emitted[i], frames[i]), `frame ${i} differs`);
      }

      // The metadata's size is the plaintext length, which is what the
      // renderer's integrity check compares against.
      const metadata = await downloader.getMetadata(HASH);
      assertEquals(metadata?.size, 1009);
      assertEquals(await downloader.size(HASH), 1009 + 3 * 17);
    });
  });
});

Deno.test("writeContiguous re-splits backup bytes at the renderer frame size", async () => {
  await withStore(async (store) => {
    // Two full frames plus a short final one, concatenated — the shape of
    // an attachment inside a backup payload.
    const frames = [
      patternBytes(ENCRYPTED_CHUNK_SIZE, 7),
      patternBytes(ENCRYPTED_CHUNK_SIZE, 8),
      patternBytes(4321, 9),
    ];
    const flat = new Uint8Array(
      frames.reduce((total, frame) => total + frame.length, 0),
    );
    let offset = 0;
    for (const frame of frames) {
      flat.set(frame, offset);
      offset += frame.length;
    }

    await store.writeContiguous(HASH, flat);
    const emitted = await collect((await store.readStream(HASH))!);
    assertEquals(
      emitted.map((chunk) => chunk.length),
      frames.map((frame) => frame.length),
    );
    for (let i = 0; i < frames.length; i++) {
      assert(bytesEqual(emitted[i], frames[i]), `frame ${i} differs`);
    }

    const all = await store.readAll(HASH);
    assert(all && bytesEqual(all, flat), "readAll changed the bytes");
  });
});

Deno.test("an overwriting writeStream leaves no stale chunks behind", async () => {
  await withStore(async (store) => {
    await store.writeStream(
      HASH,
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(patternBytes(50, i));
          controller.close();
        },
      }),
    );
    await store.writeStream(
      HASH,
      new ReadableStream({
        start(controller) {
          controller.enqueue(patternBytes(30, 9));
          controller.close();
        },
      }),
    );
    const emitted = await collect((await store.readStream(HASH))!);
    assertEquals(emitted.map((chunk) => chunk.length), [30]);
  });
});

// ---------------------------------------------------------------------------
// Crash cleanup
// ---------------------------------------------------------------------------

Deno.test("cleanupPartials removes uncommitted writes and temp files only", async () => {
  await withStore(async (store, root) => {
    // A committed attachment with a leftover temp file next to it.
    await store.setMetadata(HASH, { filename: HASH, size: 10, type: "x" });
    await store.writeChunk(`${HASH}-chunk-0`, patternBytes(27, 1));
    const committedDir = join(root, "d1", "c2", HASH);
    await Deno.writeFile(join(committedDir, "1.part"), patternBytes(5, 2));

    // An interrupted sync download: chunks, but no meta.json commit.
    const orphan = "eeee111122223333";
    const orphanDir = join(root, "ee", "ee", orphan);
    await Deno.mkdir(orphanDir, { recursive: true });
    await Deno.writeFile(join(orphanDir, "0"), patternBytes(40, 3));
    await Deno.writeFile(join(orphanDir, "1"), patternBytes(40, 4));

    const removed = await store.cleanupPartials();
    assertEquals(removed, 2);

    // The committed attachment survives, whole.
    assert(await store.exists(HASH));
    const chunk = await store.readChunk(`${HASH}-chunk-0`);
    assert(chunk && chunk.length === 27);
    assertEquals(
      await Deno.stat(join(committedDir, "1.part")).catch(() => undefined),
      undefined,
    );

    // The orphan is gone entirely.
    assertEquals(
      await Deno.stat(orphanDir).catch(() => undefined),
      undefined,
    );
    assertEquals(await store.listHashes(), [HASH]);
  });
});

// ---------------------------------------------------------------------------
// End to end through the real RPC handlers
// ---------------------------------------------------------------------------

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

Deno.test("renderer-shaped RPC writes read back through the sync view", async () => {
  await withStore(async (store) => {
    const handlers = createHandlers();
    const context = { files: store } as unknown as AppContext;
    const call = async (path: string, input?: unknown) => {
      const response = await dispatch({ path, input }, handlers, context);
      if (!response.ok) throw new Error(response.error.message);
      return response.result;
    };

    // Exactly what DesktopFileStore does: createFile writes metadata first,
    // then base64 chunks under `<hash>-chunk-<i>`.
    const frames = [
      patternBytes(2000 + SECRETSTREAM_ABYTES, 11),
      patternBytes(2000 + SECRETSTREAM_ABYTES, 12),
      patternBytes(123 + SECRETSTREAM_ABYTES, 13),
    ];
    await call("attachments.setMetadata", {
      filename: HASH,
      metadata: { filename: HASH, size: 4123, type: "application/pdf" },
    });
    for (let i = 0; i < frames.length; i++) {
      await call("attachments.writeChunk", {
        chunkName: `${HASH}-chunk-${i}`,
        data: base64Encode(frames[i]),
      });
    }

    // The sync engine's view of the same content: one chunk per frame,
    // byte-identical.
    const emitted = await collect((await store.readStream(HASH))!);
    assertEquals(emitted.length, frames.length);
    for (let i = 0; i < frames.length; i++) {
      assert(bytesEqual(emitted[i], frames[i]), `frame ${i} differs`);
    }

    // And the renderer's read path over RPC returns the same bytes.
    const listed = await call("attachments.listChunks", {
      chunkPrefix: `${HASH}-chunk-`,
    }) as string[];
    assertEquals(listed.length, frames.length);
    for (let i = 0; i < listed.length; i++) {
      const encoded = await call("attachments.readChunk", {
        chunkName: listed[i],
      }) as string;
      assert(bytesEqual(base64Decode(encoded), frames[i]));
    }

    // clear requires explicit confirmation, like storage.clear.
    const refused = await dispatch(
      { path: "attachments.clear", input: {} },
      handlers,
      context,
    );
    assert(!refused.ok);
    await call("attachments.clear", { confirm: "clear" });
    assertEquals(await store.list(), []);
  });
});

Deno.test("RPC chunk writes with hostile names are refused", async () => {
  await withStore(async (store, root) => {
    const handlers = createHandlers();
    const context = { files: store } as unknown as AppContext;
    const response = await dispatch(
      {
        path: "attachments.writeChunk",
        input: {
          chunkName: "../../escape-chunk-0",
          data: base64Encode(patternBytes(4, 1)),
        },
      },
      handlers,
      context,
    );
    assert(!response.ok);
    const entries: string[] = [];
    for await (const entry of Deno.readDir(root)) entries.push(entry.name);
    assertEquals(entries, []);
  });
});
