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
 * PKCE (RFC 7636) and the CSRF `state`, for the loopback authorization-code
 * flow all three providers use.
 *
 * A desktop app redirects to http://127.0.0.1:<port>/ and any other process
 * on the machine can race to that port or watch the browser's history, so
 * the authorization code alone is not enough to protect the account. PKCE
 * binds the code to this run: the code is worthless without the verifier,
 * which never leaves the process. Only S256 is implemented — the "plain"
 * method puts the verifier in the authorization URL, which is exactly the
 * place we are assuming leaks.
 */

import { encodeBase64Url } from "@std/encoding";
import { SyncError } from "@notesnook/sync-remote";

/** RFC 7636 §4.1 bounds on the verifier. */
export const MIN_VERIFIER_LENGTH = 43;
export const MAX_VERIFIER_LENGTH = 128;

/** 43 characters carries 256 bits; more is allowed and buys nothing. */
const DEFAULT_VERIFIER_LENGTH = 64;

/** Characters in a `state`. Long enough that guessing is hopeless. */
const STATE_LENGTH = 32;

/**
 * The base64url alphabet, which is a subset of RFC 7636's unreserved set,
 * so a verifier built from it never needs escaping in a form body. Its
 * length divides 256 exactly, which is what lets `randomString` map a
 * random byte onto a character with no modulo bias.
 */
const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface PkceChallenge {
  /** Kept in memory until the code is exchanged, then discarded. */
  verifier: string;
  /** Sent in the authorization request. */
  challenge: string;
  method: "S256";
}

/**
 * A fresh code verifier. `length` is a character count, not a byte count,
 * because that is what RFC 7636 bounds.
 */
export function createCodeVerifier(
  length: number = DEFAULT_VERIFIER_LENGTH,
): string {
  if (
    !Number.isInteger(length) ||
    length < MIN_VERIFIER_LENGTH ||
    length > MAX_VERIFIER_LENGTH
  ) {
    throw new SyncError(
      `PKCE verifier length must be an integer between ` +
        `${MIN_VERIFIER_LENGTH} and ${MAX_VERIFIER_LENGTH}, got ${length}`,
      "corrupt-data",
    );
  }
  return randomString(length);
}

/** base64url(SHA-256(ascii(verifier))), unpadded — RFC 7636 §4.2. */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  // encodeBase64Url omits the "=" padding, which the RFC requires stripped.
  return encodeBase64Url(new Uint8Array(digest));
}

/** The pair to start an authorization request with. */
export async function createPkceChallenge(
  length: number = DEFAULT_VERIFIER_LENGTH,
): Promise<PkceChallenge> {
  const verifier = createCodeVerifier(length);
  return {
    verifier,
    challenge: await createCodeChallenge(verifier),
    method: "S256",
  };
}

/**
 * A CSRF `state`. PKCE proves the code belongs to our request; `state`
 * proves the redirect that arrived at the loopback server is the answer to
 * it, so a request forged by anything else on the machine is dropped before
 * its code is ever exchanged.
 */
export function createState(): string {
  return randomString(STATE_LENGTH);
}

/**
 * Compare the `state` we sent with the one that came back, in time that
 * does not depend on how many leading characters match. An attacker who can
 * hit the loopback server repeatedly could otherwise recover the expected
 * value one character at a time from the timing of the rejection.
 */
export function statesMatch(expected: string, received: string): boolean {
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(received);
  // Folding the lengths in rather than returning early keeps the loop from
  // being the thing that reveals how long the expected value is.
  let difference = a.length ^ b.length;
  const width = Math.max(a.length, b.length);
  for (let i = 0; i < width; i++) {
    difference |= (i < a.length ? a[i] : 0) ^ (i < b.length ? b[i] : 0);
  }
  return difference === 0;
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}
