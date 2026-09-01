/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited
Copyright (C) 2026 Openotes contributors

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
 * Turning "devices/abc/changes/7.bin" into a Google Drive file id.
 *
 * Drive has no paths. It has files with a `name` and a `parents` list, and
 * a folder is just a file with a magic mime type, so every path the sync
 * protocol uses has to be walked one segment at a time — a query per
 * segment, each one returning the children of the previous answer. That is
 * what the cache in this file exists to avoid: without it, reading one
 * journal entry costs four round trips instead of one.
 *
 * THE HARD PART: DRIVE ALLOWS DUPLICATE NAMES. Two files called "7.bin" can
 * sit in the same folder, with different ids and different contents, and
 * Drive considers that perfectly normal. Two devices appending to the same
 * journal at the same moment will produce exactly that. So a name does not
 * identify a file, and "resolve a path" is really "choose between the
 * candidates", which means:
 *
 *  - The choice must be DETERMINISTIC and identical everywhere. Oldest
 *    createdTime wins, lowest id breaks a tie. Every device that looks at
 *    the same folder therefore reads the same file, whichever device
 *    created which duplicate and whatever order the listing arrives in.
 *  - The choice must be the SAME ON THE READ PATH as in `create`'s
 *    reconciliation. If reads picked "the first one Drive listed" while
 *    create picked the oldest, then a reconciliation that failed halfway —
 *    the loser's owner crashed before deleting it — would leave devices
 *    permanently reading different bytes from the same path, and the
 *    journal would fork with nothing to detect it.
 *
 * `pickWinner` is that rule, and it is exported so nothing has to
 * reimplement it.
 *
 * WHAT IS CACHED. Only positive resolutions: remembering that a path was
 * absent would hide a file another device created a second later, which for
 * an append-only journal means never seeing the rest of it. Both directions
 * are kept (path to file, id to path) so an operation that only knows an id
 * can drop the path that named it.
 */

import { SyncError } from "@notesnook/sync-remote";
import { splitPath } from "../path.ts";
import { DriveTransport, expectJson, expectOk } from "./errors.ts";

/** The Drive v3 metadata endpoint. Uploads use a different host path. */
export const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

/** A folder is a file with this mime type and no content. */
export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/** The alias Drive accepts anywhere a folder id goes: "My Drive". */
export const DRIVE_ROOT_ID = "root";

/**
 * The fields every query asks for. `createdTime` is half the tie-break and
 * `parents` is what makes a move one request instead of three, so neither
 * is optional however tempting the smaller response looks. `modifiedTime`
 * is here only to fill RemoteEntry.modifiedAt.
 */
export const DRIVE_FILE_FIELDS =
  "id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,parents";

/**
 * A listing can be paged; a repository with a hundred thousand attachments
 * is a hundred pages. The cap is not a limit on the repository, it is a
 * guard against a server that keeps handing back the same page token —
 * without it that answer is an infinite loop inside one sync cycle.
 */
const MAX_LIST_PAGES = 1_000;

/**
 * Above this the index stops adding paths rather than growing for as long
 * as the app runs. Resolution still works past it, just at one query per
 * path; the repository's own listings are the same order of magnitude, so
 * the ceiling only matters for accounts far larger than those.
 */
const MAX_CACHED_PATHS = 10_000;

/** One file as Drive describes it, with the fields above. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Bytes. Drive sends it as a decimal string, and omits it for folders. */
  size?: number;
  /** RFC 3339. The first half of the duplicate tie-break. */
  createdTime?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  /** Drive allows exactly one parent now, but still sends a list. */
  parents?: string[];
}

export interface DriveResolution {
  file: DriveFile;
  /**
   * True when the id came from the cache and so proves only that the file
   * was there last time we looked. Callers use it to decide whether a 404
   * means "gone" or "our id is stale, look again".
   */
  fromCache: boolean;
}

