# PORTING_NOTES.md — Notesnook → Deno Desktop ("Openotes")

Synthesis of seven domain audits (desktop-electron, web-ui, core-data, crypto,
subscription, mobile-footprint, editor-and-themes), cross-checked against the
working tree on 2026-08-31.

**Repo state (verified, supersedes the audits):** the audits were taken against
upstream v3.4.7 (`09a0c30`) with untracked scaffolding. Since then, commit
`d4c495a` ("Add encrypted WebDAV sync engine and Deno workspace bootstrap")
landed: `packages/sync-webdav/` is now a complete committed package
(`src/{client,crypto,conflicts,repository,queue,engine,backup,http,xml,types,index}.ts`,
`tests/{client_test,sync_test,fake-server,harness,memory-store}.ts`, 36 passing
tests, own `deno.json`), plus root `deno.json`/`deno.lock` and
`packages/sodium/src/libsodium.ts` (+ `types/libsodium-wrappers-sumo.d.ts`).
Untracked work in flight: `apps/desktop/src/rpc/protocol.ts` (the new binding
contract), `apps/desktop/src/native/{paths,logger}.ts`, and a modified
`apps/desktop/src/constants.ts` establishing fork identity (`APP_NAME =
"Openotes"`, `APP_IDENTIFIER = "org.openotes.Openotes"`, deep-link scheme
`openotes`, `UPDATE_MANIFEST_URL` → the fork's GitHub releases,
`TELEMETRY_ENABLED = false`).

> **Known breakage introduced by the new constants.ts:** it deletes the
> `PATHS` export, but `apps/web/src/stores/setting-store.ts:20,56` still does
> `import { DesktopIntegration, PATHS } from "@notesnook/desktop"` and uses
> `PATHS.backupsDirectory`. Either re-export `PATHS = { backupsDirectory,
> logsDirectory }` from the new constants or repoint the web import. Same for
> `type AppRouter` and `@notesnook/desktop/preload.d.ts`
> (`apps/web/src/global.d.ts:23`) once the Electron package is rewritten.

---

## 1. Reusable packages (and why)

The `apps/web` transitive closure is the keep-set. All of these are
web-API-clean or already platform-abstracted:

| Package | Verdict | Why |
|---|---|---|
| `packages/core` | **Keep** | Storage-agnostic over SQLite/Kysely (`@streetwriters/kysely` fork); the platform injects the driver as a Dialect factory via `db.setup({sqliteOptions.dialect})` (`packages/core/src/database/index.ts:360-401`). No `node:fs`/`node:path` imports in `src/`. Sync collection/merge logic is transport-independent (§7). Cloud coupling is concentrated in `src/api/` and `src/utils/constants.ts` (§5). |
| `packages/crypto` | **Keep unmodified** | Pure web APIs (TextEncoder, TransformStream, Uint8Array); single dep `@notesnook/sodium`. Runs in Deno and any webview as-is. |
| `packages/sodium` | **Keep (browser build)** | `src/browser.ts` delegates to `libsodium-wrappers-sumo` WASM; the vendored patch (`patches/libsodium-sumo+0.7.15.patch`) forces the Emscripten loader off the Node path, so it is Deno/webview-safe. The fork already adds `src/libsodium.ts` as the Deno entry and maps it in root `deno.json` imports. Avoid the `node` export condition (would pull `sodium-native`). |
| `packages/streamable-fs` | **Keep** | Web-streams-only chunked encrypted file store behind a pluggable `IFileStorage` (`src/interfaces.ts:39-50`); trivially implementable over Deno FS or kept on OPFS in the webview. |
| `packages/common` | **Keep (with paywall surgery)** | Owns the shared `database` singleton (`src/database.ts:22`), keybindings (`utils/keybindings.ts` — the editor build depends on it), `export-notes.ts`, date/file/path utilities. Only `utils/is-feature-available.ts` + `hooks/use-is-feature-available.ts` get replaced (§6). Prune the bogus self-dep on published `@notesnook/common@^2.1.3` (`packages/common/package.json:44`). |
| `packages/editor` | **Keep** | Zero Electron/Node imports; host integration is `editor.storage` callbacks (`src/index.ts:395-411`: openLink, downloadAttachment, openAttachmentPicker, previewAttachment, getAttachmentData, …). Pro-gating is an injected claims system, not baked in (§6). Build-time gotcha: gitignored generated `src/extensions/code-block/languages/index.ts` from `scripts/langen.mjs` (§11). |
| `packages/theme` | **Keep** | Bundled default themes; applied themes persist in localStorage. Gotcha: `default-{light,dark}.json` are gitignored and fetched at prebuild from raw.githubusercontent.com — **vendor them** (`packages/theme/scripts/prebuild.mjs` already skips-if-exists). |
| `packages/ui`, `packages/intl`, `packages/logger` | **Keep** | Pure UI/i18n/logging leaves of the web closure. |
| `packages/sync-webdav` | **Keep (new, the point of the fork)** | Committed WebDAV engine: verb-complete client with compatibility fallbacks, namespace-tolerant PROPFIND parsing, append-only per-device journal protocol, keyed subkey hierarchy, durable queue, conflict policy, backup subsystem (§7–§9). |
| `apps/web` | **Keep** | Becomes the embedded UI; the desktop seams are two files (§2). |
| `apps/desktop` | **Rewrite** | Electron shell replaced by the Deno host; `src/rpc/protocol.ts`, `src/native/*`, `src/constants.ts` are the beginnings. |

---

## 2. Electron dependency surface → Deno Desktop replacement mapping

### 2.1 The single seam

ALL renderer↔main IPC is tRPC v10 over `electron-trpc` on one channel
(`"electron-trpc"`). The preload (`apps/desktop/src/preload.ts`) exposes exactly
two globals: `electronTRPC` (`{sendMessage,onMessage}`) and `os()`. The renderer
side lives in one file — `apps/web/src/common/desktop-bridge/index.desktop.ts`
(`createTRPCProxyClient<AppRouter>({links:[ipcLink()]})`) — selected by the Vite
alias `/desktop-bridge$ → index.desktop` when `PLATFORM=desktop`
(`apps/web/vite.config.ts:102-113`). Every other web call site goes through the
optional-chained `desktop?.` proxy and is transport-agnostic.

**Replacement (already designed in `apps/desktop/src/rpc/protocol.ts`):** the
whole surface remains addressed by dotted procedure path but travels through
exactly two bindings:

- `bindings.rpc({ path, input })` — request/response, renderer → runtime,
  gated by the `PROCEDURE_NAMES` allowlist (unknown paths rejected before
  handler lookup).
