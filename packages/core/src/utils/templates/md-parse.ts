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

import { markdownToHTML } from "../../content-types/tiptap.js";

/**
 * Reads a note file back: front matter plus body.
 *
 * WHY A PURPOSE-BUILT PARSER RATHER THAN A YAML LIBRARY
 *
 * The front matter this must read is written by templateForSync, which emits a
 * deliberately small subset: JSON-encoded scalars, ISO timestamps and flow
 * sequences. Pulling in a full YAML parser to read that would add a dependency
 * and, worse, would accept documents we have no business acting on — anchors,
 * merge keys and custom tags are attack surface in a file the user may have
 * been handed by someone else.
 *
 * It is nevertheless tolerant of front matter a person wrote by hand in
 * another editor: unquoted scalars, single quotes and block sequences all
 * parse. Anything it cannot understand is skipped rather than thrown on,
 * because a file that fails to parse must still import as an ordinary note
 * instead of blocking a sync.
 */
export interface ParsedNote {
  /** Present only when the file carried an id; absent for foreign files. */
  id?: string;
  title?: string;
  dateCreated?: number;
  dateEdited?: number;
  pinned?: boolean;
  favorite?: boolean;
  archived?: boolean;
  color?: string;
  tags?: string[];
  /** Body as HTML, ready to store as note content. */
  html: string;
  /** Body as Markdown, before conversion. */
  markdown: string;
}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseNoteMarkdown(source: string): ParsedNote {
  const match = FRONTMATTER.exec(source);
  const fields = match ? parseFrontmatter(match[1]) : {};
  let body = match ? source.slice(match[0].length) : source;

  const title = stringField(fields, "title");

  // templateForSync writes the title as an H1 immediately after the front
  // matter. Left in place it would be both the note's title and the first line
  // of its body, so every round trip would stack another heading.
  body = stripLeadingHeading(body, title);

  const tags = fields["tags"];
  return {
    id: stringField(fields, "id"),
    title,
    dateCreated: dateField(fields, "created") ?? dateField(fields, "created_at"),
    dateEdited: dateField(fields, "updated") ?? dateField(fields, "updated_at"),
    pinned: boolField(fields, "pinned"),
    favorite: boolField(fields, "favorite"),
    archived: boolField(fields, "archived"),
    color: stringField(fields, "color"),
    tags: Array.isArray(tags)
      ? tags
      : typeof tags === "string" && tags.trim()
      ? tags.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined,
    markdown: body,
    html: markdownToHTML(body)
  };
}

type Fields = Record<string, string | string[]>;

function parseFrontmatter(block: string): Fields {
  const fields: Fields = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const rest = line.slice(colon + 1).trim();

    if (rest.startsWith("[") && rest.endsWith("]")) {
      fields[key] = splitScalars(rest.slice(1, -1));
      continue;
    }

    if (rest === "") {
      // A block sequence written by hand:
      //   tags:
      //     - work
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s*-\s+/, "").trim()));
      }
      if (items.length > 0) fields[key] = items;
      continue;
    }

    fields[key] = unquote(rest);
  }
  return fields;
}

/** Split a flow sequence, respecting quotes so a value may contain a comma. */
function splitScalars(inner: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && i + 1 < inner.length) {
        current += inner[++i] === "n" ? "\n" : inner[i];
        continue;
      }
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      const inner = value.slice(1, -1);
      if (first === '"') {
        try {
          return JSON.parse(value) as string;
        } catch {
          // Not valid JSON despite the quotes; fall back to the raw inner text.
        }
      }
      return inner;
    }
  }
  return value;
}

function stringField(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function boolField(fields: Fields, key: string): boolean | undefined {
  const value = fields[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return undefined;
}

function dateField(fields: Fields, key: string): number | undefined {
  const value = fields[key];
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Drop the body's leading `# Title` when it just repeats the front matter.
 *
 * Only when it matches: a note that genuinely opens with a different heading
 * keeps it, because removing a heading the user wrote would be an edit we were
 * never asked to make.
 */
function stripLeadingHeading(body: string, title: string | undefined): string {
  if (!title) return body;
  const match = /^\s*#[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(body);
  if (!match) return body;
  if (match[1].trim() !== title.trim()) return body;
  return body.slice(match[0].length).replace(/^\r?\n/, "");
}
