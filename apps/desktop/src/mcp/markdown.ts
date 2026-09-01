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
 * Markdown <-> note HTML, for the MCP tools.
 *
 * Notes are stored as the HTML the editor produces (ProseMirror/tiptap). An
 * assistant reading a note wants Markdown, and writing HTML by hand is how
 * you end up with a note the editor cannot open. So the MCP boundary
 * converts, and `format: "html"` stays available for callers that need the
 * stored bytes exactly.
 *
 * There is no DOM in the runtime and no HTML parser is vendored, so this
 * carries a small tolerant scanner instead. It is written for the editor's
 * own output — well-formed, machine-generated markup — but note content can
 * also come from an import or a paste, so unknown tags are unwrapped rather
 * than rejected and unbalanced ones cannot unwind the stack past its base.
 *
 * The conversion is deliberately lossy in one direction only: HTML the
 * editor supports but Markdown cannot express (colours, highlights, task
 * "indeterminate" state, math, attachments) survives a read as text, and the
 * tool description tells callers that writing Markdown replaces the block
 * structure it describes. Nothing here silently drops a whole node.
 */

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Tags whose content is text, not markup. */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

export interface HtmlElement {
  type: "element";
  tag: string;
  attributes: Record<string, string>;
  children: HtmlNode[];
}

export interface HtmlText {
  type: "text";
  value: string;
}

export type HtmlNode = HtmlElement | HtmlText;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (all, body: string) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
        try {
          return String.fromCodePoint(code);
        } catch {
          return all;
        }
      }
      return ENTITIES[body.toLowerCase()] ?? all;
    },
  );
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Parse a fragment into a node tree. Never throws on malformed input. */
export function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = {
    type: "element",
    tag: "#root",
    attributes: {},
    children: [],
  };
  const stack: HtmlElement[] = [root];
  const top = () => stack[stack.length - 1];

  let index = 0;
  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next < 0) {
      pushText(top(), html.slice(index));
      break;
    }
    if (next > index) pushText(top(), html.slice(index, next));

    // Comments, doctypes and CDATA carry nothing we want.
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
      const end = html.indexOf(">", next);
      index = end < 0 ? html.length : end + 1;
      continue;
    }

    const match =
      /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/
        .exec(html.slice(next));
    if (!match) {
      // A bare "<" in text. Keep it rather than losing the character.
      pushText(top(), "<");
      index = next + 1;
      continue;
    }

    const [raw, closing, rawTag, rawAttributes] = match;
    const tag = rawTag.toLowerCase();
    index = next + raw.length;

    if (closing) {
      // Unwind to the matching open tag if there is one; ignore the tag
      // entirely if there is not, so a stray </div> cannot pop the root.
      const at = stack.findLastIndex((node) => node.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }

    const element: HtmlElement = {
      type: "element",
      tag,
      attributes: parseAttributes(rawAttributes),
      children: [],
    };
    top().children.push(element);

    if (VOID_TAGS.has(tag) || /\/\s*$/.test(rawAttributes)) continue;

    if (RAW_TEXT_TAGS.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, index);
      const end = close < 0 ? html.length : close;
      // Deliberately dropped: nothing in a note should carry script or style.
      index = end;
      const after = html.indexOf(">", end);
      index = after < 0 ? html.length : after + 1;
      continue;
    }

    stack.push(element);
  }

  return root.children;
}

function pushText(parent: HtmlElement, value: string) {
  if (!value) return;
  parent.children.push({ type: "text", value: decodeEntities(value) });
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const [, name, dq, sq, bare] = match;
    attributes[name.toLowerCase()] = decodeEntities(dq ?? sq ?? bare ?? "");
  }
  return attributes;
}

// ---------------------------------------------------------------------------
// HTML -> Markdown
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

interface InlineContext {
  /** Inside a table cell: newlines would break the row. */
  tight?: boolean;
}

export function htmlToMarkdown(html: string): string {
  const nodes = parseHtml(html);
  const out = blocksToMarkdown(nodes, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function blocksToMarkdown(nodes: HtmlNode[], indent: string): string {
  const parts: string[] = [];
  let inline: HtmlNode[] = [];

  const flushInline = () => {
    if (!inline.length) return;
    const text = inlineToMarkdown(inline, {}).trim();
    inline = [];
    if (text) parts.push(indent + text);
  };

  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value.trim()) inline.push(node);
      continue;
    }
    if (!BLOCK_TAGS.has(node.tag)) {
      inline.push(node);
      continue;
    }
    flushInline();
    const block = blockToMarkdown(node, indent);
    if (block) parts.push(block);
  }
  flushInline();

  return parts.join("\n\n");
}

