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
 * The Google Drive RemoteStore, against a loopback Drive.
 *
 * Everything here runs over real HTTP to tests/fake-google.ts, so what is
 * being checked is the query strings, multipart bodies and error envelopes
 * the adapter really produces — not a mock built from the same reading of
 * the API as the code.
 *
 * The store's own clock is injected everywhere: `delay` collects the waits
 * instead of spending them, which keeps the two-second reconciliation
 * settle and the retry backoff free, and makes both of them assertable.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { encodeHex } from "@std/encoding";
import { SyncError } from "@notesnook/sync-remote";
import {
  type DriveProvider,
  GoogleDriveStore,
  TokenManager,
  type TokenStorage,
} from "@notesnook/sync-drive";
import { RESUMABLE_THRESHOLD_BYTES } from "../src/google/upload.ts";
import { FakeGoogleDrive, FOLDER_MIME_TYPE } from "./fake-google.ts";

/** The repository directory every test below configures. */
const DIRECTORY = "Openotes";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

interface StoreOptions {
  directory?: string;
  /** Replaces every wait the store would make, including the settle. */
  delay?: (ms: number) => Promise<void>;
}

function driveStore(
  drive: FakeGoogleDrive,
  options: StoreOptions = {},
): GoogleDriveStore {
  const saved = new Map<DriveProvider, string>([
    ["googledrive", "saved-refresh-token"],
  ]);
  const storage: TokenStorage = {
    read: (provider) => Promise.resolve(saved.get(provider)),
    write: (provider, token) => {
      saved.set(provider, token);
      return Promise.resolve();
    },
    clear: (provider) => {
      saved.delete(provider);
      return Promise.resolve();
    },
  };
  const client = {
    provider: "googledrive" as const,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  };
  return new GoogleDriveStore({
    client,
    tokens: new TokenManager({ client, storage, fetch: drive.fetch }),
    directory: options.directory ?? DIRECTORY,
    fetch: drive.fetch,
    delay: options.delay ?? (() => Promise.resolve()),
    // Full jitter draws from `random`, so pinning it to zero makes every
    // backoff the shortest the policy allows and every wait predictable.
    random: () => 0,
  });
}

async function withDrive(
  scenario: (drive: FakeGoogleDrive) => Promise<void>,
): Promise<void> {
  const drive = new FakeGoogleDrive();
  await drive.start();
  try {
    await scenario(drive);
  } finally {
    await drive.stop();
  }
}

/** A connected store and the Drive folder it settled on. */
async function connected(
  drive: FakeGoogleDrive,
  options: StoreOptions = {},
): Promise<GoogleDriveStore> {
  const store = driveStore(drive, options);
  await store.connect();
  return store;
}

function folderId(drive: FakeGoogleDrive): string {
  const [folder] = drive.lookup(DIRECTORY);
  assert(folder, `the repository folder ${DIRECTORY} is not in the fake Drive`);
  return folder.id;
}

/** The `files.list` calls, which is what path resolution costs. */
function lookupQueries(drive: FakeGoogleDrive): number {
  return drive.requests.filter((request) =>
    request.method === "GET" && request.path === "/drive/v3/files" &&
    request.params.q !== undefined
  ).length;
}

function uploadRequests(
  drive: FakeGoogleDrive,
): readonly { method: string; params: Record<string, string> }[] {
  return drive.requests.filter((request) =>
    request.path.startsWith("/upload/drive/v3/files")
  );
}

async function sha256(data: Uint8Array): Promise<string> {
  // The bundled DOM lib types BufferSource narrowly enough that a
  // Uint8Array over an ArrayBufferLike does not match, though Deno's
  // WebCrypto takes one. Same cast as the adapters make for BodyInit.
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return encodeHex(new Uint8Array(digest));
}

Deno.test("connect creates the repository folder, and a second device joins the one already there", async () => {
  await withDrive(async (drive) => {
    const first = await connected(drive);
    const folders = drive.lookup(DIRECTORY);
    assertEquals(folders.length, 1);
    assertEquals(folders[0].mimeType, FOLDER_MIME_TYPE);

    const second = await connected(drive);
    assertEquals(drive.lookup(DIRECTORY).length, 1);

    // Both devices writing into the same folder is the point: a duplicate
    // repository folder is a silent fork, not a cosmetic wart.
    await first.put("from-first.bin", bytes("one"));
    await second.put("from-second.bin", bytes("two"));
    assertEquals(drive.lookup(`${DIRECTORY}/from-first.bin`).length, 1);
    assertEquals(drive.lookup(`${DIRECTORY}/from-second.bin`).length, 1);
    assertEquals(await second.get("from-first.bin"), bytes("one"));
  });
});