- `window.__nnDesktopEvent(event, payload)` — runtime → renderer push via
  `win.executeJs()`, names in `EVENT_NAMES`.

Web-side work: replace `ipcLink()` in `index.desktop.ts` with a custom tRPC
link (or thin proxy) over `bindings.rpc`, and inject a `window.os()`
equivalent (consumed by `apps/web/src/utils/platform.ts:23-24` for
titlebar/menu/keybinding decisions).

### 2.2 Channel → binding map (upstream router: `apps/desktop/src/api/index.ts`)

| Upstream tRPC procedure | Deno binding (per `src/rpc/protocol.ts`) | Notes |
|---|---|---|
| `sqlite.open/run/close/delete` | `sqlite.open/run/close/delete` (+ new `sqlite.export`) | **Critical.** Renderer runs Kysely; `{sql, parameters}` forwarded raw (`apps/web/src/common/sqlite/index.desktop.ts:95` → `apps/desktop/src/api/sqlite-kysely.ts`). Host must be a SQLite3MC-compatible build (`PRAGMA key` arrives as ordinary SQL; hex of `databaseKey` passed via `sqliteOptions.password`, `apps/web/src/common/db.ts:88-93`), WAL + exclusive locking, and must load `sqlite-better-trigram` + `sqlite3-fts5-html` extensions **after** decryption (`sqlite-kysely.ts:129-150`) or FTS migrations fail. FTS triggers are TEMPORARY, re-created per connection (`packages/core/src/database/triggers.ts`, called from `api/index.ts:333-335`). |
| `backups.open/write/close` | `backups.open/write/close` | Base64-chunk streamed file writes into `config.backupDirectory` (`apps/desktop/src/api/backups.ts`; consumed by `createWritableStream`, `index.desktop.ts:86-102`). |
| `bridge.ready`, `bridge.onOpenLink` (sub) | `bridge.ready` + event `bridge.openLink` | Deep links; scheme is now `openotes://` (upstream `nn://` grammar parsed by `packages/core/src/utils/internal-link.ts` — keep `nn://` parsing for note links inside the editor, register the fork scheme with the OS). |
| `bridge.onCreateItem` (sub) | *(add an event)* | **Verified upstream regression:** main emits it (tray/dock/second-instance) but the web never subscribes — only `onOpenLink` and `updater.on*` are attached in `index.desktop.ts:37-70`, while the handler `AppEvents.onCreateItem` exists at `apps/web/src/app-effects.tsx:234,242-254`. The port should wire it up. |
| `integration.*` (isFlatpak/isSnap/isPortable, backupDirectory, selectBackupDirectory, zoomFactor, setZoomFactor, privacyMode, desktopIntegration, restart, showNotification, openPath, bringToFront, changeTheme; subs onThemeChanged, showMenu) | `integration.*` same names + new `openExternal, revealFile, systemTheme, selectDirectory, selectFile, saveFile, readClipboard, writeClipboard, appVersion, about, openLogDirectory, logs` | `showNotification` (returns clicked tag) + `bringToFront` are **required for reminders** (`apps/web/src/stores/reminder-store.ts:95-125`). `changeTheme`/`onThemeChanged` drive dark-mode sync (`apps/web/src/stores/theme-store.ts:82,128`, `hooks/use-system-theme.ts`). `openPath` backs `file:` links (`components/editor/tiptap.tsx:439`). `showMenu` is mac-only nicety with an HTML fallback — stub-able. |
| `safeStorage.isEncryptionAvailable/encryptString/decryptString` | `safeStorage.*` | Optimization only: return `isEncryptionAvailable=false` and the web app falls back to CryptoKey wrapping in IndexedDB (`apps/web/src/interfaces/key-store.ts:421-481`) — the portable-build path, correct today. Implement libsecret/DPAPI/Keychain later if desired. |
| `compress.gzip/gunzip` | `compress.*` | Or drop: WASM fallback (`@hazae41/foras`) exists in `apps/web/src/utils/compressor.ts`, and Deno has `CompressionStream`. |
| `updater.*` (7 procs + 6 subs) | `updater.*` + events | Upstream feed `https://notesnook.com/api/v1/releases/...` (`apps/desktop/src/utils/autoupdater.ts:26-31`) is replaced by `UPDATE_MANIFEST_URL` (fork GitHub releases `latest.json`, `src/constants.ts`). UI already handles `autoUpdates=false` (flatpak path), so a stub is a valid v1. |
| `window.maximize/restore/minimze[sic]/maximized/fullscreen`, `onWindowStateChanged` | `window.*` (typo **kept** deliberately) + events `window.stateChanged/close` + new `window.setTitle` | Only needed when `!hasNativeTitlebar` (`apps/web/src/root.tsx:44-50`, `components/title-bar/index.tsx`); forcing native titlebar is the cheap path. Close button uses DOM `window.close()` — webview must honor it or bind it. |
| `spellChecker.*` (7 procs) | **Dropped** (absent from PROCEDURE_NAMES) | Chromium-session-specific. WebView2 has its own; WebKitGTK uses enchant. Hide the settings section (`apps/web/src/hooks/use-spell-checker.ts` callers degrade). |
| — | **New:** `webdav.getConfig/setConfig/testConnection/connect/disconnect/syncNow/status/resetRemoteState/rebuildRemote/setPassphrase/fetchAttachment`; events `webdav.status/conflict` | Host-side sync engine control (§7). `fetchAttachment` pulls one attachment's content on demand (§7.3). |
| — | **New:** `backup.getSettings/setSettings/createNow/list/restore/selectLocalDirectory/importFile`; event `backup.completed` | Host-side backup engine (§8). |
| — | **New:** `attachments.setMetadata/getMetadata/deleteMetadata/writeChunk/readChunk/deleteChunk/chunkSize/listChunks/list/deleteFile/clear` | The streamable-fs `IFileStorage` surface, served by the runtime's chunked store (§7.3). Base64 chunks; `clear` requires `confirm:"clear"`. |
| — | **New:** `capabilities.get` | Feature discovery for the renderer. |

### 2.3 Main-process-only features to re-implement in the Deno host

- **Stable origin serving `apps/web/build/`**: Electron intercepts
  `https://app.notesnook.com` via `protocol.handle`
  (`apps/desktop/src/utils/protocol.ts`), which keeps IndexedDB/OPFS/
  localStorage origin-stable. Attachments (OPFS via streamable-fs), the
  key store (IndexedDB) and localStorage live in the **webview origin**, not
  SQLite. `checkPrerequisites` (`apps/web/src/bootstrap.tsx:172-183`) hard
  requires secure context + `navigator.locks` + `crypto.subtle` +
  IndexedDB-or-OPFS + WebAssembly — the Deno webview must serve from an
  https-like custom scheme or fixed localhost origin, and the origin must
  never change or user data is orphaned.
