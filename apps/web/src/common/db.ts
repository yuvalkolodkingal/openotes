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

import { DatabasePersistence, NNStorage } from "../interfaces/storage";
import { database } from "@notesnook/common";
import { createDialect } from "./sqlite";
import { isFeatureSupported } from "../utils/feature-check";
import { generatePassword } from "../utils/password-generator";
import { deriveKey, useKeyStore } from "../interfaces/key-store";
import { FileStorage } from "../interfaces/fs";

const db = database;
async function initializeDatabase(persistence: DatabasePersistence) {
  performance.mark("start:initializeDatabase");

  let databaseKey = await useKeyStore.getState().getValue("databaseKey");
  if (!databaseKey) {
    databaseKey = await deriveKey(generatePassword());
    await useKeyStore.getState().setValue("databaseKey", databaseKey);
  }

  // Openotes talks to no Notesnook server: there are no hosts to configure.
  // The only remote this app has is the user's own WebDAV endpoint, which is
  // configured (and contacted) by the desktop host, not by core.

  const storage = new NNStorage(
    "Notesnook",
    () => useKeyStore.getState(),
    persistence
  );
  await storage.migrate();

  const multiTab = !!globalThis.SharedWorker && isFeatureSupported("opfs");
  database.setup({
    sqliteOptions: {
      dialect: (name, init) =>
        createDialect({
          name: persistence === "memory" ? ":memory:" : name,
          encrypted: persistence !== "memory",
          async: !isFeatureSupported("opfs"),
          init,
          multiTab
        }),
      ...(IS_DESKTOP_APP || isFeatureSupported("opfs")
        ? { journalMode: "WAL", lockingMode: "exclusive" }
        : {
            journalMode: "MEMORY",
            lockingMode: "normal"
          }),
      tempStore: "memory",
      synchronous: "normal",
      pageSize: 8192,
      cacheSize: -32000,
      password:
        persistence === "memory"
          ? undefined
          : Buffer.from(databaseKey).toString("hex"),
      skipInitialization: !IS_DESKTOP_APP && multiTab
    },
    storage: storage,
    fs: FileStorage,
    compressor: () =>
      import("../utils/compressor").then(({ Compressor }) => new Compressor()),
    // unlimited: note history is only bounded by local disk space.
    maxNoteVersions: async () => undefined,
    batchSize: 100
  });

  performance.mark("start:initdb");
  await db.init();
  performance.mark("end:initdb");

  if (db.migrations?.required()) {
    await import("../dialogs/migration-dialog").then(({ MigrationDialog }) =>
      MigrationDialog.show({})
    );
  }

  performance.mark("end:initializeDatabase");

  return db;
}

export { db, initializeDatabase };
