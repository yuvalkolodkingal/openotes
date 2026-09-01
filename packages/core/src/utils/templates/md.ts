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

import { TemplateData } from "./index.js";
import { formatDate } from "../date.js";

export const buildMarkdown = (data: TemplateData) => `# ${data.title}

${data.content}`;

export const templateWithFrontmatter = (data: TemplateData) => `---
${buildFrontmatter(data)}
---

# ${data.title}

${data.content}`;

/**
 * Front matter for synchronization, as opposed to for a human reading an
 * export.
 *
 * templateWithFrontmatter above is built to be read: dates are formatted for
 * people and tags are a comma-joined sentence. That is not round-trippable —
 * there is no note id, and "12-08-2026 3:04 PM" cannot be parsed back without
 * knowing which format produced it.
 *
 * This one is built to survive a round trip:
 *
 *   id      so a file that is renamed, moved or restored from a backup still
 *           binds to the right note. This is why the sync manifest can stay
 *           local — identity travels with the file.
 *   dates   ISO 8601 UTC, unambiguous everywhere.
 *   tags    a YAML flow sequence, so a tag containing a comma survives.
 *
 * Values are JSON-encoded, which is valid YAML for scalars and quotes exactly
 * the things that would otherwise break the document — a title with a colon
 * being the common one.
 */
export const templateForSync = (data: TemplateData) => `---
${buildSyncFrontmatter(data)}
---

# ${data.title}

${data.content}`;

function buildSyncFrontmatter(data: TemplateData) {
  const lines = [
    `id: ${JSON.stringify(data.id)}`,
    `title: ${JSON.stringify(data.title || "")}`,
    `created: ${new Date(data.dateCreated).toISOString()}`,
    `updated: ${new Date(data.dateEdited).toISOString()}`
  ];
  if (data.pinned) lines.push(`pinned: true`);
  if (data.favorite) lines.push(`favorite: true`);
  if (data.archived) lines.push(`archived: true`);
  if (data.color) lines.push(`color: ${JSON.stringify(data.color)}`);
  if (data.tags && data.tags.length > 0) {
    lines.push(`tags: [${data.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  return lines.join("\n");
}

function buildFrontmatter(data: TemplateData) {
  const lines = [
    `title: ${JSON.stringify(data.title || "")}`,
    `created_at: ${formatDate(data.dateCreated)}`,
    `updated_at: ${formatDate(data.dateEdited)}`
  ];
  if (data.pinned) lines.push(`pinned: ${data.pinned}`);
  if (data.favorite) lines.push(`favorite: ${data.favorite}`);
  if (data.archived) lines.push(`archived: ${data.archived}`);
  if (data.color) lines.push(`color: ${data.color}`);
  if (data.tags) lines.push(`tags: ${data.tags.join(", ")}`);
  return lines.join("\n");
}