export interface DrivePathIndexOptions {
  transport: DriveTransport;
  /** Already through `normalizeDirectory`; "" means the account root. */
  directory: string;
  /**
   * How long to let a folder creation become visible before asking who else
   * created one. Zero is legitimate for a test with a synchronous server.
   */
  settleMs: number;
}

export class DrivePathIndex {
  private readonly transport: DriveTransport;
  private readonly directory: string;
  private readonly settleMs: number;
  /** Path (no trailing slash, "" excluded) to the file that won it. */
  private readonly byPath = new Map<string, DriveFile>();
  /** The reverse, so an id-only invalidation can find its path. */
  private readonly byId = new Map<string, string>();
  /**
   * Folder creations in flight, keyed "<parentId>/<name>". Ten parallel
   * uploads into a folder that does not exist yet would otherwise each
   * create one, and Drive would keep all ten.
   */
  private readonly creating = new Map<string, Promise<DriveFile>>();
  /** The repository folder itself, resolved (and created) exactly once. */
  private rootPromise?: Promise<DriveFile>;

  constructor(options: DrivePathIndexOptions) {
    this.transport = options.transport;
    this.directory = options.directory;
    this.settleMs = options.settleMs;
  }

  /** Forget everything, including which folder the repository is in. */
  clear(): void {
    this.byPath.clear();
    this.byId.clear();
    this.rootPromise = undefined;
  }

  /** Record a resolution. Call it whenever Drive has just named a file. */
  remember(path: string, file: DriveFile): void {
    const key = cacheKey(path);
    if (key === "") return;
    const previous = this.byPath.get(key);
    if (previous && previous.id !== file.id) this.byId.delete(previous.id);
    // Past the ceiling, keep what is already known rather than trading a
    // hot path for whichever one was resolved last.
    if (!previous && this.byPath.size >= MAX_CACHED_PATHS) return;
    this.byPath.set(key, file);
    this.byId.set(file.id, key);
  }

  forget(path: string): void {
    const key = cacheKey(path);
    const file = this.byPath.get(key);
    if (file) this.byId.delete(file.id);
    this.byPath.delete(key);
  }

  /** Drop whatever id we knew for this file, wherever it was. */
  forgetId(id: string): void {
    const path = this.byId.get(id);
    this.byId.delete(id);
    if (path !== undefined) this.byPath.delete(path);
  }

  /**
   * Drop `path` and everything under it. A folder move relocates every
   * descendant in one call, so every remembered path below it now names a
   * file that is somewhere else.
   */
  forgetSubtree(path: string): void {
    const key = cacheKey(path);
    this.forget(key);
    const prefix = key === "" ? "" : `${key}/`;
    for (const cached of [...this.byPath.keys()]) {
      if (cached.startsWith(prefix)) this.forget(cached);
    }
  }

  /**
   * The repository folder's id, creating the configured directory under the
   * account root the first time it is needed.
   */
  async rootId(): Promise<string> {
    return (await this.rootFile()).id;
  }

  /**
   * Resolve a store path to the file that owns it, or undefined when
   * nothing of that name is there.
   *
   * `refresh` skips the cache for the final segment — used by everything
   * that is about to act on the answer rather than merely read through it.
   */
  async resolve(
    path: string,
    options: { refresh?: boolean } = {},
  ): Promise<DriveResolution | undefined> {
    const segments = splitPath(path);
    if (segments.length === 0) {
      return { file: await this.rootFile(), fromCache: false };
    }
    const key = segments.join("/");
    if (!options.refresh) {
      const cached = this.byPath.get(key);
      if (cached) return { file: cached, fromCache: true };
    }
    const parentId = await this.resolveFolderId(segments.slice(0, -1));
    if (parentId === undefined) return undefined;
    const name = segments[segments.length - 1];
    const winner = pickWinner(
      await this.findByName(parentId, name, `look up ${key}`),
    );
    if (!winner) {
      // Whatever we remembered is provably wrong now.
      this.forget(key);
      return undefined;
    }
    this.remember(key, winner);
    return { file: winner, fromCache: false };
  }

