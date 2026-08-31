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

import { parseArgs } from "@std/cli/parse-args";
import { APP_ID, APP_NAME, APP_VERSION } from "./constants.ts";

/**
 * The command line, matching upstream's surface so desktop launchers,
 * jump lists and .desktop actions keep working:
 *
 *   openotes                          open the app
 *   openotes --hidden                 start without showing the window
 *   openotes new note|notebook|reminder
 *   openotes open note --id <id>
 *   openotes open notebook --id <id>
 *
 * yargs is a Node-only dependency; @std/cli covers this without it.
 */

export interface CLIOptions {
  note: boolean | string;
  notebook: boolean | string;
  reminder: boolean;
  hidden: boolean;
}

export function parseArguments(argv: string[]): Promise<CLIOptions> {
  const result: CLIOptions = {
    note: false,
    notebook: false,
    reminder: false,
    hidden: false
  };

  const args = parseArgs(argv, {
    boolean: ["hidden", "help", "version"],
    string: ["id", "notebookId"],
    alias: { h: "help", v: "version" },
    // Ignore anything else rather than failing: launchers and the OS add
    // their own flags (a deep-link URL, for instance).
    unknown: () => true
  });

  if (args.help) {
    console.log(usage());
    Deno.exit(0);
  }
  if (args.version) {
    console.log(`${APP_NAME} ${APP_VERSION}`);
    Deno.exit(0);
  }

  result.hidden = !!args.hidden;

  const positional = args._.map(String);
  const [command, subject] = positional;

  if (command === "new") {
    if (subject === "note") result.note = true;
    else if (subject === "notebook") result.notebook = true;
    else if (subject === "reminder") result.reminder = true;
  } else if (command === "open") {
    const id = typeof args.id === "string" ? args.id : undefined;
    if (subject === "note" && id) result.note = id;
    else if (subject === "notebook" && id) result.notebook = id;
  }

  return Promise.resolve(result);
}

function usage(): string {
  return `${APP_NAME} ${APP_VERSION} — an offline-first, end-to-end-encrypted notes app.

Usage:
  ${APP_ID} [options]
  ${APP_ID} new note|notebook|reminder
  ${APP_ID} open note --id <id>
  ${APP_ID} open notebook --id <id>

Options:
  --hidden        Start without showing the window.
  -v, --version   Print the version and exit.
  -h, --help      Print this help and exit.

Environment:
  OPENOTES_DATA_DIR      Override the application data directory.
  OPENOTES_UI_ROOT       Directory holding the built user interface.
  OPENOTES_NATIVE_DIR    Directory holding the bundled native libraries.
  OPENOTES_LOG_LEVEL     error | warn | info | debug | trace (default: info).
  OPENOTES_PORTABLE      Set to 1 to keep data next to the executable.
`;
}
