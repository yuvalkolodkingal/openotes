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

// Upstream generated the default themes here by fetching them from
// streetwriters/notesnook-themes at build time. Openotes ships its own
// branded themes committed in src/theme-engine/themes/ (they are the source
// of truth, imported directly by the theme engine), so this build must not
// reach out to anyone — the fork contacts no Notesnook infrastructure, and a
// build that silently re-downloaded upstream would also overwrite the
// Openotes palette with Notesnook's green. This step now only asserts the
// committed themes are present.

import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_THEMES = ["default-light", "default-dark"];

const THEMES_DIRECTORY = path.resolve(
  path.join(__dirname, "..", "src", "theme-engine", "themes")
);

function main() {
  const missing = DEFAULT_THEMES.filter(
    (themeId) => !existsSync(path.join(THEMES_DIRECTORY, `${themeId}.json`))
  );

  if (missing.length > 0) {
    console.error(
      `The default theme file(s) ${missing
        .map((id) => `${id}.json`)
        .join(", ")} are missing from ${THEMES_DIRECTORY}.\n` +
        "They are committed to the repository — restore them with " +
        "`git checkout -- packages/theme/src/theme-engine/themes`. " +
        "This build never downloads them."
    );
    process.exit(1);
  }

  console.log("Default themes present:", DEFAULT_THEMES.join(", "));
}

main();