function blockToMarkdown(node: HtmlElement, indent: string): string {
  switch (node.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(node.tag[1]);
      const text = inlineToMarkdown(node.children, {}).trim();
      return text ? `${indent}${"#".repeat(level)} ${text}` : "";
    }
    case "hr":
      return `${indent}---`;
    case "pre": {
      const code = node.children.find(
        (child): child is HtmlElement =>
          child.type === "element" && child.tag === "code",
      );
      // tiptap puts the language on the <pre>; a pasted highlight.js block
      // puts it on the <code>. Look at both.
      const language = languageOf(node) || (code ? languageOf(code) : "");
      const body = textContent(code ? code.children : node.children)
        .replace(/\n$/, "");
      const fence = body.includes("```") ? "````" : "```";
      return [
        `${indent}${fence}${language}`,
        ...body.split("\n").map((line) => indent + line),
        `${indent}${fence}`,
      ].join("\n");
    }
    case "blockquote": {
      const inner = blocksToMarkdown(node.children, "");
      return inner
        .split("\n")
        .map((line) => `${indent}> ${line}`.trimEnd())
        .join("\n");
    }
    case "ul":
    case "ol":
      return listToMarkdown(node, indent);
    case "table":
      return tableToMarkdown(node, indent);
    case "li":
      // A stray <li> outside a list; treat it as a bullet.
      return `${indent}- ${inlineToMarkdown(node.children, {}).trim()}`;
    case "p": {
      const text = inlineToMarkdown(node.children, {}).trim();
      return text ? indent + text : "";
    }
    default:
      return blocksToMarkdown(node.children, indent);
  }
}

function languageOf(node: HtmlElement): string {
  const source = `${node.attributes["class"] ?? ""} ${
    node.attributes["data-language"] ?? ""
  }`;
  const fromClass = /language-([a-zA-Z0-9+#-]+)/.exec(source);
  if (fromClass) return fromClass[1];
  const explicit = node.attributes["data-language"];
  return explicit ? explicit.trim() : "";
}

function listToMarkdown(list: HtmlElement, indent: string): string {
  const ordered = list.tag === "ol";
  const checklist = (list.attributes["class"] ?? "").includes("checklist");
  const start = Number(list.attributes["start"] ?? "1") || 1;
  const rows: string[] = [];
  let number = start;

  for (const child of list.children) {
    if (child.type !== "element" || child.tag !== "li") continue;

    const nested: HtmlElement[] = [];
    const own: HtmlNode[] = [];
    for (const grandchild of child.children) {
      if (
        grandchild.type === "element" &&
        (grandchild.tag === "ul" || grandchild.tag === "ol")
      ) {
        nested.push(grandchild);
      } else own.push(grandchild);
    }

    let marker = ordered ? `${number++}.` : "-";
    if (checklist) {
      const checked = (child.attributes["class"] ?? "").split(/\s+/)
        .includes("checked");
      marker = `- [${checked ? "x" : " "}]`;
    }

    const body = blocksToMarkdown(own, "").trim() ||
      inlineToMarkdown(own, {}).trim();
    const continuation = " ".repeat(marker.length + 1);
    const lines = body.split("\n");
    rows.push(
      `${indent}${marker} ${lines[0] ?? ""}`.trimEnd(),
      ...lines.slice(1).map((line) =>
        `${indent}${continuation}${line}`.trimEnd()
      ),
    );
    for (const sublist of nested) {
      rows.push(listToMarkdown(sublist, indent + continuation));
    }
  }
  return rows.join("\n");
}

function tableToMarkdown(table: HtmlElement, indent: string): string {
  const rows: string[][] = [];
  const collect = (node: HtmlNode) => {
    if (node.type !== "element") return;
    if (node.tag === "tr") {
      rows.push(
        node.children
          .filter(
            (cell): cell is HtmlElement =>
              cell.type === "element" &&
              (cell.tag === "td" || cell.tag === "th"),
          )
          .map((cell) =>
            inlineToMarkdown(cell.children, { tight: true })
              .replace(/\|/g, "\\|")
              .trim()
          ),
      );
      return;
    }
    node.children.forEach(collect);
  };
  table.children.forEach(collect);
  if (!rows.length) return "";

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) =>
    `${indent}| ${
      Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")
    } |`;

  return [
    pad(rows[0]),
    `${indent}|${" --- |".repeat(width)}`,
    ...rows.slice(1).map(pad),
  ].join("\n");
}

function inlineToMarkdown(nodes: HtmlNode[], context: InlineContext): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += context.tight ? node.value.replace(/\s+/g, " ") : node.value;
      continue;
    }
    switch (node.tag) {
      case "br":
        out += context.tight ? " " : "  \n";
        break;
      case "strong":
      case "b":
        out += wrap("**", inlineToMarkdown(node.children, context));
        break;
      case "em":
      case "i":
        out += wrap("*", inlineToMarkdown(node.children, context));
        break;
      case "s":
      case "del":
      case "strike":
        out += wrap("~~", inlineToMarkdown(node.children, context));
        break;
      case "code": {
        const text = textContent(node.children);
        const ticks = "`".repeat(longestRun(text, "`") + 1);
        out += text ? `${ticks}${text}${ticks}` : "";
        break;
      }
      case "a": {
        const href = node.attributes["href"] ?? "";
        const label = inlineToMarkdown(node.children, context).trim();
        out += href ? `[${label || href}](${href})` : label;
        break;
      }
      case "img": {
        const source = node.attributes["src"] ??
          node.attributes["data-hash"] ?? "";
        const alt = node.attributes["alt"] ?? "";
        out += `![${alt}](${source})`;
        break;
      }
      default:
        out += inlineToMarkdown(node.children, context);
    }
  }
  return out;
}

