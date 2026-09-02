# Linux packaging

Everything Openotes needs to become an installable Linux package. Nothing in
this directory builds the application — the CI release job builds one tarball
first, and each manifest here only unpacks and installs it.

The app identity these files use (`Openotes`, `openotes`,
`org.openotes.Openotes`, the `openotes://` URI scheme) comes from
`apps/desktop/src/constants.ts`. If that file changes, these change with it.

## The release tarball (the shared input)

The release job produces exactly one Linux artifact and every packaging format
consumes it:

```
Openotes-<version>-linux-x86_64.tar.gz     the release asset name
└── openotes-<version>-linux-x86_64/       the inner directory (lowercase)
    ├── openotes                     launcher (deno desktop)
    ├── openotes.so                  the deno desktop payload the launcher
    │                                loads from beside itself — not an
    │                                ordinary shared library
    ├── ui/                          built web UI, served to the webview
    │   └── index.html
    ├── native/                      libsqlite3mc.so + the two FTS5 tokenizer
    │                                extensions (deno task build:native)
    ├── icons/
    │   ├── 16x16.png … 512x512.png  copied from apps/desktop/assets/icons
    ├── openotes.desktop             copied from packaging/linux
    ├── openotes.1                   copied from packaging/linux
    ├── openotes-launcher.sh         the PATH-extending launcher template
    │                                (see below); recipes fill in @PRELUDE@
    │                                and @TARGET@ and install it as the
    │                                command on PATH
    ├── LICENSE                      copied from the repository root
    └── UPSTREAM.md                  copied from the repository root
```

Three properties of that layout are load-bearing:

- **The binary must not be stripped.** `deno desktop` appends its payload after
  the ELF sections; stripping rewrites the file, drops the payload, and leaves
  a binary that starts and then cannot find its own code. Both the flatpak
  manifest (`build-options: strip: false`) and the PKGBUILD (`options=('!strip')`)
  turn the default stripping off, and the release job must not strip it either.
- **`openotes.so` travels with the launcher.** `deno desktop` splits the
  application into a launcher plus a payload; installing only the launcher
  gives a package that starts and then cannot find its own code. Every
  package installs the two side by side.
- **`ui/` and `native/` travel with the binary.** At startup the app looks for
  a `ui` directory and a `native` directory next to its own executable
  (`apps/desktop/main.ts:51-71`, `apps/desktop/src/native/sqlite.ts:63-80`) and
  checks `OPENOTES_UI_ROOT` / `OPENOTES_NATIVE_DIR` first. Both packages keep
  everything together under a private lib directory and put a four-line `sh`
  launcher on `PATH` that pins the two variables, so an unset variable can
  never make an installed copy load a stale UI.

## The launcher

Every distro package and the AppImage start through
`linux/openotes-launcher.sh`. The AI assistant launches agents the user
installed, and the runtime only permits programs it found on `PATH` when it
started; an application started from a desktop launcher gets the session's
`PATH`, not a login shell's, so agents under `nvm`, `volta` or `~/.local/bin`
were unlaunchable. The wrapper adds those directories — and the `PATH` the
user's own shell reports, when it answers within three seconds — before
`exec`ing the binary. `OPENOTES_NO_SHELL_PATH=1` skips asking the shell.

The .deb and .rpm install it as `/usr/bin/openotes` with the resource
directories pinned; the AppImage installs it as `AppRun` in front of Deno's
own; the PKGBUILD fills it in from the tarball. The flatpak keeps its own
four-line launcher, since host programs are not visible inside the sandbox.

## Files

### `flatpak/org.openotes.Openotes.yml`

The flatpak-builder manifest.

CI copies the release tarball next to this file as
`openotes-linux-x86_64.tar.gz` — a version-less name, so the manifest needs no
per-release edit — and then runs:

```sh
flatpak-builder --force-clean --repo=repo build-dir \
    packaging/flatpak/org.openotes.Openotes.yml
flatpak build-bundle repo openotes.flatpak org.openotes.Openotes
```

The manifest pulls in three files from this directory by relative path
(`../linux/openotes.desktop`, `../linux/openotes.1`, and the metainfo next to
it), so it must be built from a checkout, not from the tarball alone.

**Runtime.** `org.gnome.Platform//48` with `org.gnome.Sdk`. The app ships no
browser engine: its window is an OS webview, which on Linux is WebKitGTK
loaded from the runtime. `org.freedesktop.Platform` does not provide
WebKitGTK; `org.gnome.Platform//48` is that same freedesktop 24.08 base plus
the GTK/WebKitGTK stack, which is the only reason the GNOME runtime is used.

**Permissions.** Seven `finish-args`, each commented in the manifest with why
it exists: `--socket=wayland` and `--socket=fallback-x11` for the window,
`--share=ipc` for display-server shared memory, `--device=dri` for GPU
rendering, `--share=network` for WebDAV sync and the update check,
`--talk-name=org.freedesktop.Notifications` for reminders, and
`--filesystem=xdg-documents` for backups. `--filesystem=host` is never
granted. Application data stays in the XDG app directories flatpak provides
(`~/.var/app/org.openotes.Openotes/{data,config,cache}`), which is where
`appDataDir()`, `configDir()` and `cacheDir()` land on their own — no
permission is needed for the app's own storage.