- **Window state persistence** (`src/utils/window-state.ts` — debounced JSON),
  **config store** (`src/utils/config.ts`, single `userData/config.json` with
  keys desktopSettings/zoomFactor/theme/backupDirectory/windowState/…),
  **tray** (`src/utils/tray.ts`), **single-instance lock**, **CLI**
  (`src/cli.ts`: `new note|notebook|reminder`, `open note|notebook|topic
  --id`, `--hidden`; first-launch actions become hash routes
  `#/notes/create/1` etc., `main.ts createURL`), **autostart**
  (`src/utils/autolaunch.ts`), **deep-link OS registration**.
  `apps/desktop/src/native/paths.ts` (untracked) already implements the
  per-OS data dir + renderer-path validation replacing
  `src/utils/resolve-path.ts`.
- **Droppable:** context menu + spellcheck menu (`src/utils/menu.ts`),
  jumplist/dock menu (`src/utils/jumplist.ts`), DoH custom DNS
  (`src/utils/custom-dns.ts`), proxy rules, privacyMode
  (`setContentProtection`), MAS/portable variants, locale stripping,
  `icojs` asset parsing (ship PNGs instead).

---

## 3. Node-only dependencies and replacements

| Dependency | Where | Replacement |
|---|---|---|
| `better-sqlite3-multiple-ciphers` (native) | `apps/desktop/src/api/sqlite-kysely.ts` | Deno host SQLite: FFI to a SQLite3MC build, or N-API via Deno node-compat. Must support `PRAGMA key/rekey`, WAL, exclusive locking, loadable extensions. |
| `sqlite-better-trigram`, `sqlite3-fts5-html` (native loadable extensions) | loaded in `sqlite-kysely.ts:142-150` | Mandatory for FTS (tokenizers referenced by migrations, `packages/core/src/database/migrations.ts:564-584`); `sqlite-regex` also used by `packages/core/src/api/lookup.ts`. Compile/load the same extensions for the Deno build. Alternative: the wa-sqlite WASM path (`apps/web/src/common/sqlite/index.ts`) if the webview has OPFS. |
| `electron`, `electron-trpc`, `electron-updater`, `electron-builder` | apps/desktop | Deno.BrowserWindow host + `bindings.rpc` (§2) + fork update manifest + `deno compile`/packagers (§11). |
| `sodium-native` | packaged by electron-builder but **unused** (NativeNNCrypto disabled, `apps/web/src/interfaces/nncrypto.ts:29-33`; crypto is libsodium-WASM in a renderer worker) | Delete. |
| Node `zlib` | `apps/desktop/src/api/compression.ts` | Deno `CompressionStream` or the existing foras WASM fallback. |
| `undici` fetch globals | `apps/desktop/global.d.ts:39-58` | Deno-native fetch. |
| `Buffer` in renderer bundle | `apps/web/src/interfaces/fs.ts:144,163`, `utils/streams/chunked-stream.ts:29-33`, `interfaces/key-store.ts`, `common/db.ts:92` | Fine — Vite bundles the `buffer` polyfill for the webview. No change. |
| `Buffer` + `require("node:crypto")` fallback in core | `packages/core/src/utils/random.ts:22-37` | Falls back to `globalThis.crypto.getRandomValues` (present in Deno) but still allocates Buffer — replace with Uint8Array or rely on the polyfill in the webview. |
| `process.env.NODE_ENV` reads in core | `sanitizer.ts`, `merger.ts:36`, `utils/constants.ts:30`, logger | Fine under Deno's process shim / Vite define. |
| `@microsoft/signalr`, `event-source-polyfill`, `isomorphic-fetch` | core sync/SSE (lazy-imported) | Deleted with cloud sync (§5). |
| `icojs` | `apps/desktop/src/utils/asset-manager.ts` (tray .ico parsing) | Ship pre-sized PNGs. |
| Deno export-condition trap | `@notesnook/sodium` | Deno npm resolution honors the `"node"` condition → would pick `dist/node.js` (sodium-native). Solved in-tree: root `deno.json` maps `@notesnook/sodium → packages/sodium/src/browser.ts` and `libsodium-wrappers-sumo → packages/sodium/src/libsodium.ts`. |
| `patch-package` patches | `packages/editor/patches/` (tiptap/prosemirror/katex dist fixes), `packages/sodium/patches/`, `apps/desktop/patches/` | The web bundle is still built with npm+Vite, so `postinstall: patch-package` keeps working; if package management ever moves, vendor the patched packages. |

---

## 4. Browser/Chromium-specific risks (WebView2 = Chromium, fine; WebKitGTK = risk)

- **`windowControlsOverlay` + `env(titlebar-area-*)` CSS** —
  `apps/web/src/app.tsx:82-109`, `components/editor/action-bar.tsx:229`,
  `components/lightbox/index.tsx:347`, `hooks/use-window-controls.ts`,
  `global.d.ts:66-71`. Chromium-only; on WebKitGTK `env()` resolves to
  nothing. Mitigation: run with native titlebar (`hasNativeTitlebar=true`)
  and the custom-titlebar/frameless code path never executes.
- **WebAuthn PRF extension** (security-key app lock,
  `apps/web/src/utils/webauthn.ts`, `global.d.ts:37-59`) — Chromium-only;
  WebKitGTK has no authenticator UI. Hide the security-key option there.
- **OPFS `FileSystemSyncAccessHandle`** (`common/sqlite/AccessHandlePoolVFS.js`,
  `interfaces/opfs.worker.ts`) — historically flaky on WebKitGTK; full
  IndexedDB fallbacks exist (`IDBBatchAtomicVFS.js`,
  `utils/feature-check.ts:56-67`) and desktop uses native sqlite anyway.
- **Hard prerequisites** (`bootstrap.tsx:172-183`): secure context, Web
  Locks, WebCrypto, WASM — OK in current WebView2/WebKitGTK **only from a
  secure origin** (§2.3).
- **`index.html` inline script touches `caches` unconditionally** (L48) —
  async IIFE rejects when CacheStorage is absent (WebKitGTK non-secure
  contexts); harmless once the origin is secure, but guard it.
- **CSS `zoom`** for editor zoom (`components/editor/tiptap.tsx:702`) —
  supported in WebKit, verify; fallback `transform: scale`.