  /** The folder id for a directory path, or undefined when it is absent. */
  directoryId(path: string): Promise<string | undefined> {
    return this.resolveFolderId(splitPath(path));
  }

  /**
   * Create every missing folder along `path` and return the deepest id.
   * Also the way the repository directory itself comes into being.
   */
  async ensureDirectory(path: string): Promise<string> {
    let parentId = await this.rootId();
    let prefix = "";
    for (const segment of splitPath(path)) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const cached = this.byPath.get(prefix);
      if (cached && isFolder(cached)) {
        parentId = cached.id;
        continue;
      }
      const folder = await this.ensureFolder(parentId, segment);
      this.remember(prefix, folder);
      parentId = folder.id;
    }
    return parentId;
  }

  /**
   * Every non-trashed file called `name` directly inside `parentId` — the
   * candidate set the tie-break chooses from, and the pre-check `create`
   * runs before it writes anything.
   *
   * Unpaged on purpose: the result is one name in one folder, which is a
   * handful of duplicates in the worst case anyone has ever seen.
   */
  async findByName(
    parentId: string,
    name: string,
    action: string,
  ): Promise<DriveFile[]> {
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set(
      "q",
      `'${escapeQueryValue(parentId)}' in parents and ` +
        `name='${escapeQueryValue(name)}' and trashed=false`,
    );
    url.searchParams.set("fields", `files(${DRIVE_FILE_FIELDS})`);
    url.searchParams.set("spaces", "drive");
    const response = await this.transport.request({ url: url.toString() }, action);
    return parseDriveFileList(expectJson(response, action), action);
  }

  /** Everything directly inside a folder, following Drive's paging. */
  async listChildren(
    parentId: string,
    action: string,
  ): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    for (let page = 0;; page++) {
      const url = new URL(DRIVE_FILES_URL);
      url.searchParams.set(
        "q",
        `'${escapeQueryValue(parentId)}' in parents and trashed=false`,
      );
      url.searchParams.set("fields", `nextPageToken,files(${DRIVE_FILE_FIELDS})`);
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("pageSize", "1000");
      if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
      const payload = expectJson(
        await this.transport.request({ url: url.toString() }, action),
        action,
      );
      files.push(...parseDriveFileList(payload, action));
      const next = asRecord(payload)?.nextPageToken;
      if (typeof next !== "string" || next.length === 0) return files;
      if (page >= MAX_LIST_PAGES) {
        throw new SyncError(
          `Google Drive kept paging while trying to ${action}: gave up ` +
            `after ${MAX_LIST_PAGES} pages`,
          "corrupt-data",
        );
      }
      pageToken = next;
    }
  }

  /** Fetch one file's current metadata by id, bypassing every cache. */
  async fetchFile(id: string, action: string): Promise<DriveFile | undefined> {
    const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(id)}`);
    url.searchParams.set("fields", DRIVE_FILE_FIELDS);
    const response = await this.transport.request({ url: url.toString() }, action);
    if (response.status === 404) return undefined;
    return parseDriveFile(expectJson(response, action), action);
  }

  /**
   * Permanently delete a file by id and drop it from the cache.
   *
   * Permanent, not trashed: a trashed file still counts against the account
   * quota, so pruning attachments into the trash would fill the Drive up
   * and stop sync with the very error errors.ts explains how to fix.
   */
  async deleteFile(id: string, action: string): Promise<void> {
    const url = `${DRIVE_FILES_URL}/${encodeURIComponent(id)}`;
    const response = await this.transport.request(
      { url, method: "DELETE" },
      action,
    );
    // Already gone is the outcome the caller wanted. Everything else, from
    // a permission failure to a 500, has to reach them.
    if (response.status !== 404) expectOk(response, action);
    this.forgetId(id);
  }

  /**
   * Walk a folder chain without creating anything. Undefined as soon as a
   * segment is missing — or is not a folder, which for a read path means
   * the same thing: there are no children under a file.
   */
  private async resolveFolderId(
    segments: string[],
  ): Promise<string | undefined> {
    let parentId = await this.rootId();
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      const cached = this.byPath.get(prefix);
      if (cached) {
        if (!isFolder(cached)) return undefined;
        parentId = cached.id;
        continue;
      }
      // Folders only: a stray file of the same name — dropped in by the
      // user, or left by a half-finished reconciliation — must not win the
      // tie-break against the folder the repository lives in and send the
      // walk down a dead end.
      const winner = pickWinner(
        foldersIn(await this.findByName(parentId, segment, `open ${prefix}`)),
      );
      if (!winner) return undefined;
      this.remember(prefix, winner);
      parentId = winner.id;
    }
    return parentId;
  }

  private rootFile(): Promise<DriveFile> {
    const existing = this.rootPromise;
    if (existing) return existing;
    const started = this.resolveRoot().catch((error: unknown) => {
      // A failed resolution must not be remembered as the answer: the next
      // call would keep rethrowing an error from a network blip an hour ago.
      if (this.rootPromise === started) this.rootPromise = undefined;
      throw error;
    });
    this.rootPromise = started;
    return started;
  }

  private async resolveRoot(): Promise<DriveFile> {
    // An empty directory means the repository is the account root itself,
    // which always exists and needs no metadata: "root" is accepted
    // wherever a folder id is.
    let folder: DriveFile = {
      id: DRIVE_ROOT_ID,
      name: "",
      mimeType: FOLDER_MIME_TYPE,
    };
    for (const segment of splitPath(this.directory)) {
      folder = await this.ensureFolder(folder.id, segment);
    }
    return folder;
  }

  private ensureFolder(parentId: string, name: string): Promise<DriveFile> {
    const key = `${parentId}/${name}`;
    const inFlight = this.creating.get(key);
    if (inFlight) return inFlight;
    const started = this.reconcileFolder(parentId, name).finally(() => {
      // Only clear our own: a creation that started later is still current.
      if (this.creating.get(key) === started) this.creating.delete(key);
    });
    this.creating.set(key, started);
    return started;
  }

  /**
   * Find the folder, or create it and make sure everyone ends up in the
   * same one.
   *
   * Two devices setting up the same account minutes apart both find nothing
   * and both create "Openotes", and Drive keeps both. Left alone that is a
   * silent fork: each device syncs happily into its own folder and neither
   * ever sees the other's notes. So the create is followed by another look,
   * and the loser deletes the folder it just made.
   */
  private async reconcileFolder(
    parentId: string,
    name: string,
  ): Promise<DriveFile> {
    const action = `open the folder ${name}`;
    const existing = pickWinner(
      foldersIn(await this.findByName(parentId, name, action)),
    );
    if (existing) return existing;

    const created = await this.createFolder(parentId, name);
    // Drive's file list is not read-your-writes across replicas: asking
    // immediately can answer from one that has seen neither create, and
    // both devices would conclude they were alone.
    await this.transport.sleep(this.settleMs);
    const candidates = includeFile(
      foldersIn(await this.findByName(parentId, name, action)),
      created,
    );
    const winner = pickWinner(candidates) ?? created;
    if (winner.id === created.id) return created;

    // Ours lost. It was created a moment ago and no one can have written
    // into it — every device resolves this name to the same winner — so
    // deleting it is safe, and leaving it would hand the next device a
    // duplicate to trip over. The winner is never touched.
    await this.deleteFile(created.id, `remove a duplicate ${name} folder`);
    return winner;
  }

  private async createFolder(
    parentId: string,
    name: string,
  ): Promise<DriveFile> {
    const action = `create the folder ${name}`;
    const url = new URL(DRIVE_FILES_URL);
    url.searchParams.set("fields", DRIVE_FILE_FIELDS);
    const response = await this.transport.request({
      url: url.toString(),
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME_TYPE,
        parents: [parentId],
      }),
    }, action);
    return parseDriveFile(expectJson(response, action), action);
  }
}

export function isFolder(file: DriveFile): boolean {
  return file.mimeType === FOLDER_MIME_TYPE;
}

/** The folders among a candidate set, for a path segment that must be one. */
export function foldersIn(files: readonly DriveFile[]): DriveFile[] {
  return files.filter(isFolder);
}

/**
 * The winner among files that share a name: oldest first, lowest id to
 * break a tie. Undefined only for an empty set.
 *
 * Every device runs this over the same candidates and must reach the same
 * answer — see the note at the top of the file.
 */
export function pickWinner(
  files: readonly DriveFile[],
): DriveFile | undefined {
  let winner: DriveFile | undefined;
  for (const file of files) {
    if (winner === undefined || beats(file, winner)) winner = file;
  }
  return winner;
}

/** `files`, plus `extra` when the listing has not caught up with it yet. */
export function includeFile(
  files: readonly DriveFile[],
  extra: DriveFile,
): DriveFile[] {
  return files.some((file) => file.id === extra.id)
    ? [...files]
    : [...files, extra];
}

/**
 * Escape a value going into a Drive query string. A note titled "don't" is
 * ordinary, and its unescaped apostrophe closes the quoted term and makes
 * the rest of the query a syntax error — or, with the right characters,
 * something else entirely.
 */
export function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function parseDriveFile(value: unknown, action: string): DriveFile {
  const record = asRecord(value);
  const id = record?.id;
  const name = record?.name;
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string") {
    throw new SyncError(
      `Google Drive answered a request to ${action} with a file that has ` +
        `no id or no name`,
      "corrupt-data",
    );
  }
  return {
    id,
    name,
    mimeType: typeof record?.mimeType === "string" ? record.mimeType : "",
    size: parseSize(record?.size),
    createdTime: asString(record?.createdTime),
    modifiedTime: asString(record?.modifiedTime),
    md5Checksum: asString(record?.md5Checksum),
    parents: parseParents(record?.parents),
  };
}

export function parseDriveFileList(
  payload: unknown,
  action: string,
): DriveFile[] {
  const files = asRecord(payload)?.files;
  // A query that matched nothing may omit the array entirely.
  if (files === undefined) return [];
  if (!Array.isArray(files)) {
    throw new SyncError(
      `Google Drive answered a request to ${action} with a file list that ` +
        `is not a list`,
      "corrupt-data",
    );
  }
  return files.map((file) => parseDriveFile(file, action));
}

function beats(candidate: DriveFile, incumbent: DriveFile): boolean {
  const candidateAt = createdAt(candidate);
  const incumbentAt = createdAt(incumbent);
  if (candidateAt !== incumbentAt) return candidateAt < incumbentAt;
  // Code-unit order, never localeCompare: collation depends on the locale
  // and on the ICU data the runtime was built with, so two devices could
  // order the same pair of ids differently and each keep a different file.
  return candidate.id < incumbent.id;
}

/**
 * A file whose createdTime Drive did not report sorts last rather than
 * first: missing metadata must not win the "oldest" test by default, or a
 * truncated response would silently change which file the account agrees on.
 */
function createdAt(file: DriveFile): number {
  const at = file.createdTime ? Date.parse(file.createdTime) : Number.NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

/** The cache key: no trailing slash, so "a/b" and "a/b/" are one entry. */
function cacheKey(path: string): string {
  return splitPath(path).join("/");
}

function parseSize(value: unknown): number | undefined {
  // Drive sends size as a decimal string, because a file can be larger than
  // JSON's safe integer range.
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const size = Number(value);
  return Number.isFinite(size) ? size : undefined;
}

function parseParents(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parents = value.filter((id): id is string => typeof id === "string");
  return parents.length > 0 ? parents : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
