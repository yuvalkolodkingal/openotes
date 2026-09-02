# Openotes for phones

An Expo application that syncs to the same Neon or Supabase database as the
desktop. No account: it connects with what the desktop's settings show, and
decrypts with the same sync passphrase.

## What it shares with the desktop

Code, not a format. Metro resolves these by path from the repository:

| Path                                | What                                              |
| ----------------------------------- | ------------------------------------------------- |
| `packages/sync-webdav/src`          | The journal engine, conflict rules, queue         |
| `packages/sync-sql/src`             | The SQL backend (Neon over HTTPS, Supabase REST)  |
| `packages/sync-core/src`            | The storage seam                                  |
| `packages/sync-crypto-js/src`       | The engine's cryptography, in pure JavaScript     |
| `apps/desktop/src/mcp/markdown.ts`  | HTML ⇄ Markdown, the way the assistant sees notes |

`metro.config.js` points `@notesnook/crypto` and `@notesnook/sodium` at the
pure-JS build, because libsodium is WebAssembly and a phone has none. That
build is checked against libsodium in `packages/sync-crypto-js/tests`.

## Building

```sh
cd apps/mobile
npm ci
npm run typecheck      # what CI runs
npx expo start         # development server; scan with Expo Go
npx expo run:android   # or run:ios — a native build
```

Requires Node 22. See the Expo documentation for the native toolchains.

### The APK

```sh
npm run build:apk    # dist/Openotes-<version>-android.apk
```

Needs a JDK (17 or newer) and the Android SDK (`ANDROID_HOME`). The script
generates the native project with `expo prebuild`, builds the release variant
with Gradle and signs the result with `apksigner` -- with the keystore named
by `ANDROID_KEYSTORE` (plus `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`), or with a throwaway key when none is given. CI
builds the same APK for every release; see PACKAGING.md at the root.

## What it does not do

- Attachments are not synced (their streaming cipher needs libsodium).
- Vault notes are listed but cannot be opened; the vault password stays on the
  desktop.
- A plain Postgres and WebDAV servers are not reachable: both need a socket.

See [DATABASE.md](../../DATABASE.md) at the repository root.
