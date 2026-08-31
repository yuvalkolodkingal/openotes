# Building Openotes

Everything here uses Deno. **A separate Node.js installation is not
required** — the interface still builds with Vite, but Deno runs it through
its npm compatibility layer.

---

## Requirements

| | |
|---|---|
| Deno | 2.9 or newer |
| A C compiler | `cc`/`gcc` on Linux and macOS, MSVC (`cl.exe`) on Windows — for the encrypted SQLite library |
| `unzip`, `tar` | Extracting build inputs (`Expand-Archive` on Windows) |

### Platform runtime dependencies

| Platform | Needs |
|---|---|
| Linux | WebKitGTK (`libwebkit2gtk-4.1-0` on Debian/Ubuntu, `webkit2gtk-4.1` on Arch), GTK 3 |
| Windows | WebView2 runtime (present on Windows 11 and current Windows 10) |

Optional on Linux, used as fallbacks when the runtime exposes no native
equivalent: `zenity` (file dialogs), `libnotify` (`notify-send`), `wl-clipboard`
or `xclip`.

### Installing Deno

```bash
curl -fsSL https://deno.land/install.sh | sh     # Linux / macOS
irm https://deno.land/install.ps1 | iex          # Windows PowerShell
deno --version                                    # expect 2.9.0 or newer
```

---

## First build

```bash
git clone https://github.com/yuvalkolodkingal/notesnook.git openotes
cd openotes

deno task build:native   # encrypted SQLite + FTS5 extensions (~1 minute)
deno task build:ui       # the React interface
deno task dev            # run it
```

`build:native` is the only step that needs a compiler. It downloads the
SQLite3MultipleCiphers amalgamation, **verifies its SHA-256 against a pinned
value**, compiles a shared library with FTS5 and encryption enabled,
installs the two FTS5 tokenizer extensions, and then smoke-tests that
encryption is actually active and that a search returns results before
reporting success. Artifacts land in `apps/desktop/native/` and are
gitignored.

If it fails, nothing else will work: a missing encryption library is a hard
startup error, never a silent fall back to an unencrypted database.

---

## Tasks

| Task | What it does |
|---|---|
| `deno task dev` | Run the app against the built interface, with debug logging. |
| `deno task fmt` | Format. |
| `deno task lint` | Lint. |
| `deno task check` | Type-check the runtime and the sync engine. |
| `deno task test` | Unit and protocol tests (no network needed). |
| `deno task test:webdav` | Integration tests against a **real** WebDAV server. |
| `deno task build:native` | Build the encrypted SQLite library and extensions. |
| `deno task check:native` | Verify existing native artifacts and re-run the smoke test. |
| `deno task build:ui` | Build the React interface. |
| `deno task build` | Build the application for this platform. |
| `deno task build:windows` | Cross-build for Windows. |
| `deno task build:linux` | Cross-build for Linux. |
| `deno task build:appimage` / `:deb` / `:rpm` / `:msi` | Build one package format. |
| `deno task checksums` | Write `SHA256SUMS` for a directory of artifacts. |
| `deno task verify:no-electron` | Fail if Electron or React Native reappears. |
| `deno task bench` | Startup, memory and latency benchmarks. |

---

## Running in development

```bash
deno task build:ui        # rebuild after changing anything under apps/web
deno task dev
```

Useful environment variables:

| Variable | Effect |
|---|---|
| `OPENOTES_DATA_DIR` | Use a different data directory — the way to run two independent profiles. |
| `OPENOTES_UI_ROOT` | Point at a different built interface. |
| `OPENOTES_NATIVE_DIR` | Point at a different native library directory. |
| `OPENOTES_LOG_LEVEL` | `error`, `warn`, `info`, `debug`, `trace`. |
| `OPENOTES_DEV=1` | Development defaults, including debug logging. |
| `OPENOTES_PORTABLE=1` | Keep data next to the executable. |

### Two profiles against one server

The way to exercise synchronization by hand, and what the multi-device tests
automate:

```bash
OPENOTES_DATA_DIR=/tmp/openotes-a deno task dev
OPENOTES_DATA_DIR=/tmp/openotes-b deno task dev   # in another terminal
```

Point both at the same WebDAV server and directory, with the same sync
passphrase.

