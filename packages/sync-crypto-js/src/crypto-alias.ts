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
 * What "@notesnook/crypto" resolves to on the phone.
 *
 * apps/mobile/metro.config.js points the package name here, so the sync
 * engine's `import { NNCrypto } from "@notesnook/crypto"` gets the pure-JS
 * implementation without a line of the engine changing.
 */

export { JsNNCrypto as NNCrypto } from "./nncrypto.ts";
export type { Cipher, DataFormat, SerializedKey } from "./nncrypto.ts";
