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
 * The splash screen is the one part of the interface drawn before the theme
 * engine exists.
 *
 * Everything else can lean on the theme: by the time it renders, the engine
 * has written the colour variables into `#theme-colors`. The splash cannot.
 * It is in the served document, so it paints on the first frame, when that
 * stylesheet is still empty and every `var(--…)` in it resolves to nothing —
 * an SVG whose `stroke` is invalid falls back to `none` and whose `fill` is
 * invalid falls back to black. That is a black logo on a black page in dark
 * mode, which is what shipped: invisible, and invisible in a way light mode
 * hides, because black on a pale ground looks deliberate.
 *
 * So: every variable the splash uses must be defined by index.html itself,
 * in both schemes.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const INDEX = fromFileUrl(
  new URL("../../web/src/index.html", import.meta.url),
);
const html = await Deno.readTextFile(INDEX);

/** The inline stylesheets — all the CSS that exists on the first frame. */
function bootStylesheets(document: string): string {
  return [...document.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map((match) => match[1])
    .join("\n");
}

/** Every custom property the boot stylesheets define. */
function definedVariables(css: string, within?: RegExp): Set<string> {
  const names = new Set<string>();
  // Walk rule by rule so a selector filter is possible.
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = rule;
    if (within && !within.test(selector)) continue;
    for (const declaration of body.matchAll(/(--[\w-]+)\s*:/g)) {
      names.add(declaration[1]);
    }
  }
  return names;
}

/** Every variable read by the splash: its own rules, and its markup. */
function splashVariables(document: string, css: string): Set<string> {
  const used = new Set<string>();
  const collect = (text: string) => {
    for (const reference of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
      used.add(reference[1]);
    }
  };

  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/#splash/.test(rule[1])) collect(rule[2]);
  }

  // The splash element, and the symbol it references through <use>: custom
  // properties inherit into a use shadow tree, so the symbol's markup reads
  // the splash's values.
  const splash = /<div id="splash"[\s\S]*?<\/div>/.exec(document);
  assert(splash, "index.html no longer has a #splash element");
  collect(splash[0]);

  const symbolName = /<use href="#([\w-]+)"/.exec(splash[0])?.[1];
  if (symbolName) {
    const symbol = new RegExp(
      `<symbol id="${symbolName}"[\\s\\S]*?</symbol>`,
    ).exec(document);
    assert(symbol, `the splash references #${symbolName}, which is missing`);
    collect(symbol[0]);
  }
  return used;
}

Deno.test("every colour the splash uses is defined before the theme loads", () => {
  const css = bootStylesheets(html);
  const defined = definedVariables(css);
  const missing = [...splashVariables(html, css)].filter((name) =>
    !defined.has(name)
  );
  assertEquals(
    missing,
    [],
    `the splash reads ${missing.join(", ")} but nothing in index.html ` +
      `defines them, so they are empty on the first frame`,
  );
});

Deno.test("the splash has its own values for dark, not only for light", () => {
  // Without a dark branch the light values apply to a dark page, which is
  // how a black logo ends up on a near-black background.
  const css = bootStylesheets(html);
  const dark = definedVariables(css, /#splash/);
  const darkScoped = definedVariables(
    css,
    /data-theme="dark"[^{]*#splash|prefers-color-scheme/,
  );
  assert(dark.size > 0, "the splash defines no colours at all");
  assert(
    darkScoped.size > 0 || /data-theme="dark"[^{]*#splash/.test(css),
    "the splash has no dark-mode values",
  );
});

Deno.test("the splash's dark values are dark, and its light values are light", () => {
  // A regression here is silent: the page still renders, it is just
  // illegible. Compare the ink against the ground it is drawn on.
  const css = bootStylesheets(html);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((rule) => /#splash/.test(rule[1]));

  const readColours = (predicate: (selector: string) => boolean) => {
    const colours: Record<string, string> = {};
    for (const [, selector, body] of rules) {
      if (!predicate(selector)) continue;
      for (
        const declaration of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)
      ) {
        colours[declaration[1]] = declaration[2];
      }
    }
    return colours;
  };

  const light = readColours((selector) =>
    !/data-theme="dark"/.test(selector) && !/not\(\[data-theme="light"\]\)/
      .test(selector)
  );
  const dark = readColours((selector) => /data-theme="dark"/.test(selector));

  for (const [scheme, colours] of [["light", light], ["dark", dark]] as const) {
    for (const ink of ["--heading", "--paragraph"]) {
      const background = colours["--background"];
      const foreground = colours[ink];
      assert(background, `${scheme}: no --background`);
      assert(foreground, `${scheme}: no ${ink}`);
      const ratio = contrast(foreground, background);
      assert(
        ratio >= 4.5,
        `${scheme}: ${ink} ${foreground} on ${background} is ${
          ratio.toFixed(2)
        }:1, below WCAG AA`,
      );
    }
  }
});

function contrast(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