- **Clipboard**: `navigator.clipboard.write([new ClipboardItem(...)])`
  (`packages/editor/src/extensions/image/image.ts:226-228`) — WebKit requires
  the promise-in-ClipboardItem pattern within user gestures;
  `clipboard-polyfill` in use. New `integration.readClipboard/writeClipboard`
  bindings can backstop.
- **Downloads**: `file-saver` `saveAs` (CSV export,
  `packages/editor/src/extensions/table/actions.ts:246`) and the
  stream-saver web fallback assume a browser download manager; webviews need
  host handling — route through `integration.saveFile`/`backups.*` bindings.
  (Desktop backups already do this.)
- **iframes/fullscreen**: sandboxed iframes for webclips/embeds/SVG and
  `iframe.requestFullscreen()` (`packages/editor/src/toolbar/tools/web-clip.tsx:62`)
  — verify Fullscreen API in the chosen webview.
- **SharedWorker** multi-tab sqlite (`common/sqlite/shared-service.ts:20-24`)
  — feature-checked, web-only; irrelevant single-window.
- **Notification permission**: `Notification.requestPermission()`
  (`dialogs/add-reminder-dialog.tsx:194`) — needs host-side auto-grant in
  the webview permission handler (reminders use the desktop binding path,
  but the permission check at `reminder-store.ts:66-69` still runs).
- **Regex lookbehind** (`packages/editor/src/extensions/math/math-inline.ts:33`)
  — fine in current WebKit.

---

## 5. Notesnook server/API dependencies — replace or remove

Single choke point: `packages/core/src/utils/constants.ts:34-56` (`hosts`) and
its mirror `apps/web/src/common/db.ts:47-59` (`db.host({...})`, `NN_*` env
overrides + user `serverUrls` config).

| Host / endpoint | Used by | Disposition |
|---|---|---|
| `API_HOST` api.notesnook.com — `/users*`, `/devices`, `/hubs/sync/v2` (SignalR WS, `packages/core/src/api/sync/index.ts:483-596`), `/s3?name=` + `/s3/bulk-delete` (`packages/core/src/database/fs.ts:126,190,242,321,335`), `/version`, `/announcements/active` | sync, attachments, account | **Remove.** Sync → `packages/sync-webdav` engine (§7). Attachments → WebDAV-backed `IFileStorage` (§7). Announcements deleted (phones home with userId). |
| `AUTH_HOST` auth.streetwriters.co — `/connect/*`, `/account/*`, `/mfa*` (`api/user-manager.ts:37-48`, `token-manager.ts`, `mfa-manager.ts`) | login/MFA/recovery | **Remove** with accounts; keep a local key provider replacing `user-manager` key material (§9). |
| `SSE_HOST` events.streetwriters.co `/sse` (`api/index.ts:369-453 connectSSE`) | push events | **Remove** (`connectSSE`, `eventsource` option). |
| `SUBSCRIPTIONS_HOST` — `api/subscriptions.ts`, `offers.ts`, `circle.ts`, `activateTrial` (`user-manager.ts:255-264`) | billing | **Delete files** (§6). |
| `ISSUES_HOST` — `api/debug.ts:33`, caller `apps/web/src/dialogs/issue-dialog.tsx:79` | bug reports | Delete or repoint to fork GitHub issues. |
| `MONOGRAPH_HOST` / monographs API (`api/monographs.ts`, `collections/monographs.ts`) | publishing | **Remove** + web UI surgery (~15 files: `stores/monograph-store.ts`, `components/publish-view/`, `/monographs` route in `navigation/routes.tsx`, …). |
| `NOTESNOOK_HOST` — checkout, pricing, desktop release feed (`apps/desktop/src/utils/autoupdater.ts:28`) | billing/updates | Billing deleted; updates → `UPDATE_MANIFEST_URL` in new `apps/desktop/src/constants.ts`. |
| themes-api.notesnook.com (`apps/web/src/common/themes-router.ts:24`) | theme marketplace | Login-free but network: recommend dropping the gallery UI, keeping bundled defaults + the existing offline "Load from file" path (`dialogs/settings/components/themes-selector.tsx:183-202`). `servers/themes` is self-hostable if wanted. |
| cors.notesnook.com (`components/editor/index.tsx:562`, Config `corsProxy`) | external-image fetch | Replace with host-side fetch binding or drop for offline-first. |
| dictionaries.notesnook.com (`apps/desktop/src/main.ts:180`) | Chromium spellcheck | Gone with spellChecker. |
| api.github.com (`apps/web/src/utils/changelog.ts:24`) | release notes | Repoint to fork repo or drop. |
| **Telemetry** | — | **None exists** (no Sentry/PostHog/etc.; `trackEvent` only in commented code, `views/email-confirmed.tsx:217`). The fork adds `TELEMETRY_ENABLED = false` as a greppable statement. |

Auth-coupled UI to remove/hide: forced `/signup` first-run
(`bootstrap.tsx:149-155` — neutralize; skip flow sets `skipInitiation`),
post-auth `/plans` redirects (`views/auth.tsx:303,361`), email verification
(dialog + status-bar button + `/account/verified`), MFA/recovery views,
sessions/profile settings sections, `views/sessionexpired`-style flows.
`servers-configuration.tsx` (Settings → Servers) is the ready-made template
for the WebDAV config panel; add a `SectionKeys` entry in
`apps/web/src/dialogs/settings/types.ts:23-46`.

---

## 6. Subscription check inventory and removal plan

**Source of truth:** `User.subscription.plan`
(`packages/core/src/types.ts:600-666`), fetched by
`user-manager.ts fetchUser` and SSE `"upgrade"`. ALL gating funnels through
`packages/common/src/utils/is-feature-available.ts` — a 35-feature matrix
(L118-517) whose `getUserPlan()` (L573-577, verified) returns
`SubscriptionPlan.FREE` when no user is logged in. **Without replacement, a
local-only fork is permanently free-tier-limited** (50 notebooks/tags,
7 colors, 10 reminders, 10MB files, no app lock, no task lists/callouts/
outlines, no custom toolbar, no sync controls).

Plan, in priority order:

