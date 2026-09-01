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
 * A durable slot holding one string.
 *
 * Deliberately this small. Engines need to persist a little JSON — an outgoing
 * queue, a sync manifest — and the *how* differs by host: a file in the app
 * data directory on desktop, an in-memory value in tests. Anything richer
 * would drag filesystem assumptions into packages that must not have them.
 *
 * `read()` returns undefined when nothing has been written yet. Implementations
 * must treat a corrupt or unreadable value as "nothing written" rather than
 * throwing, so a damaged file cannot wedge sync permanently.
 */
export interface TextStore {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
}

export class MemoryTextStore implements TextStore {
  private value?: string;

  read(): Promise<string | undefined> {
    return Promise.resolve(this.value);
  }

  write(value: string): Promise<void> {
    this.value = value;
    return Promise.resolve();
  }
}
