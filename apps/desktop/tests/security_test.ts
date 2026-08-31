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
 * Tests for the runtime's security boundary: path validation, log
 * redaction, credential storage, and the RPC allowlist. These are the
 * pieces that stand between untrusted renderer content and the filesystem,
 * so they get direct tests rather than being covered incidentally.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  assertInside,
  PathAccessError,
  sanitizeSegment
} from "../src/native/paths.ts";
import { Logger, redactUrl, redactValue } from "../src/native/logger.ts";
import { CredentialStore } from "../src/security/credentials.ts";
import { isKnownProcedure, PROCEDURE_NAMES } from "../src/rpc/protocol.ts";
import { isWriteStatement } from "../src/rpc/handlers.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "openotes-test-" });
  try {
    await fn(await Deno.realPath(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Path validation
// ---------------------------------------------------------------------------

Deno.test("paths inside an allowed root are accepted", async () => {
  await withTempDir(async (root) => {
    await Deno.mkdir(join(root, "backups"), { recursive: true });
    assertEquals(assertInside(join(root, "backups"), [root]), join(root, "backups"));
    assertEquals(
      assertInside(join(root, "backups", "new.enc"), [root]),
      join(root, "backups", "new.enc")
    );
    // A relative path resolves against the first allowed root.
    assertEquals(assertInside("backups/x.enc", [root]), join(root, "backups", "x.enc"));
  });
});

Deno.test("paths outside every allowed root are refused", async () => {
  await withTempDir(async (root) => {
    for (const candidate of [
      "/etc/passwd",
      join(root, "..", "elsewhere"),
      join(root, "..", "..", "etc", "shadow")
    ]) {
      assertThrows(
        () => assertInside(candidate, [root]),
        PathAccessError,
        undefined,
        `expected ${candidate} to be refused`
      );
    }
  });
});

Deno.test("a symlink cannot be used to escape an allowed root", async () => {
  await withTempDir(async (root) => {
    await withTempDir(async (outside) => {
      const secret = join(outside, "secret.txt");
      await Deno.writeTextFile(secret, "not yours");

      const allowed = join(root, "allowed");
      await Deno.mkdir(allowed);
      const link = join(allowed, "escape");
      await Deno.symlink(outside, link);

      // The link itself and anything under it resolve outside the root.
      assertThrows(() => assertInside(link, [allowed]), PathAccessError);
      assertThrows(
        () => assertInside(join(link, "secret.txt"), [allowed]),
        PathAccessError
      );
    });
  });
});

Deno.test("a path with a null byte is refused", async () => {
  await withTempDir(async (root) => {
    assertThrows(() => assertInside(`${root}/a\0b`, [root]), PathAccessError);
    assertThrows(() => assertInside("", [root]), PathAccessError);
  });
});

Deno.test("a not-yet-existing file inside an allowed root is accepted", async () => {
  await withTempDir(async (root) => {
    const target = join(root, "does", "not", "exist", "yet.enc");
    assertEquals(assertInside(target, [root]), target);
  });
});

Deno.test("path segments are sanitized to something a filesystem accepts", () => {
  // Dots survive, because they are legitimate in filenames; separators do
  // not, which is what makes the result a single segment.
  assertEquals(sanitizeSegment("normal-name_1.txt"), "normal-name_1.txt");
  assertEquals(sanitizeSegment("../etc/passwd"), ".._etc_passwd");
  assertEquals(sanitizeSegment("with spaces & symbols!"), "with_spaces___symbols_");

  // The traversal tokens themselves are replaced outright.
  assertEquals(sanitizeSegment(".."), "_");
  assertEquals(sanitizeSegment("."), "_");
  assertEquals(sanitizeSegment(""), "_");

  assertEquals(sanitizeSegment("a".repeat(500)).length, 128);
});

Deno.test("no input makes sanitizeSegment produce a traversing segment", () => {
  // The property that matters: whatever goes in, what comes out is one
  // path segment that cannot climb out of its directory.
  for (const input of [
    "../etc/passwd",
    "..",
    ".",
    "....//....//etc",
    "/absolute/path",
    "C:\\Windows\\System32",
    "a/b/c",
    "a\\b\\c",
    "\u0000null",
    "~/.ssh/id_rsa",
    "",
    "   ",
    "..%2f..%2fetc"
  ]) {
    const output = sanitizeSegment(input);
    assert(!output.includes("/"), `${JSON.stringify(input)} -> ${output}`);
    assert(!output.includes("\\"), `${JSON.stringify(input)} -> ${output}`);
    assert(output !== "." && output !== "..", `${JSON.stringify(input)} -> ${output}`);
    assert(output.length > 0 && output.length <= 128);
  }
});

// ---------------------------------------------------------------------------
// Log redaction
// ---------------------------------------------------------------------------

Deno.test("secrets are redacted by key name", () => {
  const redacted = redactValue("", {
    password: "hunter2",
    passphrase: "correct horse",
    token: "abc123",
    key: "AAAA",
    masterKey: "BBBB",
    content: "the note body",
    title: "Bank details",
    cipher: "encrypted",
    safe: "this is fine"
  }) as Record<string, unknown>;

  for (const secret of [
    "password", "passphrase", "token", "key", "masterKey",
    "content", "title", "cipher"
  ]) {
    assertEquals(redacted[secret], "[redacted]", `${secret} was not redacted`);
  }
  assertEquals(redacted.safe, "this is fine");
});

Deno.test("credentials embedded anywhere in a string are redacted", () => {
  const redacted = redactValue("header", "Basic dXNlcjpwYXNzd29yZA==") as string;
  assert(!redacted.includes("dXNlcjpwYXNzd29yZA=="), redacted);
  assert(redacted.includes("[redacted]"));

  const bearer = redactValue("note", "the header was Bearer eyJhbGciOi.J9") as string;
  assert(!bearer.includes("eyJhbGciOi.J9"), bearer);
});

Deno.test("URLs are stripped of credentials and query strings", () => {
  assertEquals(
    redactUrl("https://user:secret@dav.example.com/files/?token=abc"),
    "https://dav.example.com/files/"
  );
  assertEquals(
    redactUrl("https://dav.example.com/files/Openotes/"),
    "https://dav.example.com/files/Openotes/"
  );
  // Not a parseable URL: the credential pattern is still removed.
  assert(!redactUrl("dav://user:pw@host/path").includes("user:pw"));
});

Deno.test("binary and deeply nested values do not end up in logs verbatim", () => {
  assertEquals(redactValue("blob", new Uint8Array(1024)), "[1024 bytes]");
  const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
  const redacted = JSON.stringify(redactValue("", deep));
  assert(redacted.includes("[nested]"), redacted);
});

Deno.test("the logger writes redacted records and nothing else", async () => {
  await withTempDir(async (dir) => {
    const logger = new Logger({ level: "debug", directory: dir });
    const log = logger.scope("test");
    log.info("Connected to the server", {
      url: "https://user:hunter2@dav.example.com/dav/?t=1",
      password: "hunter2",
      note: "Secret note body",
      attempt: 3
    });
    logger.close();

    const written = await Deno.readTextFile(join(dir, "app.log"));
    assert(!written.includes("hunter2"), "the password reached the log file");
    assert(!written.includes("Secret note body"), "note content reached the log");
    assert(written.includes("Connected to the server"));
    assert(written.includes('"attempt":3'), "safe context was dropped");

    const record = JSON.parse(written.trim().split("\n")[0]);
    assertEquals(record.level, "info");
    assertEquals(record.scope, "test");
  });
});

Deno.test("log level filtering suppresses quieter records", async () => {
  await withTempDir(async (dir) => {
    const logger = new Logger({ level: "warn", directory: dir });
    const log = logger.scope("test");
    log.debug("should not appear");
    log.info("should not appear either");
    log.warn("should appear");
    logger.close();

    const written = await Deno.readTextFile(join(dir, "app.log"));
    assert(!written.includes("should not appear"));
    assert(written.includes("should appear"));
  });
});

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

Deno.test("credentials round-trip and are encrypted at rest", async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore(dir);
    await store.unlockWithPassphrase("the vault passphrase");
    await store.set("webdav.password", "server-password-1234");
    await store.set("webdav.passphrase", "sync-passphrase-5678");

    assertEquals(await store.get("webdav.password"), "server-password-1234");
    assertEquals((await store.keys()).sort(), [
      "webdav.passphrase",
      "webdav.password"
    ]);

    const onDisk = await Deno.readTextFile(join(dir, "credentials.enc"));
    assert(!onDisk.includes("server-password-1234"), "the password is in plaintext");
    assert(!onDisk.includes("sync-passphrase-5678"), "the passphrase is in plaintext");

    // A fresh store with the same passphrase can read them back.
    const reopened = new CredentialStore(dir);
    await reopened.unlockWithPassphrase("the vault passphrase");
    assertEquals(await reopened.get("webdav.password"), "server-password-1234");
  });
});

