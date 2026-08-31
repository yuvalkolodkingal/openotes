# Architecture

Openotes is a desktop-only, offline-first, end-to-end-encrypted notes
application derived from [Notesnook](https://github.com/streetwriters/notesnook).
It runs on Deno Desktop with the operating system's own webview, keeps the
upstream React interface and note engine, and replaces Notesnook Cloud with
encrypted WebDAV synchronization.

---

## 1. Shape of the system

```
┌──────────────────────────────────────────────────────────┐
│                      OS WebView                          │
│              (WebView2 / WebKitGTK)                      │
│                                                          │
│   React UI · TipTap editor · notes, notebooks, tags      │
│   settings · search · themes                             │
│   @notesnook/core  (data model, migrations, FTS)         │
│   @notesnook/crypto (libsodium, in a worker)             │
└──────────────┬───────────────────────────────────────────┘
               │  bindings.rpc({path, input})   ← calls
               │  __openotesEvent(name, payload) ← events
┌──────────────▼───────────────────────────────────────────┐
│                  Deno Desktop runtime                    │
│                                                          │
│  main.ts        window, UI server, bindings              │
│  rpc/           allowlisted procedures + validation      │
│  native/        sqlite · filesystem · settings · logger  │
│                 shell · dialogs · notifications          │
│  security/      encrypted credential store               │
│  sync/          WebDAV sync service + database adapter   │
│  backup/        snapshot, restore, retention             │
│  updates/       release checking, checksum verification  │
└──────────────┬───────────────────────────────────────────┘
               │
     ┌─────────┴──────────┐
     ▼                    ▼
Local encrypted        WebDAV server
vault + attachments    (sync repository, attachments, backups)
```

Both halves run in **one process**. There is no main/renderer split and no
IPC: Deno Desktop registers named functions on the window, and the webview
calls them directly.

---

## 2. Why this shape

### Deno Desktop instead of Electron

Electron ships a Chromium build per application. The OS webview is already
installed, which is most of the download and installed-size difference, and
it removes an entire second engine from the update surface. The cost is that
rendering is no longer identical everywhere: WebView2 is Chromium, WebKitGTK
is not. The UI therefore avoids Chromium-only APIs, and the two known
divergences are handled explicitly:

- **Custom titlebar.** Upstream draws its own window controls using
  `windowControlsOverlay` and `env(titlebar-area-*)`, which WebKitGTK does
  not implement. The native titlebar is the default, so that code path never
  runs.
- **Security-key app lock.** WebAuthn's PRF extension is Chromium-only;
  the option is hidden where the platform cannot honour it.

CEF remains available as a developer fallback (`--backend cef`) but is not
a release configuration.

### The renderer keeps the upstream UI

The interface, editor, data model, migrations and crypto are upstream's,
unchanged where possible. That is deliberate: they are mature, and a rewrite
would trade working software for novelty. What changed is everything below
them — the host, the transport, and the sync backend.

---

## 3. The security boundary

The renderer runs web content: notes, imported HTML, embedded pages. It is
treated as the least trusted part of the system.

**The renderer cannot:**

- read or write arbitrary files,
- run a subprocess or a shell,
- reach the network outside its own origin,
- name a database key or re-key the vault,
- call anything not on the procedure allowlist.

**The renderer can** call the procedures in
[`apps/desktop/src/rpc/protocol.ts`](apps/desktop/src/rpc/protocol.ts), each
of which validates its own input. Everything privileged lives on the Deno
side:

| Concern | Where it lives | Guard |
|---|---|---|
| Filesystem paths | `native/paths.ts` | Every renderer-supplied path is resolved (symlinks included) and asserted to be inside a directory the user chose. |
| Export writes | `native/filesystem.ts` | Confined to the app data directory, the chosen backup directory and Documents. |
| Opening links | `native/shell.ts` | Only `http`, `https` and `mailto`. A note cannot launch a `file://` or custom-scheme handler. |
| Subprocesses | `native/shell.ts` | Fixed argv, never a shell string; only for file-manager, notification and clipboard fallbacks. |
| Database keys | `native/sqlite.ts` | Keyed at connection time; `PRAGMA key`/`rekey` from the renderer is rejected. |
| Secrets | `security/credentials.ts` | AES-256-GCM at rest; the WebDAV password is never returned to the renderer, not even to its own settings form. |

The UI is served from a loopback origin with `nosniff`, `COOP` and `COEP`,
and static serving is confined to the built UI directory.

### Why the port is fixed

The webview keys IndexedDB and localStorage by origin. An ephemeral port
would change the origin on every launch and silently orphan the key store
and settings — the app would look freshly installed. So the UI server binds
a fixed port, and if that port is taken by something else the app says so
instead of starting on a different one.

Belt and braces: attachments and the vault database live on the filesystem
under the Deno side, not in webview storage, so the bulk of user data does
not depend on this at all.

---

## 4. Storage

| Data | Where | Encryption |
|---|---|---|
| Notes, notebooks, tags, relations, settings | SQLite in the app data directory | SQLite3MultipleCiphers, keyed at open |
| Attachment content | `attachments/<xx>/<yy>/<hash>` | Encrypted by the renderer before it is handed over |
| WebDAV password, sync passphrase | `credentials.enc` | AES-256-GCM over PBKDF2 |
| Device-local settings, window geometry, sync cursors | `settings.json` | None — nothing secret is kept here |
| Logs | Cache directory | None — redacted at the point of writing |

### The SQLite decision

Upstream runs `better-sqlite3-multiple-ciphers`, a native addon built
against V8 internals that Deno does not expose, so it cannot load. Rather
than give up encryption at rest or the search index, the database runs on
Deno's FFI binding (`@db/sqlite`) against a bundled build of
**SQLite3MultipleCiphers** — the same encryption layer upstream uses, so
`PRAGMA key` behaves identically and an existing Notesnook database can be
opened for import.

The two FTS5 tokenizer extensions upstream depends on (`better_trigram` for
substring search and `html` for stripping markup) are ordinary loadable
SQLite extensions and load unchanged, after the database is decrypted —
before that, `SELECT fts5` fails and the extensions cannot obtain the FTS5
API.

`deno task build:native` builds the library from a checksum-verified
upstream amalgamation, installs the extensions, and **smoke-tests that
encryption is actually active and that search returns results** before
reporting success. A missing library is a hard startup error; the
application will not quietly fall back to an unencrypted database.

---

## 5. Synchronization

Fully specified in [WEBDAV.md](WEBDAV.md). The shape:

- `packages/sync-webdav` is transport- and database-agnostic: a WebDAV
  client, the protocol, the crypto, conflict policy, a durable queue and a
  scheduler. It has no knowledge of SQLite or of Notesnook's schema.
- `apps/desktop/src/sync/store-adapter.ts` is the only place that does. It
  reuses the dirty/tombstone bookkeeping `@notesnook/core` already
  maintains, so "what changed locally" is a query rather than a second
  change log that could disagree with the first.
- `apps/desktop/src/sync/service.ts` owns the lifecycle: configuration,
  scheduling, and the rule that a WebDAV failure surfaces as a status
  indicator and never as an exception reaching the editor.

The application is fully usable with no server configured. Sync is a
feature, not a prerequisite.

---

## 6. Capabilities instead of subscription tiers

Upstream gates ~35 features behind a subscription plan, and defaults to the
free tier when nobody is logged in — which for a local-only fork would mean
permanent free-tier limits (50 notebooks, 7 colors, no app lock, no custom
toolbar).

That whole matrix is replaced by a single capability declaration in
`packages/common/src/utils/is-feature-available.ts`:

```ts
export const capabilities = { allLocalFeatures: true } as const;
```

Every exported name and signature is preserved, so the ~40 call sites across
the UI compile and behave correctly without edits. No fake subscription
object is spread through the app, and nothing pretends to Notesnook's
servers that a subscription exists — the hosted model is simply gone.

`resetFeatures()`, which actively disabled app lock and reset the user's
toolbar and homepage on every startup for "free" users, is deleted rather
than orphaned.

---

## 7. Repository layout

```
apps/
  desktop/            the Deno Desktop application
    main.ts           entry point: window, UI server, bindings
    src/
      constants.ts    fork identity (name, id, endpoints, user agent)
      app.ts          composition root
      rpc/            the renderer contract: allowlist + handlers
      native/         paths, logger, settings, sqlite, filesystem,
                      server, shell/dialogs/notifications/clipboard
      security/       encrypted credential store
      sync/           WebDAV sync service + database adapter
      backup/         snapshot, restore, retention
      updates/        release checking
    scripts/          build-native, build-ui, build, checksums, smoke test
    types/            ambient declarations for the deno desktop API
  web/                the React UI (built and served by the desktop app)

packages/
  core/               data model, collections, migrations, search
  common/             shared helpers and the capability module
  crypto/  sodium/    libsodium wrappers (upstream, audited)
  editor/             TipTap editor
  sync-webdav/        the WebDAV sync + backup engine
  theme/  ui/  intl/  logger/  streamable-fs/

packaging/            flatpak manifest, PKGBUILD, .desktop, man page
.github/workflows/    test, build, release
```

---

## 8. Testing

| Suite | What it covers |
|---|---|
| `packages/sync-webdav/tests/client_test.ts` | Every WebDAV verb, conditional requests, each HTTP error, timeouts, malformed PROPFIND, truncated uploads, path traversal, and parser tolerance for Nextcloud/Apache/absolute-href responses. |
| `packages/sync-webdav/tests/sync_test.ts` | Protocol behaviour: initialization, version refusal, the mandatory multi-device scenario, stale-delete resurrection, corrupt and duplicate records, sequence collisions, attachment round-trips, remote rebuild. |
| `packages/sync-webdav/tests/backup_test.ts` | The mandatory backup scenario, corruption, tampering, wrong keys, retention, scheduling, and that deleting a synced note leaves backups untouched. |
| `packages/sync-webdav/tests/integration_test.ts` | The same protocol scenarios against a **real** third-party WebDAV server, run by `deno task test:webdav`. Required in CI, not skippable. |

The unit suite runs against an in-process WebDAV server that can inject
failures a hosted server will not produce on demand. The integration suite
answers the different question of whether the client interoperates with a
server nobody here wrote — and it has already earned its place by finding a
server that accepts `If-None-Match` and ignores it, which would have allowed
a journal entry to be overwritten.

---

## 9. Deliberate differences from upstream

| Upstream | Here | Why |
|---|---|---|
| Electron | Deno Desktop + OS webview | Smaller downloads, no bundled browser engine |
| tRPC over Electron IPC | Allowlisted bindings, same call shape | No IPC exists; the call shape was kept so UI call sites did not change |
| Notesnook Cloud sync | Encrypted WebDAV | No hosted dependency for ordinary operation |
| Subscription tiers | Local capabilities | No hosted subscription model exists in this fork |
| Attachments in OPFS | Attachments on the filesystem | Privileged I/O belongs on the Deno side; survives a cleared webview profile |
| OS keychain via Electron `safeStorage` | Encrypted credential file | No reliable cross-platform Deno keychain binding; the renderer's existing fallback path covers the rest |
| Chromium spellcheck | Not present | It was a Chromium session feature with no webview equivalent |
| Monograph publishing, theme marketplace | Not present | Both require Notesnook-operated infrastructure |
| Mobile apps | Not present | Desktop-only fork |

---

## 10. Attribution and licensing

Openotes is a GPL-3.0-or-later fork. Upstream copyright headers are intact,
attribution is preserved, and the fork is renamed throughout — name,
identifier, icons, data directory, update endpoint and user agent — so no
user can mistake a build of this for an official Notesnook release. See
[UPSTREAM.md](UPSTREAM.md).
