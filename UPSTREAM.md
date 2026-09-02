# Upstream tracking

Openotes is a fork of [Notesnook](https://github.com/streetwriters/notesnook) by
Streetwriters (Private) Limited, licensed GPL-3.0-or-later.

This file records where the fork stands relative to upstream, what was removed,
and where the two architectures have diverged far enough that a merge will not
be mechanical.

---

## Current base

|                          |                                    |
| ------------------------ | ---------------------------------- |
| Upstream repository      | `streetwriters/notesnook`          |
| Base revision            | `09a0c30` (merge of release/3.4.7) |
| Base version             | 3.4.7                              |
| Fork version             | 2.2.1                              |
| Fork repository          | `yuvalkolodkingal/openotes`        |
| Last merge from upstream | Initial fork point                 |

### Remotes

```bash
git remote add upstream https://github.com/streetwriters/notesnook.git
git fetch upstream
```

`origin` is the fork; `upstream` is Notesnook. Never push to `upstream`.

---

## Attribution

Upstream copyright headers are preserved verbatim in every file that originated
there, including files this fork has modified. New files carry the same
GPL-3.0-or-later header. `LICENSE` and `AUTHORS` are unchanged.

The fork is renamed throughout — application name, identifier, icons, data
directory, update endpoint, release repository and user agent — so that a build
of this project cannot be mistaken for an official Notesnook release. That
renaming is a licensing and honesty requirement, not branding.

---

## Packages intentionally removed

| Removed                                                                                           | Reason                                            | Anything depending on it?                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `apps/mobile`                                                                                     | Replaced in 2.2.1 by a small Expo app of the fork's own | No (rewritten)                        |
| `packages/editor-mobile`                                                                          | Mobile editor wrapper                             | No                                          |
| `apps/monograph`                                                                                  | Public note publishing; requires Notesnook Cloud  | No                                          |
| `apps/vericrypt`                                                                                  | Unrelated tool                                    | No                                          |
| `apps/theme-builder`                                                                              | Unrelated tool                                    | No                                          |
| `extensions/web-clipper`                                                                          | Browser extension, out of scope                   | Referenced by `apps/web`; reference removed |
| `servers/themes`                                                                                  | Theme marketplace server; bundled themes are kept | Referenced by `apps/web`; reference removed |
| `fastlane/`                                                                                       | Play Store / F-Droid metadata                     | No                                          |
| Electron main process, preload, tRPC router, electron-builder config                              | Replaced by the Deno Desktop runtime              | Replaced                                    |
| Mobile and Electron CI workflows                                                                  | Nothing left to build                             | Replaced                                    |
| Node monorepo tooling (root `package.json`, `scripts/*.mjs`, eslint, prettier, husky, commitlint) | Deno is the runtime and task runner               | Replaced by `deno.json`                     |

## Packages kept and reused

`core`, `common`, `crypto`, `sodium`, `editor`, `intl`, `logger`,
`streamable-fs`, `theme`, `ui`, and `apps/web` as the interface source. These
are upstream's and are deliberately kept close to upstream so that improvements
there remain mergeable.

## Packages added

`packages/sync-webdav` — the encrypted WebDAV synchronization and backup engine.
Entirely new; no upstream counterpart.

---

## Architecture differences

These are the places where a future merge needs thought rather than a three-way
diff.

### 1. Host runtime (`apps/desktop`)

Upstream's `apps/desktop` is an Electron application. This fork's is a Deno
Desktop application. **Essentially nothing in this directory is shared with
upstream any more.** Upstream changes here are read for intent and
reimplemented, not merged.

### 2. Renderer ↔ host transport

Upstream: tRPC over Electron IPC (`electron-trpc`), with the router in
`apps/desktop/src/api`.

Here: an allowlisted procedure table reached through Deno Desktop bindings. The
**call shape was deliberately preserved** —
`desktop.integration.showNotification.mutate({...})` still works — so the ~50
renderer call sites did not change and upstream changes to those call sites
usually still merge. Only `apps/web/src/common/desktop-bridge/index.desktop.ts`
was rewritten.

Consequence: an upstream change that _adds a procedure_ needs the procedure
added to `apps/desktop/src/rpc/protocol.ts` and implemented in `handlers.ts`, or
it will be rejected at the boundary.

### 3. Database driver

Upstream: `better-sqlite3-multiple-ciphers` in the Electron main process.

Here: Deno FFI (`@db/sqlite`) against a bundled SQLite3MultipleCiphers build.
The same encryption layer and the same FTS5 extensions, so the schema,
migrations and queries in `packages/core` are unchanged and upstream migrations
merge normally.

### 4. Synchronization

Upstream: `packages/core/src/api/sync` against Notesnook Cloud (SignalR, S3
attachments, account keys).

Here: `packages/sync-webdav` against a user's WebDAV server. The fork reuses
core's dirty-flag and tombstone bookkeeping rather than replacing it, so core's
collections are untouched. Upstream changes to the cloud sync transport do not
apply; upstream changes to how items are marked dirty do.

### 5. Attachments

Upstream: OPFS in the renderer.

Here: the filesystem, under the Deno side. Privileged I/O belongs off the
renderer, and it means user data survives a cleared webview profile.

### 6. Subscriptions

Upstream: a 35-feature matrix keyed on `User.subscription.plan`, defaulting to
the free tier when nobody is logged in.

Here: `packages/common/src/utils/is-feature-available.ts` is rewritten around a
`capabilities` object, keeping every exported name and signature so call sites
are unchanged. Upstream changes that _add_ a feature id merge cleanly; upstream
changes to the gating logic itself are discarded.

### 7. Accounts and cloud UI

Login, signup, MFA, recovery, email verification, subscription and checkout UI,
monograph publishing and the theme marketplace are removed. Upstream changes to
those areas do not apply.

---

## Known conflict areas

Expect to resolve these by hand on every merge:

| Area                                                  | Why                                                |
| ----------------------------------------------------- | -------------------------------------------------- |
| `apps/desktop/**`                                     | Different runtime; no shared history in practice.  |
| `apps/web/src/common/desktop-bridge/index.desktop.ts` | Rewritten transport.                               |
| `apps/web/src/common/db.ts`                           | Host configuration and subscription hooks removed. |
| `apps/web/src/bootstrap.tsx`, `views/auth.tsx`        | Auth-gated first-run removed.                      |
| `packages/common/src/utils/is-feature-available.ts`   | Rewritten.                                         |
| `packages/core/src/api/index.ts`                      | Subscription and SSE registrations removed.        |
| `packages/sodium/src/{browser,types}.ts`              | Small additions for Deno type resolution.          |
| `.github/workflows/**`                                | Entirely different pipeline.                       |
| Root configuration                                    | Deno replaces the Node monorepo tooling.           |

Upstream changes to `packages/{core,editor,ui,theme,intl,logger,streamable-fs}`
and to most of `apps/web/src` should merge with ordinary effort. Keeping it that
way is the reason those packages were left as close to upstream as possible.

---

## Merging from upstream

```bash
git fetch upstream
git checkout -b merge/upstream-X.Y.Z
git merge upstream/master
```

Then, in order:

1. Resolve conflicts. For `apps/desktop`, prefer this fork's file and port the
   _intent_ of the upstream change by hand.
2. Check whether upstream added a call site for a procedure that does not exist
   in `apps/desktop/src/rpc/protocol.ts`; add and implement it, or remove the
   call site if the feature does not apply here.
3. Check for reintroduced subscription checks, Notesnook host URLs, Electron
   imports or telemetry. `deno task verify:no-electron` catches some of this;
   grep for the hosts listed in `PORTING_NOTES.md` §5 for the rest.
4. Run `deno task check`, `deno task test` and `deno task test:webdav`.
5. Update the base revision at the top of this file.

**Do not preserve upstream architecture that no longer fits merely to make the
diff smaller.** A smaller diff is not worth a worse application.

---

## Fork changelog

### 2.2.1 — the agents launch, and notes reach a database and a phone

- Fixed why no agent worked outside a terminal. On Windows an npm-installed
  agent is a `.cmd` shim, which the runtime detected and could not start; the
  shim's script is now run under `node`. On Linux the packaged builds start
  through a launcher that extends `PATH` before the runtime binds its
  allowlist, so agents under `nvm` or `~/.local/bin` are launchable from a
  desktop launcher. Two catalog entries named commands that do not exist
  (`codex acp`, `antigravity --acp`); they are `codex-acp` and `agy --acp`.
- Made Claude's sign-in reachable: the adapter only lists it for a client
  that understands terminal sign-ins, and refuses `authenticate` for it. The
  command is shown, run where permitted, its page opened, the agent restarted.
- A live model picker in the panel, through `session/set_model`, with the
  launch-time picker as the fallback.
- A Postgres database as a sync backend (`packages/sync-sql`): a plain
  Postgres over a socket, Neon over its HTTPS endpoint, Supabase over REST,
  with real create-if-absent and compare-and-swap. Neon (API key) and
  Supabase (your own OAuth app, or a token) create the project and the table.
- A second device now adopts the repository's salt instead of deriving a
  different key and failing the passphrase check.
- A phone app (`apps/mobile`, Expo) that syncs to Neon or Supabase with the
  desktop's own engine, conflict rules and Markdown converter, on a pure-JS
  build of the cryptography that is checked against libsodium in the tests.

### 2.2.0 — the assistant actually works

- Fixed the AI assistant, which had never worked in a released build. Five
  defects: a transport error left the turn hanging forever, the handshake had
  no deadline, sign-in was unreachable so an unauthenticated agent failed with
  a raw protocol error, the agent could not read a single note, and Claude
  Code was launched under the wrong binary name.
- Made the permission manifest real. It was documented as a subprocess
  sandbox and never applied: the binary was compiled with `-A`, and Deno binds
  a config permission set only with `--permission-set`. Every release from
  2.0.0 to 2.1.2 could run any program.
- Added a model picker. ACP has no model selection, so the choice is made when
  the agent process starts, from the catalog; agents whose mechanism could not
  be confirmed get no picker rather than one that does nothing.
- Surfaced session modes, which were plumbed through four layers with no
  control bound to them.
- Added S3 (and every S3-compatible service) and Box as sync backends, and
  Koofr, pCloud and Nextcloud as WebDAV presets rather than as new API
  clients.
- Added two guards against the class of bug behind most of the above: a test
  that the manifest covers what the code reads and runs, and a CI check that
  drives the whole agent path under the shipped permission set rather than
  under `-A`.

### 2.1.2

Everything 2.1.1 fixed, plus what an adversarial review of the whole 2.1 diff
turned up — seventeen confirmed defects out of thirty candidates, looking
specifically for the kind that passes a unit test and breaks in the real
webview. 2.1.1 itself was never published: the release job refused to build it a
second time under a tag already pointing elsewhere, which is the guard working.

- **The smoke test was asking a dead process.** Its new boot check ran after the
  shutdown block had signalled the application and awaited its exit, so
  "connection refused" was the corpse rather than a fact about the platform —
  and the 2.1.1 commit mistook it for one and exempted Windows. The questions
  that need a live application are now asked before it is stopped, and the
  exemption is gone.
- **The smoke test never stopped the application at all.** It launched through
  xvfb-run, whose shell was the process it held, so the application was
  reparented to init and survived, while the isolated HOME was deleted
  underneath it. It now starts its own X server and spawns the application
  directly. `mcp-check` did the same thing and additionally ran
  `pkill -x
  openotes`, which signals every Openotes on the machine — including
  the real one the user has open.
- **Two `mcp-check` assertions could not fail** — one fell back to stringifying
  any reply, the other passed when the endpoint never started.
- **The health route answered before the guards**, so a page at a DNS name
  rebound to 127.0.0.1 could still learn Openotes is running here.
- **A start-up failure is now on screen** instead of a dropped promise behind
  the splash. That is what 2.1.0 looked like from the outside, and why
  diagnosing it needed a hand-injected probe.
- **A downloaded theme reusing a shipped id** was discarded on every launch;
  only an older copy of a shipped theme is refreshed now.
- **The boot theme outlived its purpose**, pinning one scheme's background and
  `color-scheme` for the life of the page.
- **Changing sync provider carried the previous provider's connection**, so the
  settings screen reported one drive connected on another's sign-in.
- **A mistyped MCP port took down a working endpoint** and was saved for the
  next launch; and the panel kept showing a token that "Replace token" had
  already invalidated.
- The flatpak advertised 1.0.0 as its newest release, and a local build could
  ship a stale compiled theme while the theme tests read the source and passed.

### 2.1.1

- **2.1.0 did not start.** Every window sat at "Starting up the engines" and
  nothing was logged. 2.1.0 hardened the interface server to refuse any request
  carrying an `Origin` header, on the reasoning that the webview only makes
  same-origin navigations and subresource loads and those carry no Origin. Vite
  emits the entry bundle as `<script type="module"
  crossorigin>` and the
  stylesheet as `<link rel="stylesheet" crossorigin>`, and a crossorigin
  subresource is fetched in CORS mode — which does send an Origin, naming that
  very server. So the application forbade itself its own JavaScript. The guard
  now compares the Origin against the request's own authority instead of
  refusing its presence; a page on another origin is refused exactly as before.
- **The smoke test now asks whether the interface can load itself**: it fetches
  the served document from a real build, extracts every script and stylesheet
  the document names, and requests each one carrying the Origin a browser sends.
  It fails against the published 2.1.0 and passes against this one.
  `server_test.ts` covers the same ground against a real listener, including a
  Host set down a raw socket, which `fetch` will not do.

### 2.1.0

- **The Model Context Protocol**, so an assistant the user already runs can
  connect to Openotes and search, read and edit notes. The opposite direction
  from 2.0.0's ACP host, and the one people mean when they ask for MCP tools.
  Off by default, read-only when enabled, editing a second switch; notes in a
  vault are never readable through it and nothing it can do deletes a note
  permanently.
- **The drive providers are reachable.** 2.0.0 shipped Google Drive, Dropbox and
  OneDrive as tested libraries that nothing in the application constructed: the
  settings had no provider, the service always built a WebDAV client, and
  deno.json's specifier for @notesnook/sync-files held two paths so the package
  could not even be imported. All three are fixed, and the settings screen now
  has a provider picker and a sign-in panel.
- **Dark mode rebuilt.** The dark theme defined four of the eleven scopes the
  app renders and carried light-mode values in its disabled variant; both themes
  now define the same scopes and are held to WCAG AA by a test. System theme
  detection actually asks the desktop, the first frame is painted by the runtime
  rather than flashing white, the sync-status colours are no longer light-mode
  literals on a dark status bar, the scrollbar is no longer a black thumb on a
  black track — and a stored copy of a shipped theme is refreshed when the
  shipped one moves, without which none of it would have reached an existing
  installation.

### 2.0.0 — an assistant, cloud drives, and TypeScript throughout

- Added an Agent Client Protocol _client_, so the application can host an agent
  the user already has (Claude Code, Gemini, OpenCode, Codex, Antigravity) under
  that agent's own subscription. No model ships here and no model credential is
  stored.
- Widened the runtime's subprocess allowlist to include agent launchers, bounded
  by a fixed catalog the renderer cannot influence and by per-binary consent.
  This is the fork's first deliberate loosening of a security boundary;
  `SECURITY.md` §10 describes it.
- Added a second sync protocol beside the WebDAV journal: one readable Markdown
  file per note in Google Drive, Dropbox or OneDrive, with encryption available
  per remote and off by default.
- Added a provider-agnostic `RemoteStorage` seam, so the sync engine no longer
  assumes WebDAV.
- Converted the remaining JavaScript to TypeScript, except what genuinely cannot
  be: vendored wa-sqlite, the SQLite C amalgamation, PKGBUILD and workflow YAML.

### 1.0.0 — initial fork from 3.4.7

- Ported the desktop application from Electron to Deno Desktop on the OS
  webview.
- Removed the mobile applications, the hosted web build and the other
  non-desktop projects.
- Replaced Notesnook Cloud synchronization with an encrypted WebDAV protocol,
  and added encrypted WebDAV and local backups as a separate subsystem.
- Removed the subscription architecture in favour of local capabilities.
- Replaced the Electron IPC transport with allowlisted Deno bindings, keeping
  the renderer call shape.
- Moved attachment storage and privileged I/O to the runtime side.
- Replaced the Electron build with a Deno build and a GitHub Actions pipeline
  producing Windows and Linux packages.
