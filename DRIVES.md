# Syncing to a cloud drive

Openotes syncs to Google Drive, Dropbox and OneDrive directly, to Koofr,
pCloud and Nextcloud through WebDAV, as well as to any other WebDAV
server. This describes what it writes, what it can promise, and what it cannot.

---

## Choosing one

`Settings → Synchronization → Sync through`. Pick Google Drive, Dropbox or
OneDrive and the panel below it walks through registering an application in that
provider's own console — Openotes registers none of its own, so there is no
shared client id for a provider to revoke and the scopes can be the narrow ones
that reach only files Openotes created.

Sign-in happens in your own browser, not in a window Openotes draws: a webview
cannot be trusted by you to be showing the real Google, and it would not carry
the session you already have.

> **Currently encrypted only.** The readable-Markdown format below is
> implemented and tested, but nothing in the application constructs its engine
> yet, so a drive today holds the same encrypted journal a WebDAV server would.
> The section that follows describes where this is going.

---

## Two remote formats, and why the default is the readable one

**Readable Markdown (the default).** One `.md` file per note, in a folder that
mirrors your notebooks:

```
Openotes/
  Work/Q3 plan.md
  Personal/Reading list.md
  attachments/<hash>-photo.png
  .openotes/conflicts/
```

Each file opens on a phone, in Obsidian, in Drive's own preview, or in any text
editor. Front matter carries the note's id, dates, tags and colour, so a file
that is moved, renamed or restored from a backup still binds to the right note.

**The provider can read these notes.** That is the trade, and it is stated at
the point where you choose.

**Encrypted (opt-in).** The same protocol with the bytes and the names replaced:

```
Openotes/
  notes/3f8a1c02.bin
  notes/9b4d77e1.bin
```

Content is XChaCha20-encrypted with a key derived from your sync passphrase.
Filenames are keyed BLAKE2b digests of the note id, so the _title_ and the
_notebook structure_ are hidden too — a folder listing that reads
`Legal/Divorce paperwork.md` has already told the provider most of what matters.
Because the name is keyed on the id rather than the title, retitling a note does
not move its file, so even a rename is not observable.

The cost is that nothing outside Openotes can read the folder, including you.

Switching modes rewrites every file. Openotes treats it as a rebuild rather than
pretending it is cheap.

---

## What is never written in plaintext

**Locked notes.** A note in the vault is not exported without an unlocked vault,
and the sync path does not offer to unlock one. In readable mode locked notes
are skipped entirely and the skipped count is shown — not silently omitted,
because a note quietly missing from a backup is worse than one you know is
missing.

---

## How conflicts are handled

Sync compares three things: what is here, what is on the server, and what was
there the last time the two agreed. Comparing against that remembered base means
the answer never depends on a clock — device clocks drift, and Drive reports
server time, so "newest wins" silently destroys work.

- Only one side changed → that change is applied.
- Both sides changed to the same content → nothing to do.
- Both sides changed differently → **both are kept.** Yours stays as the note;
  theirs is copied to `.openotes/conflicts/` and also appears in Openotes so you
  can see it without going hunting in the folder.
- One side deleted while the other edited → the **edit wins**, and you are told.
  An edit exists nowhere else; a delete is easy to repeat.

The rule underneath all of it: never silently discard content.

---

## What each provider can actually promise

Two operations carry the whole correctness argument — creating a file only if it
does not exist, and overwriting only if nobody else changed it first.

|                  | create-if-absent                   | compare-and-swap         | change detection         |
| ---------------- | ---------------------------------- | ------------------------ | ------------------------ |
| **Dropbox**      | yes, native                        | yes, native (`rev`)      | delta cursor + long-poll |
| **OneDrive**     | yes, native                        | yes, native (`if-match`) | delta link               |
| **WebDAV**       | emulated (probe + `If-None-Match`) | yes (`If-Match`)         | listing                  |
| **Google Drive** | **no**                             | **no**                   | change feed              |

### Koofr, pCloud and Nextcloud go through WebDAV

