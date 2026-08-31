# WebDAV synchronization and backup

This document specifies the protocol Openotes uses to synchronize a vault
between devices over an ordinary WebDAV server, and the separate format it
uses for backups. It is the reference for anyone implementing a compatible
client, auditing the encryption, or debugging a sync problem.

Implementation: [`packages/sync-webdav`](packages/sync-webdav).

---

## 1. Design constraints

A WebDAV server is a filesystem with HTTP verbs. It has no transactions, no
reliable cross-client locking, no server-side logic, and wildly varying
support for the optional parts of the specification. The protocol is shaped
by that reality:

| Constraint | Consequence |
|---|---|
| No reliable locking | No shared mutable file. Each device writes only into its own directory. |
| No transactions | Every remote object is immutable once written. Nothing is ever edited in place. |
| Servers differ | Only the universally implemented verbs are required; everything optional has a fallback. |
| The server is untrusted | Everything content-bearing is encrypted client-side. The server sees sizes and timings, nothing else. |
| Networks fail mid-operation | A local change is only marked synchronized after its remote object has been verified. |

The protocol is **append-only journals plus per-device cursors**. There is no
central index to corrupt and no lock to lose.

---

## 2. Remote layout

Everything lives under the directory the user configures (default
`Openotes/`):

```
<directory>/
├── protocol.json                      plaintext metadata + key check
├── devices/
│   ├── <DEVICE_ID>/
│   │   ├── device.json                encrypted device descriptor
│   │   └── changes/
│   │       ├── 0000000001.bin         immutable encrypted change batch
│   │       ├── 0000000002.bin
│   │       └── ...
│   └── <OTHER_DEVICE_ID>/
│       └── changes/
├── objects/
│   └── <hash>.bin                     oversized record payloads
├── attachments/
│   └── <hash>.bin                     encrypted attachment content
└── backups/
    └── 2026-08-31T120000Z.backup.enc  encrypted snapshots
```

A device id is 16 characters from `A-Z2-7`, generated from random bytes on
first run. It identifies a *vault profile on a machine*, carries no
information about the machine or the user, and never leaves the device
except as a directory name.

**No filename is derived from plaintext.** Object and attachment names are
keyed BLAKE2b digests (§5), so the server cannot tell that two accounts hold
the same file, and a directory listing reveals nothing about note titles.

---

## 3. `protocol.json`

The only plaintext file. It exists so a client can decide whether it may
safely write *before* it writes anything.

```json
{
  "protocol": "notesnook-webdav-sync",
  "version": 1,
  "salt": "<base64 argon2 salt>",
  "keyCheck": { "format": "base64", "alg": "...", "cipher": "...", "iv": "...", "salt": "...", "length": 41 },
  "createdAt": 1756636800000,
  "createdBy": "ABCDEFGH12345678",
  "generation": "ABCDEFGH1a2b3c4d5e6f"
}
```

| Field | Purpose |
|---|---|
| `protocol` | Refuses to write into a directory holding another application's data. |
| `version` | A client that reads a **higher** version refuses to write and explains why. Reading a lower version is allowed. |
| `salt` | The argon2 salt, so a second device with the same passphrase derives the same keys. Public by design; a salt is not a secret. |
| `keyCheck` | A fixed string encrypted with the sync key. Lets a client detect a wrong passphrase before uploading anything encrypted under the wrong key. |
| `generation` | Changes when the repository is rebuilt (§9). A client whose cursors refer to an older generation resets them instead of skipping records. |

Creation uses `If-None-Match: *` so two devices setting up simultaneously
cannot clobber each other; the loser adopts the winner's repository.

---

## 4. Change records and journals

A change record describes one change to one entity:

```ts
interface SyncRecord {
  entityId: string;      // note id, notebook id, ...
  entityType: string;    // "notes" | "notebooks" | "tags" | "content" | ...
  operation: "upsert" | "delete";
  revision: number;      // monotonic per entity (dateModified in practice)
  timestamp: number;     // ms since epoch
  item?: unknown;        // the full item, or the tombstone for a delete
  objectRef?: string;    // set instead of `item` for oversized payloads
}
```

Records are grouped into **batches**, one per sync cycle, and written to
`devices/<id>/changes/<sequence>.bin` where `<sequence>` is a zero-padded
10-digit number that increases monotonically per device. Each file is:

```json
{
  "protocolVersion": 1,
  "deviceId": "ABCDEFGH12345678",
  "sequence": 42,
  "cipher": { "format": "base64", "alg": "...", "cipher": "...", "iv": "...", "salt": "...", "length": 1234 }
}
```

The envelope is plaintext so a client can validate routing without a key;
the records themselves are inside `cipher`.

**Journal entries are immutable.** A write that would land on an existing
sequence is refused and the writer advances to the next free one. This is
enforced twice, because servers differ: `If-None-Match: *` (a conforming
server answers 412) *and* an explicit existence check first, because some
servers — dufs among them, as the integration suite demonstrates — accept
the header and ignore it. Without the second check, a crash that lost the
locally persisted sequence number would silently overwrite a published
entry.