/** `**` around empty content produces `****`, which renders as literal text. */
function wrap(marker: string, body: string): string {
  if (!body.trim()) return body;
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(body)!;
  return `${lead}${marker}${core}${marker}${trail}`;
}

function longestRun(value: string, character: string): number {
  let best = 0;
  let run = 0;
  for (const char of value) {
    run = char === character ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function textContent(nodes: HtmlNode[]): string {
  return nodes
    .map((node) =>
      node.type === "text"
        ? node.value
        : node.tag === "br"
        ? "\n"
        : textContent(node.children)
    )
    .join("");
}

/** Plain text of a note, for previews and headlines. */
export function htmlToText(html: string): string {
  const blocks = parseHtml(html);
  return textContent(blocks).replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Markdown -> HTML
// ---------------------------------------------------------------------------

/**
 * The inverse, emitting the shapes the editor's own parsers recognise:
 * paragraphs inside list items, `ul.checklist > li.checklist--item.checked`
 * for task lists, and `pre > code` for fenced blocks.
 *
 * This is a block-first CommonMark subset — headings, lists (bullet, ordered
 * and task, nested), blockquotes, fenced and indented code, thematic breaks,
 * pipe tables — plus the inline marks the editor has: strong, emphasis,
 * strikethrough, code, links and images. Setext headings, reference links,
 * footnotes and raw HTML blocks are not supported; raw HTML in the source is
 * escaped rather than passed through, because a note is rendered without a
 * sanitizer and an assistant is not a trusted author of markup.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  return renderBlocks(lines).join("");
}

function renderBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    // Fenced code.
    const fence = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/.exec(line);
    if (fence) {
      const [, , marker, language] = fence;
      const body: string[] = [];
      index++;
      while (
        index < lines.length &&
        !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(
          lines[index],
        )
      ) {
        body.push(lines[index++]);
      }
      index++; // the closing fence, or the end of input
      const attributes = language
        ? ` class="language-${escapeAttribute(language)}" data-language="${
          escapeAttribute(language)
        }"`
        : "";
      out.push(
        `<pre${attributes}><code>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // ATX heading.
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index++;
      continue;
    }

    // Thematic break.
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      out.push("<hr>");
      index++;
      continue;
    }

    // Blockquote: strip one level of "> " and recurse.
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        body.push(lines[index++].replace(/^\s{0,3}>\s?/, ""));
      }
      out.push(`<blockquote>${renderBlocks(body).join("")}</blockquote>`);
      continue;
    }

    // Table: a header row followed by a delimiter row.
    if (
      line.includes("|") && index + 1 < lines.length &&
      /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[index + 1])
    ) {
      const rows: string[][] = [];
      const header = splitRow(line);
      index += 2;
      while (index < lines.length && lines[index].includes("|")) {
        rows.push(splitRow(lines[index++]));
      }
      const cells = (row: string[], tag: "th" | "td") =>
        row
          .map((cell) => `<${tag}><p>${renderInline(cell)}</p></${tag}>`)
          .join("");
      out.push(
        `<table><thead><tr>${cells(header, "th")}</tr></thead><tbody>` +
          rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("") +
          `</tbody></table>`,
      );
      continue;
    }

    if (bulletOf(line) || orderedOf(line)) {
      const [html, next] = renderList(lines, index);
      out.push(html);
      index = next;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (
      index < lines.length && lines[index].trim() &&
      !startsBlock(lines[index])
    ) {
      paragraph.push(lines[index++]);
    }
    if (!paragraph.length) {
      // `startsBlock` matched something the branches above did not consume;
      // take the line as text so the loop cannot spin.
      paragraph.push(lines[index++]);
    }
    out.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
  }

  return out;
}

function startsBlock(line: string): boolean {
  return (
    /^(\s*)(`{3,}|~{3,})/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s{0,3}>/.test(line) ||
    /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line) ||
    !!bulletOf(line) ||
    !!orderedOf(line)
  );
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

interface Marker {
  indent: number;
  /** Characters before the item's content, including the trailing space. */
  width: number;
  ordered: boolean;
  start: number;
  task?: boolean;
  checked?: boolean;
}

function bulletOf(line: string): Marker | undefined {
  const match = /^(\s*)([-*+])\s+(\[( |x|X)\]\s+)?/.exec(line);
  if (!match) return undefined;
  return {
    indent: match[1].length,
    width: match[0].length,
    ordered: false,
    start: 1,
    task: !!match[3],
    checked: match[4]?.toLowerCase() === "x",
  };
}

function orderedOf(line: string): Marker | undefined {
  const match = /^(\s*)(\d{1,9})[.)]\s+/.exec(line);
  if (!match) return undefined;
  return {
    indent: match[1].length,
    width: match[0].length,
    ordered: true,
    start: Number(match[2]),
  };
}

function markerOf(line: string): Marker | undefined {
  return bulletOf(line) ?? orderedOf(line);
}

/** Render one list starting at `from`; returns the html and the next index. */
function renderList(lines: string[], from: number): [string, number] {
  const first = markerOf(lines[from])!;
  const items: string[] = [];
  let index = from;

  while (index < lines.length) {
    const marker = markerOf(lines[index]);
    if (!marker || marker.indent < first.indent) break;
    // A deeper marker belongs to a nested list, handled inside the item.
    if (marker.indent > first.indent) break;
    if (marker.ordered !== first.ordered || !!marker.task !== !!first.task) {
      break;
    }

    const body: string[] = [lines[index].slice(marker.width)];
    index++;
    // Continuation lines: anything indented past the marker, and blank lines
    // that are followed by more of the same item.
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        const following = lines[index + 1];
        if (
          following && /^\s+\S/.test(following) &&
          (following.length - following.trimStart().length) >= marker.width
        ) {
          body.push("");
          index++;
          continue;
        }
        break;
      }
      const indent = line.length - line.trimStart().length;
      if (
        indent >= marker.width || (markerOf(line)?.indent ?? 0) > first.indent
      ) {
        body.push(line.slice(Math.min(indent, marker.width)));
        index++;
        continue;
      }
      break;
    }

    const inner = renderBlocks(body).join("") || "<p></p>";
    if (first.task) {
      items.push(
        `<li class="checklist--item${
          marker.checked ? " checked" : ""
        }">${inner}</li>`,
      );
    } else {
      items.push(`<li>${inner}</li>`);
    }
  }

  if (first.task) {
    return [`<ul class="checklist">${items.join("")}</ul>`, index];
  }
  if (first.ordered) {
    const start = first.start === 1 ? "" : ` start="${first.start}"`;
    return [`<ol${start}>${items.join("")}</ol>`, index];
  }
  return [`<ul>${items.join("")}</ul>`, index];
}

