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

import { assertEquals, assertRejects } from "@std/assert";
import { type Cipher, NNCrypto } from "@notesnook/crypto";
import { Sodium } from "@notesnook/sodium";
import { JsNNCrypto, JsSodium } from "../src/index.ts";
import { SyncCrypto } from "../../sync-webdav/src/crypto.ts";

/**
 * The whole point of the package: what the phone encrypts, the desktop
 * decrypts, and the other way round. Every case runs the real libsodium
 * on one side and @noble on the other.
 */

const PASSPHRASE = "correct horse battery staple";

Deno.test("the same passphrase and salt derive the same key on both sides", async () => {
  const sodiumSide = new NNCrypto();
  const jsSide = new JsNNCrypto();

  const fromSodium = await sodiumSide.exportKey(PASSPHRASE);
  const fromJs = await jsSide.exportKey(PASSPHRASE, fromSodium.salt);
  assertEquals(fromJs.key, fromSodium.key);
  assertEquals(fromJs.salt, fromSodium.salt);

  // And a salt the JS side generated is one libsodium accepts.
  const jsFirst = await jsSide.exportKey(PASSPHRASE);
  const sodiumAfter = await sodiumSide.exportKey(PASSPHRASE, jsFirst.salt);
  assertEquals(sodiumAfter.key, jsFirst.key);
});

Deno.test("libsodium ciphertext decrypts in JS, and JS ciphertext in libsodium", async () => {
  const sodiumSide = new NNCrypto();
  const jsSide = new JsNNCrypto();
  const key = await sodiumSide.exportKey(PASSPHRASE);

  const fromSodium = await sodiumSide.encrypt(
    key,
    "a note, with ünïcode and emoji 🚀",
    "text",
    "base64",
  );
  assertEquals(
    await jsSide.decrypt(key, fromSodium as Cipher<"base64">, "text"),
    "a note, with ünïcode and emoji 🚀",
  );

  const fromJs = await jsSide.encrypt(
    key,
    "written on the phone",
    "text",
    "base64",
  );
  assertEquals(fromJs.alg, "xcha-argon2i13-7");
  assertEquals(
    await sodiumSide.decrypt(key, fromJs as Cipher<"base64">, "text"),
    "written on the phone",
  );
});

Deno.test("binary payloads cross too, both directions", async () => {
  const sodiumSide = new NNCrypto();
  const jsSide = new JsNNCrypto();
  const key = await jsSide.exportKey(PASSPHRASE);
  const payload = new Uint8Array(4096);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;

  const fromSodium = await sodiumSide.encrypt(
    key,
    payload,
    "uint8array",
    "base64",
  );
  assertEquals(
    await jsSide.decrypt(key, fromSodium as Cipher<"base64">, "uint8array"),
    payload,
  );
  const fromJs = await jsSide.encrypt(key, payload, "uint8array", "base64");
  assertEquals(
    await sodiumSide.decrypt(key, fromJs as Cipher<"base64">, "uint8array"),
    payload,
  );
});

Deno.test("keyed BLAKE2b subkeys and digests agree", async () => {
  const sodium = new Sodium();
  await sodium.initialize();
  const js = new JsSodium();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const message = new TextEncoder().encode("nn-sync-v1");

  assertEquals(
    js.crypto_generichash(32, message, key),
    sodium.crypto_generichash(32, message, key),
  );
  assertEquals(
    js.crypto_generichash(16, message),
    sodium.crypto_generichash(16, message, null),
  );
});

Deno.test("base64 matches libsodium in every variant", async () => {
  const sodium = new Sodium();
  await sodium.initialize();
  const js = new JsSodium();
  for (const length of [0, 1, 2, 3, 31, 32, 33]) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    for (const variant of [1, 3, 5, 7] as const) {
      assertEquals(
        js.to_base64(bytes, variant),
        sodium.to_base64(bytes, variant),
      );
      assertEquals(
        js.from_base64(sodium.to_base64(bytes, variant), variant),
        bytes,
      );
    }
    assertEquals(js.to_base64(bytes), sodium.to_base64(bytes));
  }
});

Deno.test("the sync engine's own crypto runs on the JS build unchanged", async () => {
  // SyncCrypto is what the engine calls; on the phone its imports resolve to
  // the JS build. Here the same class is driven with keys from the JS side
  // and payloads from libsodium, the way a desktop-written journal is read.
  const sync = new SyncCrypto();
  const js = new JsNNCrypto();
  const salt = await sync.generateSalt();
  const master = await sync.deriveMasterKey(PASSPHRASE, salt);
  const jsMaster = await js.exportKey(PASSPHRASE, salt);
  assertEquals(jsMaster.key, master.key);

  const syncKey = await sync.deriveSubkey(master, "sync");
  const record = await sync.encryptJson(syncKey, { hello: "world" });
  assertEquals(
    JSON.parse(
      await js.decrypt(syncKey, record as unknown as Cipher<"base64">, "text"),
    ),
    { hello: "world" },
  );

  await assertRejects(
    () => js.createEncryptionStream(syncKey),
    Error,
    "not available",
  );
});
