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
 * The state behind Settings → AI assistant.
 *
 * The access token is deliberately NOT held here. It is fetched on demand by
 * the connection panel when the user asks to see the client snippet, and it
 * is not kept in a store other parts of the interface can read.
 */

import {
  hasDesktopRuntime,
  onDesktopEvent,
  type McpClientConfig,
  type McpSettings,
  type McpStatus
} from "../common/desktop-bridge/index.desktop";
import { desktop } from "../common/desktop-bridge";
import createStore from "../common/store";
import BaseStore from "./index";

class McpStore extends BaseStore<McpStore> {
  settings?: McpSettings;
  status?: McpStatus;
  /** "we are done trying", not "it worked" — the form waits on this. */
  isLoaded = false;

  refresh = async () => {
    try {
      if (!hasDesktopRuntime()) return;
      const [settings, status] = await Promise.all([
        desktop.mcp.getSettings.query(),
        desktop.mcp.status.query()
      ]);
      this.set((state) => {
        state.settings = settings;
        state.status = status;
      });
    } finally {
      this.set((state) => {
        state.isLoaded = true;
      });
    }
  };

  setSettings = async (partial: Partial<McpSettings>) => {
    const status = await desktop.mcp.setSettings.mutate(partial);
    const settings = await desktop.mcp.getSettings.query();
    this.set((state) => {
      state.settings = settings;
      state.status = status;
    });
  };

  /** Fetched on demand: it carries the token. */
  clientConfig = (): Promise<McpClientConfig> =>
    desktop.mcp.clientConfig.query();

  setStatus = (status: McpStatus) => {
    this.set((state) => {
      state.status = status;
    });
  };
}

const [useStore, store] = createStore<McpStore>(
  (set, get) => new McpStore(set, get)
);

let attached = false;
function attachRuntimeListeners() {
  if (attached || !hasDesktopRuntime()) return;
  attached = true;
  onDesktopEvent("mcp.status", (payload) => {
    if (payload && typeof payload === "object" && "listening" in payload) {
      store.get().setStatus(payload as McpStatus);
    }
  });
}
attachRuntimeListeners();

export { useStore, store };
