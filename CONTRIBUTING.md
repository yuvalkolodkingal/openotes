# Contributing

Thanks for considering it.

Openotes is a fork of [Notesnook](https://github.com/streetwriters/notesnook).
Before you start, it is worth knowing which project a change belongs to:

| Change | Where it belongs |
|---|---|
| The editor, the note data model, migrations, crypto primitives | **Upstream Notesnook.** Everyone benefits, this fork included, and it will reach us on the next merge. |
| Mobile, cloud sync, subscriptions, publishing | **Upstream.** Not present here. |
| WebDAV sync or backup, the Deno runtime, packaging | **Here.** |
| A bug in the shared UI | Either. If it reproduces in Notesnook, upstream is the better home. |

---

## Getting set up

Requires [Deno](https://deno.land) 2.9+ and a C compiler.

```bash
git clone https://github.com/yuvalkolodkingal/notesnook.git openotes
cd openotes
deno task build:native
deno task build:ui
deno task dev
```

[BUILDING.md](BUILDING.md) has the details, including how to run two
profiles against one WebDAV server to exercise synchronization by hand.

---

## Before you open a pull request

```bash
deno task fmt          # format
deno task lint         # lint
deno task check        # type-check
deno task test         # unit and protocol tests
deno task test:webdav  # against a real WebDAV server
```

All five run in CI, along with a check that Electron and React Native have
not crept back into the dependency tree.

---

## What good looks like here

**Data safety is the first consideration, every time.** This application
holds people's notes. When a change could lose or corrupt data, that
outweighs elegance, performance and diff size. Concretely, the invariants
that must not regress:

- A change is only marked synchronized after its remote object is verified.
- Journal entries are immutable.
- Conflicts keep both versions and tell the user.
- Deletions are tombstones; a stale device cannot resurrect a deleted note.
- A restore takes a verified safety backup first and rolls back intact.
- A missing encryption library is a startup error, never a silent downgrade.

If a change touches any of those, say so in the pull request and explain why
it is still safe.

**Test what you change.** Especially the sync engine. The suite is fast
(about a second) and the integration suite runs against a real WebDAV
server — that suite has already caught a real defect that a mock would have
missed, which is why it exists.

**Write for the next reader.** Comments should say *why*, particularly where
the reason is not visible in the code: a workaround for a specific server's
behaviour, an ordering that exists for crash-safety, a trade-off that was
chosen deliberately. Do not comment what the next line does.

**Keep upstream mergeable.** `packages/core`, `packages/editor` and most of
`apps/web` are deliberately close to upstream. Gratuitous divergence there
costs us on every merge. `apps/desktop` has no shared history and is free.

**Say what you actually verified.** "Tests pass" should mean you ran them.
If something is untested or you could not check it on your platform, write
that down — an honest gap is useful, a false claim is not.

---

## Code style

Deno's formatter and linter decide layout; run `deno task fmt` and stop
thinking about it.

Beyond that:

- Every source file carries the GPL header. Copy it from a neighbour.
- New code is TypeScript with explicit types at module boundaries.
- Error messages are written for a user who is stuck, not for a developer
  reading a stack trace: say what went wrong and what to do about it.
- Prefer Deno and web APIs over Node-only ones. npm packages are fine
  through Deno's compatibility layer where they earn their place.
- No TODOs in merged code. Either finish it or open an issue.

---

## Commits and pull requests

Write commit messages that explain the change and its reasoning. A reader
six months from now should be able to tell what you did and why without
opening the diff.

In the pull request, cover: what changed, why, how you verified it, and
anything you could not verify.

---

## Reporting bugs

Include your platform and version, what happened, what you expected, and
whether it reproduces from a clean profile
(`OPENOTES_DATA_DIR=/tmp/test deno task dev`).

For sync problems, the relevant details are your server software, whether
"Test connection" succeeds, and what the status indicator says. Logs live in
the cache directory and are reachable through `Help → Open log directory`.
They are redacted at the point of writing — no note content, keys or
passwords — but do skim one before attaching it.

Security vulnerabilities go through
[SECURITY.md](SECURITY.md), not the public issue tracker.

---

## Licence

Contributions are licensed GPL-3.0-or-later, matching the project and
upstream. By contributing you confirm you have the right to license your
work that way.
