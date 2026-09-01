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
 * The MCP tools against a real SQLite database.
 *
 * The schema here is the subset of @notesnook/core's that the tools touch,
 * copied from packages/core/src/database/migrations.ts and triggers.ts —
 * including the FTS5 tables and the triggers that keep them current, since
 * "does search still work after a write" is exactly what these tests are
 * for. If core's schema moves, these fail, which is the point.
 *
 * Skipped when no SQLite library can be loaded: the unit-test job runs
 * before anything builds the native one.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { nativeDir } from "../src/native/sqlite.ts";
import { NoteError, NoteRepository, type SqlRunner } from "../src/mcp/notes.ts";
import { handleMessage } from "../src/mcp/protocol.ts";

type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): number;
    columnNames(): string[];
  };
  close(): void;
};

async function loadDatabase(): Promise<
  (new (path: string) => Database) | undefined
> {
  // Prefer the encrypted build the app ships; fall back to whatever
  // @db/sqlite finds, so a developer without it can still run these.
  if (!Deno.env.get("DENO_SQLITE_PATH")) {
    for (
      const name of ["libsqlite3mc.so", "libsqlite3mc.dylib", "sqlite3mc.dll"]
    ) {
      try {
        const path = `${nativeDir()}/${name}`;
        Deno.statSync(path);
        Deno.env.set("DENO_SQLITE_PATH", path);
        break;
      } catch {
        continue;
      }
    }
  }
  try {
    const module = await import("@db/sqlite");
    return module.Database as unknown as new (path: string) => Database;
  } catch {
    return undefined;
  }
}

const Database = await loadDatabase();
const ignore = !Database;

const SCHEMA = `
CREATE TABLE notes (
  id TEXT PRIMARY KEY, type TEXT, dateModified INTEGER, dateCreated INTEGER,
  synced BOOLEAN, deleted BOOLEAN, dateDeleted INTEGER, itemType TEXT,
  deletedBy TEXT, title TEXT COLLATE NOCASE, headline TEXT, contentId TEXT,
  pinned BOOLEAN, favorite BOOLEAN, localOnly BOOLEAN, conflicted BOOLEAN,
  readonly BOOLEAN, dateEdited INTEGER
);
CREATE TABLE content (
  id TEXT PRIMARY KEY, type TEXT, dateModified INTEGER, dateCreated INTEGER,
  synced BOOLEAN, deleted BOOLEAN, noteId TEXT, data TEXT, locked BOOLEAN,
  localOnly BOOLEAN, conflicted TEXT, sessionId TEXT, dateEdited INTEGER,
  dateResolved INTEGER
);
CREATE TABLE notebooks (
  id TEXT PRIMARY KEY, type TEXT, dateModified INTEGER, dateCreated INTEGER,
  synced BOOLEAN, deleted BOOLEAN, dateDeleted INTEGER, itemType TEXT,
  deletedBy TEXT, title TEXT COLLATE NOCASE, description TEXT,
  dateEdited INTEGER, pinned BOOLEAN
);
CREATE TABLE tags (
  id TEXT PRIMARY KEY, type TEXT, dateModified INTEGER, dateCreated INTEGER,
  synced BOOLEAN, deleted BOOLEAN, title TEXT COLLATE NOCASE
);
CREATE TABLE relations (
  id TEXT PRIMARY KEY, type TEXT, dateModified INTEGER, dateCreated INTEGER,
  synced BOOLEAN, deleted BOOLEAN, fromType TEXT, fromId TEXT, toType TEXT,
  toId TEXT
);
CREATE VIRTUAL TABLE notes_fts USING fts5(id, title, content='notes', tokenize='porter trigram');
CREATE VIRTUAL TABLE content_fts USING fts5(id, noteId, data, content='content', tokenize='porter trigram');

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, id, title) VALUES (new.rowid, new.id, new.title);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, id, title) VALUES ('delete', old.rowid, old.id, old.title);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, id, title) VALUES ('delete', old.rowid, old.id, old.title);
  INSERT INTO notes_fts(rowid, id, title) VALUES (new.rowid, new.id, new.title);
END;
CREATE TRIGGER content_ai AFTER INSERT ON content BEGIN
  INSERT INTO content_fts(rowid, id, noteId, data) VALUES (new.rowid, new.id, new.noteId, new.data);
END;
CREATE TRIGGER content_ad AFTER DELETE ON content BEGIN
  INSERT INTO content_fts(content_fts, rowid, id, noteId, data) VALUES ('delete', old.rowid, old.id, old.noteId, old.data);
END;
CREATE TRIGGER content_au AFTER UPDATE ON content BEGIN
  INSERT INTO content_fts(content_fts, rowid, id, noteId, data) VALUES ('delete', old.rowid, old.id, old.noteId, old.data);
  INSERT INTO content_fts(rowid, id, noteId, data) VALUES (new.rowid, new.id, new.noteId, new.data);
END;
`;