1. **Rewrite `packages/common/src/utils/is-feature-available.ts` +
   `hooks/use-is-feature-available.ts`** to return always-allowed results
   while keeping every exported name (`isFeatureAvailable`,
   `areFeaturesAvailable`, `getFeature`, `getFeatureLimit`,
   `getFeaturesUsage`, `getFeaturesTable`, `planToAvailability`, `FeatureId`,
   `FeatureResult`). This neutralizes ~40 web call sites (picker.ts,
   add-reminder-dialog, app-lock-settings, navigation-menu, create-color-
   dialog, add-notebook-dialog, item-dialog, add-tags-dialog, note-linking-
   dialog, sync-settings, behaviour-settings, editor-settings,
   customize-toolbar, multi-select, editor header, …) with zero edits there.
2. **Delete `resetFeatures()`** (`apps/web/src/common/index.ts:537-593`) and
   its callers (`app-effects.tsx:68`, `stores/user-store.ts:72`). It actively
   disables app lock, resets homepage/toolbar/sidebar, forces image
   compression and sync toggles on every startup for "free" users — it would
   wipe settings for local users. Must be removed, not just orphaned.
3. **Neutralize `checkFeature`/`withFeatureCheck`**
   (`apps/web/src/common/index.ts:510-535`) and delete
   `showFeatureNotAllowedToast` (`common/toasts.ts`) — the only paths opening
   UpgradeDialog/BuyDialog.
4. **Delete wholesale:** `apps/web/src/dialogs/buy-dialog/` (12 files incl.
   Paddle), `views/{plans,checkout,payments}.tsx`,
   `hooks/use-is-user-premium.ts`,
   `dialogs/settings/{subscription-settings,notesnook-circle-settings}.ts`,
   `dialogs/settings/components/{subscription-status,billing-history,circle-partners}.tsx`,
   `stores/announcement-store.js` + `components/announcements/` +
   `dialogs/announcement-dialog.tsx`, routes `/plans|/checkout|/payments`
   (`bootstrap.tsx:56-68`) and `#/buy` (`hash-routes.tsx:58-63`),
   `@paddle/paddle-js` dep, e2e `checkout.test.ts` + `isPro` bindings +
   free-limit tests (tags 50, colors 7).
5. **packages/core:** delete `api/{subscriptions,pricing,circle,offers}.ts`,
   their registrations (`api/index.ts:201-205`) and re-exports
   (`index.ts:41-43`), `activateTrial`, `announcements()`, SSE `"upgrade"`.
   **Keep the `SubscriptionPlan/Status` enums** and synthesize a local user
   with `subscription: {plan: PRO, status: ACTIVE}` — test fixtures and the
   capabilities shim reference them.
6. **Editor:** no package change needed — pass all claims `true` in
   `apps/web/src/components/editor/tiptap.tsx:198-236`
   (claims map: `packages/editor/src/hooks/use-permission-handler.ts:30-37`).
   Rewire the `insertAttachment` claim off `isLoggedIn` (tiptap.tsx:211) to
   local/WebDAV availability.
7. **Loose ends:** `maxNoteVersions` flows into core pruning via
   `apps/web/src/common/db.ts:100-103` — return `undefined` (unlimited);
   dead code `SUBSCRIPTION_STATUS` (`apps/web/src/common/constants.ts:20-27`)
   and `FREE_NOTEBOOKS_LIMIT` (`packages/core/src/common.ts:132`) — delete;
   `premium?:` crown in `packages/ui/.../menu-button.tsx:110-117` (optional);
   web-clipper bridge `pro: true` hardcode
   (`apps/web/src/utils/web-extension-server.ts:41-42`) — moot if clipper is
   deleted (§10). apps/desktop has **zero** subscription code.

---

## 7. Sync interfaces in core and the WebDAV seam

### 7.1 What core provides (transport-independent, reuse verbatim)

- **Dirty tracking**: every syncable row carries `synced` (dirty flag) and
  `deleted` (tombstone); `SQLCollection.upsert/update` stamp
  `dateModified=Date.now(); synced=false` only when `!item.remote`
  (`packages/core/src/database/sql-collection.ts:89-113,226-266`);
  `softDelete` writes the tombstone shape `{id, deleted:true, dateModified,
  synced}` (L115-138) — **a WebDAV engine must use softDelete, never hard
  `delete()`**. `put()` deliberately does not touch dateModified (L193-224,
  the sync-apply/restore primitive).
- **Collector** (`packages/core/src/api/sync/collector.ts`): iterates the 12
  `SYNC_COLLECTIONS_MAP` types (`api/sync/types.ts:37-50` — settingitem,
  attachment, content, notebook, shortcut, reminder, relation, tag, color,
  note, vault, inboxitemhistory; notehistory/sessioncontent/monographs/kv/
  config never sync), pulls dirty rows via `unsynced()` (keyset-paginated,
  conflicted/un-uploaded excluded, `sql-collection.ts:304-334`), encrypts
  with `storage().encryptMulti`, flips `synced=true` only where
  `dateModified <= pushTimestamp` (race-safe, collector.ts:78-93);
  `localOnly` items collected as fake tombstones (L120-145).
- **Merger** (`api/sync/merger.ts`): LWW on `dateModified`; content conflict
  iff local unsynced-edited, not already resolved, `|dateEdited delta| ≥ 60s`
  (2s in tests) and HTML differs (`isContentConflicted`, L169-203) — stores
  remote into `localItem.conflicted`; attachment merge on `dateUploaded`;
  trash-expiry restore special case (L58-85).
- **Apply path**: `Sync.processChunk` (`api/sync/index.ts:360-476`) =
  decryptMulti grouped by keyVersion → JSON.parse → `deserializeItem`
  (L636-683: sets `remote=true, synced=true`, runs
  `migrateItem(item, v, 6.1, …, 'sync')`, re-dirties if migrated, fixes
  colors-as-tags) → merge → `collection.put`. This is THE function a WebDAV
  engine re-implements/reuses. Wire version `v = CURRENT_DATABASE_VERSION =
  6.1` (`src/common.ts:130`).
- **AutoSync** (`api/sync/auto-sync.ts`): debounces `EVENTS.databaseUpdated`
  → `EVENTS.databaseSyncRequested` — reuse as-is.
- **Post-send re-entrancy**: `Sync.stop` re-checks
  `collector.hasUnsyncedChanges()` and re-runs send-only
  (`api/sync/index.ts:308-315`) — replicate.
- **Swap point**: `Database.syncer = new Sync(db)` at
  `packages/core/src/api/index.ts:208`; public entry points the apps call are
  only `db.sync(options)` (L463-465) and `db.hasUnsyncedChanges()` (L467-469).
  UI trigger hub: `appStore.sync()` (`apps/web/src/stores/app-store.ts:301-359`),
  status pill `components/status-bar/index.tsx` — keep call sites/events
  (`EVENTS.syncProgress/syncCompleted/syncAborted/databaseSyncRequested`).