Deno.test("put and get round-trip bytes through the repository folder", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    const body = bytes("an encrypted change batch");
    await store.put("devices/abc/changes/1.bin", body);

    assertEquals(await store.get("devices/abc/changes/1.bin"), body);
    assertEquals(
      drive.lookup(`${DIRECTORY}/devices/abc/changes/1.bin`).length,
      1,
    );
  });
});

Deno.test("put replaces the file holding the path instead of adding a second one beside it", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.put("protocol.json", bytes("first"));
    const [before] = drive.lookup(`${DIRECTORY}/protocol.json`);
    await store.put("protocol.json", bytes("second"));

    const after = drive.lookup(`${DIRECTORY}/protocol.json`);
    assertEquals(after.length, 1);
    assertEquals(after[0].id, before.id);
    assertEquals(await store.get("protocol.json"), bytes("second"));
  });
});

Deno.test("get throws not-found for a path nothing wrote, and getIfExists answers undefined", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    assertEquals(await store.getIfExists("missing.bin"), undefined);
    const error = await assertRejects(
      () => store.get("missing.bin"),
      SyncError,
    );
    assertEquals(error.code, "not-found");

    await store.put("missing.bin", bytes("here now"));
    assertEquals(await store.getIfExists("missing.bin"), bytes("here now"));
  });
});

Deno.test("exists follows the file, before it is written and after it is deleted", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    assertEquals(await store.exists("cursors.bin"), false);
    await store.put("cursors.bin", bytes("x"));
    assertEquals(await store.exists("cursors.bin"), true);
    await store.delete("cursors.bin");
    assertEquals(await store.exists("cursors.bin"), false);
  });
});

Deno.test("list reports each child once, with folders marked and file sizes filled in", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.makeDirectory("devices/");
    await store.put("protocol.json", bytes("{}"));
    await store.put("objects/aa.bin", bytes("twelve bytes"));

    const entries = (await store.list("")).sort((left, right) =>
      left.path < right.path ? -1 : 1
    );
    assertEquals(entries.map((entry) => entry.path), [
      "devices",
      "objects",
      "protocol.json",
    ]);
    assertEquals(entries.map((entry) => entry.isDirectory), [
      true,
      true,
      false,
    ]);
    assertEquals(entries[2].size, 2);
    assertEquals(typeof entries[2].modifiedAt, "number");

    const children = await store.list("objects/");
    assertEquals(children.map((entry) => entry.path), ["objects/aa.bin"]);
    assertEquals(children[0].size, 12);
  });
});

Deno.test("list of a directory that is not there is empty rather than an error", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    assertEquals(await store.list("devices/nobody/"), []);
  });
});

Deno.test("list follows Drive's paging to the end of the folder", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    for (let index = 0; index < 5; index++) {
      await store.put(`${index}.bin`, bytes(`batch ${index}`));
    }
    drive.maxPageSize = 2;
    drive.clearRequests();

    const entries = await store.list("");
    assertEquals(entries.length, 5);
    // Five children at two per page is three pages. An unpaged listing of
    // the same folder is one query, so a store that stopped at the first
    // nextPageToken would have made one and returned two entries.
    assertEquals(lookupQueries(drive), 3);
  });
});

Deno.test("delete removes the file, and deleting a path that is not there is not an error", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.put("gone.bin", bytes("x"));
    await store.delete("gone.bin");
    assertEquals(drive.lookup(`${DIRECTORY}/gone.bin`).length, 0);
    await store.delete("gone.bin");
    await store.delete("never-existed.bin");
  });
});

Deno.test("delete refuses a folder that still holds files, because Drive would take them with it", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.put("devices/abc/1.bin", bytes("a journal entry"));

    const error = await assertRejects(
      () => store.delete("devices/abc/"),
      SyncError,
    );
    assertEquals(error.code, "conflict");
    assertEquals(
      await store.get("devices/abc/1.bin"),
      bytes("a journal entry"),
    );
  });
});