Deno.test("the wrong passphrase cannot read stored credentials", async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore(dir);
    await store.unlockWithPassphrase("the right passphrase");
    await store.set("webdav.password", "secret");

    const attacker = new CredentialStore(dir);
    await attacker.unlockWithPassphrase("the wrong passphrase");
    const error = await assertRejects(() => attacker.get("webdav.password"));
    assert(error instanceof Error);
    assert(
      error.message.includes("could not be decrypted"),
      error.message
    );
  });
});

Deno.test("a locked store refuses to read or write", async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore(dir);
    await store.unlockWithPassphrase("passphrase");
    await store.set("k", "v");
    store.lock();

    assertEquals(store.isUnlocked, false);
    await assertRejects(() => store.get("k"), Error, "locked");
    await assertRejects(() => store.set("k", "v2"), Error, "locked");
  });
});

Deno.test("the machine-key mode works without a passphrase", async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore(dir);
    await store.unlockWithMachineKey();
    await store.set("webdav.password", "background-sync-password");

    const reopened = new CredentialStore(dir);
    await reopened.unlockWithMachineKey();
    assertEquals(
      await reopened.get("webdav.password"),
      "background-sync-password"
    );

    // The machine key file is not world-readable.
    if (Deno.build.os !== "windows") {
      const info = await Deno.stat(join(dir, "machine.key"));
      assertEquals((info.mode ?? 0) & 0o077, 0, "machine.key is group/other readable");
    }
  });
});

