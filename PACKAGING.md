# Packaging

Every artifact a release publishes, what produces it, and how to verify it.

**GitHub Actions is the authoritative release process.** Local packaging is
for development and for checking a change before it reaches CI; a release
built on someone's laptop is not a release.

---

## Release artifacts

A tagged release (`v1.0.0`) publishes:

### Windows (x86_64)

| Artifact | Purpose |
|---|---|
| `Openotes-VERSION-windows-x86_64.msi` | The normal installed distribution. |
| `Openotes-VERSION-windows-x86_64.exe` | Portable — runs without installing. |
| `Openotes-VERSION-windows-x86_64.zip` | The portable build with its assets, zipped. |

The `.exe` and `.msi` are both required, and the `.exe` is the portable
distribution rather than a second installer.

### Linux (x86_64, and arm64 where the format supports it)

| Artifact | Purpose |
|---|---|
| `Openotes-VERSION-linux-x86_64.AppImage` | Runs on any distribution with WebKitGTK. |
| `Openotes-VERSION-linux-x86_64.flatpak` | Sandboxed bundle. |
| `Openotes-VERSION-linux-x86_64.deb` | Debian, Ubuntu. |
| `Openotes-VERSION-linux-x86_64.rpm` | Fedora, RHEL, openSUSE. |
| `openotes-VERSION-1-x86_64.pkg.tar.zst` | Arch, Manjaro. |
| `Openotes-VERSION-linux-x86_64.tar.gz` | Generic tarball, and the input every other Linux format is built from. |

The `.deb` and `.rpm` release assets deliberately keep the uniform
`Openotes-VERSION-linux-ARCH` scheme rather than each distro's native
convention (`openotes_VERSION_amd64.deb`, `openotes-VERSION-1.x86_64.rpm`) —
one predictable name per artifact keeps `SHA256SUMS`, the update manifest
and the download page consistent. The *package metadata inside* each file
uses the distro's convention (`Package: openotes`, amd64), so the installed
package behaves natively. `openotes-VERSION-1-x86_64.pkg.tar.zst` is the one
exception: it is exactly what `makepkg` names `pkgname-pkgver-pkgrel-arch`,
because pacman tooling expects that shape. There is no `.pacman` extension
and nothing here invents one.

### Android

| Artifact | Purpose |
|---|---|
| `Openotes-VERSION-android.apk` | The phone app (`apps/mobile`), one APK for every ABI. Sideload it; it is not on a store. |

Built by `apps/mobile/scripts/build-apk.sh`: `expo prebuild` generates the
native project from `app.json` (nothing under `android/` is checked in),
Gradle builds the release variant, and `apksigner` signs it. The
`versionCode` is derived from the version (`2.2.1` → `20201`) so each release
installs over the last.

### Alongside them

| | |
|---|---|
| `SHA256SUMS` | One line per artifact, standard `sha256sum -c` format. |
| `sbom.spdx.json` | Software bill of materials, where it can be generated. |

---

## Verifying a download

```bash
sha256sum --check --ignore-missing SHA256SUMS
```

`--ignore-missing` so you can check just the file you downloaded.

---

## What builds what

| Artifact | Produced by |
|---|---|
| `.msi`, Windows app directory | `deno desktop` native output |
| `.AppImage`, `.deb`, `.rpm` | `deno desktop` native output |
| `.exe`, `.zip`, `.tar.gz` | Assembled from the app directory |
| `.flatpak` | `flatpak-builder` + `packaging/flatpak/` |
| `.pkg.tar.zst` | `makepkg` + `packaging/arch/PKGBUILD` |

Deno Desktop's own package outputs are used wherever they exist rather than
repackaging them by hand. The rest are assembled from the app directory it
produces.

---

## The Linux release tarball

Every Linux format consumes one tarball, so there is a single definition of
what an installed copy contains:

```
openotes-<version>-linux-x86_64/
├── openotes            the launcher
├── openotes.so         the deno desktop payload the launcher loads
├── ui/                 the built interface, served to the webview
├── native/             libsqlite3mc.so and the two FTS5 extensions
├── icons/              16×16 … 512×512 PNGs
├── openotes.desktop
├── openotes.1
├── LICENSE
└── UPSTREAM.md
```

Three properties of that layout are load-bearing, and getting any of them
wrong produces a package that installs cleanly and then fails at runtime:

**The binary must not be stripped.** `deno desktop` appends its payload
after the ELF sections. Stripping rewrites the file, discards the payload,
and leaves a binary that starts and then cannot find its own code. The
flatpak manifest sets `strip: false` and the PKGBUILD sets
`options=('!strip')`; the release job must not strip it either.

**`openotes.so` travels with the launcher.** It is not an ordinary shared
library: it is the application payload `deno desktop` splits out beside the
launcher. A package that installs only the launcher starts and then cannot
find its own code.

**`ui/` and `native/` travel with the binary.** At startup the application
looks for them next to its own executable, and honours `OPENOTES_UI_ROOT`
and `OPENOTES_NATIVE_DIR` first. The distribution packages keep everything
together under a private library directory and install a small launcher on
`PATH` that pins both variables, so an unset variable cannot make an
installed copy load a stale interface.

---

## The native library

`deno task build:native` produces `native/`: the encrypted SQLite library
and the two FTS5 tokenizer extensions.

