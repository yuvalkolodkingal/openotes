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

/**
 * The client half of the Agent Client Protocol.
 *
 * Openotes hosts agents — Claude Code, Gemini, OpenCode, Codex, Antigravity —
 * and is never an agent itself, so only the client half is implemented. See
 * types.ts for the protocol shapes, and for what a real agent returned that
 * the published schema does not mention.
 */

export * from "./types.ts";
export * from "./jsonrpc.ts";
export * from "./stdio.ts";
export * from "./client.ts";