Deno.test("move renames a file and takes over a destination that was occupied", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.put("staged.bin", bytes("new generation"));
    await store.put("live.bin", bytes("old generation"));

    await store.move("staged.bin", "live.bin");
    assertEquals(await store.get("live.bin"), bytes("new generation"));
    assertEquals(await store.exists("staged.bin"), false);
    // The overwritten file is gone, not left behind as a duplicate for the
    // tie-break to choose between.
    assertEquals(drive.lookup(`${DIRECTORY}/live.bin`).length, 1);
  });
});

Deno.test("move of a missing source is not-found", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    const error = await assertRejects(
      () => store.move("nowhere.bin", "somewhere.bin"),
      SyncError,
    );
    assertEquals(error.code, "not-found");
  });
});

Deno.test("moveRecursive relocates a folder and every descendant in a single PATCH", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.put("generation-1/devices/abc/1.bin", bytes("batch one"));
    await store.put("generation-1/protocol.json", bytes("{}"));
    drive.clearRequests();

    await store.moveRecursive("generation-1/", "generation-2/");

    const patches = drive.requests.filter((request) =>
      request.method === "PATCH"
    );
    assertEquals(patches.length, 1);
    assertEquals(
      await store.get("generation-2/devices/abc/1.bin"),
      bytes("batch one"),
    );
    assertEquals(await store.get("generation-2/protocol.json"), bytes("{}"));
    assertEquals(await store.list("generation-1/"), []);
  });
});

Deno.test("makeDirectory creates every missing parent along the path", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.makeDirectory("devices/abc/changes/");

    for (const path of ["devices", "devices/abc", "devices/abc/changes"]) {
      const found = drive.lookup(`${DIRECTORY}/${path}`);
      assertEquals(found.length, 1, `expected exactly one ${path}`);
      assertEquals(found[0].mimeType, FOLDER_MIME_TYPE);
    }
  });
});

Deno.test("verifyUpload accepts the length Drive really holds and rejects any other", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.put("1.bin", bytes("0123456789"));
    await store.verifyUpload("1.bin", 10);

    const wrong = await assertRejects(
      () => store.verifyUpload("1.bin", 11),
      SyncError,
    );
    assertEquals(wrong.code, "corrupt-data");
    assert(wrong.message.includes("holds 10 bytes"));

    const missing = await assertRejects(
      () => store.verifyUpload("2.bin", 10),
      SyncError,
    );
    assertEquals(missing.code, "corrupt-data");
  });
});

Deno.test("scope confines a store to a subdirectory of the repository", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    const staging = store.scope("rebuild");
    await staging.put("protocol.json", bytes("staged"));

    assertEquals(
      drive.lookup(`${DIRECTORY}/rebuild/protocol.json`).length,
      1,
    );
    assertEquals(await staging.get("protocol.json"), bytes("staged"));
    assertEquals(await store.get("rebuild/protocol.json"), bytes("staged"));
    assertEquals(
      (await staging.list("")).map((entry) => entry.path),
      ["protocol.json"],
    );
  });
});

Deno.test("create writes the bytes when the path is free", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.create("devices/abc/changes/1.bin", bytes("batch one"));

    assertEquals(
      await store.get("devices/abc/changes/1.bin"),
      bytes("batch one"),
    );
    assertEquals(
      drive.lookup(`${DIRECTORY}/devices/abc/changes/1.bin`).length,
      1,
    );
  });
});

Deno.test("create on a taken path is precondition-failed and leaves the original bytes untouched", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.create("1.bin", bytes("the first batch"));
    drive.clearRequests();

    const error = await assertRejects(
      () => store.create("1.bin", bytes("a second batch")),
      SyncError,
    );
    assertEquals(error.code, "precondition-failed");

    // Nothing written: the pre-check found the file and stopped there.
    assertEquals(uploadRequests(drive).length, 0);
    const files = drive.lookup(`${DIRECTORY}/1.bin`);
    assertEquals(files.length, 1);
    assertEquals(await store.get("1.bin"), bytes("the first batch"));
  });
});

