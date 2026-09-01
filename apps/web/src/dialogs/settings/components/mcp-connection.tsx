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
 * What the user pastes into their assistant.
 *
 * The token is fetched only when this panel is on screen and only shown
 * behind a deliberate "Show" — it grants an assistant the same reach over
 * notes the settings above allow, so it should not be sitting in a
 * screenshot of the settings dialog.
 */

import { useCallback, useEffect, useState } from "react";
import { Button, Flex, Text } from "@theme-ui/components";
import { showToast } from "../../../utils/toast";
import {
  store as mcpStore,
  useStore as useMcpStore
} from "../../../stores/mcp-store";
import type { McpClientConfig } from "../../../common/desktop-bridge/index.desktop";

export function McpConnectionPanel() {
  const status = useMcpStore((store) => store.status);
  const [config, setConfig] = useState<McpClientConfig>();
  const [revealed, setRevealed] = useState(false);

  const load = useCallback(async () => {
    try {
      setConfig(await mcpStore.get().clientConfig());
    } catch (error) {
      showToast(
        "error",
        error instanceof Error ? error.message : String(error)
      );
    }
  }, []);

  useEffect(() => {
    setRevealed(false);
    void load();
  }, [load, status?.url, status?.listening]);

  if (!status?.listening || !config?.listening) {
    return (
      <Text variant="subBody" sx={{ color: "var(--paragraph-error)" }}>
        {status?.lastError ??
          "Not listening yet. Open a vault, or check the port above."}
      </Text>
    );
  }

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast("success", `${what} copied.`);
    } catch {
      showToast("error", "Could not reach the clipboard.");
    }
  };

  return (
    <Flex sx={{ flexDirection: "column", gap: 2, flex: 1 }}>
      <Text variant="subBody">
        Listening on {config.url} — {status.toolCount} tools,{" "}
        {status.allowWrites ? "read and write" : "read only"}.
      </Text>

      <Text variant="subBody" sx={{ fontWeight: "bold", mt: 1 }}>
        Claude Code
      </Text>
      <Snippet value={config.command} onCopy={() => copy(config.command, "Command")} />

      <Text variant="subBody" sx={{ fontWeight: "bold", mt: 1 }}>
        A client that keeps its servers in a JSON file
      </Text>
      <Snippet value={config.json} onCopy={() => copy(config.json, "Configuration")} />

      <Flex sx={{ gap: 1, alignItems: "center", mt: 1 }}>
        <Button
          variant="secondary"
          onClick={() => setRevealed((shown) => !shown)}
        >
          {revealed ? "Hide token" : "Show token"}
        </Button>
        <Button variant="secondary" onClick={() => copy(config.token, "Token")}>
          Copy token
        </Button>
      </Flex>
      {revealed && (
        <Snippet value={config.token} onCopy={() => copy(config.token, "Token")} />
      )}
      <Text variant="subBody" sx={{ color: "var(--paragraph-secondary)" }}>
        The token is the whole of the security here. Anyone who has it, and
        can reach this machine&apos;s loopback address, can do what the
        switches above allow.
      </Text>
    </Flex>
  );
}

function Snippet(props: { value: string; onCopy: () => void }) {
  return (
    <Flex
      sx={{
        alignItems: "flex-start",
        gap: 1,
        bg: "var(--background-secondary)",
        border: "1px solid var(--border)",
        borderRadius: "default",
        p: 1
      }}
    >
      <Text
        as="pre"
        sx={{
          flex: 1,
          m: 0,
          fontFamily: "monospace",
          fontSize: "subBody",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          color: "var(--paragraph)"
        }}
      >
        {props.value}
      </Text>
      <Button variant="secondary" sx={{ py: 0 }} onClick={props.onCopy}>
        Copy
      </Button>
    </Flex>
  );
}
