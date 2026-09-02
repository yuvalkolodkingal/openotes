/*
This file is part of the Notesnook project (https://notesnook.com/)

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

import { htmlToMarkdown, htmlToText, markdownToHtml } from "@openotes/markdown";

/**
 * Notes are edited as Markdown on the phone and stored as the editor's HTML,
 * through the same converter the desktop uses for its assistant endpoint --
 * so headings, lists, task lists, quotes, code and tables survive both ways,
 * and formatting Markdown cannot express is what a replace loses, exactly as
 * documented for the desktop.
 */

export function toMarkdown(html: string): string {
  return htmlToMarkdown(html);
}

export function toHtml(markdown: string): string {
  return markdownToHtml(markdown);
}

/** The first line of the body, the way the desktop shows it under a title. */
export function headlineOf(html: string): string {
  const text = htmlToText(html).replace(/\s+/g, " ").trim();
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}

export function formatDate(time: number): string {
  if (!time) return "";
  const date = new Date(time);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