Each client stores a cursor per remote device: the highest sequence it has
applied. Synchronizing means "list each device's journal, read what is past
my cursor, apply it, advance the cursor". Cursors are device-local and never
roam.

Payloads larger than 256 KB are stored as content-addressed objects under
`objects/` and referenced by `objectRef`, keeping journal entries small and
deduplicating repeated blobs.

---

## 5. Encryption

Openotes reuses Notesnook's audited crypto package rather than inventing
new cryptography. Primitives come from libsodium:

| Purpose | Primitive |
|---|---|
| Key derivation from the passphrase | argon2 (`crypto_pwhash`) |
| Subkey derivation | keyed BLAKE2b (`crypto_generichash`) |
| Record and object encryption | XChaCha20-Poly1305 (AEAD) |
| Attachment streaming | XChaCha20-Poly1305 secretstream |
| Content addressing | keyed BLAKE2b |
| Backup integrity | SHA-256 over the plaintext, checked after decryption |

### Key hierarchy

```
        sync passphrase
              │  argon2 (salt from protocol.json)
              ▼
         master key
              ├── BLAKE2b("nn-sync-v1")        → sync key
              ├── BLAKE2b("nn-attachment-v1")  → attachment key
              ├── BLAKE2b("nn-backup-v1")      → backup key
              └── BLAKE2b("nn-database-v1")    → database key
```

The master key exists only in memory. Only the salt is stored remotely, and
only the derived subkeys are ever used to encrypt anything, so compromising
one purpose does not compromise another.

**The server never receives a key.** It cannot decrypt notes, attachments or
backups, and the WebDAV password is unrelated to the encryption passphrase —
losing the passphrase means the remote data is unrecoverable, which the UI
states plainly when the passphrase is set.

### What the server can still see

Honesty about the limits: an operator can observe how many objects exist,
their sizes, when they were written, how many devices you have, and how
often you sync. Object and attachment names are keyed digests, so identical
content produces identical names *within one vault* — that is what makes
deduplication work, and it means an operator can tell that two of your notes
reference the same attachment. It does not let them correlate across vaults,
because the digest is keyed with your sync key.

---

## 6. The synchronization cycle

1. Verify connectivity (`OPTIONS`).
2. Read `protocol.json`; refuse a newer protocol version.
3. Verify the passphrase against `keyCheck` before writing anything.
4. List device directories.
5. For each remote device, list sequences past our cursor.
6. Download each unseen batch, validate the envelope, decrypt.
7. Apply each record (§7); advance the cursor only after the whole batch
   applied.
8. Collect local changes (rows whose `synced` flag is clear) and merge them
   into the durable outgoing queue.
9. Upload attachments referenced by those changes.
10. Spill oversized payloads into `objects/`.
11. Write one immutable batch at the next free sequence.
12. **Verify the remote object exists and has the expected length.**
13. Only now mark the local rows synchronized and clear the queue.
14. Update the status the UI displays.

Step 12 before step 13 is the rule that prevents silent data loss: a change
is never considered synchronized on the strength of a request that appeared
to succeed.

A cycle never runs twice concurrently for one vault. Edits schedule a
debounced cycle rather than one cycle per keystroke.

---

## 7. Conflicts

Conflicts are expected, and the governing rule is that **no user content is
ever silently discarded**.

| Situation | Resolution |
|---|---|
| Item absent locally | Apply the remote version. |
| Remote delete, no local edits | Apply the tombstone. |
| Remote delete, unsynced local edits | Keep the local edit and raise a conflict — the user decides. |
| Remote update of a locally deleted item | Apply only if strictly newer; otherwise ignore, so a stale device cannot resurrect a deleted note. |
| Remote revision older than local | Keep local. |
| Remote newer, no local edits | Apply the remote version. |
| Remote newer, local edits, identical content | Apply the remote version (the same edit, made twice). |
| Remote newer, local edits, different content | Preserve both. |

"Preserve both" means, for note content, setting the `conflicted` column
that Notesnook's editor already surfaces as a side-by-side resolution view.
For other entity types it means keeping the local row as a conflict copy
titled like `Shopping List (conflict)` and applying the remote version to
the original. Either way the user is told.

Deletions always use tombstones, never bare removal, so a device that has
been offline for a month cannot bring deleted notes back.

---

## 8. Attachments

Attachments are content-addressed: `attachments/<keyed-digest>.bin`.

- Deduplicated — a file already present under the same digest is not
  re-uploaded.
- Encrypted with the attachment key, streamed with libsodium's secretstream
  in 512 KB chunks, so a large file never has to fit in memory. Wire format
  is a length-prefixed header followed by length-prefixed chunks.