Deno.test("a store written with one mode is not read with the other", async () => {
  await withTempDir(async (dir) => {
    const vault = new CredentialStore(dir);
    await vault.unlockWithPassphrase("passphrase");
    await vault.set("k", "v");

    const machine = new CredentialStore(dir);
    await machine.unlockWithMachineKey();
    const error = await assertRejects(() => machine.get("k"), Error);
    assert(
      error.message.includes("locked with the vault key"),
      error.message
    );
  });
});

Deno.test("re-wrapping keeps the secrets and changes the key", async () => {
  await withTempDir(async (dir) => {
    const store = new CredentialStore(dir);
    await store.unlockWithPassphrase("old passphrase");
    await store.set("webdav.password", "unchanged");

    await store.rewrap("new passphrase", "vault");
    assertEquals(await store.get("webdav.password"), "unchanged");

    const withNew = new CredentialStore(dir);
    await withNew.unlockWithPassphrase("new passphrase");
    assertEquals(await withNew.get("webdav.password"), "unchanged");

    const withOld = new CredentialStore(dir);
    await withOld.unlockWithPassphrase("old passphrase");
    await assertRejects(() => withOld.get("webdav.password"));
  });
});

Deno.test("a corrupt credentials file is reported, not silently ignored", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "credentials.enc"), "{not json");
    const store = new CredentialStore(dir);
    await store.unlockWithPassphrase("passphrase");
    const error = await assertRejects(() => store.get("anything"), Error);
    assert(error.message.includes("corrupt"), error.message);
  });
});

// ---------------------------------------------------------------------------
// The RPC allowlist
// ---------------------------------------------------------------------------

Deno.test("only allowlisted procedures are recognized", () => {
  assert(isKnownProcedure("sqlite.run"));
  assert(isKnownProcedure("webdav.syncNow"));
  assert(isKnownProcedure("backup.restore"));

  for (const forbidden of [
    "shell.exec",
    "fs.readAnyFile",
    "eval",
    "sqlite.run ",
    "SQLITE.RUN",
    "__proto__",
    "constructor",
    "toString",
    ""
  ]) {
    assertEquals(
      isKnownProcedure(forbidden),
      false,
      `${JSON.stringify(forbidden)} should not be a known procedure`
    );
  }
});

Deno.test("the procedure list has no duplicates and no dangerous names", () => {
  const seen = new Set<string>();
  for (const name of PROCEDURE_NAMES) {
    assertEquals(seen.has(name), false, `duplicate procedure: ${name}`);
    seen.add(name);
    assert(
      /^[a-zA-Z]+\.[a-zA-Z]+$/.test(name),
      `procedure name is not namespace.procedure: ${name}`
    );
  }
  for (const dangerous of ["exec", "shell", "eval", "spawn", "readAnyFile"]) {
    for (const name of PROCEDURE_NAMES) {
      assert(
        !name.toLowerCase().includes(dangerous),
        `procedure ${name} looks like an arbitrary-execution binding`
      );
    }
  }
});

Deno.test("write statements are recognized so sync is notified", () => {
  for (const sql of [
    "INSERT INTO notes VALUES (1)",
    "  update notes set title = 'x'",
    "DELETE FROM notes",
    "replace into notes values (1)",
    "CREATE TABLE t (id)",
    "\n\tinsert into content values (1)"
  ]) {
    assertEquals(isWriteStatement(sql), true, sql);
  }
  for (const sql of [
    "SELECT * FROM notes",
    "  select 1",
    "PRAGMA table_info(notes)",
    "BEGIN",
    "",
    null,
    undefined,
    42
  ]) {
    assertEquals(isWriteStatement(sql), false, String(sql));
  }
});
