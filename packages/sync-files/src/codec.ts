/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { SyncError } from "@notesnook/sync-core";

/**
 * How a note is written into the remote folder.
 *
 * Two modes, and the choice is the user's:
 *
 * **Readable (the default).** One Markdown file per note, at a path that
 * mirrors the notebook it lives in. The folder is something you can open on a
 * phone, search with the provider's own search, or restore by hand. The cost
 * is that the provider can read the notes.
 *
 * **Encrypted (opt-in).** The same protocol with the bytes and the names
 * replaced: content is XChaCha20-encrypted and the filename is a keyed BLAKE2b
 * digest of the note id, so neither the text nor the *title* nor the notebook
 * structure leaks. The cost is that the folder is opaque -- nothing outside
 * Openotes can read it, including the user.
 *
 * WHY THE PATH GOES INSIDE THE PAYLOAD
 *
 * A digest cannot be reversed into a path, so an encrypted file has to carry
 * its own. That also means a device with no manifest can rebuild one by
 * decrypting the folder, which is what keeps the encrypted mode as
 * recoverable as the readable one.
 *
 * Filenames are keyed on the *note id*, not the title, so retitling a note
 * does not move its file and cannot be observed as a rename.
 */
export interface NoteCodec {
  /** True when the remote folder is human-readable. */
  readonly readable: boolean;

  /** Where a note's bytes live remotely. */
  remotePath(noteId: string, logicalPath: string): Promise<string>;

  /** Bytes to store, given the note's logical path and rendered content. */
  encode(logicalPath: string, content: Uint8Array): Promise<Uint8Array>;

  /** Recover the logical path and content from what was stored. */
  decode(
    remotePath: string,
    stored: Uint8Array,
  ): Promise<{ path: string; content: Uint8Array }>;

  /** Whether a file in the folder is one of ours. */
  claims(remotePath: string): boolean;
}

/** Readable Markdown, one file per note. The default. */
export class PlaintextCodec implements NoteCodec {
  readonly readable = true;

  remotePath(_noteId: string, logicalPath: string): Promise<string> {
    return Promise.resolve(logicalPath);
  }

  encode(_logicalPath: string, content: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(content);
  }

  decode(
    remotePath: string,
    stored: Uint8Array,
  ): Promise<{ path: string; content: Uint8Array }> {
    return Promise.resolve({ path: remotePath, content: stored });
  }

  claims(remotePath: string): boolean {
    return remotePath.endsWith(".md");
  }
}

/** What an encrypted file holds, once decrypted. */
interface EncryptedNote {
  version: 1;
  /** The note's logical path, so a folder alone is enough to rebuild state. */
  path: string;
  /** UTF-8 Markdown. */
  content: string;
}

/**
 * The crypto this codec needs. Structurally satisfied by SyncCrypto from
 * @notesnook/sync-webdav, which is where the audited implementation lives;
 * declared as an interface so this package does not depend on the WebDAV one.
 */
export interface NoteCrypto {
  hashString(key: unknown, value: string): Promise<string>;
  encryptJson(key: unknown, value: unknown): Promise<unknown>;
  decryptJson<T>(key: unknown, cipher: unknown): Promise<T>;
}

export const ENCRYPTED_DIR = "notes";
const EXTENSION = ".bin";

export class EncryptedCodec implements NoteCodec {
  readonly readable = false;

  constructor(
    private readonly crypto: NoteCrypto,
    /** Subkey for note content. Never the master key. */
    private readonly key: unknown,
  ) {}

  /**
   * Keyed on the note id, so the name is stable across retitles and reveals
   * nothing to someone holding the folder but not the key.
   */
  async remotePath(noteId: string, _logicalPath: string): Promise<string> {
    const digest = await this.crypto.hashString(this.key, noteId);
    return `${ENCRYPTED_DIR}/${digest}${EXTENSION}`;
  }

  async encode(
    logicalPath: string,
    content: Uint8Array,
  ): Promise<Uint8Array> {
    const payload: EncryptedNote = {
      version: 1,
      path: logicalPath,
      content: new TextDecoder().decode(content),
    };
    const cipher = await this.crypto.encryptJson(this.key, payload);
    return new TextEncoder().encode(JSON.stringify(cipher));
  }

  async decode(
    remotePath: string,
    stored: Uint8Array,
  ): Promise<{ path: string; content: Uint8Array }> {
    let cipher: unknown;
    try {
      cipher = JSON.parse(new TextDecoder().decode(stored));
    } catch {
      throw new SyncError(
        `${remotePath} is not a readable encrypted note`,
        "corrupt-data",
      );
    }

    let payload: EncryptedNote;
    try {
      payload = await this.crypto.decryptJson<EncryptedNote>(this.key, cipher);
    } catch {
      // Wrong passphrase and corrupt bytes are indistinguishable from here,
      // and saying "wrong key" when the file is damaged would send the user
      // to re-enter a passphrase that was never the problem.
      throw new SyncError(
        `${remotePath} could not be decrypted. Either the sync passphrase is ` +
          `different from the one that wrote it, or the file is damaged.`,
        "bad-key",
      );
    }

    if (payload?.version !== 1 || typeof payload.path !== "string") {
      throw new SyncError(
        `${remotePath} was written by a newer version of Openotes`,
        "protocol-mismatch",
      );
    }

    return {
      path: payload.path,
      content: new TextEncoder().encode(payload.content ?? ""),
    };
  }

  claims(remotePath: string): boolean {
    return remotePath.startsWith(ENCRYPTED_DIR + "/") &&
      remotePath.endsWith(EXTENSION);
  }
}
