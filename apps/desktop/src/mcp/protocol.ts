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
 * The Model Context Protocol surface: JSON-RPC 2.0 over one HTTP endpoint.
 *
 * There is no Deno MCP SDK vendored here and pulling the Node one into the
 * runtime is not worth 300 lines, so the protocol is implemented directly.
 * It is deliberately the request/response half of the "streamable HTTP"
 * transport: every call is a POST that returns its own answer, with no
 * server-initiated stream. Nothing in this tool set needs to push, and a
 * transport that cannot push is a transport that cannot leak.
 *
 * This module is pure: it takes a parsed JSON-RPC message and a
 * NoteRepository and returns a response. Sockets, tokens and settings live
 * in server.ts, so the whole protocol is testable without listening on
 * anything.
 */

import { NoteError, type NoteRepository } from "./notes.ts";

/** Revisions this server can speak, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | {
    jsonrpc: "2.0";
    id: string | number | null;
    error: { code: number; message: string; data?: unknown };
  };

/** JSON-RPC reserved codes. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

type Json = Record<string, unknown>;

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  /** Write tools are only offered when the user has allowed editing. */
  mutates: boolean;
  run(repository: NoteRepository, input: Json): unknown;
}

const FORMAT_ENUM = {
  type: "string",
  enum: ["markdown", "html", "text"],
  description:
    "markdown (default) converts to and from the editor's HTML; html is " +
    "the stored markup verbatim; text is plain text.",
};

export const TOOLS: Tool[] = [
  {
    name: "search_notes",
    title: "Search notes",
    description:
      "Full-text search across note titles and bodies. Returns matching " +
      "notes without their content — follow up with read_note.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.searchNotes(str(input, "query"), num(input, "limit") ?? 25),
  },
  {
    name: "list_notes",
    title: "List notes",
    description:
      "List notes, most recently edited first, optionally filtered by " +
      "notebook, tag, favourite or pinned.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {
        notebook_id: { type: "string" },
        tag: { type: "string" },
        favorite: { type: "boolean" },
        pinned: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 25 },
        offset: { type: "integer", minimum: 0, default: 0 },
        sort_by: {
          type: "string",
          enum: ["dateEdited", "dateCreated", "title"],
          default: "dateEdited",
        },
        order: { type: "string", enum: ["asc", "desc"], default: "desc" },
      },
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.listNotes({
        notebookId: optionalStr(input, "notebook_id"),
        tag: optionalStr(input, "tag"),
        favorite: optionalBool(input, "favorite"),
        pinned: optionalBool(input, "pinned"),
        limit: num(input, "limit"),
        offset: num(input, "offset"),
        sortBy: optionalStr(input, "sort_by") as
          | "dateEdited"
          | "dateCreated"
          | "title"
          | undefined,
        order: optionalStr(input, "order") as "asc" | "desc" | undefined,
      }),
  },
  {
    name: "read_note",
    title: "Read a note",
    description:
      "Read one note's title and content. Notes kept in a vault are " +
      "encrypted with a key the app does not hold while locked and cannot " +
      "be read here.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        format: FORMAT_ENUM,
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.readNote(
        str(input, "id"),
        (optionalStr(input, "format") ?? "markdown") as "markdown",
      ),
  },
  {
    name: "list_notebooks",
    title: "List notebooks",
    description: "List every notebook with how many notes it holds.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    run: (repository) => repository.listNotebooks(),
  },
  {
    name: "list_tags",
    title: "List tags",
    description: "List every tag with how many notes carry it.",
    mutates: false,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    run: (repository) => repository.listTags(),
  },
  {
    name: "create_note",
    title: "Create a note",
    description:
      "Create a note. Content is Markdown by default; headings, lists, " +
      "task lists, quotes, code fences, tables and links are converted to " +
      "the editor's own format.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        format: FORMAT_ENUM,
        notebook_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        pinned: { type: "boolean" },
        favorite: { type: "boolean" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.createNote({
        title: str(input, "title"),
        content: optionalStr(input, "content"),
        format: (optionalStr(input, "format") ?? "markdown") as "markdown",
        notebookId: optionalStr(input, "notebook_id"),
        tags: strArray(input, "tags"),
        pinned: optionalBool(input, "pinned"),
        favorite: optionalBool(input, "favorite"),
      }),
  },
  {
    name: "update_note",
    title: "Update a note",
    description:
      "Change a note's title, content or flags. mode=replace (default) " +
      "swaps the whole body, append and prepend add to it. Replacing the " +
      "body with Markdown discards formatting Markdown cannot express, " +
      "such as colours and highlights — read the note as html and write " +
      "html back to preserve those.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        format: FORMAT_ENUM,
        mode: {
          type: "string",
          enum: ["replace", "append", "prepend"],
          default: "replace",
        },
        pinned: { type: "boolean" },
        favorite: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.updateNote({
        id: str(input, "id"),
        title: optionalStr(input, "title"),
        content: optionalStr(input, "content"),
        format: (optionalStr(input, "format") ?? "markdown") as "markdown",
        mode: (optionalStr(input, "mode") ?? "replace") as "replace",
        pinned: optionalBool(input, "pinned"),
        favorite: optionalBool(input, "favorite"),
      }),
  },
  {
    name: "trash_note",
    title: "Move a note to the trash",
    description:
      "Move a note to the trash, where the user can restore it. Nothing " +
      "here deletes a note permanently.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    run: (repository, input) => repository.trashNote(str(input, "id")),
  },
  {
    name: "create_notebook",
    title: "Create a notebook",
    description: "Create a notebook to group notes in. Returns its id, which " +
      "create_note and move_note_to_notebook take.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.createNotebook(
        str(input, "title"),
        optionalStr(input, "description") ?? "",
      ),
  },
  {
    name: "set_note_tags",
    title: "Set a note's tags",
    description:
      "Replace a note's tags with this list. Tags that do not exist yet " +
      "are created; an empty list clears them.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "tags"],
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.setTags(str(input, "id"), strArray(input, "tags") ?? []),
  },
  {
    name: "move_note_to_notebook",
    title: "Add a note to a notebook",
    description:
      "Add an existing note to a notebook. A note can be in more than one.",
    mutates: true,
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "string" },
        notebook_id: { type: "string" },
      },
      required: ["note_id", "notebook_id"],
      additionalProperties: false,
    },
    run: (repository, input) =>
      repository.moveToNotebook(
        str(input, "note_id"),
        str(input, "notebook_id"),
      ),
  },
];

