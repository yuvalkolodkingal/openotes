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

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  appDataDir,
  cacheDir,
  configDir,
  logDir,
} from "../src/native/paths.ts";

/** Run `body` with the given environment, restoring whatever was there. */
function withEnv(vars: Record<string, string | undefined>, body: () => void) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, Deno.env.get(key));
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const CLEAR = {
  OPENOTES_DATA_DIR: undefined,
  OPENOTES_PORTABLE: undefined,
};

Deno.test("with no override the XDG directories are used", () => {
  if (Deno.build.os !== "linux") return;
  withEnv({
    ...CLEAR,
    XDG_DATA_HOME: "/xdg/data",
    XDG_CONFIG_HOME: "/xdg/config",
    XDG_CACHE_HOME: "/xdg/cache",
  }, () => {
    assertEquals(appDataDir(), "/xdg/data/openotes");
    assertEquals(configDir(), "/xdg/config/openotes");
    assertEquals(cacheDir(), "/xdg/cache/openotes");
  });
});

Deno.test("a data directory override takes settings and logs with it", () => {
  // BUILDING.md calls OPENOTES_DATA_DIR the way to run two independent
  // profiles. It is only independent if settings.json moves too: otherwise
  // both profiles share one sync account, one assistant port and one theme.
  withEnv({
    ...CLEAR,
    OPENOTES_DATA_DIR: "/tmp/profile-a",
    XDG_CONFIG_HOME: "/xdg/config",
    XDG_CACHE_HOME: "/xdg/cache",
  }, () => {
    assertEquals(appDataDir(), "/tmp/profile-a");
    assertEquals(configDir(), "/tmp/profile-a");
    assertEquals(cacheDir(), "/tmp/profile-a/cache");
    assert(logDir().startsWith("/tmp/profile-a"), logDir());
  });
});

Deno.test("two overridden profiles share nothing", () => {
  const paths = (directory: string) => {
    let all: string[] = [];
    withEnv({ ...CLEAR, OPENOTES_DATA_DIR: directory }, () => {
      all = [appDataDir(), configDir(), cacheDir(), logDir()];
    });
    return all;
  };
  const a = paths("/tmp/profile-a");
  const b = paths("/tmp/profile-b");
  for (let i = 0; i < a.length; i++) assertNotEquals(a[i], b[i]);
});

Deno.test("a portable build leaves nothing in the home directory", () => {
  withEnv({
    ...CLEAR,
    OPENOTES_PORTABLE: "1",
    XDG_CONFIG_HOME: "/xdg/config",
    XDG_CACHE_HOME: "/xdg/cache",
  }, () => {
    const data = appDataDir();
    assertEquals(configDir(), data);
    assert(cacheDir().startsWith(data), cacheDir());
    assert(logDir().startsWith(data), logDir());
  });
});