**It does not cross-compile.** It is a C library built by the host
toolchain, so each target's copy must be produced on that target — which is
why the release pipeline uses one runner per platform rather than
cross-compiling everything from one machine.

The build verifies the SQLite3MultipleCiphers amalgamation against a pinned
SHA-256 before compiling, and then smoke-tests that encryption is active and
that full-text search returns results before reporting success. A release
whose native step passed has actually exercised the encrypted database.

---

## Building locally

```bash
deno task build:native
deno task build:ui

deno task build              # this platform, default format
deno task build:appimage
deno task build:deb
deno task build:rpm
deno task build:windows
deno task build:msi
deno task checksums          # SHA256SUMS over the output directory
```

Flatpak and Arch use their own tooling:

```bash
flatpak-builder --force-clean --repo=repo build-dir \
    packaging/flatpak/org.openotes.Openotes.yml
flatpak build-bundle repo Openotes-1.0.0-linux-x86_64.flatpak org.openotes.Openotes

cd packaging/arch && makepkg
```

---

## Workflows

### `test.yml` — every pull request and push

```
setup Deno → fmt --check → lint → check → unit tests
           → WebDAV integration tests (real server, in a container)
           → interface tests
           → forbidden-dependency check
           → build smoke test
```

The forbidden-dependency check fails the build if `electron`,
`electron-builder`, `electron-updater`, `electron-trpc` or `react-native`
reappear in the dependency tree.

The integration tests run against a real WebDAV server as a service
container. **A missing server is a failure, not a skip** — an integration
job that quietly did nothing must not look like a passing one.

### `build.yml` — matrix build

Builds every artifact for Linux and Windows on their native runners and
uploads them as workflow artifacts. Flatpak builds with `flatpak-builder`;
the Arch package builds with `makepkg` in an `archlinux` container. ARM64
Linux where the format supports it reliably.

### `release.yml` — on a `v*` tag

```
tests (all of them)
   ↓  nothing is published if any of them fail
Windows build      Linux builds
   ↓                   ↓
distribution packaging (flatpak, Arch)
   ↓
SHA256SUMS
   ↓
GitHub Release with every artifact attached
```

---

## Code signing

Windows Authenticode signing is **optional**, and deliberately so: a fork
must be able to build without private certificates. The signing step runs
only when the signing secrets exist, and is skipped otherwise, so the build
succeeds either way.

Signing secrets are never exposed to pull requests from forks.

An unsigned Windows build shows a SmartScreen warning on first run. That is
expected for an unsigned application and not a defect in the build.

Android is different in one way: an APK cannot be unsigned at all, so the
build always signs. With `ANDROID_SIGNING_KEYSTORE` (a base64-encoded `.jks`
or `.p12`), `ANDROID_SIGNING_KEYSTORE_PASSWORD`, `ANDROID_SIGNING_KEY_ALIAS`
and `ANDROID_SIGNING_KEY_PASSWORD` configured, it signs with that key and
each release installs over the previous one. Without them it signs with a
key generated for that build and thrown away; the APK installs, but Android
treats the next release as a different app until the old one is removed. The
release notes say which of the two happened. To make a keystore:

```sh
keytool -genkeypair -keystore openotes-release.jks -alias openotes \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 openotes-release.jks   # the value of ANDROID_SIGNING_KEYSTORE
```

---

## Verifying a package before release

```bash
# Debian
dpkg-deb --info Openotes-1.0.0-linux-x86_64.deb
dpkg-deb --contents Openotes-1.0.0-linux-x86_64.deb

# RPM
rpm -qip Openotes-1.0.0-linux-x86_64.rpm
rpm -qlp Openotes-1.0.0-linux-x86_64.rpm

# Arch
bsdtar -tf openotes-1.0.0-1-x86_64.pkg.tar.zst

# AppImage
chmod +x Openotes-1.0.0-linux-x86_64.AppImage
./Openotes-1.0.0-linux-x86_64.AppImage --version

# Desktop entry and AppStream metadata
desktop-file-validate packaging/linux/openotes.desktop
appstream-util validate-relax packaging/flatpak/org.openotes.Openotes.metainfo.xml
```

Each package must install the executable, the desktop entry, the icons and
the metadata — and the CI smoke test confirms the installed application
actually starts, opens its window, serves the interface and opens a local
vault.

---

## Supply chain

- Actions are pinned to major versions; the official Deno setup action is
  used.
- No build script is downloaded from an arbitrary URL and executed.
- External build inputs are checksum-verified: the SQLite amalgamation
  against a pinned hash that fails the build if upstream changes it, and the
  WebDAV test server likewise, with CI refusing to run an unverified binary.
- Final distribution happens through GitHub release artifacts.
- Signing secrets are never exposed to fork pull requests.
- An SBOM is generated where practical.

---

## Auto-update

Update metadata lives at the release base URL configured in
`apps/desktop/src/constants.ts` and points at this fork's releases. **The
Notesnook update servers are never contacted.**

Each entry identifies the version, platform, architecture, asset URL and
SHA-256, with an optional signature. A downloaded artifact is verified
against that hash and deleted if it does not match, before anything is done
with it.

Package-manager installations (deb, rpm, pacman, flatpak, snap) are never
self-updated — replacing a managed binary behind the package manager's back
corrupts the installation. Those builds check and tell you; the package
manager applies the update. AppImage and the portable Windows build are the
two cases that can update in place.
