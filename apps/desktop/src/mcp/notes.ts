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
 * The vault, as the MCP tools see it.
 *
 * The runtime owns the SQLite connection — the interface reaches it through
 * `sqlite.run` — so the MCP server can read and write notes directly instead
 * of driving the interface. This module is the only place that knows the
 * schema, the same arrangement sync/store-adapter.ts uses.
 *
 * Three things it must get right, because @notesnook/core is not in the loop
 * to get them right for us:
 *
 *   - **Dirty flags.** Every write clears `synced` and stamps `dateModified`,
 *     which is how the sync engine finds local changes. A write that forgets
 *     is a note that never leaves the machine.
 *   - **Search.** notes_fts and content_fts are external-content FTS5 tables
 *     kept current by SQL triggers (see core's database/triggers.ts), so
 *     plain INSERT/UPDATE/DELETE keeps search correct. Nothing here may
 *     bypass them with a direct write to an _fts table.
 *   - **Locked notes.** Content in a vault is stored encrypted with a key
 *     this process does not have. Those notes are listed but never read and
 *     never written; an assistant cannot be handed a way around the lock.
 *
 * Transaction bodies are synchronous on purpose. The interface shares this
 * connection, and the runtime is single-threaded, so a BEGIN..COMMIT with no
 * await inside it cannot interleave with a query from the interface.
 */

import { htmlToMarkdown, htmlToText, markdownToHtml } from "./markdown.ts";

/**
 * Just enough of SqliteService to run statements. Narrowing it here keeps
 * this module testable against a plain SQLite database, without the
 * encrypted build the app itself insists on.
 */
export interface SqlRunner {
  run(id: string, sql: string, parameters: unknown[]): { rows: unknown[] };
}

/** Raised for anything the caller could have avoided. */
export class NoteError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "NoteError";
  }
}

export type ContentFormat = "markdown" | "html" | "text";

export interface NoteSummary {
  id: string;
  title: string;
  headline: string;
  dateCreated: number;
  dateEdited: number;
  pinned: boolean;
  favorite: boolean;
  /** In a vault: content is encrypted and this process cannot read it. */
  locked: boolean;
  readonly: boolean;
  notebooks: { id: string; title: string }[];
  tags: string[];
}

export interface NoteDetail extends NoteSummary {
  format: ContentFormat;
  content: string;
}

export interface NotebookSummary {
  id: string;
  title: string;
  description: string;
  dateCreated: number;
  noteCount: number;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
  notebookId?: string;
  tag?: string;
  favorite?: boolean;
  pinned?: boolean;
  sortBy?: "dateEdited" | "dateCreated" | "title";
  order?: "asc" | "desc";
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;

/**
 * A MongoDB-style ObjectId in hex, matching @notesnook/core's
 * utils/object-id.ts. Ids created here must be indistinguishable from ids
 * created by the interface, or sync and the trash view treat them oddly.
 */
const PROCESS_UNIQUE = (() => {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
})();
let counter = Math.floor(Math.random() * 0xffffff);

export function createId(now = Date.now()): string {
  counter = (counter + 1) & 0xffffff;
  const time = Math.floor(now / 1000).toString(16).padStart(8, "0");
  return time + PROCESS_UNIQUE + counter.toString(16).padStart(6, "0");
}

interface Row {
  [column: string]: unknown;
}

export interface NoteRepositoryOptions {
  sqlite: SqlRunner;
  /** undefined until the interface opens the vault. */
  databaseHandle: () => string | undefined;
}

export class NoteRepository {
  constructor(private readonly options: NoteRepositoryOptions) {}

  /** Whether the vault is open. Every tool checks this first. */
  get available(): boolean {
    return !!this.options.databaseHandle();
  }

  private query(sql: string, parameters: unknown[] = []): Row[] {
    const handle = this.options.databaseHandle();
    if (!handle) {
      throw new NoteError(
        "The vault is not open. Unlock Openotes and try again.",
        "vault-closed",
      );
    }
    return this.options.sqlite.run(handle, sql, parameters).rows as Row[];
  }

