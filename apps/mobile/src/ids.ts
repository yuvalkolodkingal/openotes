/*
This file is part of the Notesnook project (https://notesnook.com/)

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
 * Item ids in the shape @notesnook/core makes them: a 24-character hex
 * ObjectId -- four bytes of seconds, five of randomness, three of counter --
 * so a note created here sorts and looks like one created on the desktop.
 */
const random = crypto.getRandomValues(new Uint8Array(5));
let counter = crypto.getRandomValues(new Uint8Array(3)).reduce(
  (value, byte) => (value << 8) | byte,
  0
);

export function newId(time = Date.now()): string {
  const seconds = Math.floor(time / 1000);
  counter = (counter + 1) & 0xffffff;
  const bytes = new Uint8Array(12);
  bytes[0] = (seconds >>> 24) & 0xff;
  bytes[1] = (seconds >>> 16) & 0xff;
  bytes[2] = (seconds >>> 8) & 0xff;
  bytes[3] = seconds & 0xff;
  bytes.set(random, 4);
  bytes[9] = (counter >>> 16) & 0xff;
  bytes[10] = (counter >>> 8) & 0xff;
  bytes[11] = counter & 0xff;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** A device id the way the desktop makes one: ten base32 characters. */
export function newDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let id = "";
  for (const byte of bytes) {
    id += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[byte % 32];
  }
  return id;
}