Deno.test("when two devices both get past the pre-check, the loser deletes its own file and the winner's bytes survive", async () => {
  await withDrive(async (drive) => {
    const path = "devices/abc/changes/7.bin";
    const winnerBytes = bytes("the batch that was there first");
    const loserBytes = bytes("the batch that lost the race");

    // Each store's settle wait is a hook the test replaces once the folders
    // exist, so connecting and creating the directory do not trip it.
    let winnerSettle: () => Promise<void> = () => Promise.resolve();
    let loserSettle: () => Promise<void> = () => Promise.resolve();
    const winner = await connected(drive, { delay: () => winnerSettle() });
    const loser = await connected(drive, { delay: () => loserSettle() });
    await winner.makeDirectory("devices/abc/changes/");
    await loser.makeDirectory("devices/abc/changes/");

    const uploaded = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    winnerSettle = () => {
      uploaded.resolve();
      return release.promise;
    };

    const winning = winner.create(path, winnerBytes);
    await uploaded.promise;

    // Drive's file list has not caught up with the winner's upload. That
    // window is the only reason a second device can pass the pre-check,
    // and it closes while that device is settling.
    const [first] = drive.lookup(`${DIRECTORY}/${path}`);
    drive.conceal(first.id);
    loserSettle = () => {
      drive.reveal(first.id);
      return Promise.resolve();
    };

    drive.clearRequests();
    const error = await assertRejects(
      () => loser.create(path, loserBytes),
      SyncError,
    );
    assertEquals(error.code, "precondition-failed");

    // It got past the pre-check and really wrote, which is the case this
    // test exists for; a loser that had merely found the path taken would
    // have uploaded nothing and proved nothing.
    assertEquals(uploadRequests(drive).length, 1);
    // And it removed exactly one file: its own. Deleting the winner would
    // lose a journal entry the other device has already recorded as
    // written and will never send again.
    const removals = drive.requests.filter((request) =>
      request.method === "DELETE"
    );
    assertEquals(removals.length, 1);
    assertEquals(removals[0].path.includes(first.id), false);

    release.resolve();
    await winning;

    const survivors = drive.lookup(`${DIRECTORY}/${path}`);
    assertEquals(survivors.length, 1);
    assertEquals(survivors[0].id, first.id);
    assertEquals(survivors[0].content, winnerBytes);

    // Both devices, and a third that never saw the race, agree on which
    // file is the real one.
    assertEquals(await winner.get(path), winnerBytes);
    assertEquals(await loser.get(path), winnerBytes);
    const bystander = await connected(drive);
    assertEquals(await bystander.get(path), winnerBytes);
  });
});

Deno.test("two files sharing a name resolve to the oldest createdTime on every device", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    const parentId = folderId(drive);
    // The older file is given the higher id on purpose: createdTime decides
    // first, and an implementation that sorted by id would read "newer".
    drive.seedFile({
      id: "zzz-older",
      name: "7.bin",
      parentId,
      content: bytes("older"),
      createdTime: "2026-03-01T10:00:00.000Z",
    });
    drive.seedFile({
      id: "aaa-newer",
      name: "7.bin",
      parentId,
      content: bytes("newer"),
      createdTime: "2026-03-01T10:00:05.000Z",
    });

    assertEquals(await store.get("7.bin"), bytes("older"));
    const other = await connected(drive);
    assertEquals(await other.get("7.bin"), bytes("older"));
    // One path, one entry: handing the engine both halves of a duplicate
    // would give it two records at one path.
    const entries = await store.list("");
    assertEquals(entries.filter((entry) => entry.path === "7.bin").length, 1);
  });
});

Deno.test("duplicates created in the same instant are broken by the lowest id, not by listing order", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    const parentId = folderId(drive);
    const createdTime = "2026-03-01T10:00:00.000Z";
    drive.seedFile({
      id: "id-b",
      name: "8.bin",
      parentId,
      content: bytes("bravo"),
      createdTime,
    });
    drive.seedFile({
      id: "id-a",
      name: "8.bin",
      parentId,
      content: bytes("alpha"),
      createdTime,
    });

    assertEquals(await store.get("8.bin"), bytes("alpha"));
    const other = await connected(drive);
    assertEquals(await other.get("8.bin"), bytes("alpha"));
  });
});

