<p align="center">
<img style="align:center;" src="./resources/icon.png" alt="Notesnook Logo" width="100" />
</p>

<h1 align="center">Notesnook</h1>
<h3 align="center">An end-to-end encrypted note taking alternative to Evernote.</h3>
<p align="center">
<a href="https://notesnook.com/">Website</a> | <a href="https://notesnook.com/about">About us</a> | <a href="https://notesnook.com/roadmap">Roadmap</a> | <a href="https://notesnook.com/downloads">Downloads</a> | <a href="https://twitter.com/@notesnook">Twitter</a> | <a href="https://discord.gg/5davZnhw3V">Discord</a>
</p>

## Overview

Notesnook is a free (as in speech) & open-source note-taking app focused on user privacy & ease of use. To ensure zero knowledge principles, Notesnook encrypts everything on your device using `XChaCha20-Poly1305` & `Argon2`.

Notesnook is our **proof** that privacy does _not_ (always) have to come at the cost of convenience. We aim to provide users peace of mind & 100% confidence that their notes are safe and secure. The decision to go fully open source is one of the most crucial steps towards that.

This repository is a desktop-only fork of [Notesnook](https://github.com/streetwriters/notesnook). It contains all the code required to build & use the desktop client. The mobile, hosted-web and cloud-service projects of the upstream repository are not part of this fork. If you are looking for a full feature list or screenshots of upstream Notesnook, please check the [website](https://notesnook.com/).

## Developer guide

### Technologies & languages

Notesnook is built using the following technologies:

1. JavaScript/Typescript — this repo is in a hybrid state. A lot of the newer code is being written in Typescript & the old code is slowly being ported over.
2. React — the front-end is built using React.
3. Deno — the desktop host process is a Deno program driving the operating system's native webview.
4. NPM — only as a build-time dependency, to install the dependencies of the web UI bundle & the shared packages.

> **Note: Each project in the monorepo contains its own architecture details which you can refer to.**

### Monorepo structure

| Name                        | Path                                               | Description                                                         |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- |
| `@notesnook/web`            | [/apps/web](/apps/web)                             | The UI bundle served inside the desktop webview                     |
| `@notesnook/desktop`        | [/apps/desktop](/apps/desktop)                     | Desktop host process (Deno + native webview)                        |
| `@notesnook/core`           | [/packages/core](/packages/core)                   | Shared core: database, collections, sync & backup primitives        |
| `@notesnook/common`         | [/packages/common](/packages/common)               | Shared helpers between the core and the clients                     |
| `@notesnook/crypto`         | [/packages/crypto](/packages/crypto)               | Cryptography library wrapper around libsodium                       |
| `@notesnook/editor`         | [/packages/editor](/packages/editor)               | Notesnook editor + all extensions                                   |
| `@notesnook/intl`           | [/packages/intl](/packages/intl)                   | Translated strings & the Lingui setup around them                   |
| `@notesnook/logger`         | [/packages/logger](/packages/logger)               | Simple & pluggable logger                                           |
| `@notesnook/sodium`         | [/packages/sodium](/packages/sodium)               | Wrapper around libsodium to support Node.js & Browser               |
| `@notesnook/streamable-fs`  | [/packages/streamable-fs](/packages/streamable-fs) | Streaming interface around an IndexedDB based file system           |
| `@notesnook/sync-webdav`    | [/packages/sync-webdav](/packages/sync-webdav)     | Encrypted WebDAV sync & backup engine used instead of cloud sync    |
| `@notesnook/theme`          | [/packages/theme](/packages/theme)                 | The core theme used by the client                                   |
| `@notesnook/ui`             | [/packages/ui](/packages/ui)                       | Shared low-level UI components                                      |

### Contributing guidelines

If you are interested in contributing to Notesnook, I highly recommend checking out the [contributing guidelines](/CONTRIBUTING.md). You'll find all the relevant information such as [style guideline](/CONTRIBUTING.md#style-guidelines), [how to make a PR](/CONTRIBUTING.md#opening--submitting-a-pull-request), [how to commit](/CONTRIBUTING.md#commit-guidelines) etc., there.

### Support & help

You can reach out to us via:

1. [Email](mailto:support@streetwriters.co)
2. [Discord](https://discord.gg/5davZnhw3V)
3. [Twitter](https://twitter.com/notesnook)
4. [Create an issue](https://github.com/streetwriters/notesnook/issues/new)

We take all queries, issues and bug reports that you might have. Feel free to ask.

## Additional Resources

- [Migrating & Importing your data from other apps — Importer](https://notesnook.com/help/importing-notes)
- [Privacy policy](https://notesnook.com/privacy) & [Terms of service](https://notesnook.com/terms)
