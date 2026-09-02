# Syncing through a database

Openotes can keep the synced copy of your notes in a Postgres database: one
you run, or one that Neon or Supabase hosts for you on a free tier. The phone
app syncs to the same database, which is what makes it the first backend that
reaches every device.

This describes what is written, what each host can promise, and what Openotes
does on your behalf when it creates the database.

---

## Why a database

Every sync backend has to promise two things: *create this only if it does not
exist* and *overwrite this only if nobody changed it first*. WebDAV emulates the
first with a probe; Google Drive has neither. A Postgres table has both as
ordinary features — a primary key makes a duplicate create fail, and
`UPDATE … WHERE version = $expected` is compare-and-swap — which puts it in the
same class as Dropbox and S3, and above WebDAV, as a place to keep notes.

It is also reachable over plain HTTPS. Neon publishes an endpoint that runs SQL
from a `fetch`; Supabase publishes a REST API over its tables. Neither needs a
socket, which is why the phone app can use them and cannot use a plain
Postgres or a WebDAV server.

---

## What the database holds

One table, `openotes_objects`:

| Column      | What                                                      |
| ----------- | --------------------------------------------------------- |
| `path`      | The repository path, e.g. `Openotes/devices/AB12/changes/0000000001.bin` |
| `body`      | The bytes — always ciphertext                             |
| `version`   | Changes on every write; compared for equality only        |
| `size`      | For verifying an upload landed whole                      |
| `modified_at` | When                                                    |

It is the same encrypted journal a WebDAV server holds (see
[WEBDAV.md](WEBDAV.md)), with the directory replaced by a path prefix. The
"Repository name" in settings is that prefix, so two repositories can share a
database. Row-level security is turned on with no policies: on Supabase the
public `anon` key can neither read nor write the table.

**The database never sees a note.** Content, titles and structure are
encrypted with a key derived from your sync passphrase before anything is
written, and the passphrase never leaves your devices. What the host can see
is how many objects there are, how big they are, and when they change.

---

## Choosing one

`Settings → Synchronization → Sync through`.

### Neon

Neon hosts Postgres and has a free tier. Openotes can create the project:

1. Neon console → Account settings → API keys → **Create new API key**.
2. Paste it into the panel. Openotes lists your projects and the regions a new
   one can go in.
3. Create a project, or pick an existing one. Openotes reads its connection
   string, creates the table over HTTPS, and connects.

The API key is kept encrypted with your other sync credentials so the next
visit needs no paste. Neon's OAuth sign-in is available to commercial partners
only, which is why this asks for a key rather than opening a browser.

Already have a project? *I already have a database* takes the connection
string from the Neon console (Connect → copy) instead.

Neon is reached over its HTTPS SQL endpoint by default. Switch the transport
to a socket in the connection settings if you prefer a persistent connection.

### Supabase

Supabase hosts Postgres and has a free tier. Two ways in:

- **Sign in.** Register an OAuth application at Supabase → Organization
  settings → OAuth Apps, with the redirect URI the panel shows, and paste its
  client ID and secret. The sign-in happens in your browser, the same way the
  cloud drives work: your application, your consent screen.
- **A personal access token** from `supabase.com/dashboard/account/tokens`.

Either way Openotes can then create a project — it takes a minute or two to
come up, and the panel waits — or use one you already have, create the table
through Supabase's management API, fetch the project's service key and
connect. The service key is what reaches the table; it is kept encrypted, and
it is what a phone is given too.

Already have a project? *I already have a database* takes the project URL and
service key, and shows the SQL to run once in the project's SQL editor.

### A Postgres database you control

Paste a connection string — `postgresql://user:password@host:5432/database`.
The table is created on the first connection. The phone cannot reach this
one: a plain Postgres speaks only its own protocol, over a socket.

---

## What each host can actually promise

|                | create-if-absent    | compare-and-swap                | transport                     |
| -------------- | ------------------- | ------------------------------- | ----------------------------- |
| **Postgres**   | yes (primary key)   | yes (`WHERE version = …`)       | socket                        |
| **Neon**       | yes (primary key)   | yes (`WHERE version = …`)       | HTTPS by default, or socket   |
| **Supabase**   | yes (primary key)   | yes (PATCH filtered on version) | HTTPS (REST)                  |

Every guarantee is a single statement, because neither HTTPS transport offers
transactions — and a guarantee that needed one would not survive them.

---

## The phone

The Openotes mobile app (`apps/mobile`, built with Expo) syncs to a Neon or
Supabase repository. Connecting it means pasting what the desktop's settings
show — the Neon connection string, or the Supabase project URL and service key
— and the same sync passphrase. There is no account.

What it shares with the desktop is not a format but the code: the same journal
engine, the same conflict rules, the same Markdown converter, and a pure-JS
build of the same cryptography that is checked against libsodium in the test
suite. What it does not do:

- **Attachments.** Their streaming cipher needs libsodium, which the phone does
  not have. Notes sync; images do not.
- **Vault notes.** A locked note appears in the list and cannot be opened; the
  vault password never leaves the desktop.
- **Rich formatting.** Notes are edited as Markdown. Formatting Markdown cannot
  express is what a replace loses, exactly as for the assistant endpoint.

Every release ships it as `Openotes-<version>-android.apk`; see
[apps/mobile/README.md](apps/mobile/README.md) for building it yourself.

---

## Troubleshooting

**"The openotes_objects table is missing."** Setup was never run on this
database. For Neon and a plain Postgres, connecting again creates it. For
Supabase, run the SQL shown under *I already have a database* in the SQL
editor, or connect through the management API again.

**"Supabase refused the service key."** The key pasted is the anon or
publishable key, which row-level security keeps out by design. Use
`service_role`, or a secret key.

**"The sync passphrase does not match this remote repository."** A second
device has to use the passphrase the first one set. The salt is read from the
repository, so nothing else has to match.

**A Supabase project stuck on "coming up".** New projects take a minute or
two; the panel waits up to six. If it gives up, connect again a little later:
the project is still there.