These publish a WebDAV endpoint rather than an API of their own, so they use
the WebDAV row above — the same code path, with the same real-server
integration suite behind it, rather than a second implementation of
create-if-absent and compare-and-swap for each. The connection form offers
them as presets: picking one fills in the server URL and says which account
details that provider actually wants.

| Provider | Server | Account |
|---|---|---|
| Koofr | `https://app.koofr.net/dav/Koofr` | Email address, and an **app password** — the account password is refused |
| pCloud (US) | `https://webdav.pcloud.com` | Email address and account password |
| pCloud (EU) | `https://ewebdav.pcloud.com` | As above; EU accounts are rejected by the US host rather than redirected |
| Nextcloud / ownCloud | `https://<server>/remote.php/dav/files/<user>` | Username, and an app password if two-factor is on |

A preset only fills the server URL in. Any WebDAV server still works by typing
its URL, and nothing here is required.


### Google Drive is the weakest, and here is exactly why

Drive lets two files share a name in the same folder, and Drive API v3 dropped
conditional update. So neither operation exists, and Openotes emulates both with
a read, a write and a re-read. A second device writing in the same instant can
slip between those steps.

What happens when it does:

1. After creating a file, Openotes looks again. If two files now share the name,
   the one that lost **deletes the file it created** — the one whose id it knows
   — and retries. The winner's file is never touched.
2. An update whose revision moved underneath it becomes a conflict copy rather
   than an overwrite.
3. Deletes move to Drive's bin rather than destroying, and Drive keeps revision
   history. On the backend that cannot promise atomicity, a mistake stays
   recoverable by hand.

Dropbox and OneDrive need none of this. If you have a choice and you care about
the guarantee, prefer one of them.

---

## Connecting an account

Settings → Sync, choose a provider, and sign in through your browser. Openotes
uses the standard authorization-code flow with PKCE and a loopback redirect; the
page you land on is served by Openotes itself on `127.0.0.1` and closes after
one request.

**Access tokens never reach the interface, and are never written down.** The
runtime keeps them in memory only: they last about an hour, a restart costs one
refresh, and storing them would widen what a stolen data directory is worth for
nothing. The _refresh_ token is what persists, in the encrypted credential store
beside the WebDAV password. The note-editing half of the application is only
ever told whether an account is connected and which one.

**Scopes are the narrowest that work:** Drive uses `drive.file`, which grants
access only to files Openotes itself created — it cannot see the rest of your
Drive. Dropbox and OneDrive use their app-folder equivalents.

### Your own OAuth application is not optional

Openotes ships no client ids. There is no Openotes OAuth application at any of
the three providers, so the provider picker asks you for a client id before it
will let you sign in, and the panel beside it lists the exact steps for that
provider's console.

This is a deliberate trade. A shipped client id would make connecting a drive
one click instead of ten minutes — but it would also be a single credential
every installation shares, revocable by the provider, rate-limited across every
user at once, and an entry in a consent screen naming a project you have no
relationship with. A client id you registered is yours: it can be revoked by you
alone, its quota is yours, and the consent screen names you.

Installed-app client ids are public by design — they are embedded in every copy
of a binary, and PKCE exists precisely because they cannot be kept secret — so
there is nothing sensitive about the one you paste in. Google additionally
issues a "client secret" for installed apps while documenting that it is not
treated as confidential; the panel asks for it because Google refuses the token
exchange without it. Dropbox and OneDrive need only the id.

---

## Troubleshooting

**"This account is no longer connected."** The refresh token was revoked or
expired. Signing in again restores it; nothing local is lost.

**A note appears twice in Drive.** Two devices created it in the same instant
and Drive allowed both. Openotes resolves this on the next sync by keeping the
one every device agrees on. Delete the other if it lingers.

**Conflict copies you did not expect.** Most often two devices were both offline
and both edited. If it happens constantly, check that the devices agree on the
same folder and, on OneDrive, that nothing else is rewriting the files.

**Nothing syncs and there is no error.** Check whether the notes are in the
vault — locked notes are skipped by design, and the count is shown in the sync
status.