  /** Runs `body` inside a transaction. `body` must not await. */
  private transaction<T>(body: () => T): T {
    this.query("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.query("COMMIT");
      return result;
    } catch (error) {
      try {
        this.query("ROLLBACK");
      } catch {
        /* the transaction was already unwound */
      }
      throw error;
    }
  }

  // -- reads ---------------------------------------------------------------

  listNotes(options: ListOptions = {}): NoteSummary[] {
    const limit = clamp(options.limit ?? DEFAULT_LIMIT);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const where: string[] = ["notes.type = 'note'", "notes.deleted IS NOT 1"];
    const parameters: unknown[] = [];

    if (options.notebookId) {
      where.push(
        `notes.id IN (SELECT toId FROM relations WHERE fromType = 'notebook' ` +
          `AND toType = 'note' AND fromId = ? AND deleted IS NOT 1)`,
      );
      parameters.push(options.notebookId);
    }
    if (options.tag) {
      where.push(
        `notes.id IN (SELECT r.toId FROM relations r JOIN tags t ON t.id = r.fromId ` +
          `WHERE r.fromType = 'tag' AND r.toType = 'note' AND t.title = ? ` +
          `AND r.deleted IS NOT 1)`,
      );
      parameters.push(options.tag);
    }
    if (typeof options.favorite === "boolean") {
      where.push("notes.favorite IS " + (options.favorite ? "1" : "NOT 1"));
    }
    if (typeof options.pinned === "boolean") {
      where.push("notes.pinned IS " + (options.pinned ? "1" : "NOT 1"));
    }

    const sortColumn =
      { dateEdited: "dateEdited", dateCreated: "dateCreated", title: "title" }[
        options.sortBy ?? "dateEdited"
      ];
    const direction = options.order === "asc" ? "ASC" : "DESC";

    const rows = this.query(
      `SELECT notes.* FROM notes WHERE ${where.join(" AND ")} ` +
        `ORDER BY notes.${sortColumn} ${direction} LIMIT ? OFFSET ?`,
      [...parameters, limit, offset],
    );
    return this.decorate(rows);
  }

  searchNotes(query: string, limit = DEFAULT_LIMIT): NoteSummary[] {
    const expression = toMatchExpression(query);
    if (!expression) return [];
    const capped = clamp(limit);

    // Title matches outrank body matches, which is what core's own ranking
    // does (bm25 with the title column weighted up).
    const ids = new Set<string>();
    const push = (rows: Row[], column: string) => {
      for (const row of rows) {
        const id = row[column];
        if (typeof id === "string") ids.add(id);
      }
    };
    try {
      push(
        this.query(
          `SELECT id FROM notes_fts WHERE title MATCH ? ORDER BY rank LIMIT ?`,
          [expression, capped],
        ),
        "id",
      );
      if (ids.size < capped) {
        push(
          this.query(
            `SELECT noteId FROM content_fts WHERE data MATCH ? ORDER BY rank LIMIT ?`,
            [expression, capped],
          ),
          "noteId",
        );
      }
    } catch (error) {
      throw new NoteError(
        `Search failed: ${error instanceof Error ? error.message : error}`,
        "search-failed",
      );
    }

    // The FTS5 tables are trigram-tokenized, so a token shorter than three
    // characters matches nothing at all — "AI" or "Q3" would silently return
    // no results rather than the notes that plainly contain them. Fall back
    // to a scan for those, bounded by the same limit.
    if (!ids.size) {
      for (
        const row of this.query(
          `SELECT n.id FROM notes n
             LEFT JOIN content c ON c.noteId = n.id AND c.deleted IS NOT 1
            WHERE n.type = 'note' AND n.deleted IS NOT 1
              AND (n.title LIKE ? ESCAPE '\\'
                   OR (c.locked IS NOT 1 AND c.data LIKE ? ESCAPE '\\'))
            ORDER BY n.dateEdited DESC LIMIT ?`,
          [likePattern(query), likePattern(query), capped],
        )
      ) {
        if (typeof row.id === "string") ids.add(row.id);
      }
    }

    if (!ids.size) return [];
    const list = [...ids].slice(0, capped);
    const rows = this.query(
      `SELECT * FROM notes WHERE id IN (${placeholders(list.length)}) ` +
        `AND type = 'note' AND deleted IS NOT 1 ORDER BY dateEdited DESC`,
      list,
    );
    return this.decorate(rows);
  }

