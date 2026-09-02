# The AI assistant

Openotes hosts an AI assistant, but ships no model, no API keys and no LLM code
of its own. It speaks the [Agent Client Protocol][acp] as a *client*, which
means the assistant you get is whichever agent you connect — Claude Code,
Gemini, OpenCode, Codex, Antigravity, or anything else that speaks ACP.

[acp]: https://agentclientprotocol.com

---

## Why it works this way

Three things follow from Openotes not being the agent:

**No API keys in Openotes.** Every one of these agents already authenticates
with a subscription you have — a Claude account, a Google account, a ChatGPT
account. That sign-in belongs to the agent's own CLI, happens in your browser,
and Openotes never sees the credentials. Where the CLI is already signed in,
connecting takes one click and no login step at all.

**No model to maintain.** A better model, a new provider or a cheaper tier is
someone else's release, not ours.

**Adding an agent is a data change.** ACP is a protocol, not a partnership, so
supporting a new one is an entry in `apps/desktop/src/acp/catalog.ts` rather
than an integration. It is not a free-form setting, though: the runtime will
only start a program named in its permission manifest, so an arbitrary command
cannot be pointed at — see the note under Troubleshooting.

The cost is that an agent is a separate program running on your computer. That
is a real trade and [ARCHITECTURE.md §3](ARCHITECTURE.md) describes exactly what
it costs.

---

## Connecting one

Settings → AI lists every agent Openotes knows how to launch, and whether it is
installed. Installing one is the agent's own instructions — usually a single
`npm install -g`.

The first time you connect an agent, Openotes asks whether you want to let it
run. That question is not a formality: an approved agent runs with your
privileges. The answer is recorded against the binary's **resolved absolute
path**, so if the program at that path is later replaced, you are asked again.

After that, connecting reports one of two things:

- **Connected** — the agent's CLI is already signed in and there is nothing
  else to do.
- **Sign in** — the agent offers one or more sign-in methods. Choosing one
  hands off to the agent, which opens your browser. Openotes is not part of
  that exchange and stores nothing from it.

---

## What the agent can and cannot see

An agent reaches your notes through exactly two protocol methods,
`fs/read_text_file` and `fs/write_text_file`, and both are answered by Openotes
rather than by the filesystem.

**Notes are never written to disk for the agent.** Each session gets a real,
empty workspace directory — real because the protocol requires an absolute path
for `cwd`, empty because a directory of plaintext notes outside the encrypted
database is not a trade worth making. A note read is answered from the database
and rendered to Markdown on the way out.

**Locked notes are never exposed.** The export path already refuses to render a
vault note without an unlocked vault, and the agent path does not offer to
unlock one. A locked note is invisible to an agent, not merely unreadable.

**No terminal.** Openotes tells every agent `terminal: false` at the handshake,
so a well-behaved agent will not try to run commands through it.

**Every write asks first.** When an agent wants to change a note, it must ask,
and the request blocks until you answer. Refusing is not an error the agent can
retry around — it is told the request was cancelled.

---

## What it looks like while it works

An agent streams its work as it goes: the answer as it is written, its
reasoning where it chooses to share it, a plan when it makes one, and each tool
call with its status. Stopping is immediate — the current turn ends with
`cancelled` rather than being abandoned.

If an agent fails to start, the tail of what it printed is kept and shown. That
is usually the only thing that explains a bad install.

---

## Troubleshooting

**"… is not installed."** Openotes looks for the agent's binary on your
`PATH`. If it finds one somewhere else — under `nvm`, Homebrew or
`~/.local/bin` — it says exactly where, because that case needs a different
fix: add that directory to your `PATH` and restart Openotes, or start Openotes
from a terminal that already has it.

It cannot simply launch the binary where it lies. Openotes is compiled with a
fixed list of programs it may run, and the runtime binds that list to the
binaries found on `PATH` when it starts; a program at any other path is
refused, and so is one under a name that is not on the list. That is the same
restriction that stops an agent from being an arbitrary command, and it is
deliberate — see [SECURITY.md §10](SECURITY.md).

**The agent starts and immediately stops.** Check the diagnostics shown with
the error — an agent that cannot find its own configuration usually says so on
its first line.

**"This agent speaks Agent Client Protocol version N."** The agent is newer or
older than this build. Updating either one resolves it.

**A sign-in that never completes.** The browser flow belongs to the agent, not
to Openotes. Running the agent's own CLI once, directly in a terminal, is the
quickest way to see what it is asking for.
