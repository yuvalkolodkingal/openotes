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

/**
 * Errors shared by every synchronization backend.
 *
 * This type lives here rather than in a backend package so that a provider
 * implementation (WebDAV, Dropbox, OneDrive, Google Drive) can raise it
 * without depending on any other backend.
 */

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unauthorized"
      | "forbidden"
      | "not-found"
      | "conflict"
      | "precondition-failed"
      | "server-error"
      | "timeout"
      | "network"
      | "protocol-mismatch"
      | "bad-key"
      | "corrupt-data"
      | "insecure-url"
      | "cancelled",
    readonly status?: number,
  ) {
    super(message);
    this.name = "SyncError";
  }

  get isRetryable() {
    return (
      this.code === "server-error" ||
      this.code === "timeout" ||
      this.code === "network"
    );
  }
}
