# Connecting an AI assistant

Openotes speaks the [Model Context Protocol](https://modelcontextprotocol.io),
so an assistant running on your machine can search, read and — if you let it —
write your notes.

This is the opposite direction from [AI.md](AI.md): there, Openotes launches
an agent over the Agent Client Protocol. Here, an assistant you already run
connects to Openotes. Use whichever fits the assistant you have.

Nothing about this is a service. There is no account, no key to buy and no
request that leaves the machine. The assistant connects **to Openotes**, over a
port on `127.0.0.1`, and only while Openotes is open with a vault unlocked.

## Turning it on

Settings → **AI assistant**.

1. Turn on **Let an assistant work with your notes**. Openotes starts
   listening on port 4747 (change it if something else has that port).
2. Copy the snippet under **Connect your assistant**.
3. Optionally turn on **Let the assistant edit notes**. Leave it off and the
   assistant can search and read, and the tools that change anything are not
   even offered to it.

For Claude Code, the snippet is a command:

```sh
claude mcp add --transport http openotes http://127.0.0.1:4747/mcp \
  --header "Authorization: Bearer <your token>"
```

For a client that keeps its servers in a JSON file, the snippet is the entry:

```json
{
  "mcpServers": {
    "openotes": {
      "type": "http",
      "url": "http://127.0.0.1:4747/mcp",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
```

## What the assistant can do

| Tool | What it does |
|---|---|
| `search_notes` | Full-text search over titles and bodies |
| `list_notes` | List notes, filtered by notebook, tag, favourite or pinned |
| `read_note` | One note, as Markdown, HTML or plain text |
| `list_notebooks`, `list_tags` | What exists, and how many notes are in each |
| `create_note` | A new note, from Markdown |
| `update_note` | Change a title or body; replace, append or prepend |
| `trash_note` | Move a note to the trash |
| `create_notebook` | A new notebook |
| `set_note_tags` | Replace a note's tags |
| `move_note_to_notebook` | File a note |

The last six only exist while **Let the assistant edit notes** is on. Notes are
also exposed as resources at `openotes://note/<id>`.

Markdown is converted to and from the editor's own format, so headings, lists,
task lists, quotes, code fences, tables and links survive in both directions.
Formatting Markdown cannot express — colours, highlights, mathematics —
survives a read but is lost if the assistant *replaces* the body with Markdown.
Ask it to read and write `format: "html"` when that matters.

## What it cannot do

- **Read a note in a vault.** Vault notes are encrypted with a key this process
  does not hold while they are locked. They appear in listings, with
  `locked: true`, and reading or writing one is refused.
- **Delete anything permanently.** `trash_note` is the only removal, and the
  trash is yours to empty.
- **Reach anything but notes.** The endpoint serves these tools and nothing
  else. There is no filesystem, shell or network access behind it.
- **Work while Openotes is closed**, or before you have unlocked your vault.

## What guards it

- **Off by default.** Nothing listens until you turn it on.
- **Loopback only.** The listener binds `127.0.0.1`, never `0.0.0.0`, so it is
  not reachable from your network.
- **A bearer token** on every request, compared in constant time. It lives in
  `mcp.token` in the configuration directory with `0600` permissions, so a
  client configuration you write once keeps working across launches. **Replace
  token** in settings invalidates every copy of it.
- **Origin and Host are checked** and the CORS preflight is refused, so a page
  in your browser cannot reach the endpoint even if it somehow had the token.
- **Reading and writing are separate switches**, and turning writing on asks
  first.

The honest limit: the token is the whole of the security. Any process running
as you on this machine can read `mcp.token` — but such a process can also read
the app's memory, so this does not widen what an attacker in that position can
already do. It does mean the token is not a secret you should paste anywhere
else.

## Troubleshooting

**"Not listening yet."** Open a vault. The endpoint answers questions about
notes, so it starts once there are notes to answer about.

**"Port 4747 is already in use."** Pick another port in settings, then update
your client's configuration — the port is part of the URL.

**The assistant only sees five tools.** Editing is off. Turn it on, then
reconnect the client: MCP clients ask for the tool list once, at connect time.

**Nothing appears in Openotes after the assistant writes.** It should be
immediate — the runtime tells the interface to reload. If it is not, the
interface has lost the event; reopening the window is enough.