Deno.test("a 403 whose reason is userRateLimitExceeded is retried, and Drive's Retry-After is obeyed", async () => {
  await withDrive(async (drive) => {
    const waits: number[] = [];
    const store = await connected(drive, {
      delay: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    waits.length = 0;
    drive.clearRequests();
    drive.injectFailure({
      status: 403,
      reason: "userRateLimitExceeded",
      message: "User Rate Limit Exceeded",
      pathIncludes: "/upload/",
      retryAfterSeconds: 1,
    });

    await store.put("1.bin", bytes("throttled once"));

    assertEquals(uploadRequests(drive).length, 2);
    assertEquals(await store.get("1.bin"), bytes("throttled once"));
    // Drive puts throttling behind a 403, which the shared HTTP client does
    // not read Retry-After for; the adapter has to, and one second is what
    // the server asked for.
    assertEquals(waits, [1000]);
  });
});

Deno.test("a 403 whose reason is rateLimitExceeded is retried", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    drive.clearRequests();
    drive.injectFailure({
      status: 403,
      reason: "rateLimitExceeded",
      message: "Rate Limit Exceeded",
      pathIncludes: "/upload/",
      times: 2,
    });

    await store.put("2.bin", bytes("throttled twice"));

    assertEquals(uploadRequests(drive).length, 3);
    assertEquals(await store.get("2.bin"), bytes("throttled twice"));
  });
});

Deno.test("a 403 that is a real permission failure is reported once and never retried", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    drive.clearRequests();
    drive.injectFailure({
      status: 403,
      reason: "insufficientFilePermissions",
      message: "The user does not have sufficient permissions for this file.",
      pathIncludes: "/upload/",
      times: 10,
    });

    const error = await assertRejects(
      () => store.put("3.bin", bytes("denied")),
      SyncError,
    );
    assertEquals(error.code, "forbidden");
    assertEquals(error.isRetryable, false);
    // Retrying a permission failure would hammer the API four times over
    // for every single request and still fail.
    assertEquals(uploadRequests(drive).length, 1);
    assert(error.message.includes("drive.file"));
  });
});

Deno.test("storageQuotaExceeded is not retryable and points at the Drive trash", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    drive.clearRequests();
    drive.injectFailure({
      status: 403,
      reason: "storageQuotaExceeded",
      message: "The user's Drive storage quota has been exceeded.",
      pathIncludes: "/upload/",
      times: 10,
    });

    const error = await assertRejects(
      () => store.put("4.bin", bytes("no room")),
      SyncError,
    );
    assertEquals(error.code, "forbidden");
    assertEquals(error.isRetryable, false);
    assertEquals(uploadRequests(drive).length, 1);
    // Trashed files keep taking up the quota, so a user who has just
    // deleted a lot of data cannot act on "out of space" without this.
    assert(error.message.includes("drive.google.com/drive/trash"));
  });
});

Deno.test("a small write is one multipart upload request", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    drive.clearRequests();
    const body = new Uint8Array(RESUMABLE_THRESHOLD_BYTES);
    body.fill(7);

    await store.put("small.bin", body);

    assertEquals(
      uploadRequests(drive).map((request) =>
        `${request.method} ${request.params.uploadType}`
      ),
      ["POST multipart"],
    );
    assertEquals(
      await sha256(await store.get("small.bin")),
      await sha256(body),
    );
  });
});

Deno.test("a write past the resumable threshold opens a session and fills it without the bearer token", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    drive.clearRequests();
    const body = new Uint8Array(RESUMABLE_THRESHOLD_BYTES + 1);
    for (let index = 0; index < body.length; index++) body[index] = index % 251;

    await store.put("large.bin", body);

    const uploads = drive.requests.filter((request) =>
      request.path.startsWith("/upload/drive/v3/files")
    );
    assertEquals(uploads.map((request) => request.method), ["POST", "PUT"]);
    assertEquals(uploads[0].params.uploadType, "resumable");
    // The session URI carries its own credential and may live on a host
    // that is not the API, so the content PUT must not carry the token.
    assertEquals(uploads[1].authorized, false);

    const stored = await store.get("large.bin");
    assertEquals(stored.length, body.length);
    // Compared as a digest: a failing assertEquals over five million bytes
    // would try to render a five-million-entry diff.
    assertEquals(await sha256(stored), await sha256(body));
  });
});

