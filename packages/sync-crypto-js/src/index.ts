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
 * The sync engine's cryptography in pure JavaScript.
 *
 * The desktop derives keys and encrypts with libsodium, through
 * @notesnook/crypto and @notesnook/sodium. libsodium is WebAssembly, and a
 * React Native app has no WebAssembly. Rather than a native module per
 * platform, this reproduces exactly the primitives the sync engine uses --
 * Argon2i for the passphrase, XChaCha20-Poly1305 for every payload, keyed
 * BLAKE2b for subkeys and digests, libsodium's URL-safe unpadded base64 --
 * on the audited @noble implementations, and is checked against libsodium
 * itself in tests/compat_test.ts: a key derived here equals the key derived
 * there, and ciphertext crosses in both directions.
 *
 * The phone imports this in place of the two packages (see
 * apps/mobile/metro.config.js), and the engine above it does not know the
 * difference.
 */

export * from "./sodium.ts";
export * from "./nncrypto.ts";