  readNote(id: string, format: ContentFormat = "markdown"): NoteDetail {
    const [note] = this.decorate(
      this.query(
        `SELECT * FROM notes WHERE id = ? AND type = 'note' AND deleted IS NOT 1`,
        [id],
      ),
    );
    if (!note) throw new NoteError(`No note with id ${id}`, "not-found");
    if (note.locked) {
      throw new NoteError(
        `Note ${id} is in a vault. Its content is encrypted with a key this ` +
          `process does not hold, so it cannot be read here — open it in ` +
          `Openotes instead.`,
        "locked",
      );
    }

    const html = this.contentHtml(id) ?? "";
    return {
      ...note,
      format,
      content: format === "html"
        ? html
        : format === "text"
        ? htmlToText(html)
        : htmlToMarkdown(html),
    };
  }

  listNotebooks(): NotebookSummary[] {
    const rows = this.query(
      `SELECT nb.*, (
         SELECT COUNT(*) FROM relations r JOIN notes n ON n.id = r.toId
         WHERE r.fromType = 'notebook' AND r.toType = 'note'
           AND r.fromId = nb.id AND r.deleted IS NOT 1
           AND n.type = 'note' AND n.deleted IS NOT 1
       ) AS noteCount
       FROM notebooks nb
       WHERE nb.type = 'notebook' AND nb.deleted IS NOT 1
       ORDER BY nb.title COLLATE NOCASE ASC`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      description: row.description ? String(row.description) : "",
      dateCreated: Number(row.dateCreated ?? 0),
      noteCount: Number(row.noteCount ?? 0),
    }));
  }

  listTags(): { id: string; title: string; noteCount: number }[] {
    const rows = this.query(
      `SELECT t.id, t.title, (
         SELECT COUNT(*) FROM relations r JOIN notes n ON n.id = r.toId
         WHERE r.fromType = 'tag' AND r.toType = 'note' AND r.fromId = t.id
           AND r.deleted IS NOT 1 AND n.type = 'note' AND n.deleted IS NOT 1
       ) AS noteCount
       FROM tags t WHERE t.type = 'tag' AND t.deleted IS NOT 1
       ORDER BY t.title COLLATE NOCASE ASC`,
    );
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      noteCount: Number(row.noteCount ?? 0),
    }));
  }

  // -- writes --------------------------------------------------------------

  createNote(input: {
    title: string;
    content?: string;
    format?: ContentFormat;
    notebookId?: string;
    tags?: string[];
    pinned?: boolean;
    favorite?: boolean;
  }): NoteDetail {
    const title = input.title.trim();
    if (!title) throw new NoteError("A note needs a title.", "invalid-input");

    const html = toHtml(input.content ?? "", input.format ?? "markdown");
    const now = Date.now();
    const noteId = createId(now);
    const contentId = createId(now);

    this.transaction(() => {
      this.query(
        `INSERT INTO content (id, type, dateModified, dateCreated, synced,
           deleted, noteId, data, locked, localOnly, dateEdited)
         VALUES (?, 'tiptap', ?, ?, 0, NULL, ?, ?, 0, 0, ?)`,
        [contentId, now, now, noteId, html, now],
      );
      this.query(
        `INSERT INTO notes (id, type, dateModified, dateCreated, synced,
           deleted, title, headline, contentId, pinned, favorite, localOnly,
           conflicted, readonly, dateEdited)
         VALUES (?, 'note', ?, ?, 0, NULL, ?, ?, ?, ?, ?, 0, NULL, 0, ?)`,
        [
          noteId,
          now,
          now,
          title,
          headlineOf(html),
          contentId,
          input.pinned ? 1 : 0,
          input.favorite ? 1 : 0,
          now,
        ],
      );
      if (input.notebookId) this.linkNotebook(noteId, input.notebookId, now);
      for (const tag of input.tags ?? []) this.linkTag(noteId, tag, now);
    });

    return this.readNote(noteId, input.format ?? "markdown");
  }

  updateNote(input: {
    id: string;
    title?: string;
    content?: string;
    format?: ContentFormat;
    mode?: "replace" | "append" | "prepend";
    pinned?: boolean;
    favorite?: boolean;
  }): NoteDetail {
    const format = input.format ?? "markdown";
    const [existing] = this.decorate(
      this.query(
        `SELECT * FROM notes WHERE id = ? AND type = 'note' AND deleted IS NOT 1`,
        [input.id],
      ),
    );
    if (!existing) {
      throw new NoteError(`No note with id ${input.id}`, "not-found");
    }
    if (existing.locked) {
      throw new NoteError(
        `Note ${input.id} is in a vault and cannot be edited here.`,
        "locked",
      );
    }
    if (existing.readonly) {
      throw new NoteError(
        `Note ${input.id} is marked read-only in Openotes.`,
        "readonly",
      );
    }
    if (
      input.title === undefined && input.content === undefined &&
      input.pinned === undefined && input.favorite === undefined
    ) {
      throw new NoteError("Nothing to change.", "invalid-input");
    }

    const now = Date.now();
    this.transaction(() => {
      if (input.content !== undefined) {
        const addition = toHtml(input.content, format);
        const current = this.contentHtml(input.id) ?? "";
        const mode = input.mode ?? "replace";
        const html = mode === "append"
          ? current + addition
          : mode === "prepend"
          ? addition + current
          : addition;

        const contentId = this.contentIdOf(input.id);
        if (contentId) {
          this.query(
            `UPDATE content SET data = ?, dateModified = ?, dateEdited = ?,
               synced = 0 WHERE id = ?`,
            [html, now, now, contentId],
          );
        } else {
          const created = createId(now);
          this.query(
            `INSERT INTO content (id, type, dateModified, dateCreated, synced,
               deleted, noteId, data, locked, localOnly, dateEdited)
             VALUES (?, 'tiptap', ?, ?, 0, NULL, ?, ?, 0, 0, ?)`,
            [created, now, now, input.id, html, now],
          );
          this.query(`UPDATE notes SET contentId = ? WHERE id = ?`, [
            created,
            input.id,
          ]);
        }
        this.query(
          `UPDATE notes SET headline = ?, dateEdited = ? WHERE id = ?`,
          [headlineOf(html), now, input.id],
        );
        this.syncAttachmentLinks(input.id, current, html, now);
      }

      const sets: string[] = ["dateModified = ?", "synced = 0"];
      const parameters: unknown[] = [now];
      if (input.title !== undefined) {
        const title = input.title.trim();
        if (!title) {
          throw new NoteError("A note needs a title.", "invalid-input");
        }
        sets.push("title = ?");
        parameters.push(title);
      }
      if (input.pinned !== undefined) {
        sets.push("pinned = ?");
        parameters.push(input.pinned ? 1 : 0);
      }
      if (input.favorite !== undefined) {
        sets.push("favorite = ?");
        parameters.push(input.favorite ? 1 : 0);
      }
      this.query(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`, [
        ...parameters,
        input.id,
      ]);
    });

    return this.readNote(input.id, format);
  }

  /**
   * Moves a note to the trash, the way the interface does: the row stays,
   * its type becomes "trash" and itemType remembers what it was. Nothing
   * here deletes a row outright — an assistant must not be able to destroy
   * a note past recovery.
   */
  trashNote(id: string): { id: string; title: string } {
    const [note] = this.query(
      `SELECT id, title FROM notes WHERE id = ? AND type = 'note' AND deleted IS NOT 1`,
      [id],
    );
    if (!note) throw new NoteError(`No note with id ${id}`, "not-found");

    const now = Date.now();
    this.transaction(() => {
      this.query(
        `UPDATE notes SET type = 'trash', itemType = 'note', dateDeleted = ?,
           deletedBy = 'app', dateModified = ?, synced = 0 WHERE id = ?`,
        [now, now, id],
      );
    });
    return { id, title: String(note.title ?? "") };
  }

  createNotebook(title: string, description = ""): NotebookSummary {
    const clean = title.trim();
    if (!clean) {
      throw new NoteError("A notebook needs a title.", "invalid-input");
    }
    const now = Date.now();
    const id = createId(now);
    this.query(
      `INSERT INTO notebooks (id, type, dateModified, dateCreated, synced,
         deleted, title, description, dateEdited, pinned)
       VALUES (?, 'notebook', ?, ?, 0, NULL, ?, ?, ?, 0)`,
      [id, now, now, clean, description, now],
    );
    return {
      id,
      title: clean,
      description,
      dateCreated: now,
      noteCount: 0,
    };
  }

  setTags(noteId: string, tags: string[]): NoteSummary {
    const [note] = this.query(
      `SELECT id FROM notes WHERE id = ? AND type = 'note' AND deleted IS NOT 1`,
      [noteId],
    );
    if (!note) throw new NoteError(`No note with id ${noteId}`, "not-found");

    const now = Date.now();
    this.transaction(() => {
      // Tombstone the relations rather than deleting them, so the removal
      // reaches other devices instead of being resurrected by them.
      const existing = this.query(
        `SELECT id FROM relations WHERE fromType = 'tag' AND toType = 'note'
           AND toId = ? AND deleted IS NOT 1`,
        [noteId],
      );
      for (const row of existing) {
        this.query(
          `UPDATE relations SET deleted = 1, dateModified = ?, synced = 0
             WHERE id = ?`,
          [now, row.id],
        );
      }
      for (const tag of tags) this.linkTag(noteId, tag, now);
    });

    const [updated] = this.decorate(
      this.query(`SELECT * FROM notes WHERE id = ?`, [noteId]),
    );
    return updated;
  }

  moveToNotebook(noteId: string, notebookId: string): NoteSummary {
    const [note] = this.query(
      `SELECT id FROM notes WHERE id = ? AND type = 'note' AND deleted IS NOT 1`,
      [noteId],
    );
    if (!note) throw new NoteError(`No note with id ${noteId}`, "not-found");
    const now = Date.now();
    this.transaction(() => this.linkNotebook(noteId, notebookId, now));
    const [updated] = this.decorate(
      this.query(`SELECT * FROM notes WHERE id = ?`, [noteId]),
    );
    return updated;
  }

  // -- internals -----------------------------------------------------------

  private contentIdOf(noteId: string): string | undefined {
    const [row] = this.query(
      `SELECT id FROM content WHERE noteId = ? AND deleted IS NOT 1
         ORDER BY dateModified DESC LIMIT 1`,
      [noteId],
    );
    return row?.id === undefined ? undefined : String(row.id);
  }

  private contentHtml(noteId: string): string | undefined {
    const [row] = this.query(
      `SELECT data, locked FROM content WHERE noteId = ? AND deleted IS NOT 1
         ORDER BY dateModified DESC LIMIT 1`,
      [noteId],
    );
    if (!row) return undefined;
    if (row.locked === 1 || row.locked === true) return undefined;
    return typeof row.data === "string" ? row.data : "";
  }

  private linkNotebook(noteId: string, notebookId: string, now: number) {
    const [notebook] = this.query(
      `SELECT id FROM notebooks WHERE id = ? AND type = 'notebook' AND deleted IS NOT 1`,
      [notebookId],
    );
    if (!notebook) {
      throw new NoteError(`No notebook with id ${notebookId}`, "not-found");
    }
    this.relate("notebook", notebookId, "note", noteId, now);
  }

  private linkTag(noteId: string, title: string, now: number) {
    // Core trims each line of a tag title and then matches COLLATE BINARY
    // (collections/tags.ts). The column is NOCASE, so a plain `=` here would
    // reuse "Work" for "work" and quietly rename the user's tag on the next
    // sync. Match core exactly instead.
    const clean = title.split("\n").map((line) => line.trim()).join("\n")
      .trim();
    if (!clean) return;
    const [existing] = this.query(
      `SELECT id FROM tags WHERE title = ? COLLATE BINARY AND type = 'tag'
         AND deleted IS NOT 1`,
      [clean],
    );
    let tagId = existing?.id === undefined ? undefined : String(existing.id);
    if (!tagId) {
      tagId = createId(now);
      this.query(
        `INSERT INTO tags (id, type, dateModified, dateCreated, synced, deleted, title)
         VALUES (?, 'tag', ?, ?, 0, NULL, ?)`,
        [tagId, now, now, clean],
      );
    }
    this.relate("tag", tagId, "note", noteId, now);
  }

  /**
   * Keep `note -> attachment` relations in step with the body.
   *
   * @notesnook/core does this on every content write (collections/content.ts
   * processLinkedAttachments): the relations are what the attachment manager
   * counts references with, so a body that loses its last reference to a file
   * has to lose the relation too, or the file is never collectable. Writing
   * content.data directly means doing it here.
   *
   * Markdown cannot express an attachment, so this only ever has anything to
   * do when the caller wrote HTML or removed something that was there.
   */
  private syncAttachmentLinks(
    noteId: string,
    before: string,
    after: string,
    now: number,
  ) {
    const previous = attachmentHashes(before);
    const current = attachmentHashes(after);
    if (previous.size === 0 && current.size === 0) return;

    for (const hash of previous) {
      if (current.has(hash)) continue;
      const [attachment] = this.query(
        `SELECT id FROM attachments WHERE hash = ? AND deleted IS NOT 1`,
        [hash],
      );
      if (!attachment) continue;
      this.query(
        `UPDATE relations SET deleted = 1, dateModified = ?, synced = 0
           WHERE fromType = 'note' AND fromId = ? AND toType = 'attachment'
             AND toId = ? AND deleted IS NOT 1`,
        [now, noteId, String(attachment.id)],
      );
    }

    for (const hash of current) {
      if (previous.has(hash)) continue;
      const [attachment] = this.query(
        `SELECT id FROM attachments WHERE hash = ? AND deleted IS NOT 1`,
        [hash],
      );
      // An unknown hash means the caller pasted markup referring to a file
      // this vault does not hold. There is nothing to relate it to, and
      // inventing an attachment row would be worse than leaving it inert.
      if (!attachment) continue;
      this.relate("note", noteId, "attachment", String(attachment.id), now);
    }
  }

  private relate(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    now: number,
  ) {
    const [existing] = this.query(
      `SELECT id, deleted FROM relations WHERE fromType = ? AND fromId = ?
         AND toType = ? AND toId = ?`,
      [fromType, fromId, toType, toId],
    );
    if (existing) {
      // Re-adding a relation that was tombstoned has to clear the tombstone,
      // or the next sync deletes it again on this device.
      this.query(
        `UPDATE relations SET deleted = NULL, dateModified = ?, synced = 0
           WHERE id = ?`,
        [now, existing.id],
      );
      return;
    }
    this.query(
      `INSERT INTO relations (id, type, dateModified, dateCreated, synced,
         deleted, fromType, fromId, toType, toId)
       VALUES (?, 'relation', ?, ?, 0, NULL, ?, ?, ?, ?)`,
      [createId(now), now, now, fromType, fromId, toType, toId],
    );
  }

  /** Turn note rows into summaries, resolving notebooks, tags and lock state. */
  private decorate(rows: Row[]): NoteSummary[] {
    if (!rows.length) return [];
    const ids = rows.map((row) => String(row.id));
    const marks = placeholders(ids.length);

    const notebooks = new Map<string, { id: string; title: string }[]>();
    for (
      const row of this.query(
        `SELECT r.toId AS noteId, nb.id, nb.title FROM relations r
           JOIN notebooks nb ON nb.id = r.fromId
          WHERE r.fromType = 'notebook' AND r.toType = 'note'
            AND r.toId IN (${marks}) AND r.deleted IS NOT 1
            AND nb.deleted IS NOT 1 AND nb.type = 'notebook'`,
        ids,
      )
    ) {
      const list = notebooks.get(String(row.noteId)) ?? [];
      list.push({ id: String(row.id), title: String(row.title ?? "") });
      notebooks.set(String(row.noteId), list);
    }

    const tags = new Map<string, string[]>();
    for (
      const row of this.query(
        `SELECT r.toId AS noteId, t.title FROM relations r
           JOIN tags t ON t.id = r.fromId
          WHERE r.fromType = 'tag' AND r.toType = 'note'
            AND r.toId IN (${marks}) AND r.deleted IS NOT 1
            AND t.deleted IS NOT 1 AND t.type = 'tag'`,
        ids,
      )
    ) {
      const list = tags.get(String(row.noteId)) ?? [];
      list.push(String(row.title ?? ""));
      tags.set(String(row.noteId), list);
    }

    const locked = new Set<string>();
    for (
      const row of this.query(
        `SELECT noteId FROM content WHERE noteId IN (${marks}) AND locked = 1`,
        ids,
      )
    ) {
      locked.add(String(row.noteId));
    }

    return rows.map((row) => {
      const id = String(row.id);
      return {
        id,
        title: String(row.title ?? ""),
        headline: String(row.headline ?? ""),
        dateCreated: Number(row.dateCreated ?? 0),
        dateEdited: Number(row.dateEdited ?? row.dateModified ?? 0),
        pinned: row.pinned === 1 || row.pinned === true,
        favorite: row.favorite === 1 || row.favorite === true,
        readonly: row.readonly === 1 || row.readonly === true,
        locked: locked.has(id),
        notebooks: notebooks.get(id) ?? [],
        tags: tags.get(id) ?? [],
      };
    });
  }
}

// ---------------------------------------------------------------------------

function clamp(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

function toHtml(content: string, format: ContentFormat): string {
  if (format === "html") return content;
  if (format === "text") {
    return content
      .split(/\n{2,}/)
      .map((paragraph) =>
        `<p>${
          paragraph
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br>")
        }</p>`
      )
      .join("");
  }
  return markdownToHtml(content);
}

/** A LIKE pattern that matches `value` anywhere, with wildcards escaped. */
function likePattern(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The attachment hashes a body refers to, as the editor writes them. */
export function attachmentHashes(html: string): Set<string> {
  const hashes = new Set<string>();
  for (
    const match of html.matchAll(/data-hash=["']([A-Za-z0-9_-]{1,128})["']/g)
  ) {
    hashes.add(match[1]);
  }
  return hashes;
}

function headlineOf(html: string): string {
  return htmlToText(html).replace(/\s+/g, " ").slice(0, 150).trim();
}

/**
 * Turn a plain query into an FTS5 MATCH expression.
 *
 * FTS5's query language treats bare punctuation as syntax, so a user query
 * like `foo: bar` is a syntax error rather than a search. Every token is
 * quoted, which makes the whole thing a conjunction of phrases and means no
 * caller input can be read as an operator.
 */
export function toMatchExpression(query: string): string {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ""))
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"`)
    .join(" ");
}