export interface HandlerOptions {
  repository: NoteRepository;
  /** Tools that change notes are hidden and refused unless this is true. */
  allowWrites: boolean;
  serverName: string;
  serverVersion: string;
  /** Called after a tool changed anything, so sync and the UI find out. */
  onChanged?: () => void;
}

const INSTRUCTIONS =
  "These tools read and edit the notes in the Openotes app running on this " +
  "machine. Search or list first to find a note's id, then read it. Notes " +
  "kept in a vault are listed but their content stays encrypted. Nothing " +
  "here can delete a note permanently — trash_note moves it to the trash.";

/**
 * Handle one JSON-RPC message. Returns undefined for notifications, which
 * by the specification get no response at all.
 */
export function handleMessage(
  message: unknown,
  options: HandlerOptions,
): JsonRpcResponse | undefined {
  if (
    typeof message !== "object" || message === null ||
    (message as Json).jsonrpc !== "2.0" ||
    typeof (message as Json).method !== "string"
  ) {
    return error(null, RPC_INVALID_REQUEST, "Not a JSON-RPC 2.0 request");
  }

  const request = message as JsonRpcRequest;
  const id = request.id ?? null;
  const isNotification = request.id === undefined;
  const params = (request.params ?? {}) as Json;

  try {
    switch (request.method) {
      case "initialize":
        return ok(id, initialize(params, options));

      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;

      case "ping":
        return ok(id, {});

      case "tools/list":
        return ok(id, {
          tools: visibleTools(options).map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });

      case "tools/call":
        return ok(id, callTool(params, options));

      case "resources/list":
        return ok(id, { resources: [] });

      case "resources/templates/list":
        return ok(id, {
          resourceTemplates: [
            {
              uriTemplate: "openotes://note/{id}",
              name: "note",
              title: "A note",
              description:
                "One note by id, as Markdown. Ids come from search_notes " +
                "or list_notes.",
              mimeType: "text/markdown",
            },
          ],
        });

      case "resources/read":
        return ok(id, readResource(params, options));

      case "prompts/list":
        return ok(id, { prompts: [] });

      default:
        if (isNotification) return undefined;
        return error(
          id,
          RPC_METHOD_NOT_FOUND,
          `Unknown method: ${request.method}`,
        );
    }
  } catch (problem) {
    if (isNotification) return undefined;
    if (problem instanceof NoteError) {
      return error(id, RPC_INVALID_PARAMS, problem.message, {
        code: problem.code,
      });
    }
    return error(
      id,
      RPC_INTERNAL_ERROR,
      problem instanceof Error ? problem.message : String(problem),
    );
  }
}

