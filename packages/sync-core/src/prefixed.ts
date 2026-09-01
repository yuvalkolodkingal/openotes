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

import {
  PutOptions,
  RemoteCapabilities,
  RemoteEntry,
  RemoteStorage,
} from "./remote.ts";

/**
 * A view of another store with every path under a fixed prefix.
 *
 * Used to stage a rebuild: the engine writes a whole new repository under a
 * temporary directory, then swaps it into place, so a rebuild that fails
 * half-way leaves the live repository untouched.
 *
 * This replaces a duck-typed wrapper that mirrored sixteen WebDAV methods and
 * was handed to the repository through an `as unknown as WebDavClient` cast.
 * The cast existed because there was no interface to implement. There is one
 * now, so this is an ordinary implementation and the compiler checks it.
 */
export class PrefixedRemoteStorage implements RemoteStorage {
  private readonly prefix: string;

  constructor(
    private readonly inner: RemoteStorage,
    prefix: string,
  ) {
    // Store without a trailing slash so join() is unambiguous for "".
    this.prefix = prefix.replace(/\/+$/, "");
  }

  /**
   * Prefixing preserves the caller's trailing slash, because callers use it to
   * mean "this is a collection" and some backends care.
   */
  private join(path: string): string {
    const trimmed = path.replace(/^\/+/, "");
    if (!trimmed) return this.prefix;
    return `${this.prefix}/${trimmed}`;
  }

  /** Strip the prefix back off a path the inner store returned. */
  private strip(path: string): string {
    if (path === this.prefix) return "";
    return path.startsWith(this.prefix + "/")
      ? path.slice(this.prefix.length + 1)
      : path;
  }

  private stripEntry(entry: RemoteEntry): RemoteEntry {
    return { ...entry, path: this.strip(entry.path) };
  }

  probe(): Promise<void> {
    return this.inner.probe();
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const entries = await this.inner.list(this.join(path));
    return entries.map((entry) => this.stripEntry(entry));
  }

  async stat(path: string): Promise<RemoteEntry | undefined> {
    const entry = await this.inner.stat(this.join(path));
    return entry ? this.stripEntry(entry) : undefined;
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(this.join(path));
  }

  get(path: string): Promise<Uint8Array> {
    return this.inner.get(this.join(path));
  }

  getIfExists(path: string): Promise<Uint8Array | undefined> {
    return this.inner.getIfExists(this.join(path));
  }

  async putNew(
    path: string,
    body: Uint8Array,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    return this.stripEntry(
      await this.inner.putNew(this.join(path), body, options),
    );
  }

  async putUpdate(
    path: string,
    body: Uint8Array,
    expectedVersion?: string,
    options?: PutOptions,
  ): Promise<RemoteEntry> {
    return this.stripEntry(
      await this.inner.putUpdate(
        this.join(path),
        body,
        expectedVersion,
        options,
      ),
    );
  }

  delete(path: string): Promise<void> {
    return this.inner.delete(this.join(path));
  }

  move(from: string, to: string, overwrite = true): Promise<void> {
    return this.inner.move(this.join(from), this.join(to), overwrite);
  }

  mkdirp(path: string): Promise<void> {
    return this.inner.mkdirp(this.join(path));
  }

  verifyUpload(path: string, expectedLength: number): Promise<void> {
    return this.inner.verifyUpload(this.join(path), expectedLength);
  }

  capabilities(): Promise<RemoteCapabilities> {
    return this.inner.capabilities();
  }
}
