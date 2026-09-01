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
 * Structural and contrast checks for the shipped themes.
 *
 * These exist because a theme regression is invisible to every other test in
 * the repository: the app renders, nothing throws, and the result is simply
 * unreadable. The dark theme shipped in 1.0 carried light-mode values in its
 * `disabled` variant — a white block in a dark window — and no test noticed.
 *
 * What is checked, and why each threshold is what it is:
 *
 *   - Completeness. Both themes must define the same scopes, so a surface
 *     that is designed in light mode cannot silently fall back to `base` in
 *     dark mode (which is what made the sidebar and status bar look wrong).
 *   - Polarity. Every background in a dark theme must actually be dark, and
 *     every background in a light theme light. This is the check that would
 *     have caught the 1.0 `disabled` variant.
 *   - Contrast, per WCAG 2.1:
 *       1.4.3 (AA, 4.5:1) for body text — `paragraph`, `heading`, and the
 *         label on a filled control (`accentForeground` on `accent`);
 *       1.4.11 (3:1) for meaningful non-text — `icon` and the accent itself.
 *     `disabled` is exempt: 1.4.3 explicitly exempts inactive controls, and a
 *     disabled control that meets AA does not read as disabled.
 *     Hairline `border`/`separator` values are held to perceptibility (1.25:1)
 *     rather than 3:1: they divide panels, they are not controls, and no
 *     mainstream design system passes 3:1 on a 1px divider.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";

const THEME_DIR = fromFileUrl(
  new URL("../src/theme-engine/themes/", import.meta.url),
);

type Colors = Record<string, string>;
type Theme = {
  name: string;
  id: string;
  colorScheme: "light" | "dark";
  scopes: Record<string, Record<string, Colors>>;
};

const VARIANTS = [
  "primary",
  "secondary",
  "disabled",
  "selected",
  "error",
  "success",
] as const;

const COLOR_KEYS = [
  "accent",
  "accentForeground",
  "paragraph",
  "background",
  "border",
  "heading",
  "icon",
  "separator",
  "placeholder",
  "hover",
  "backdrop",
] as const;

function readTheme(file: string): Theme {
  return JSON.parse(Deno.readTextFileSync(THEME_DIR + file));
}

const light = readTheme("default-light.json");
const dark = readTheme("default-dark.json");

// --- colour maths -----------------------------------------------------------

type Rgb = [number, number, number];

/** Parse #rgb / #rgba / #rrggbb / #rrggbbaa, compositing alpha over `under`. */
export function parseColor(value: string, under: Rgb = [255, 255, 255]): Rgb {
  let hex = value.trim().replace(/^#/, "");
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((c) => c + c).join("");
  }
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
    throw new Error(`Not a hex colour: ${JSON.stringify(value)}`);
  }
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16);
  const alpha = hex.length === 8 ? channel(6) / 255 : 1;
  const raw: Rgb = [channel(0), channel(2), channel(4)];
  if (alpha === 1) return raw;
  return raw.map((c, i) =>
    Math.round(c * alpha + under[i] * (1 - alpha))
  ) as Rgb;
}

/** WCAG 2.1 relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const linear = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --- the checks -------------------------------------------------------------

Deno.test("both themes declare the same scopes", () => {
  assertEquals(
    Object.keys(dark.scopes).sort(),
    Object.keys(light.scopes).sort(),
    "A scope defined in one theme but not the other falls back to `base` " +
      "there, so that surface silently loses its design in one mode only.",
  );
});

Deno.test("the base scope is complete in both themes", () => {
  for (const theme of [light, dark]) {
    for (const variant of VARIANTS) {
      const colors = theme.scopes.base[variant];
      assert(colors, `${theme.id}: base.${variant} is missing`);
      for (const key of COLOR_KEYS) {
        assert(
          typeof colors[key] === "string",
          `${theme.id}: base.${variant}.${key} is missing — base is the ` +
            `fallback for every other scope, so it may not have holes`,
        );
      }
    }
  }
});

Deno.test("every colour parses and every background matches the scheme", () => {
  for (const theme of [light, dark]) {
    const page = parseColor(theme.scopes.base.primary.background);
    for (const [scope, variants] of Object.entries(theme.scopes)) {
      for (const [variant, colors] of Object.entries(variants)) {
        for (const [key, value] of Object.entries(colors)) {
          const rgb = parseColor(value, page);
          if (key !== "background") continue;
          const l = luminance(rgb);
          // The 1.0 dark theme had base.disabled.background #fafaf9 — a
          // white block in a dark window. Polarity is the cheapest way to
          // catch a value pasted from the wrong theme.
          if (theme.colorScheme === "dark") {
            assert(
              l < 0.25,
              `${theme.id}: ${scope}.${variant}.background ${value} is too ` +
                `light for a dark theme (luminance ${l.toFixed(3)})`,
            );
          } else {
            assert(
              l > 0.35,
              `${theme.id}: ${scope}.${variant}.background ${value} is too ` +
                `dark for a light theme (luminance ${l.toFixed(3)})`,
            );
          }
        }
      }
    }
  }
});

Deno.test("text and controls meet WCAG AA", () => {
  const failures: string[] = [];

  for (const theme of [light, dark]) {
    const page = parseColor(theme.scopes.base.primary.background);
    for (const [scope, variants] of Object.entries(theme.scopes)) {
      for (const [variant, partial] of Object.entries(variants)) {
        // A scope inherits everything it does not override from the base
        // scope's matching variant — mirror that here or the checks run
        // against colours the app never actually pairs.
        const colors: Colors = {
          ...theme.scopes.base[variant] ?? theme.scopes.base.primary,
          ...partial,
        };
        // WCAG 1.4.3 exempts inactive controls, and a disabled control that
        // meets AA does not read as disabled.
        if (variant === "disabled") continue;

        const bg = parseColor(colors.background, page);
        const check = (fg: string, on: Rgb, need: number, what: string) => {
          const ratio = contrast(parseColor(fg, on), on);
          if (ratio + 1e-9 < need) {
            failures.push(
              `${theme.id} ${scope}.${variant} ${what}: ${ratio.toFixed(2)} ` +
                `(need ${need.toFixed(1)})`,
            );
          }
        };

        check(colors.paragraph, bg, 4.5, "paragraph on background");
        check(colors.heading, bg, 4.5, "heading on background");
        check(colors.icon, bg, 3, "icon on background");
        check(colors.accent, bg, 3, "accent on background");
        check(
          colors.accentForeground,
          parseColor(colors.accent, bg),
          4.5,
          "accentForeground on accent",
        );
        if (variant === "primary" || variant === "secondary") {
          check(colors.placeholder, bg, 4.5, "placeholder on background");
        }
        // Hairlines only have to be visible, not to pass 1.4.11.
        for (const key of ["border", "separator"] as const) {
          check(colors[key], bg, 1.25, `${key} on background`);
        }
      }
    }
  }

  assertEquals(failures, [], `\n  ${failures.join("\n  ")}\n`);
});