- **Cursor state**: client keeps only kv `lastSynced` + `deviceId`; the
  WebDAV engine stores per-remote-device cursors itself (protocol journals).
- **Replace/delete**: SignalR `createConnection`, `SyncDevices`
  (`api/sync/devices.ts` — keep local deviceId generation), TokenManager
  auth, `connectSSE`.

### 7.2 The WebDAV engine (now committed: `packages/sync-webdav/`)

- `src/client.ts` — WebDAV verbs OPTIONS/PROPFIND/MKCOL/GET/PUT/DELETE/
  MOVE/HEAD with conditional requests, retries, server-compat fallbacks;
  `src/xml.ts` — namespace-tolerant multistatus parsing (Nextcloud/sabre,
  mod_dav, absolute vs relative hrefs).
- `src/types.ts` + `src/repository.ts` — versioned append-only protocol:
  per-device journals `devices/<deviceId>/changes/<seq>.bin` of immutable
  encrypted change batches, per-device cursors, content-addressed objects and
  attachments, tombstones, key-check canary in `protocol.json`
  (`SYNC_PROTOCOL_VERSION = 1` in the new desktop constants).
- `src/engine.ts` — the sync cycle; `src/queue.ts` — durable outgoing queue
  + debouncing scheduler (single cycle per vault); `src/conflicts.ts` —
  preserves both versions, never resurrects a stale-deleted item.
- `src/crypto.ts` — see §9. `src/backup.ts` — see §8.
- Tests: `tests/{client_test,sync_test}.ts` against `tests/fake-server.ts`
  with `tests/harness.ts`/`memory-store.ts` (multi-device convergence,
  stale-delete resurrection, corrupt/duplicate records, attachment
  round-trips, remote rebuild). For core-integration tests, use the
  two-independent-DB pattern from `packages/core/__tests__/utils/index.ts:47-74`.
- **Remaining integration work**: adapt Collector/Merger/processChunk onto the
  engine (or feed the engine from `unsynced()`), swap `db.syncer`, and expose
  it through the `webdav.*` bindings (§2.2) + a settings panel modeled on
  `servers-configuration.tsx`.

### 7.3 Attachment seam

Two layers: core `FileStorage` (`packages/core/src/database/fs.ts`) is the
**only** place hardcoding `${API_HOST}/s3?name=` + Bearer tokens (L126, 190,
242, 321, 335); actual IO is the injected app-level `IFileStorage`
(`packages/core/src/interfaces.ts:111-143`), implemented by
`apps/web/src/interfaces/fs.ts` (`FileStorage` object, uploadFile/
downloadFile/deleteFile/exists/getUploadedFileSize, L733-745, injected via
`database.setup({fs})` in `apps/web/src/common/db.ts:97`). WebDAV attachment
storage plugs in by re-implementing uploadFile/downloadFile against WebDAV
PUT/GET (ciphertext is already encrypted at rest; no crypto at transfer time)
and neutering the tokenManager Authorization header in `database/fs.ts`.

**Implemented as follows.** The streamable-fs abstraction stays, but on
desktop its `IFileStorage` backend is `DesktopFileStore`
(`apps/web/src/interfaces/fs.ts` selects it the way `key-store.ts` selects
`DesktopKVStore`), which marshals every operation over the `attachments.*`
procedures into the runtime's chunked store
(`apps/desktop/src/native/attachment-store.ts`: one directory per hash,
`meta.json` + numbered chunk files, meta written last as the commit point).
OPFS/CacheStorage/IndexedDB cannot be used on desktop — the loopback port,
and so the origin, changes every launch and origin storage is orphaned.
The browser backends remain for the pure-web build. Chunk boundaries are
one secretstream frame each; the sync engine encrypts each stored chunk as
one wire frame and its download path emits one chunk per frame
(`packages/sync-webdav/src/engine.ts`), so the boundaries the renderer's
decryption depends on survive replication. The S3 seam is dead on desktop:
`uploadFile` reports true once content is in the local store (the WebDAV
engine owns replication), `downloadFile` answers from the local store and
falls back to `webdav.fetchAttachment` (a single-attachment fetch through
the sync engine), `getUploadedFileSize` measures the local store, and
delete goes to the local store only — no code path reaches
`hosts.API_HOST` when `IS_DESKTOP_APP`. Backup payloads keep attachments
as flat bytes; restore re-splits them at the fixed 512 KiB + 17 frame size
(`writeContiguous`), the same reconstruction upstream's own download path
performs with `ChunkedStream(chunkSize + ABYTES)`. Limitation: a
`downloadFile` for content the owning device has not uploaded yet returns
false ("not available"), and sync delivers the content later.

---

## 8. Backup interfaces

- **Format** (`.nnbackupz` zip): `packages/core/src/database/backup.ts` —
  `Backup.export` (L280-383) streams every collection (notes, notebooks,
  content, notehistory, sessioncontent, colors, tags, settings, shortcuts,
  reminders, relations, attachments, vaults) into ≤10MB JSON chunks:
  `{version: 6.1, type, date, data, hash: md5-of-compressed, hash_type,
  compressed:true, encrypted}` — gzip(6)+base64, optionally encrypted with
  the **master key** (not the DEK). `mode:'full'` adds
  `attachments/.attachments_key` + raw encrypted attachment bytes.
  `Backup.import` (L436-521): version gate (refuses >6.1) → decrypt
  (re-derive `generateCryptoKey(password, backup.data.salt)` or raw
  `encryptionKey`) → md5 verify → decompress → `migrateItem(..., 'backup')`
  → `collection.put`; attachment keys re-wrapped (L607-675).
- **App driver**: `apps/web/src/common/index.ts` `createBackup` (L100-201,
  zip via `utils/streams/zip-stream.ts` into `createWritableStream` →
  desktop `backups.open/write/close`); restore `importBackup/
  restoreBackupFile` (L211-374). Scheduling: renderer cron
  (`common/notices.ts:41-86`, `utils/task-scheduler.ts` + worker), registered
  at `app-effects.tsx:75-77` — reusable as-is for scheduled WebDAV backups.
  Settings: `dialogs/settings/backup-export-settings.ts` (section
  `backup-export`, desktop dir picker at L166-193).
- **Blocker to fix**: encrypted backups currently require login —
  `createBackup` force-disables `encryptBackups` when `!isLoggedIn`
  (`common/index.ts:109-111`) and `Backup.export` throws "Please login to
  create encrypted backups" (`backup.ts:308-313`, key =
  `db.user.getMasterKey()`). The port supplies a locally-derived key
  (backup subkey from the sync passphrase, §9, or a user backup password) —
  the format then works verbatim.
