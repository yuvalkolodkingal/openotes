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
 * Deno entry point for libsodium.
 *
 * The npm package's own bundled declarations disagree with the
 * DefinitelyTyped ones the upstream code was written against, so the types
 * come from the vendored declarations in ../types instead. The runtime
 * module — and therefore every cryptographic primitive — is the unmodified
 * upstream libsodium-wrappers-sumo build.
 *
 * The root deno.json maps the bare specifier "libsodium-wrappers-sumo" here,
 * so packages/sodium and packages/crypto compile unchanged under Deno.
 */

import sodiumRuntime from "npm:libsodium-wrappers-sumo@0.7.15";

type Sodium = typeof import("../types/libsodium-wrappers-sumo.d.ts");

const sodium = sodiumRuntime as unknown as Sodium;

export default sodium;

export type {
  base64_variants,
  KeyPair,
  MessageTag,
  StateAddress,
  StringKeyPair,
  StringMessageTag,
  StringOutputFormat,
  Uint8ArrayOutputFormat
} from "../types/libsodium-wrappers-sumo.d.ts";