**Renames.** Inside a flatpak the desktop entry and the icons have to be named
after the app id, so the build installs `openotes.desktop` as
`org.openotes.Openotes.desktop` and rewrites its single `Icon=` line. Nothing
else differs from the distro packages.

### `flatpak/org.openotes.Openotes.metainfo.xml`

AppStream metadata: name, summary, description (including that Openotes is a
fork of Notesnook), `GPL-3.0-or-later`, categories, an OARS 1.1 content
rating, the 1.0.0 release entry, and a `launchable` pointing at
`org.openotes.Openotes.desktop` — the name the desktop entry has *after* the
flatpak build renames it.

It is installed to `/app/share/metainfo/` by the flatpak build only. The Arch
package does not install it, because its `launchable` names a desktop file
that exists only inside the flatpak. There are no `<screenshot>` entries; a
Flathub submission would need them added, with URLs to hosted images.

### `linux/openotes.desktop`

The desktop entry, shared by every Linux format. `Exec=openotes %U` takes the
`%U` because the entry also registers the `openotes://` URI scheme —
`x-scheme-handler/openotes` is the only MIME type claimed, since it is the
only one the app actually handles. `StartupWMClass=Openotes` matches the GTK
program class the toolkit derives from the `openotes` binary name, so the
window docks to the launcher icon instead of appearing as a second entry.

CI copies this file into the release tarball and installs it from there.

### `linux/openotes.1`

The man page (section 1), installed to `/usr/share/man/man1/openotes.1` by the
Arch package and `/app/share/man/man1/` by the flatpak. It documents the
command line implemented in `apps/desktop/src/cli.ts` — `--hidden`,
`-v/--version`, `-h/--help`, `new note|notebook|reminder`,
`open note|notebook --id <id>` — the `openotes://` scheme, and the environment
variables the app actually reads: `OPENOTES_DATA_DIR`, `OPENOTES_PORTABLE`,
`OPENOTES_UI_ROOT`, `OPENOTES_NATIVE_DIR`, `OPENOTES_LOG_LEVEL`,
`OPENOTES_UI_PORT`, plus the `XDG_*` directories consulted in
`apps/desktop/src/native/paths.ts`. Keep it in step with the `Environment:`
block that `apps/desktop/src/cli.ts` prints for `--help`.

CI copies this file into the release tarball and installs it from there.

### `arch/PKGBUILD`

Builds `openotes-<version>-1-x86_64.pkg.tar.zst`, which is makepkg's default
name for `pkgname-pkgver-pkgrel-arch`; nothing overrides `PKGEXT`.

CI does three substitutions before running `makepkg`:

1. rewrite the `pkgver=` line from the release tag;
2. point `source=` at the local tarball, because the release asset does not
   exist yet at build time;
3. replace `sha256sums=('SKIP')` with the real digest.

Run standalone after a release, the unedited PKGBUILD downloads the
published `Openotes-<version>-linux-x86_64.tar.gz` asset instead (saved
under a lowercase local name so the extracted directory matches `_src`).

`depends` is `webkit2gtk-4.1` (the GTK3/libsoup3 WebKitGTK the webview loads),
`gtk3`, and `hicolor-icon-theme`. `zenity`, `libnotify` and `xdg-utils` are
optional: without them the file dialogs, notifications and "open in browser"
fall back to in-app behaviour rather than failing
(`apps/desktop/src/native/shell.ts`).

`package()` installs the payload to `/usr/lib/openotes/`, a launcher to
`/usr/bin/openotes`, the desktop entry to `/usr/share/applications/`, the man
page to `/usr/share/man/man1/`, the eight icon sizes to
`/usr/share/icons/hicolor/<size>/apps/openotes.png`, and `LICENSE` plus
`UPSTREAM.md` to `/usr/share/licenses/openotes/`.

## Validating a change

```sh
python3 -c "import yaml; yaml.safe_load(open('packaging/flatpak/org.openotes.Openotes.yml'))"
xmllint --noout packaging/flatpak/org.openotes.Openotes.metainfo.xml
appstreamcli validate packaging/flatpak/org.openotes.Openotes.metainfo.xml
desktop-file-validate packaging/linux/openotes.desktop
groff -man -Tutf8 -ww -z packaging/linux/openotes.1
bash -n packaging/arch/PKGBUILD
```

Two clean-run remarks are expected and should not be "fixed":

- `desktop-file-validate` emits a hint that `Categories=Office;Utility;`
  contains more than one main category. Both are wanted; the entry is meant to
  appear under Office and under Accessories.
- `appstreamcli validate --pedantic` notes that the component ID contains
  uppercase letters. The ID has to equal `APP_IDENTIFIER` in
  `apps/desktop/src/constants.ts`, which is `org.openotes.Openotes`, so it
  stays as is. Plain `appstreamcli validate` passes.

`flatpak-builder --show-manifest`, `makepkg` and `namcap` need the real
packaging toolchains and only run on a CI runner or a developer machine with
them installed.

## Licensing and attribution

Openotes is a GPL-3.0-or-later fork of
[Notesnook](https://github.com/streetwriters/notesnook) by Streetwriters
(Private) Limited. Every file here carries the GPL header, and both packages
install `LICENSE` and `UPSTREAM.md` so the origin of the code travels with the
binary. Openotes is not affiliated with or endorsed by Streetwriters.
