# Upstream tracking

Openotes is a fork of [Notesnook](https://github.com/streetwriters/notesnook)
by Streetwriters (Private) Limited, licensed GPL-3.0-or-later.

This file records where the fork stands relative to upstream, what was
removed, and where the two architectures have diverged far enough that a
merge will not be mechanical.

---

## Current base

| | |
|---|---|
| Upstream repository | `streetwriters/notesnook` |
| Base revision | `09a0c30` (merge of release/3.4.7) |
| Base version | 3.4.7 |
| Fork version | 2.1.0 |
| Fork repository | `yuvalkolodkingal/notesnook` |
| Last merge from upstream | Initial fork point |

### Remotes

```bash
git remote add upstream https://github.com/streetwriters/notesnook.git
git fetch upstream
```

`origin` is the fork; `upstream` is Notesnook. Never push to `upstream`.

---

## Attribution

Upstream copyright headers are preserved verbatim in every file that
originated there, including files this fork has modified. New files carry
the same GPL-3.0-or-later header. `LICENSE` and `AUTHORS` are unchanged.

The fork is renamed throughout — application name, identifier, icons, data
directory, update endpoint, release repository and user agent — so that a
build of this project cannot be mistaken for an official Notesnook release.
That renaming is a licensing and honesty requirement, not branding.

---

## Packages intentionally removed

| Removed | Reason | Anything depending on it? |
|---|---|---|
| `apps/mobile` | Desktop-only fork | No |
| `packages/editor-mobile` | Mobile editor wrapper | No |
| `apps/monograph` | Public note publishing; requires Notesnook Cloud | No |
| `apps/vericrypt` | Unrelated tool | No |
| `apps/theme-builder` | Unrelated tool | No |
| `extensions/web-clipper` | Browser extension, out of scope | Referenced by `apps/web`; reference removed |
| `servers/themes` | Theme marketplace server; bundled themes are kept | Referenced by `apps/web`; reference removed |
| `fastlane/` | Play Store / F-Droid metadata | No |
| Electron main process, preload, tRPC router, electron-builder config | Replaced by the Deno Desktop runtime | Replaced |
| Mobile and Electron CI workflows | Nothing left to build | Replaced |
| Node monorepo tooling (root `package.json`, `scripts/*.mjs`, eslint, prettier, husky, commitlint) | Deno is the runtime and task runner | Replaced by `deno.json` |

## Packages kept and reused

`core`, `common`, `crypto`, `sodium`, `editor`, `intl`, `logger`,
`streamable-fs`, `theme`, `ui`, and `apps/web` as the interface source.
These are upstream's and are deliberately kept close to upstream so that
improvements there remain mergeable.

## Packages added

`packages/sync-remote` — the encrypted WebDAV synchronization and backup
engine. Entirely new; no upstream counterpart.

---

## Architecture differences

These are the places where a future merge needs thought rather than a
three-way diff.

### 1. Host runtime (`apps/desktop`)

Upstream's `apps/desktop` is an Electron application. This fork's is a Deno
Desktop application. **Essentially nothing in this directory is shared with
upstream any more.** Upstream changes here are read for intent and
reimplemented, not merged.

### 2. Renderer ↔ host transport

Upstream: tRPC over Electron IPC (`electron-trpc`), with the router in
`apps/desktop/src/api`.

Here: an allowlisted procedure table reached through Deno Desktop bindings.
The **call shape was deliberately preserved** —
`desktop.integration.showNotification.mutate({...})` still works — so the
~50 renderer call sites did not change and upstream changes to those call
sites usually still merge. Only
`apps/web/src/common/desktop-bridge/index.desktop.ts` was rewritten.

Consequence: an upstream change that *adds a procedure* needs the procedure
added to `apps/desktop/src/rpc/protocol.ts` and implemented in `handlers.ts`,
or it will be rejected at the boundary.

### 3. Database driver

Upstream: `better-sqlite3-multiple-ciphers` in the Electron main process.

Here: Deno FFI (`@db/sqlite`) against a bundled SQLite3MultipleCiphers
build. The same encryption layer and the same FTS5 extensions, so the schema,
migrations and queries in `packages/core` are unchanged and upstream
migrations merge normally.

### 4. Synchronization

Upstream: `packages/core/src/api/sync` against Notesnook Cloud (SignalR,
S3 attachments, account keys).

Here: `packages/sync-remote` against a user's WebDAV server. The fork reuses
core's dirty-flag and tombstone bookkeeping rather than replacing it, so
core's collections are untouched. Upstream changes to the cloud sync
transport do not apply; upstream changes to how items are marked dirty do.

### 5. Attachments

Upstream: OPFS in the renderer.

Here: the filesystem, under the Deno side. Privileged I/O belongs off the
renderer, and it means user data survives a cleared webview profile.

### 6. Subscriptions

Upstream: a 35-feature matrix keyed on `User.subscription.plan`, defaulting
to the free tier when nobody is logged in.

Here: `packages/common/src/utils/is-feature-available.ts` is rewritten
around a `capabilities` object, keeping every exported name and signature so
call sites are unchanged. Upstream changes that *add* a feature id merge
cleanly; upstream changes to the gating logic itself are discarded.

### 7. Accounts and cloud UI

Login, signup, MFA, recovery, email verification, subscription and checkout
UI, monograph publishing and the theme marketplace are removed. Upstream
changes to those areas do not apply.

---

## Known conflict areas

Expect to resolve these by hand on every merge:

| Area | Why |
|---|---|
| `apps/desktop/**` | Different runtime; no shared history in practice. |
| `apps/web/src/common/desktop-bridge/index.desktop.ts` | Rewritten transport. |
| `apps/web/src/common/db.ts` | Host configuration and subscription hooks removed. |
| `apps/web/src/bootstrap.tsx`, `views/auth.tsx` | Auth-gated first-run removed. |
| `packages/common/src/utils/is-feature-available.ts` | Rewritten. |
| `packages/core/src/api/index.ts` | Subscription and SSE registrations removed. |
| `packages/sodium/src/{browser,types}.ts` | Small additions for Deno type resolution. |
| `.github/workflows/**` | Entirely different pipeline. |
| Root configuration | Deno replaces the Node monorepo tooling. |

Upstream changes to `packages/{core,editor,ui,theme,intl,logger,streamable-fs}`
and to most of `apps/web/src` should merge with ordinary effort. Keeping it
that way is the reason those packages were left as close to upstream as
possible.

---

## Merging from upstream

```bash
git fetch upstream
git checkout -b merge/upstream-X.Y.Z
git merge upstream/master
```

Then, in order:

1. Resolve conflicts. For `apps/desktop`, prefer this fork's file and port
   the *intent* of the upstream change by hand.
2. Check whether upstream added a call site for a procedure that does not
   exist in `apps/desktop/src/rpc/protocol.ts`; add and implement it, or
   remove the call site if the feature does not apply here.
3. Check for reintroduced subscription checks, Notesnook host URLs, Electron
   imports or telemetry. `deno task verify:no-electron` catches some of this;
   grep for the hosts listed in `PORTING_NOTES.md` §5 for the rest.
4. Run `deno task check`, `deno task test` and `deno task test:webdav`.
5. Update the base revision at the top of this file.

**Do not preserve upstream architecture that no longer fits merely to make
the diff smaller.** A smaller diff is not worth a worse application.

---

## Fork changelog

### 2.1.0

- **A built-in MCP server.** Openotes answers the Model Context Protocol on a
  loopback endpoint, so an assistant on the same machine can search, read and
  — if allowed — edit notes. Off by default, read-only when enabled, editing
  a second switch; notes in a vault are never readable through it, and
  nothing it can do deletes a note permanently.
- **Sync to a folder.** The same encrypted protocol now runs over a plain
  directory, which is how Google Drive, OneDrive, Dropbox and iCloud Drive
  are reached in practice: point at the folder their desktop client keeps in
  step and it does the uploading. A NAS mount, a USB stick or Syncthing works
  the same way.
- **Sync to Google Drive, OneDrive and Dropbox directly**, for machines with
  no desktop client, through the user's own OAuth registration and a
  loopback authorization-code flow with PKCE.
- The sync engine no longer speaks WebDAV: it drives an eleven-verb
  `RemoteStore`, of which WebDAV is one implementation. Two latent bugs fell
  out of writing that interface down — `rebuildRemote` moved directories
  through a file-only path, and `initialize` adopted a remote repository
  after *any* failed write rather than only a lost race.
- **Dark mode rebuilt.** The dark theme defined four of the eleven scopes the
  app renders and carried light-mode values in its disabled variant; both
  themes now define the same scopes and are held to WCAG AA by a test. System
  theme detection actually asks the desktop, the first frame is painted by
  the runtime rather than flashing white, and the sync-status colours are no
  longer light-mode literals drawn on a dark status bar.

### 2.1.0 — initial fork from 3.4.7

- Ported the desktop application from Electron to Deno Desktop on the OS
  webview.
- Removed the mobile applications, the hosted web build and the other
  non-desktop projects.
- Replaced Notesnook Cloud synchronization with an encrypted WebDAV
  protocol, and added encrypted WebDAV and local backups as a separate
  subsystem.
- Removed the subscription architecture in favour of local capabilities.
- Replaced the Electron IPC transport with allowlisted Deno bindings,
  keeping the renderer call shape.
- Moved attachment storage and privileged I/O to the runtime side.
- Replaced the Electron build with a Deno build and a GitHub Actions
  pipeline producing Windows and Linux packages.