- **Fork engine**: `packages/sync-webdav/src/backup.ts` implements encrypted,
  integrity-verified snapshots to local and WebDAV targets with retention;
  exposed via the `backup.*` bindings (§2.2, incl. `backup.restore` and
  `backup.importFile`).

---

## 9. Crypto boundaries and exact functions the WebDAV engine uses

**Primitives** (all `@notesnook/crypto` over libsodium-WASM):

- AEAD: XChaCha20-Poly1305-IETF — 32B key, random 24B nonce per message, 16B
  tag, no AAD (`packages/crypto/src/encryption.ts:53-64`). Authenticated:
  tamper/wrong-key throws (matched as "ciphertext cannot be decrypted" in
  `backup.ts:478-484`).
- KDF: Argon2i v1.3, opslimit 3, memlimit 8MiB, 32B out, 16B salt
  (`packages/crypto/src/keyutils.ts:51-58`); alg string `xcha-argon2i13-7`.
  (Login hash — Argon2id, 64MiB, `password.ts:22-39` — is server-auth only,
  irrelevant for WebDAV Basic auth.)
- Streaming: secretstream, 512KiB plaintext chunks + 17B ABYTES each, header
  = base64 `iv`, alg `xcha-stream` (`apps/web/src/interfaces/fs.ts:54-130`).
  streamable-fs stores exactly one frame per chunk, so
  `FileHandle.readable.pipeThrough(createDecryptionStream(key, iv))` works
  without re-chunking; downloads re-chunk by `chunkSize+17`
  (`fs.ts:552-601`).
- Wire record: `Cipher<'base64'>` = `{format, alg, cipher, iv, salt, length}`
  (`packages/crypto/src/types.ts:24-31`); iv/salt/keys are URL-safe unpadded
  base64; set `format:"base64"` after JSON deserialization before decrypting.

**Exact call map for the engine** (implemented in
`packages/sync-webdav/src/crypto.ts`):

1. **Key derivation**: `new NNCrypto().exportKey(passphrase, salt)` →
   `SerializedKey {key, salt}`; fresh salt =
   `sodium.randombytes_buf(crypto_pwhash_SALTBYTES)`, stored remotely
   (salt only). Purpose subkeys via keyed BLAKE2b
   `crypto_generichash(32, context, masterKey)` with contexts
   `nn-sync-v1` / `nn-attachment-v1` / `nn-backup-v1` / `nn-database-v1`;
   keyed content addressing for object names (`crypto.ts` `contentAddress`)
   so note content/titles never appear in remote paths. Key-check canary in
   `protocol.json` verifies the passphrase before syncing.
2. **Records**: `crypto.encrypt/encryptMulti(key, JSON.stringify(item),
   "text", "base64")` → `Cipher<'base64'>`; `crypto.decrypt/decryptMulti`.
   Serialization matches the upstream field set exactly
   (`toSerializedCipher`, crypto.ts:211-222).
3. **Attachments**: local bytes are already secretstream-encrypted with a
   random per-file key wrapped by the attachmentsKey
   (`packages/core/src/collections/attachments.ts:599-614 encryptKey` /
   `:196-201 decryptKey`) — upload/download ciphertext verbatim; keep the
   17-byte ABYTES accounting for size validation (`fs.ts:452-469,592-601`).
   For fresh encrypts: `createEncryptionStream(key)` fed via
   `ChunkedStream(512KiB)` + `IntoChunks(totalSize)`
   (`apps/web/src/utils/streams/chunked-stream.ts:22-79`).
4. **Key-material boundary to preserve**: `Collector.collect` and
   `processChunk` call `db.user.getDataEncryptionKeys()`; `Backup.export`
   calls `getUser()/getMasterKey()/getAttachmentsKey()`;
   `Attachments._getEncryptionKey` calls `getAttachmentsKey()`
   (`packages/core/src/api/user-manager.ts:407-461`). The port keeps these
   working with a **local key provider** (synthetic user + keys derived from
   the sync passphrase, as `loginFakeUser` does in
   `packages/core/__tests__/utils/index.ts:110-129`).
5. **Untouched**: Vault is account-independent (`packages/core/src/api/
   vault.ts:36,76-105,266-283` — password-KDF'd at use, syncs as opaque
   ciphers). App-lock key store (`apps/web/src/interfaces/key-store.ts`,
   3-key model documented in `apps/web/at-rest-encryption.md`) stays; only
   the Electron safeStorage wrap needs a binding or the fallback (§2.2).
   Mobile-only fallback KDFs (`deriveCryptoKeyFallback`) and crypto_box
   keypair APIs are dead — delete with mobile.

---

## 10. Deletion list (dependency-verified)