/** Inline marks. Code spans win over everything inside them. */
function renderInline(source: string): string {
  const segments: string[] = [];
  let rest = source;

  // Pull code spans out first so their contents are never re-parsed.
  const codePattern = /(`+)([\s\S]*?)\1/;
  while (true) {
    const match = codePattern.exec(rest);
    if (!match) break;
    segments.push(marks(escapeHtml(rest.slice(0, match.index))));
    segments.push(`<code>${escapeHtml(match[2].trim())}</code>`);
    rest = rest.slice(match.index + match[0].length);
  }
  segments.push(marks(escapeHtml(rest)));

  return segments.join("").replace(/\n/g, "<br>");
}

/** Applies to already-escaped text, so no user markup can survive. */
function marks(text: string): string {
  return text
    .replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (_all, alt: string, source: string) =>
        `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(alt)}">`,
    )
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (_all, label: string, href: string) =>
        `<a href="${
          escapeAttribute(href)
        }" target="_blank" rel="noopener noreferrer">${label}</a>`,
    )
    .replace(/\*\*\*([^\s*][\s\S]*?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^\s*][\s\S]*?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^\s_][\s\S]*?)__/g, "<strong>$1</strong>")
    .replace(/~~([^\s~][\s\S]*?)~~/g, "<s>$1</s>")
    .replace(/(^|[^*\w])\*([^\s*][\s\S]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^\s_][\s\S]*?)_(?![_\w])/g, "$1<em>$2</em>");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