Deno.test("resolving a path is cached, so reading it again costs no lookup query", async () => {
  await withDrive(async (drive) => {
    const writer = await connected(drive);
    await writer.put("devices/abc/1.bin", bytes("batch"));

    const reader = await connected(drive);
    drive.clearRequests();
    assertEquals(await reader.get("devices/abc/1.bin"), bytes("batch"));
    // Drive has no paths, so a cold read walks the chain a query at a time:
    // "devices", then "abc", then the file. connect() already resolved the
    // repository folder above them.
    assertEquals(lookupQueries(drive), 3);

    drive.clearRequests();
    assertEquals(await reader.get("devices/abc/1.bin"), bytes("batch"));
    assertEquals(lookupQueries(drive), 0);
  });
});

Deno.test("a delete drops the remembered id, so nothing afterwards addresses the file that is gone", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.create("devices/abc/1.bin", bytes("first generation"));
    // Read it once so the id is certainly in the index before it dies.
    assertEquals(
      await store.get("devices/abc/1.bin"),
      bytes("first generation"),
    );
    const [dead] = drive.lookup(`${DIRECTORY}/devices/abc/1.bin`);

    await store.delete("devices/abc/1.bin");
    drive.clearRequests();

    assertEquals(await store.getIfExists("devices/abc/1.bin"), undefined);
    // A surviving cache entry would send this read at the deleted id first
    // and spend a 404 discovering what the delete already knew.
    assertEquals(
      drive.requests.filter((request) => request.path.includes(dead.id)),
      [],
    );

    await store.create("devices/abc/1.bin", bytes("second generation"));
    assertEquals(
      await store.get("devices/abc/1.bin"),
      bytes("second generation"),
    );
    const [live] = drive.lookup(`${DIRECTORY}/devices/abc/1.bin`);
    assertNotEquals(live.id, dead.id);
    assertEquals(
      drive.requests.filter((request) => request.path.includes(dead.id)),
      [],
    );
  });
});

Deno.test("a remembered id that another device replaced is re-resolved rather than failing", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    await store.put("1.bin", bytes("mine"));
    assertEquals(await store.get("1.bin"), bytes("mine"));
    const [stale] = drive.lookup(`${DIRECTORY}/1.bin`);

    // Deleting and recreating a path between two syncs is what every
    // reconciliation on another device does.
    const other = await connected(drive);
    await other.delete("1.bin");
    await other.put("1.bin", bytes("theirs"));
    drive.clearRequests();

    assertEquals(await store.get("1.bin"), bytes("theirs"));
    // It really did start from the remembered id: without the second look
    // every later request in the session would answer 404.
    assert(
      drive.requests.some((request) => request.path.includes(stale.id)),
      "expected the stale id to be tried before it was re-resolved",
    );
  });
});

Deno.test("a name containing an apostrophe survives Drive's query escaping", async () => {
  await withDrive(async (drive) => {
    const store = await connected(drive);
    // An unescaped apostrophe closes the quoted term in a Drive query and
    // makes the rest of it something else entirely.
    await store.put("don't.bin", bytes("quoted"));

    assertEquals(await store.get("don't.bin"), bytes("quoted"));
    assertEquals(await store.exists("don't.bin"), true);
    assertEquals(
      (await store.list("")).map((entry) => entry.path),
      ["don't.bin"],
    );
  });
});

Deno.test("a store built on another provider's account is refused at construction", () => {
  // No server: a Dropbox grant would send a bearer token Google answers 401
  // to, and the point of the guard is that it fails before any request.
  const drive = new FakeGoogleDrive();
  const client = { provider: "dropbox" as const, clientId: "dropbox-app" };
  const storage: TokenStorage = {
    read: () => Promise.resolve("token"),
    write: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
  const error = assertThrowsSyncError(() =>
    new GoogleDriveStore({
      client,
      tokens: new TokenManager({ client, storage, fetch: drive.fetch }),
      directory: DIRECTORY,
      fetch: drive.fetch,
    })
  );
  assertEquals(error.code, "corrupt-data");
  assert(error.message.includes("dropbox"));
});

function assertThrowsSyncError(operation: () => unknown): SyncError {
  try {
    operation();
  } catch (error) {
    assert(error instanceof SyncError, `expected a SyncError, got ${error}`);
    return error;
  }
  throw new Error("expected the operation to throw");
}
