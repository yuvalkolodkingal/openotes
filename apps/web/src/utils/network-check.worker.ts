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
import { expose } from "comlink";

const module = {
  // Upstream probed api.notesnook.com/health here. This fork contacts only
  // the user's own WebDAV server and its own release endpoint, so there is
  // no health endpoint it may call: the browser's connectivity signal is
  // used instead, and the sync engine does its own retrying against the
  // one server that actually matters — the user's.
  async waitForInternet() {
    let retries = 3;
    while (retries-- > 0) {
      if (navigator.onLine) return true;
      // wait a bit before trying again.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    return false;
  }
};

expose(module);
export type NetworkCheck = typeof module;
