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

import {
  TEST_NOTE,
  databaseTest,
  loginFakeUser,
  notebookTest
} from "./utils/index.ts";
import { test, expect } from "vitest";
import type Backup from "../src/database/backup.js";
import { Item, MaybeDeletedItem } from "../src/types.js";

/**
 * `db.backup.export` yields either a file chunk or an attachment chunk. None of
 * the databases in this suite have attachments, so every chunk is a file — the
 * JS version already relied on that by reading `.data`/`.path` unconditionally.
 */
type BackupExportChunk = ReturnType<Backup["export"]> extends AsyncGenerator<
  infer TChunk,
  unknown,
  unknown
>
  ? TChunk
  : never;
type BackupFileChunk = Extract<BackupExportChunk, { type: "file" }>;

test("export backup", () =>
  notebookTest().then(async ({ db }) => {
    const id = await db.notes.add(TEST_NOTE);
    const exp: BackupFileChunk[] = [];
    for await (const file of db.backup.export({
      type: "node",
      encrypt: false
    })) {
      exp.push(file as BackupFileChunk);
    }

    let backup = JSON.parse(exp[1].data);
    expect(exp.length).toBe(2);
    expect(exp[0].path).toBe(".nnbackup");
    expect(backup.type).toBe("node");
    expect(backup.date).toBeGreaterThan(0);
    expect(backup.data).toBeTypeOf("string");
    expect(backup.compressed).toBe(true);
    expect(backup.encrypted).toBe(false);
    expect(
      JSON.parse(await (await db.compressor()).decompress(backup.data)).find(
        (i: MaybeDeletedItem<Item>) => i.id === id
      )
    ).toBeDefined();
  }));

test("export encrypted backup", () =>
  notebookTest().then(async ({ db }) => {
    await loginFakeUser(db);
    await db.notes.add(TEST_NOTE);

    const exp: BackupFileChunk[] = [];
    for await (const file of db.backup.export({
      type: "node",
      encrypt: true
    })) {
      exp.push(file as BackupFileChunk);
    }

    const backup = JSON.parse(exp[1].data);
    expect(exp.length).toBe(2);
    expect(exp[0].path).toBe(".nnbackup");
    expect(backup.type).toBe("node");
    expect(backup.date).toBeGreaterThan(0);
    expect(backup.data.iv).not.toBeUndefined();
    expect(backup.data).toBeTypeOf("object");
    expect(backup.compressed).toBe(true);
    expect(backup.encrypted).toBe(true);
  }));

test("import backup", async () => {
  const { db, id } = await notebookTest();
  const exp: BackupFileChunk[] = [];
  for await (const file of db.backup.export({
    type: "node",
    encrypt: false
  })) {
    exp.push(file as BackupFileChunk);
  }

  const db2 = await databaseTest();
  await db2.backup.import(JSON.parse(exp[1].data));
  expect((await db2.notebooks.notebook(id))!.id).toBe(id);
});

test("import encrypted backup", async () => {
  const { db, id } = await notebookTest();
  await loginFakeUser(db);
  await db.notes.add(TEST_NOTE);

  const exp: BackupFileChunk[] = [];
  for await (const file of db.backup.export({
    type: "node",
    encrypt: true
  })) {
    exp.push(file as BackupFileChunk);
  }

  const db2 = await databaseTest();
  await db2.backup.import(JSON.parse(exp[1].data), { password: "password" });
  expect((await db2.notebooks.notebook(id))!.id).toBe(id);
});

test("import tempered backup", () =>
  notebookTest().then(async ({ db }) => {
    await db.notes.add(TEST_NOTE);

    const exp: BackupFileChunk[] = [];
    for await (const file of db.backup.export({
      type: "node",
      encrypt: false
    })) {
      exp.push(file as BackupFileChunk);
    }

    await db.storage().clear();
    const backup = JSON.parse(exp[1].data);
    backup.data += "hello";
    await expect(db.backup.import(backup)).rejects.toThrow(/tempered/);
  }));