function open(): {
  repository: NoteRepository;
  runner: SqlRunner;
  close(): void;
} {
  const database = new Database!(":memory:");
  database.exec(SCHEMA);
  const runner: SqlRunner = {
    run(_id, sql, parameters) {
      const statement = database.prepare(sql);
      if (statement.columnNames().length > 0) {
        return { rows: statement.all(...parameters) };
      }
      statement.run(...parameters);
      return { rows: [] };
    },
  };
  return {
    repository: new NoteRepository({
      sqlite: runner,
      databaseHandle: () => "test",
    }),
    runner,
    close: () => database.close(),
  };
}

function withVault(body: (vault: ReturnType<typeof open>) => void) {
  const vault = open();
  try {
    body(vault);
  } finally {
    vault.close();
  }
}

Deno.test({
  name: "a created note round-trips as markdown",
  ignore,
  fn: () =>
    withVault(({ repository }) => {
      const created = repository.createNote({
        title: "Shopping",
        content: "- milk\n- eggs",
      });
      assertEquals(created.title, "Shopping");
      assertEquals(created.content, "- milk\n- eggs");

      const read = repository.readNote(created.id);
      assertEquals(read.content, "- milk\n- eggs");
      assertEquals(read.headline, "milkeggs");

      const html = repository.readNote(created.id, "html");
      assertEquals(
        html.content,
        "<ul><li><p>milk</p></li><li><p>eggs</p></li></ul>",
      );
    }),
});

Deno.test({
  name: "every write leaves the row dirty so sync ships it",
  ignore,
  fn: () =>
    withVault(({ repository, runner }) => {
      const synced = (table: string, id: string) =>
        (runner.run("test", `SELECT synced FROM ${table} WHERE id = ?`, [id])
          .rows[0] as { synced: number }).synced;

      const note = repository.createNote({ title: "One", content: "a" });
      assertEquals(synced("notes", note.id), 0);

      // Pretend a sync ran.
      runner.run("test", "UPDATE notes SET synced = 1", []);
      runner.run("test", "UPDATE content SET synced = 1", []);

      repository.updateNote({ id: note.id, content: "b" });
      assertEquals(synced("notes", note.id), 0);
      assertEquals(
        (runner.run("test", "SELECT synced FROM content WHERE noteId = ?", [
          note.id,
        ]).rows[0] as { synced: number }).synced,
        0,
      );

      runner.run("test", "UPDATE notes SET synced = 1", []);
      repository.trashNote(note.id);
      assertEquals(synced("notes", note.id), 0);
    }),
});

Deno.test({
  name: "search finds a note written through the tools",
  ignore,
  fn: () =>
    withVault(({ repository }) => {
      const note = repository.createNote({
        title: "Quarterly report",
        content: "Revenue grew by twelve percent.",
      });
      repository.createNote({ title: "Unrelated", content: "nothing here" });

      assertEquals(
        repository.searchNotes("Quarterly").map((n) => n.id),
        [note.id],
      );
      // The body is indexed too, by the trigger, not by us.
      assertEquals(
        repository.searchNotes("twelve").map((n) => n.id),
        [note.id],
      );

      // ...and an edit re-indexes it.
      repository.updateNote({ id: note.id, content: "Revenue fell." });
      assertEquals(repository.searchNotes("twelve"), []);
      assertEquals(repository.searchNotes("fell").map((n) => n.id), [note.id]);
    }),
});

Deno.test({
  name: "append and prepend keep the existing body",
  ignore,
  fn: () =>
    withVault(({ repository }) => {
      const note = repository.createNote({ title: "Log", content: "first" });
      repository.updateNote({ id: note.id, content: "second", mode: "append" });
      assertEquals(repository.readNote(note.id).content, "first\n\nsecond");
      repository.updateNote({
        id: note.id,
        content: "zeroth",
        mode: "prepend",
      });
      assertEquals(
        repository.readNote(note.id).content,
        "zeroth\n\nfirst\n\nsecond",
      );
    }),
});