Each profile is fully independent: the vault, attachments, settings and key
material all live under its data directory. The interface is served on a
loopback port the runtime assigns per launch, reachable only by that
instance's own webview, so two instances do not collide.

---

## Testing

```bash
deno task test           # unit + protocol, ~1 second, no network
deno task test:webdav    # against a real WebDAV server
```

`test:webdav` needs a real server, in this order of preference:

1. `WEBDAV_TEST_URL` (plus `WEBDAV_TEST_USER`, `WEBDAV_TEST_PASSWORD`) —
   a running server. CI uses a service container; you can point it at a
   Nextcloud instance to check interoperability.
2. A `dufs` binary on `PATH`, or at `DUFS_BINARY`.
3. Otherwise it downloads a checksum-verified `dufs` release.

In CI a missing server is a **failure**, not a skip, so an integration run
that quietly did nothing cannot be mistaken for a passing one.

---

## Building packages

```bash
deno task build                    # this platform, default format
deno task build:appimage
deno task build:deb
deno task build:rpm
deno task build:windows
deno task build:msi
```

Deno Desktop cross-compiles from one machine to
`x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
`x86_64-pc-windows-msvc`, `x86_64-apple-darwin` and `aarch64-apple-darwin`.

**The native SQLite library does not cross-compile.** It is a C library built
by the host toolchain, so each target's library must be produced on that
target — which is why the release pipeline uses one runner per platform
rather than cross-compiling everything from one machine.

Flatpak and the Arch package use their own native tooling from their CI
jobs:

```bash
flatpak-builder --repo=repo build packaging/flatpak/org.openotes.Openotes.yml
cd packaging/arch && makepkg
```

Artifacts and the exact CI steps are documented in
[PACKAGING.md](PACKAGING.md).

---

## Deno permissions

The application runs with the narrowest set that works. Every one is needed:

| Permission | Why |
|---|---|
| `--allow-read` on the data, config, cache and backup directories, plus the app's own installation | Vault, attachments, settings, logs, the interface and the native libraries |
| `--allow-write` on the data, config, cache and backup directories | Everything the app persists |
| `--allow-net` on the configured WebDAV host, the update endpoint and `127.0.0.1` | Synchronization, update checks, and serving the interface |
| `--allow-env` for `OPENOTES_*`, `HOME`/`APPDATA`, `XDG_*`, `FLATPAK_ID`, `SNAP`, `APPIMAGE` | Locating directories and detecting the packaging format |
| `--allow-ffi` on the bundled SQLite library | The encrypted database |
| `--allow-run` on a small fixed set (`xdg-open`, `open`, `explorer`, `notify-send`, `zenity`, `wl-copy`, `xclip`, `dbus-send`) | Fallbacks only, used when the runtime exposes no native equivalent, always with a fixed argument vector |

There is no blanket `--allow-run` and no blanket `--allow-net`.

---

## Troubleshooting

**`build:native` cannot find a compiler.**
Install one: `build-essential` (Debian/Ubuntu), `base-devel` (Arch),
Xcode command line tools (macOS), Visual Studio Build Tools (Windows).

**"The encrypted SQLite library was not found".**
Run `deno task build:native`, or set `OPENOTES_NATIVE_DIR`. The application
deliberately refuses to start rather than open an unencrypted vault.

**"Could not find the built user interface".**
Run `deno task build:ui`, or set `OPENOTES_UI_ROOT`.

**"Openotes is already running".**
An advisory lock is held by another instance. Close it. The kernel releases
the lock however the process dies, so a crash does not leave it stuck.

**A blank window on Linux.**
WebKitGTK is missing or too old. Install `libwebkit2gtk-4.1-0` (Debian /
Ubuntu) or `webkit2gtk-4.1` (Arch).

**Search returns nothing.**
The FTS5 extensions did not load. Re-run `deno task build:native` and check
its output; the app logs the directory it looked in.

---

## Project layout

See [ARCHITECTURE.md](ARCHITECTURE.md). Briefly:

```
apps/desktop/     the Deno Desktop application (main.ts, src/, scripts/)
apps/web/         the React interface
packages/         core, crypto, editor, sync-webdav, and the rest
packaging/        flatpak, Arch, .desktop, man page
.github/workflows/ test, build, release
```
