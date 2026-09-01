# Security

This document states what Openotes protects, how, and — just as
importantly — what it does not protect against. Vague reassurance is worse
than a stated limitation, so the limitations are stated.

Openotes is a fork of [Notesnook](https://github.com/streetwriters/notesnook)
and reuses its cryptographic components rather than inventing new ones.

---

## Reporting a vulnerability

Open a [security advisory](https://github.com/yuvalkolodkingal/notesnook/security/advisories/new)
on this repository. Please do not open a public issue for an unfixed
vulnerability.

Vulnerabilities in upstream Notesnook components should also be reported to
the upstream project, which maintains them.

---

## 1. Threat model

### Protected against

| Threat | How |
|---|---|
| A WebDAV operator reading your notes | Everything content-bearing is encrypted client-side; the server never receives a key. |
| A WebDAV operator learning note titles from filenames | Object and attachment names are keyed BLAKE2b digests. No filename derives from plaintext. |
| Someone who steals the device's disk image | The vault database is encrypted at rest; stored credentials are encrypted; the master key exists only in memory. |
| A network attacker | HTTPS by default. TLS errors are never ignored and there is no way to disable verification. |
| A malicious note (imported HTML, an embedded page) | The renderer has no filesystem, shell or network capability. It can only call an allowlisted set of validated procedures — including the AI ones: it names an agent by catalog id and can never supply a command line. |
| An AI agent reading a locked note | The export path refuses to render a vault note without an unlocked vault, and the agent path does not offer to unlock one. |
| An AI agent running shell commands through Openotes | The client advertises `terminal: false` at the handshake, and no terminal method is implemented. |
| A cloud drive access token leaking to a compromised renderer | Tokens are held by the runtime in the encrypted credential store. The renderer is told only whether an account is connected, and which one. |
| A tampered update | Updates are checked against this fork's own releases and verified by SHA-256 before anything is done with them. |
| A stale device resurrecting deleted notes | Deletions are tombstones and are ordered by revision. |
| Silent data loss during sync | A change is only marked synchronized after its remote object is verified present and the right size. |

### Not protected against

| Threat | Why not |
|---|---|
| Malware running as your user account | It can read the process memory that holds the master key while the vault is unlocked. No application-level defence is meaningful here. |
| Someone with your sync passphrase | It is the root of the key hierarchy. There is no recovery path, by design. |
| A WebDAV operator observing metadata | Object count, sizes, write times, device count and sync frequency are visible. Encryption hides content, not traffic patterns. |
| A WebDAV operator deleting or withholding data | The protocol detects corruption and refuses to act on it, but a server can still lose your data. Keep backups. |
| An attacker with filesystem read access, when "remember without unlocking" is enabled | See §4 — this mode's key is derived from a file that same attacker can read. It is opt-in and the trade-off is stated in the UI. |
| Evil-maid attacks on an unlocked machine | Out of scope for a notes application. |
| What an approved AI agent does once running | An agent is a separate program running with your privileges. Openotes chooses whether to start it and answers its note requests; it cannot constrain what it does otherwise. Approving one is as consequential as installing one. See §10. |
| A cloud provider reading notes synced in readable mode | Readable mode is plaintext by design — that is what makes the folder openable on a phone. Encryption is one setting away, and the choice is stated where it is made. |
| A cloud provider observing that you use Openotes | Even in encrypted mode the folder name and the shape of the traffic are visible. |

---

## 2. Cryptography

Primitives come from libsodium via the upstream `@notesnook/crypto` package.
No new cryptographic construction was invented for this fork.

| Purpose | Primitive |
|---|---|
| Passphrase → master key | argon2 (`crypto_pwhash`) |
| Master key → subkeys | keyed BLAKE2b (`crypto_generichash`) |
| Records, objects, backups | XChaCha20-Poly1305 (AEAD) |
| Attachment streaming | XChaCha20-Poly1305 secretstream |
| Content addressing | keyed BLAKE2b |
| Stored credentials | AES-256-GCM, key from PBKDF2-SHA-256 (600,000 iterations) |
| Database at rest | SQLite3MultipleCiphers |
| Renderer key material at rest | `keystore.json`, `0600`, holding keys the renderer itself wrapped |
| Backup integrity | SHA-256 over the plaintext, checked after decryption |

### Key hierarchy

```
        sync passphrase
              │  argon2
              ▼
         master key            (memory only, never written to disk)
              ├── sync key        BLAKE2b("nn-sync-v1")
              ├── attachment key  BLAKE2b("nn-attachment-v1")
              ├── backup key      BLAKE2b("nn-backup-v1")
              └── database key    BLAKE2b("nn-database-v1")
```

Only the argon2 salt is stored remotely — a salt is not a secret, and it is
what lets a second device with the same passphrase derive the same keys.
Compromising one subkey does not compromise the others.

### Authenticated encryption everywhere

Every ciphertext is authenticated. Tampering is detected and rejected rather
than producing garbage plaintext. Backups additionally carry a SHA-256 of
the plaintext that is checked after decryption, so a corrupt backup is
refused before anything is restored.

---

## 3. The renderer boundary

The React interface renders untrusted content. It is treated accordingly.

The renderer reaches the runtime through exactly two bindings: a call
(`bindings.rpc`) and an event channel. Every call names a procedure from a
fixed allowlist
([`apps/desktop/src/rpc/protocol.ts`](apps/desktop/src/rpc/protocol.ts));
anything else is rejected before a handler is looked up. Each handler
validates its own input.

There is deliberately **no** `executeShell`, `readAnyFile`, or
`runArbitraryCode` binding.

Concretely:

- **Paths.** Every renderer-supplied path is resolved — symlinks included —
  and asserted to be inside the app data directory, the backup directory
  the user chose, or Documents. A path outside those is refused.
- **Links.** Only `http`, `https` and `mailto` open externally. A note
  cannot launch a `file://` or custom-scheme handler.
- **Subprocesses.** Used only for file-manager, notification and clipboard
  fallbacks, always with a fixed argument vector, never a shell string.
- **Database.** The renderer cannot supply or re-read a database key;
  `PRAGMA key`/`rekey` from the renderer is rejected outright.
- **Origin.** The UI is served over loopback with `nosniff`, `COOP` and
  `COEP`, from the built UI directory only.

---

## 4. Credential storage

The WebDAV password and sync passphrase are stored in `credentials.enc`,
encrypted with AES-256-GCM. The wrapping key is derived by PBKDF2 from one
of two sources:

**Vault passphrase (default).** Nothing on disk can decrypt the file without
the passphrase. Automatic synchronization requires an unlocked vault.

**Machine-local key (opt-in).** The key is derived from a random
per-installation secret stored `0600` in the app data directory, so
background sync works without unlocking. This protects a stolen backup, a
synced home directory, or a disk image. It does **not** protect against
someone who can already read your user account's files — they can read the
secret too. The setting says so where it is enabled.

There is no OS keychain integration. No reliable cross-platform Deno
keychain binding exists that would not mean granting a blanket subprocess
permission to shell out to platform tools, which is a worse trade. The
renderer's existing key-wrapping fallback covers the browser-side key store.

**The WebDAV password is never returned to the renderer** — not even to
repopulate its own settings form, which reads a `hasPassword` boolean
instead.

---

## 4a. Renderer storage

The interface cannot use `localStorage` or IndexedDB for anything durable:
the runtime assigns a different loopback port on every launch, so the page's
origin changes and its storage is orphaned (measured, not assumed). Durable
renderer storage is therefore served by the runtime, in two namespaces.

`keys` holds key material. It is written `0600`, through a temp file and a
rename so a crash cannot truncate it, and a damaged file is preserved for
recovery rather than replaced — losing it means losing the vault. It cannot
be read in bulk: a compromised renderer must ask for each key by name rather
than exfiltrating the store in one call.

`settings` holds ordinary preferences and is plain JSON, because they are
not secret and being readable makes them debuggable. The interface keeps
using its synchronous localStorage wrapper within a session; at boot the
runtime's copy is seeded into localStorage before anything reads it, and
every write is mirrored back (`utils/config-persistence.ts`), so
preferences survive the per-launch origin change without every consumer
becoming asynchronous.

Attachment content is served the same way, through the `attachments.*`
procedures into a chunked on-disk store (one directory per attachment hash
under `attachments/`, one file per chunk). The bytes arrive already
encrypted by the renderer's crypto worker — one secretstream frame per
chunk — so the runtime stores ciphertext it cannot read and never handles
an attachment key. Chunk and file names are validated against a strict
character set and canonical index form before any path is built; a name
that does not parse is refused before it touches the filesystem.

---

## 5. Logging

Logs default to `info` and are written to the cache directory.

Redaction happens at the point of writing, not as a post-processing step:
values are passed as a context object, and every value is scrubbed before
serialization. There is no "log the raw object" escape hatch.

Always redacted: note content and titles, passwords and passphrases,
encryption and recovery keys, ciphertext, authorization headers, anything
matching a `Basic`/`Bearer` credential wherever it appears, and credentials
embedded in URLs (query strings are stripped entirely, since some servers
carry tokens there).

`Help → Open log directory` shows exactly what is stored. Please skim a log
before attaching it to a bug report anyway.

---

## 6. Network behaviour

Openotes contacts exactly two kinds of host:

1. **The WebDAV server you configured** — for synchronization and backups.
2. **This fork's GitHub releases** — for update checks, only when update
   checking is enabled.

It never contacts Notesnook-operated infrastructure. There is no analytics,
no crash reporting, and no telemetry endpoint to configure —
`TELEMETRY_ENABLED = false` exists in the source as a greppable statement of
that fact. No note content is transmitted anywhere except to your own
WebDAV server, encrypted.

HTTPS is required. Plain HTTP must be enabled explicitly, carries a warning,
and is intended for trusted local networks and self-hosted servers. TLS
certificate errors are never silently ignored, and there is no global
"disable TLS verification" mode.

---

## 7. Supply chain

- Deno permissions are declared per task rather than granting blanket access
  (see [BUILDING.md](BUILDING.md)).
- The SQLite library is built from a **checksum-verified** upstream
  amalgamation; CI fails if the archive's SHA-256 ever changes.
- The FTS5 extensions are fetched from pinned npm versions and their hashes
  are logged at build time.
- The WebDAV test server used in CI is verified against a pinned SHA-256,
  and CI refuses to run an unverified binary.
- GitHub Actions are pinned to major versions and the official Deno setup
  action is used.
- Release signing secrets are never exposed to pull requests from forks, and
  signing is optional so a fork can build without certificates.
- Every release publishes `SHA256SUMS`.

---

## 8. Update integrity

Update metadata is fetched over HTTPS from this fork's releases. A
downloaded artifact is verified against the SHA-256 in the manifest and
deleted if it does not match — nothing is executed before that check.

Package-manager installations (deb, rpm, pacman, flatpak, snap) are never
self-updated; replacing a managed binary behind the package manager's back
corrupts the installation. Those builds check and tell you; the package
manager applies the update.

---

## 9. Data safety

Security is not only confidentiality. The following are treated as security
properties:

- A synchronized change is only marked synchronized after its remote object
  is verified present and correctly sized.
- Journal entries are immutable, enforced both by `If-None-Match` and by an
  existence check, because some servers accept the header and ignore it.
- Conflicts preserve both versions and tell the user. Nothing is silently
  discarded.
- A restore takes a verified safety backup first, runs in one transaction,
  rolls back with the previous data intact on failure, and validates the
  database afterwards.
- Rebuilding the remote repository stages and verifies the replacement
  before retiring the previous generation.
- A corrupt change record is skipped and reported rather than wedging every
  subsequent sync.
- A missing encryption library is a hard startup error, never a silent
  downgrade to an unencrypted database.

---

## 10. Running an AI agent

Openotes hosts agents over the Agent Client Protocol. Hosting one means
running one, and that is a real change to what this application guarantees.
It is stated here rather than left to be discovered.

**What changed.** The runtime's subprocess allowlist grew from twelve
OS-integration binaries (`xdg-open`, `notify-send`, and the like) to also
include agent launchers: `node`, `npx`, `deno`, `bun`, and the named agent
commands. It is still a fixed list in `deno.json`, never `run: true`.

**What is preserved.**

- The renderer still cannot spawn anything. It names a catalog id; the command
  line comes from `apps/desktop/src/acp/catalog.ts`. No procedure accepts a
  command, and a test asserts that connecting refuses any id not in the
  catalog.
- argv is always an array, never a shell string.
- A first launch needs explicit consent, recorded against the **resolved
  absolute path**. If the binary at that path is replaced, consent is asked
  for again — an agent that was swapped out is not the agent that was
  approved.
- The permitted-command list is duplicated in `catalog.ts` so that drift
  between it and the manifest fails a test rather than a user's launch.
- Agents get no terminal, and their sessions get a real but permanently empty
  workspace directory. Note reads are answered from the database; no note is
  ever written to disk for an agent.

**What is given up.** An approved agent is a program running with your
privileges, and Openotes cannot constrain what it does once started. The
interface says so before the first launch, naming the exact binary path.

**Credentials.** Openotes never sees an agent's model credentials. Signing in
happens in the agent's own CLI, in your browser, and the tokens live in that
agent's config directory.

---

## 11. Cloud drive accounts

OAuth uses the authorization-code flow with PKCE and a loopback redirect. The
listener binds `127.0.0.1` explicitly, opens before the browser does, serves
exactly one request and closes. `state` is compared before the authorization
code is exchanged, so a callback the user did not initiate is discarded
without the exchange happening at all.

Access and refresh tokens are held by the runtime in `credentials.enc`,
alongside the WebDAV password, and are never returned to the renderer.

Scopes are the narrowest that work: Google Drive uses `drive.file`, which
grants access only to files Openotes itself created and cannot see the rest of
the drive. Dropbox and OneDrive use their app-folder equivalents.

Client ids ship in the binary and are public by design — installed-app client
ids cannot be kept secret, which is why PKCE exists. Settings → Sync →
Advanced accepts your own, for forks, packagers, or anyone who would rather
not appear in Openotes' OAuth application.

---

## 12. Not impersonating Notesnook

This fork does not spoof, forge or otherwise claim a Notesnook Pro
subscription, and it does not contact Notesnook's servers. The hosted
subscription model is removed rather than circumvented, and locally
implemented equivalents are provided where they make sense. The application
name, identifier, icons, data directory, update endpoint and user agent are
all distinct from upstream.