Deno.test({
  name: "trashing keeps the row so the user can restore it",
  ignore,
  fn: () =>
    withVault(({ repository, runner }) => {
      const note = repository.createNote({ title: "Oops" });
      repository.trashNote(note.id);

      assertEquals(repository.listNotes().length, 0);
      assertThrows(() => repository.readNote(note.id), NoteError);

      const [row] = runner.run(
        "test",
        "SELECT type, itemType FROM notes WHERE id = ?",
        [
          note.id,
        ],
      ).rows as { type: string; itemType: string }[];
      assertEquals(row.type, "trash");
      assertEquals(row.itemType, "note");
    }),
});

Deno.test({
  name: "notes in a vault are listed but never read or written",
  ignore,
  fn: () =>
    withVault(({ repository, runner }) => {
      const note = repository.createNote({ title: "Secret", content: "plain" });
      runner.run("test", "UPDATE content SET locked = 1 WHERE noteId = ?", [
        note.id,
      ]);

      const [listed] = repository.listNotes();
      assertEquals(listed.locked, true);
      assertEquals(listed.title, "Secret");

      assertThrows(
        () => repository.readNote(note.id),
        NoteError,
        "vault",
      );
      assertThrows(
        () => repository.updateNote({ id: note.id, content: "x" }),
        NoteError,
        "vault",
      );
    }),
});

Deno.test({
  name: "tags and notebooks link and unlink through relations",
  ignore,
  fn: () =>
    withVault(({ repository }) => {
      const notebook = repository.createNotebook("Work");
      const note = repository.createNote({
        title: "Standup",
        notebookId: notebook.id,
        tags: ["daily", "team"],
      });

      assertEquals(note.notebooks.map((n) => n.title), ["Work"]);
      assertEquals(note.tags.sort(), ["daily", "team"]);
      assertEquals(repository.listNotebooks()[0].noteCount, 1);
      assertEquals(
        repository.listTags().map((t) => `${t.title}:${t.noteCount}`).sort(),
        ["daily:1", "team:1"],
      );

      // Removing a tag tombstones the relation instead of deleting the row,
      // or the removal never reaches another device.
      const updated = repository.setTags(note.id, ["daily"]);
      assertEquals(updated.tags, ["daily"]);
      assertEquals(
        repository.listTags().map((t) => `${t.title}:${t.noteCount}`).sort(),
        ["daily:1", "team:0"],
      );

      // Adding it back has to clear the tombstone, not create a duplicate.
      repository.setTags(note.id, ["daily", "team"]);
      assertEquals(repository.listNotes({ tag: "team" }).length, 1);

      assertEquals(repository.listNotes({ notebookId: notebook.id }).length, 1);
      assertEquals(repository.listNotes({ tag: "daily" }).length, 1);
      assertEquals(repository.listNotes({ tag: "nope" }).length, 0);
    }),
});

Deno.test({
  name: "a failed write leaves nothing behind",
  ignore,
  fn: () =>
    withVault(({ repository }) => {
      assertThrows(
        () =>
          repository.createNote({
            title: "Orphan",
            notebookId: "does-not-exist",
          }),
        NoteError,
        "No notebook",
      );
      // The note and its content were inserted before the notebook lookup
      // failed; the transaction has to have taken them back out.
      assertEquals(repository.listNotes().length, 0);
      assertEquals(repository.searchNotes("Orphan").length, 0);
    }),
});

Deno.test({
  name: "the tools work end to end over the protocol",
  ignore,
  fn: () =>
    withVault(({ repository }) => {
      const call = (name: string, args: Record<string, unknown>) => {
        const answer = handleMessage(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          },
          {
            repository,
            allowWrites: true,
            serverName: "openotes",
            serverVersion: "2.1.0",
          },
        );
        assert(answer && "result" in answer);
        const result = answer.result as {
          isError: boolean;
          content: { text: string }[];
          structuredContent?: unknown;
        };
        assertEquals(result.isError, false, result.content[0]?.text);
        return result.structuredContent as Record<string, unknown>;
      };

      const created = call("create_note", {
        title: "From an assistant",
        content: "# Heading\n\nA paragraph.",
        tags: ["mcp"],
      });
      const id = String(created.id);

      const found = call("search_notes", { query: "assistant" }) as {
        items: { id: string }[];
      };
      assertEquals(found.items.map((n) => n.id), [id]);

      const read = call("read_note", { id });
      assertEquals(read.content, "# Heading\n\nA paragraph.");
      assertEquals(read.tags, ["mcp"]);

      call("update_note", { id, content: "Appended.", mode: "append" });
      assertEquals(
        call("read_note", { id }).content,
        "# Heading\n\nA paragraph.\n\nAppended.",
      );

      call("trash_note", { id });
      assertEquals(
        (call("list_notes", {}) as { items: unknown[] }).items.length,
        0,
      );
    }),
});