- Integrity is checked on download by recomputing the digest.
- Unreferenced remote objects are removed only after a conservative
  retention period (30 days by default), and only when the server reports a
  last-modified time old enough to prove it. An object whose age cannot be
  established is kept.

---

## 9. Rebuilding the repository

`Settings → Synchronization → Advanced → Rebuild WebDAV repository`
replaces the remote state with a fresh export of local data. It requires
explicit confirmation, and it never deletes the only good copy before a
replacement exists:

1. Build the new generation under a staging prefix.
2. Write every record into it.
3. Verify the staged generation is readable.
4. Move the previous generation aside into `.retired-<timestamp>`.
5. Move the staged generation into place.

Other devices notice the changed `generation` in `protocol.json` and reset
their cursors, so they re-read the new state rather than skipping it.

---

## 10. Server compatibility

Required verbs: `OPTIONS`, `PROPFIND`, `MKCOL`, `GET`, `PUT`, `DELETE`,
`HEAD`. `MOVE` is used when available and falls back to copy-then-delete.

Optional features are used when present and worked around when not:

| Feature | If unsupported |
|---|---|
| `If-None-Match` | An existence check before the write covers it. |
| `ETag` | Only used opportunistically; nothing depends on it. |
| `getcontentlength` in PROPFIND | Upload verification checks existence only. |
| Absolute vs relative hrefs | Both are parsed. |
| Namespace prefixes (`D:`, `d:`, `lp1:`, none) | Parsed by local element name. |
| `MKCOL` on an existing collection | 405 and 409 both treated as success after probing. |

Tested against dufs in CI, and written against the observed behaviour of
Nextcloud/sabre, ownCloud, Apache `mod_dav` and nginx.

**Nextcloud is not special-cased.** No server-specific code paths exist;
every accommodation above is generic.

### HTTPS

HTTPS is the default and plain HTTP is refused unless the user explicitly
enables it for a trusted local network, with a warning. TLS certificate
errors are never ignored, and there is no global "disable TLS verification"
switch.

---

## 11. Errors and retries

| HTTP | Meaning to the client |
|---|---|
| 401 | Wrong WebDAV credentials. Not retried. |
| 403 | Access denied by the server. Not retried. |
| 404 / 410 | Not found. Often normal (an empty remote). |
| 409 | Missing parent collection. Created and retried. |
| 412 | The object already exists; advance to the next sequence. |
| 423 | Locked. Not retried. |
| 429, 5xx | Retried with exponential backoff, up to the configured limit. |
| Timeout / network | Retried, then reported as offline. |

A WebDAV failure never reaches the editor. Local changes stay in a durable
queue that survives restarts and drains when the server returns. A corrupt
or unreadable change record is skipped and reported rather than wedging
every subsequent sync.

---

## 12. Backups are not synchronization

Backups are a **separate subsystem** (spec §14) and deliberately share
nothing with sync but the key hierarchy.

| | Synchronization | Backup |
|---|---|---|
| Frequency | Continuous | Scheduled or manual |
| Shape | Incremental change records | Whole-state snapshot |
| Mutability | Append-only journal | Immutable, timestamped |
| Purpose | Multi-device convergence | Disaster recovery |
| Deleting a note | Propagates the deletion | **Never touches existing backups** |

A backup file is `<timestamp>Z.backup.enc`, holding a plaintext manifest and
an encrypted payload:

```json
{
  "manifest": {
    "format": 1,
    "app": "Openotes",
    "appVersion": "1.0.0",
    "createdAt": 1756636800000,
    "deviceId": "ABCDEFGH12345678",
    "contentHash": "<sha256 of the plaintext payload>",
    "contentLength": 1048576,
    "counts": { "notes": 412, "notebooks": 9 },
    "attachments": 37,
    "encrypted": true
  },
  "payload": { "format": "base64", "alg": "...", "cipher": "...", "iv": "...", "salt": "...", "length": 1048576 }
}
```

The manifest lets the restore UI show what a snapshot contains before
committing to it. `contentHash` is verified after decryption, so a corrupt
backup is refused rather than half-restored.

Retention deletes the oldest snapshots per target, and only when a retention
count is configured. Restore takes a verified safety backup of the current
state first, runs in a single transaction, rolls back intact on any failure,
and validates the database afterwards.

---

## 13. What roams and what does not

Synchronized: notes, notebooks, tags, colors, relations, reminders,
attachments (metadata and content), note content, shortcuts, vaults,
settings classified as syncable, and tombstones for all of them.

Device-local, never synchronized: window size and position, render
preferences, the local backup path, sync cursors, the device id, WebDAV
credentials, and the last open window.

---

## 14. Protocol versioning

The current version is **1**.

A client reading a repository with a higher version number refuses to write
and explains why, because writing version-1 records into a version-2
repository could corrupt it. Reading is still attempted so the user can see
their data.

Future changes that alter how existing objects are interpreted will bump the
version and ship an explicit migration; new optional fields that older
clients can ignore will not.
