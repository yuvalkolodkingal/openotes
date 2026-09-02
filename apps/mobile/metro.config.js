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

// The phone shares the desktop's sync engine, SQL backend and Markdown
// conversion: those packages are imported from the repository by path, and
// the two packages the engine cannot use on a phone -- libsodium, which is
// WebAssembly -- are pointed at the pure-JS implementation in
// packages/sync-crypto-js. Nothing under packages/ is copied or built.

const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const config = getDefaultConfig(__dirname);

const aliases = {
  "@notesnook/crypto": path.join(
    root,
    "packages/sync-crypto-js/src/crypto-alias.ts"
  ),
  "@notesnook/sodium": path.join(
    root,
    "packages/sync-crypto-js/src/sodium-alias.ts"
  ),
  "@notesnook/sync-core": path.join(root, "packages/sync-core/src/index.ts"),
  "@notesnook/sync-sql": path.join(root, "packages/sync-sql/src/index.ts"),
  "@openotes/markdown": path.join(root, "apps/desktop/src/mcp/markdown.ts")
};

config.watchFolders = [root];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const alias = aliases[moduleName];
  if (alias) return { type: "sourceFile", filePath: alias };
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
