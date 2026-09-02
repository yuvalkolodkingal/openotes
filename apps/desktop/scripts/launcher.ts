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
 * Filling in packaging/linux/openotes-launcher.sh.
 *
 * Separate from build.ts so a test can drive it. 2.2.1 shipped every Linux
 * launcher -- AppImage, .deb, .rpm -- with `exec @TARGET@` still in it: the
 * template's own comment mentioned the placeholders, and a single
 * `String.replace` filled the mention in and left the real lines alone. No
 * package started. The lines are now matched whole, every occurrence is
 * replaced, and a result that still carries a placeholder is refused.
 */

const PRELUDE_LINE = /^@PRELUDE@$/m;
const EXEC_LINE = /^exec @TARGET@ "\$@"$/m;
const UNFILLED_LINE = /^(?:@PRELUDE@|exec @TARGET@.*)$/m;

export function renderLauncherTemplate(
  template: string,
  options: { target: string; prelude?: string },
): string {
  if (!PRELUDE_LINE.test(template) || !EXEC_LINE.test(template)) {
    throw new Error(
      "The launcher template has lost its @PRELUDE@ or exec @TARGET@ line.",
    );
  }
  const rendered = template
    .replaceAll(new RegExp(PRELUDE_LINE, "gm"), () => options.prelude ?? "")
    .replaceAll(
      new RegExp(EXEC_LINE, "gm"),
      () => `exec ${options.target} "$@"`,
    );
  // A comment may still mention a placeholder; a line that *is* one means
  // the launcher would not start anything.
  const leftover = UNFILLED_LINE.exec(rendered);
  if (leftover) {
    throw new Error(
      `The rendered launcher still contains the line "${leftover[0]}"; ` +
        `refusing to package a launcher that cannot start the application.`,
    );
  }
  return rendered;
}

/** The prelude pinning the resource directories under a lib directory. */
export function pinnedResources(libDir: string): string {
  return [
    `OPENOTES_UI_ROOT="\${OPENOTES_UI_ROOT:-${libDir}/ui}"`,
    `OPENOTES_NATIVE_DIR="\${OPENOTES_NATIVE_DIR:-${libDir}/native}"`,
    "export OPENOTES_UI_ROOT OPENOTES_NATIVE_DIR",
  ].join("\n");
}
