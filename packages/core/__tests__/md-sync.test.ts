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

import { describe, expect, test } from "vitest";
import { parseNoteMarkdown } from "../src/utils/templates/md-parse";
import { templateForSync } from "../src/utils/templates/md";
import { Tiptap } from "../src/content-types/tiptap";

/**
 * The file-per-note sync engine writes these files and reads them back, so a
 * lossy round trip is silent data loss spread across every note the user owns.
 * These tests are the fidelity gate.
 */

const build = (over: Record<string, unknown> = {}) =>
  templateForSync({
    id: "note-id-1",
    title: "Meeting notes",
    dateCreated: Date.UTC(2026, 7, 30, 10, 0, 0),
    dateEdited: Date.UTC(2026, 8, 1, 12, 30, 0),
    content: "Body text.",
    ...over
  } as Parameters<typeof templateForSync>[0]);

describe("front matter round trip", () => {
  test("identity survives, which is what lets the manifest stay local", () => {
    const parsed = parseNoteMarkdown(build());
    expect(parsed.id).toBe("note-id-1");
    expect(parsed.title).toBe("Meeting notes");
  });

  test("dates come back as the same instant", () => {
    const created = Date.UTC(2026, 7, 30, 10, 0, 0);
    const edited = Date.UTC(2026, 8, 1, 12, 30, 0);
    const parsed = parseNoteMarkdown(build());
    expect(parsed.dateCreated).toBe(created);
    expect(parsed.dateEdited).toBe(edited);
  });

  test("a title containing a colon does not break the document", () => {
    const parsed = parseNoteMarkdown(build({ title: "Q3: the reckoning" }));
    expect(parsed.title).toBe("Q3: the reckoning");
  });

  test("a title containing quotes survives", () => {
    const parsed = parseNoteMarkdown(build({ title: 'He said "hello"' }));
    expect(parsed.title).toBe('He said "hello"');
  });

  test("a tag containing a comma is not split in half", () => {
    const parsed = parseNoteMarkdown(
      build({ tags: ["work", "budget, revised", "q3"] })
    );
    expect(parsed.tags).toEqual(["work", "budget, revised", "q3"]);
  });

  test("flags round trip", () => {
    const parsed = parseNoteMarkdown(
      build({ pinned: true, favorite: true, archived: true, color: "blue" })
    );
    expect(parsed.pinned).toBe(true);
    expect(parsed.favorite).toBe(true);
    expect(parsed.archived).toBe(true);
    expect(parsed.color).toBe("blue");
  });

  test("absent flags stay absent rather than becoming false", () => {
    const parsed = parseNoteMarkdown(build());
    expect(parsed.pinned).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
  });

  test("the title heading is not duplicated into the body", () => {
    const parsed = parseNoteMarkdown(build());
    expect(parsed.markdown.trim()).toBe("Body text.");
    expect(parsed.markdown).not.toContain("# Meeting notes");
  });

  test("a heading the user wrote is left alone", () => {
    const source = build({ content: "# A different heading\n\nBody." });
    const parsed = parseNoteMarkdown(source);
    expect(parsed.markdown).toContain("# A different heading");
  });
});

describe("files written by other tools", () => {
  test("a file with no front matter still imports", () => {
    const parsed = parseNoteMarkdown("Just some text I wrote.");
    expect(parsed.id).toBeUndefined();
    expect(parsed.markdown).toBe("Just some text I wrote.");
    expect(parsed.html).toContain("Just some text I wrote.");
  });

  test("hand-written unquoted front matter parses", () => {
    const parsed = parseNoteMarkdown(
      ["---", "title: Shopping", "tags: [food, urgent]", "---", "", "milk"].join(
        "\n"
      )
    );
    expect(parsed.title).toBe("Shopping");
    expect(parsed.tags).toEqual(["food", "urgent"]);
  });

  test("a block sequence, as Obsidian writes it, parses", () => {
    const parsed = parseNoteMarkdown(
      ["---", "title: Notes", "tags:", "  - work", "  - urgent", "---", "", "x"].join(
        "\n"
      )
    );
    expect(parsed.tags).toEqual(["work", "urgent"]);
  });

  test("comma-separated tags, as md-frontmatter writes them, parse", () => {
    const parsed = parseNoteMarkdown(
      ["---", "title: N", "tags: work, urgent", "---", "", "x"].join("\n")
    );
    expect(parsed.tags).toEqual(["work", "urgent"]);
  });

  test("front matter we cannot understand does not block the import", () => {
    const parsed = parseNoteMarkdown(
      ["---", "!!weird", "title: Kept", "  ", "---", "", "body"].join("\n")
    );
    expect(parsed.title).toBe("Kept");
    expect(parsed.markdown.trim()).toBe("body");
  });

  test("CRLF line endings, as Windows produces, parse", () => {
    const parsed = parseNoteMarkdown(
      ["---", 'title: "Windows"', "---", "", "body"].join("\r\n")
    );
    expect(parsed.title).toBe("Windows");
  });
});

describe("HTML to Markdown and back", () => {
  const roundTrip = (html: string) => {
    const md = new Tiptap(html).toMD();
    return parseNoteMarkdown(md).html;
  };

  test("headings, emphasis and links survive", () => {
    const out = roundTrip(
      "<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em> text " +
        'with a <a href="https://example.com">link</a>.</p>'
    );
    expect(out).toContain("<h2");
    expect(out).toMatch(/<(strong|b)>bold<\/(strong|b)>/);
    expect(out).toMatch(/<(em|i)>italic<\/(em|i)>/);
    expect(out).toContain('href="https://example.com"');
  });

  test("lists survive", () => {
    const out = roundTrip("<ul><li>one</li><li>two</li></ul>");
    expect(out).toContain("<ul>");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  test("code blocks keep their content", () => {
    const out = roundTrip("<pre><code>const x = 1;</code></pre>");
    expect(out).toContain("const x = 1;");
  });

  test("blockquotes survive", () => {
    const out = roundTrip("<blockquote><p>quoted</p></blockquote>");
    expect(out).toContain("quoted");
  });

  test("a construct Markdown cannot express survives as raw HTML", () => {
    // Callouts, maths and attributed tables are why raw-HTML passthrough
    // matters: without it these would be silently flattened on every sync.
    const out = roundTrip('<div class="callout" data-type="warning">Careful</div>');
    expect(out).toContain("Careful");
  });
});
