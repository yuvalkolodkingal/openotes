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

import { assert, assertStringIncludes } from "@std/assert";
import { injectBootTheme } from "../src/native/server.ts";

const DOCUMENT = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Openotes</title>
  </head>
  <body><div id="root"></div></body>
</html>`;

Deno.test("the boot theme is stamped into the served document", () => {
  const dark = injectBootTheme(DOCUMENT, "dark");
  assertStringIncludes(dark, '<html data-theme="dark" lang="en">');
  assertStringIncludes(dark, "color-scheme:dark");
  assertStringIncludes(dark, "background-color:#171412");
  assert(
    dark.indexOf("boot-theme") < dark.indexOf("</head>"),
    "the boot style must land inside <head>, before the body paints",
  );

  const light = injectBootTheme(DOCUMENT, "light");
  assertStringIncludes(light, '<html data-theme="light" lang="en">');
  assertStringIncludes(light, "background-color:#fafaf9");
});

Deno.test("an existing data-theme is replaced, not duplicated", () => {
  const once = injectBootTheme(
    `<html data-theme="light"><head></head><body></body></html>`,
    "dark",
  );
  assertStringIncludes(once, 'data-theme="dark"');
  assert(
    once.match(/data-theme=/g)?.length === 1,
    `expected exactly one data-theme attribute, got: ${once}`,
  );
});

Deno.test("a document without a head still gets the boot theme", () => {
  const out = injectBootTheme("<html><body>hi</body></html>", "dark");
  assertStringIncludes(out, "boot-theme");
});