| Target | Justification (reverse-dependency check) |
|---|---|
| `apps/mobile/` (34MB) | Nothing outside it imports from it. Desktop refs are bookkeeping only. |
| `packages/editor-mobile/` (8.3MB) | Sole consumer is apps/mobile (deep imports of `src/utils/native-events`). The `editor-mobile-toolbar-popup` strings in `packages/editor` are a CSS-classname coincidence, not a dependency. Also drop `styles/*.mobile.css` variants in packages/editor. |
| `fastlane/` | Play Store/F-Droid metadata; zero in-repo references. |
| `apps/monograph/` | Fetches `https://api.notesnook.com/monographs` (`app/utils/env.ts:21-22`, `routes/$id.tsx:46`) — hard Notesnook Cloud dependency; zero reverse deps. Separate surgery: the in-app publish UI in apps/web (§5). |
| `apps/theme-builder/` | Depends on the entire `@notesnook/web` via `file:../web`; keeping it constrains apps/web refactors; zero reverse deps. |
| `apps/vericrypt/` | Entirely Notesnook-account-coupled (decrypt-your-sync-payload demo); meaningless with WebDAV; zero reverse deps. |
| `extensions/web-clipper/` + `packages/clipper/` | packages/clipper's only consumer is the extension. **Surgery required in apps/web**: `apps/web/src/utils/web-extension-relay.ts:21-25` has a runtime **value** import (`WEB_EXTENSION_CHANNEL_EVENTS`) from the extension's `common/bridge.js`, instantiated unconditionally at `apps/web/src/app.tsx:52` — remove relay+server+instantiation and the `@notesnook/web-clipper` dep (`apps/web/package.json:33`), or vendor `bridge.ts`+`constants.ts` (pure types + one const). |
| `servers/themes/` | apps/web uses it only as a type import (`ThemesRouter`/`ThemeMetadata`, `common/themes-router.ts:20-33`, `theme-details-dialog.tsx:21`, `themes-selector.tsx:37`, `theme-preview/index.tsx:23`); runtime is the hosted URL. Delete server + gallery UI, keep bundled themes + load-from-file (§5). |
| `docs/` (22MB) | Help site; no app imports it; content documents cloud/subscription features that no longer apply. Remove `docs/*` from root `taskRunner.projects`. |
| Workflows: `android.*` (5), `ios.*` (3), `nscurl.test.yml` (daily payments.streetwriters.co ATS check), `monograph.publish`, `themes.publish`, `theme-builder.publish`, `vericrypt.publish`, `web.preview`, `web.publish`, `help.*` | Mobile, subscription infra, and hosted-service deploys. Keep/adapt: `core.tests.yml`, `editor.tests.yml`, `web.tests.yml` (best UI regression suite for the embedded webview); replace `desktop.{preview,publish,tests}.yml` with Deno CI. |
| Root scripts: `publish.mjs`, `deobfuscate.mjs`, `analyze.mjs`; `generate-sources.mjs` only after a Deno flatpak replacement exists | npm-publishing, app.notesnook.com sourcemap symbolication, mobile-aware analysis, Electron-specific flatpak-node-generator. |
| Electron internals of apps/desktop (phase 3): `src/main.ts`, `preload.ts`, `overrides.ts`, `src/api/`, `electron-builder.config.js`, `app-update.yml`, `scripts/*.mjs`, `patches/`, `__tests__/` | Superseded by the Deno host + `src/rpc/protocol.ts`. Note `package.json` exports a nonexistent `./testutils` file — dead already. |
| Mobile residue (edit, don't delete): root `package.json` (15 mobile scripts, `eslint-plugin-detox`/`-react-native` devDeps, 13 taskRunner mobile commands), `scripts/bootstrap.mjs:33`, `scripts/analyze.mjs:26`, `.eslintrc.js:49,51` + apps/mobile override block, `.commitlintrc.js` SCOPES, `.github/actions/setup-node-with-cache/action.yml:14,24` (hashes mobile lockfiles) | Referenced from shared config, not standalone. |

---

## 11. Build system findings and the Deno task design

### 11.1 Upstream build (what still runs and why)

- Monorepo `file:` deps orchestrated by `npm run tx` →
  `scripts/execute.mjs` (dep-ordered, `.taskcache`); per-package builds are
  plain triple-tsc via root `scripts/build.mjs` (cjs/esm/types). Keep
  `scripts/{bootstrap,execute,build,clean}.mjs` while the web bundle is
  still built with npm + Vite.
- Web bundle for desktop: `PLATFORM=desktop vite build`
  (`apps/web/package.json`), defines `IS_DESKTOP_APP=true`, aliases
  `/desktop-bridge$` and `/sqlite$` → `index.desktop`
  (`apps/web/vite.config.ts:44,82,102-113`); `target: esnext`, **no service
  worker/PWA** on desktop (L143-164), dev server on port 3000. Output
  `apps/web/build/` is what the Deno host serves.
- Fresh-clone build hazards: (a) `packages/editor` prebuild must run
  (`scripts/langen.mjs` generates the gitignored refractor language loader);
  (b) `packages/theme` prebuild fetches gitignored default-theme JSONs from
  GitHub — **vendor them**; (c) `patch-package` postinstall in editor/
  sodium/desktop must keep running; (d) `emitEditorStyles()` Vite plugin
  emits stable `assets/editor-styles.css` which exported-note HTML references
  as a hardcoded `https://app.notesnook.com/...` URL
  (`packages/core/src/utils/templates/html/template.ts:51`) — inline it for
  offline exports.
- Electron packaging (`electron-builder.config.js`: dmg/mas/nsis/portable/
  AppImage/snap, asarUnpack for sqlite extensions, notarization/signing,
  publish to streetwriters/notesnook) is replaced wholesale;
  `scripts/generate-sources.mjs` (flatpak-node-generator with
  `--electron-node-headers`) must be rebuilt for Deno flatpak packaging.

### 11.2 Deno workspace (committed in `deno.json`, verified)

- Workspace: `./apps/desktop`, `./packages/sync-webdav`;
  `nodeModulesDir: "auto"`, `unstable: ["sloppy-imports"]`.
- Import map does the sodium/browser-condition fix:
  `@notesnook/crypto → packages/crypto/src/index.ts`,
  `@notesnook/sodium → packages/sodium/src/browser.ts`,
  `libsodium-wrappers-sumo → packages/sodium/src/libsodium.ts` (the new Deno
  libsodium entry, typed by `packages/sodium/types/libsodium-wrappers-sumo.d.ts`),
  `@notesnook/sync-webdav → packages/sync-webdav/src/index.ts`, plus
  `@std/{assert,path,fs,encoding,testing}`.
- Tasks (verified list): `dev`, `fmt`, `lint`,
  `check` (`apps/desktop/main.ts` + sync-webdav index), `test`,
  `test:webdav` (`packages/sync-webdav/tests/run-integration.ts`),
  `test:ui`, `bench`, `build:ui`, `build` (+ per-target
  `build:{windows,linux,appimage,deb,rpm,msi}`), `checksums`,
  `verify:no-electron` (`apps/desktop/scripts/verify-dependencies.ts` — CI
  guard that no Electron dep sneaks back in).
- **Gap (verified):** the tasks reference `apps/desktop/main.ts` and
  `apps/desktop/scripts/{dev,build,build-ui,test-ui,benchmark,checksums,verify-dependencies}.ts`,
  none of which exist yet — `apps/desktop/scripts/` still holds only the
  Electron-era `.mjs` scripts. `sync-webdav` tests exist but
  `tests/run-integration.ts` for `test:webdav` does not. Writing these is the
  next build-system milestone. `build-ui.ts` should wrap the existing
  `PLATFORM=desktop vite build` (Node stays a build-time-only dependency for
  the web bundle) and copy `apps/web/build/` → `apps/desktop/ui/`
  (already excluded from `deno fmt`).
- Fork identity for packaging comes from the new
  `apps/desktop/src/constants.ts` (`APP_NAME/APP_ID/APP_IDENTIFIER/
  APP_VERSION/DEEP_LINK_SCHEME/UPDATE_MANIFEST_URL/USER_AGENT`), with
  `APP_VERSION` kept in sync with `deno.json` by the build script.
  Remember the `PATHS` re-export fix (top of this file) before the web
  bundle is next built.
