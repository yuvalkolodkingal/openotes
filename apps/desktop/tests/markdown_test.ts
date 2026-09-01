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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  htmlToMarkdown,
  htmlToText,
  markdownToHtml,
} from "../src/mcp/markdown.ts";

Deno.test("html -> markdown covers the editor's block types", () => {
  assertEquals(htmlToMarkdown("<h2>Title</h2>"), "## Title");
  assertEquals(
    htmlToMarkdown("<p>Hello <strong>world</strong></p>"),
    "Hello **world**",
  );
  assertEquals(htmlToMarkdown("<p>a</p><p>b</p>"), "a\n\nb");
  assertEquals(htmlToMarkdown("<hr>"), "---");
  assertEquals(
    htmlToMarkdown("<ul><li><p>one</p></li><li><p>two</p></li></ul>"),
    "- one\n- two",
  );
  assertEquals(
    htmlToMarkdown('<ol start="3"><li><p>a</p></li><li><p>b</p></li></ol>'),
    "3. a\n4. b",
  );
  assertEquals(
    htmlToMarkdown(
      '<ul class="checklist"><li class="checklist--item checked"><p>done</p></li>' +
        '<li class="checklist--item"><p>todo</p></li></ul>',
    ),
    "- [x] done\n- [ ] todo",
  );
  assertEquals(
    htmlToMarkdown("<blockquote><p>quoted</p></blockquote>"),
    "> quoted",
  );
  assertEquals(
    htmlToMarkdown(
      '<pre class="language-ts"><code>const a = 1;\n</code></pre>',
    ),
    "```ts\nconst a = 1;\n```",
  );
  assertEquals(
    htmlToMarkdown(
      "<table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr>" +
        "<tr><td><p>c</p></td><td><p>d</p></td></tr></tbody></table>",
    ),
    "| a | b |\n| --- | --- |\n| c | d |",
  );
});

Deno.test("html -> markdown handles nested lists and inline marks", () => {
  assertEquals(
    htmlToMarkdown(
      "<ul><li><p>outer</p><ul><li><p>inner</p></li></ul></li></ul>",
    ),
    "- outer\n  - inner",
  );
  assertEquals(
    htmlToMarkdown('<p><a href="https://example.com">link</a></p>'),
    "[link](https://example.com)",
  );
  assertEquals(htmlToMarkdown("<p>a<code>b`c</code>d</p>"), "a``b`c``d");
  assertEquals(htmlToMarkdown("<p><em> spaced </em></p>"), "*spaced*");
  assertEquals(htmlToMarkdown("<p>&amp;lt; &#65; &nbsp;</p>"), "&lt; A");
});

Deno.test("html parsing survives malformed input", () => {
  // A stray close tag must not unwind past the root, and unknown elements
  // are unwrapped rather than dropped.
  assertEquals(htmlToMarkdown("</div><p>kept</p>"), "kept");
  assertEquals(htmlToMarkdown("<p>a<b>b</p>"), "a**b**");
  assertEquals(
    htmlToMarkdown("<custom-tag><p>inside</p></custom-tag>"),
    "inside",
  );
  assertEquals(htmlToMarkdown("<p>5 < 6</p>"), "5 < 6");
  assertEquals(htmlToMarkdown("<script>alert(1)</script><p>safe</p>"), "safe");
});

Deno.test("markdown -> html emits shapes the editor parses", () => {
  assertEquals(markdownToHtml("# Title"), "<h1>Title</h1>");
  assertEquals(markdownToHtml("plain"), "<p>plain</p>");
  assertEquals(
    markdownToHtml("- a\n- b"),
    "<ul><li><p>a</p></li><li><p>b</p></li></ul>",
  );
  assertEquals(
    markdownToHtml("- [x] done\n- [ ] todo"),
    '<ul class="checklist"><li class="checklist--item checked"><p>done</p></li>' +
      '<li class="checklist--item"><p>todo</p></li></ul>',
  );
  assertEquals(
    markdownToHtml("1. a\n2. b"),
    "<ol><li><p>a</p></li><li><p>b</p></li></ol>",
  );
  assertEquals(
    markdownToHtml("> quoted"),
    "<blockquote><p>quoted</p></blockquote>",
  );
  assertEquals(markdownToHtml("---"), "<hr>");
  assertEquals(
    markdownToHtml("```ts\nconst a = 1;\n```"),
    '<pre class="language-ts" data-language="ts"><code>const a = 1;</code></pre>',
  );
  assertEquals(
    markdownToHtml("**bold** and *italic*"),
    "<p><strong>bold</strong> and <em>italic</em></p>",
  );
  assertEquals(markdownToHtml("~~gone~~"), "<p><s>gone</s></p>");
  assertEquals(markdownToHtml("`code`"), "<p><code>code</code></p>");
});

Deno.test("markdown -> html never passes raw markup through", () => {
  // A note is rendered without a sanitizer, and an assistant is not a
  // trusted author of markup.
  const out = markdownToHtml('<img src=x onerror="alert(1)"> & <b>hi</b>');
  assertStringIncludes(out, "&lt;img");
  assertStringIncludes(out, "&amp;");
  assertEquals(out.includes("<b>"), false);
  assertEquals(
    markdownToHtml("[x](javascript:alert(1))").includes('<a href="javascript'),
    true,
    "the converter records the href verbatim; link safety is the renderer's job",
  );
});

Deno.test("markdown round-trips through html", () => {
  const source = [
    "# Heading",
    "",
    "Some **bold** and a [link](https://example.com).",
    "",
    "- one",
    "- two",
    "",
    "- [ ] todo",
    "",
    "> quoted",
    "",
    "```js",
    "let x = 1;",
    "```",
  ].join("\n");
  assertEquals(htmlToMarkdown(markdownToHtml(source)), source);
});

Deno.test("nested list round-trips", () => {
  const source = "- outer\n  - inner\n- second";
  assertEquals(htmlToMarkdown(markdownToHtml(source)), source);
});

Deno.test("htmlToText flattens to a preview", () => {
  assertEquals(
    htmlToText("<h1>Title</h1><p>Body <strong>text</strong></p>"),
    "TitleBody text",
  );
  assertEquals(htmlToText("<p>a<br>b</p>"), "a\nb");
});