function initialize(params: Json, options: HandlerOptions) {
  const requested = typeof params.protocolVersion === "string"
    ? params.protocolVersion
    : LATEST_PROTOCOL_VERSION;
  const agreed =
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;

  return {
    protocolVersion: agreed,
    capabilities: { tools: {}, resources: {} },
    serverInfo: {
      name: options.serverName,
      title: "Openotes",
      version: options.serverVersion,
    },
    instructions: options.allowWrites
      ? INSTRUCTIONS
      : `${INSTRUCTIONS} Editing is turned off, so only the read tools are ` +
        `available.`,
  };
}

function visibleTools(options: HandlerOptions): Tool[] {
  return options.allowWrites ? TOOLS : TOOLS.filter((tool) => !tool.mutates);
}

function callTool(params: Json, options: HandlerOptions) {
  const name = typeof params.name === "string" ? params.name : "";
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new NoteError(`Unknown tool: ${name}`, "unknown-tool");
  if (tool.mutates && !options.allowWrites) {
    throw new NoteError(
      `"${name}" changes notes, and editing from an assistant is turned ` +
        `off. Turn on "Let the assistant edit notes" in Openotes → ` +
        `Settings → AI assistant.`,
      "writes-disabled",
    );
  }

  const input = (params.arguments ?? {}) as Json;
  try {
    const result = tool.run(options.repository, input);
    if (tool.mutates) options.onChanged?.();
    return {
      // Both shapes: `content` for clients that only read text, and
      // `structuredContent` for those that can use the real object.
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: wrapStructured(result),
      isError: false,
    };
  } catch (problem) {
    // A tool that fails because of the input reports through the result, not
    // as a protocol error: the model is meant to read it and try again.
    const message = problem instanceof Error
      ? problem.message
      : String(problem);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

function wrapStructured(result: unknown): Json {
  return Array.isArray(result) ? { items: result } : (result as Json);
}

function readResource(params: Json, options: HandlerOptions) {
  const uri = typeof params.uri === "string" ? params.uri : "";
  const match = /^openotes:\/\/note\/([A-Za-z0-9_-]+)$/.exec(uri);
  if (!match) {
    throw new NoteError(
      `Not a note URI: ${uri || "(missing)"} — expected openotes://note/<id>`,
      "invalid-uri",
    );
  }
  const note = options.repository.readNote(match[1], "markdown");
  return {
    contents: [
      {
        uri,
        name: note.title,
        mimeType: "text/markdown",
        text: `# ${note.title}\n\n${note.content}`,
      },
    ],
  };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function error(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

// -- parameter coercion ------------------------------------------------------
// The specification leaves argument validation to the server, and a model
// will happily send a number where a string belongs.

function str(input: Json, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value) {
    throw new NoteError(
      `"${key}" is required and must be a string.`,
      "invalid-input",
    );
  }
  return value;
}

function optionalStr(input: Json, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new NoteError(`"${key}" must be a string.`, "invalid-input");
  }
  return value;
}

function optionalBool(input: Json, key: string): boolean | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new NoteError(`"${key}" must be true or false.`, "invalid-input");
  }
  return value;
}

function num(input: Json, key: string): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
    throw new NoteError(`"${key}" must be a number.`, "invalid-input");
  }
  return parsed;
}

function strArray(input: Json, key: string): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new NoteError(
      `"${key}" must be an array of strings.`,
      "invalid-input",
    );
  }
  return value as string[];
}
