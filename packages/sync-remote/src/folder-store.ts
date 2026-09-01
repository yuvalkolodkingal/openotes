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

import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import {
  assertSafePath,
  joinPath,
  PutOptions,
  RemoteEntry,
  RemoteStore,
  RemoteStoreCapabilities,
  scopedStore,
} from "./store.ts";
import { SyncError } from "./types.ts";

/**
 * A RemoteStore over an ordinary directory on this machine.
 *
 * This is the provider with no accounts, no tokens and no server: the user
 * points it at a folder that something else already replicates — Google
 * Drive Desktop, OneDrive, Dropbox, iCloud Drive, Syncthing, a NAS mount, a
 * USB stick — and that something else is the transport. The "remote" is
 * another device's copy of the same directory.
 *
 * Two properties of that arrangement drive every decision below.
 *
 * A DRIVE CLIENT IS WATCHING. It uploads a file the moment it appears, so
 * every write has to become visible complete or not at all: bytes go to a
 * temp name in the destination's own directory and are renamed into place,
 * and `create` gets its exclusivity from `link` rather than from a check
 * followed by a write. A partially uploaded journal entry is a corrupt
 * journal entry on every other device.
 *
 * THE FOLDER CAN VANISH. A stick is unplugged, a share is unmounted, a
 * Drive folder is unlinked — and what is left behind is very often an empty
 * directory where the mount point used to be. Reporting that as "the
 * repository is empty" is the single worst thing this store could do,
 * because the engine would initialize a fresh, empty generation over live
 * data. So an empty or missing listing is checked against the folder still
 * being there, and against it still being the filesystem `connect` saw.
 */

/** How quickly a write here becomes visible on another device. */
export type FolderConsistency = "immediate" | "eventual";

export interface FolderStoreOptions {
  /** Absolute path of the folder that holds the repository. */
  root: string;
  /**
   * "immediate" for a folder nothing replicates (a plain local directory, a
   * NAS mount, a USB stick); "eventual" for one a drive client uploads in
   * the background.
   *
   * Defaults to "eventual" because the two mistakes are not symmetric.
   * Declaring a drive folder immediate makes the engine treat a batch that
   * is merely still uploading as lost and skip past it, permanently.
   * Declaring a plain folder eventual only delays the moment a genuinely
   * lost batch is skipped.
   */
  consistency?: FolderConsistency;
}

/**
 * How long a drive client may take to hand a file to another device. Long
 * enough for a large batch on a slow uplink, short enough that a batch that
 * really is gone stops holding the cursor back within the same session.
 */
const EVENTUAL_PROPAGATION_GRACE_MS = 120_000;

/**
 * A rename is atomic for a reader on this machine, but a drive client can
 * begin uploading the instant the name appears and hand another device a
 * partial copy. This is how long a writer waits before treating its own
 * write as published.
 */
const EVENTUAL_SETTLE_MS = 1_500;

export class FolderStore implements RemoteStore {
  readonly capabilities: RemoteStoreCapabilities;
  private readonly root: string;
  /**
   * The filesystem the root was on when the user pointed us at it, or
   * undefined when the platform does not report one. See assertStillMounted.
   */
  private rootDevice?: number;
  /**
   * Hard links are the exclusive-create primitive here, and FAT32/exFAT —
   * every USB stick and most SD cards — has none. Remembering the first
   * refusal stops every later create() from writing a temp file it already
   * knows it cannot link.
   */
  private hardLinksUnsupported = false;

  constructor(options: FolderStoreOptions) {
    this.root = options.root;
    const eventual = (options.consistency ?? "eventual") === "eventual";
    this.capabilities = {
      label: "Folder",
      // link()/O_CREAT|O_EXCL is the filesystem refusing to clobber — but
      // only against another process on THIS machine. Two machines sharing
      // the folder through a drive client each see the path free, each
      // create it, and the drive client resolves the collision afterwards
      // by renaming one copy. That is not exclusion, so a replicated folder
      // declares the honest value and the protocol treats the guarantee as
      // emulated. A folder nothing replicates really is exclusive.
      conditionalCreate: eventual ? "reconciled" : "native",
      propagationGraceMs: eventual ? EVENTUAL_PROPAGATION_GRACE_MS : 0,
      atomicDirectoryMove: true,
      settleMs: eventual ? EVENTUAL_SETTLE_MS : 0,
    };
  }

  async connect(): Promise<void> {
    try {
      const root = resolve(this.root);
      const parent = dirname(root);
      const parentInfo = await statOrUndefined(parent);
      if (parentInfo === undefined) {
        throw new SyncError(
          `Cannot use ${root} for sync: its parent folder ${parent} does ` +
            `not exist. Only the last folder is created here — if that ` +
            `path is a removable drive or a network share, it is not ` +
            `mounted right now.`,
          // Retryable on purpose: an absent parent is far more often an
          // unplugged drive or a share that has not come back after sleep
          // than a typo, and sync should wait for it rather than switch
          // itself off.
          "network",
        );
      }
      if (!parentInfo.isDirectory) {
        throw new SyncError(
          `Cannot use ${root} for sync: ${parent} is not a folder.`,
          "corrupt-data",
        );
      }

      const info = await statOrUndefined(root);
      if (info === undefined) {
        try {
          // Deliberately not recursive. Creating missing parents is exactly
          // how a repository ends up written onto the local disk under a
          // stale mount point, where the drive client never sees it and the
          // user never finds it.
          await Deno.mkdir(root);
        } catch (error) {
          // Another process (or a second window of this app) got there
          // first, which is the outcome we wanted anyway.
          if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        }
      } else if (!info.isDirectory) {
        throw new SyncError(
          `Cannot use ${root} for sync: it is a file, not a folder.`,
          "corrupt-data",
        );
      }

      const mounted = await statOrUndefined(await this.resolveRoot());
      // A zero device id means the platform does not report one; recording
      // it would make assertStillMounted compare 0 against 0 forever.
      this.rootDevice = mounted && mounted.dev !== 0 ? mounted.dev : undefined;
    } catch (error) {
      throw this.mapError(error, "open the sync folder", this.root);
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    try {
      const { root, target } = await this.resolvePath(path);
      const prefix = path.replace(/\/+$/, "");
      const entries: RemoteEntry[] = [];
      try {
        for await (const child of Deno.readDir(target)) {
          // Symlinks are skipped rather than followed: a shared folder is
          // written by people who are not us, and a link is the one entry
          // whose content lives somewhere the root does not cover.
          if (child.isSymlink) continue;
          // Our own half-written files (see temporaryPathFor) and the drive
          // clients' bookkeeping (.DS_Store, desktop.ini, ~$ locks) must
          // never reach the protocol as journal entries or objects.
          if (isHiddenName(child.name)) continue;
          const info = await lstatOrUndefined(join(target, child.name));
          // Deleted between the readDir and the lstat: it is not in the
          // listing, which is the same answer we would have given a moment
          // later.
          if (info === undefined) continue;
          entries.push({
            path: joinPath(prefix, child.name),
            isDirectory: child.isDirectory,
            size: child.isDirectory ? undefined : info.size,
            modifiedAt: info.mtime?.getTime(),
          });
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          // The contract says a missing directory lists as empty — but only
          // once we know the folder itself is still there.
          await this.assertStillMounted(root);
          return [];
        }
        // A file where a directory was expected has no children, which is
        // all list() promises. Failing here would turn one stray file
        // dropped into the folder into a hard sync error.
        if (error instanceof Deno.errors.NotADirectory) return [];
        throw error;
      }
      // An empty repository root is the one listing the engine is allowed
      // to initialize over, so it gets the same scrutiny as a missing one.
      if (entries.length === 0 && prefix === "") {
        await this.assertStillMounted(root);
      }
      return entries;
    } catch (error) {
      throw this.mapError(error, "list", path);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { target } = await this.resolvePath(path);
      // lstat, not stat: a symlink — even a dangling one — occupies the
      // name, and every caller of exists() is deciding whether the name is
      // free to write to.
      return (await lstatOrUndefined(target)) !== undefined;
    } catch (error) {
      throw this.mapError(error, "check", path);
    }
  }

  async get(path: string): Promise<Uint8Array> {
    const body = await this.getIfExists(path);
    if (body === undefined) {
      throw new SyncError(
        `${path} is not in the sync folder ${this.root}`,
        "not-found",
      );
    }
    return body;
  }

  async getIfExists(path: string): Promise<Uint8Array | undefined> {
    try {
      const source = await this.locateForRead(path);
      if (source === undefined) return undefined;
      try {
        return await Deno.readFile(source);
      } catch (error) {
        // Removed by the drive client between the lstat and the read; the
        // contract for a path that is not there is undefined, not a throw.
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      }
    } catch (error) {
      throw this.mapError(error, "read", path);
    }
  }

  /**
   * PutOptions carries only a content type, and a filesystem has nowhere to
   * keep one, so it is accepted and ignored.
   */
  async put(
    path: string,
    body: Uint8Array,
    _options?: PutOptions,
  ): Promise<void> {
    try {
      const target = await this.prepareWrite(path);
      await this.writeAtomically(target, body, path);
    } catch (error) {
      throw this.mapError(error, "write", path);
    }
  }

  async create(
    path: string,
    body: Uint8Array,
    _options?: PutOptions,
  ): Promise<void> {
    try {
      const target = await this.prepareWrite(path);
      if (!this.hardLinksUnsupported) {
        const temp = temporaryPathFor(target);
        try {
          await Deno.writeFile(temp, body);
        } catch (error) {
          await discard(temp);
          throw error;
        }
        try {
          // link() is the only call that creates a name and refuses to
          // clobber one in a single step. The bytes are already complete
          // when the name appears, so no reader — local or on the other end
          // of a drive client — can see a short journal entry.
          await Deno.link(temp, target);
          return;
        } catch (error) {
          if (error instanceof Deno.errors.AlreadyExists) {
            throw this.alreadyTaken(path);
          }
          if (!isHardLinkUnsupported(error)) throw error;
          this.hardLinksUnsupported = true;
        } finally {
          // Either way: on success the destination is a second name for the
          // same inode and the temp name has done its job; on failure it is
          // litter.
          await discard(temp);
        }
      }
      await this.createWithoutLink(target, body, path);
    } catch (error) {
      throw this.mapError(error, "create", path);
    }
  }

  async delete(path: string): Promise<void> {
    try {
      const { target } = await this.resolvePath(path);
      try {
        // Not recursive: the protocol only ever deletes single files, and a
        // store that quietly removes a subtree turns a path bug into data
        // loss.
        await Deno.remove(target);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
    } catch (error) {
      throw this.mapError(error, "delete", path);
    }
  }

  async move(from: string, to: string): Promise<void> {
    try {
      const { target: source } = await this.resolvePath(from);
      const target = await this.prepareWrite(to);
      try {
        await Deno.rename(source, target);
      } catch (error) {
        throw this.renameFailure(error, to);
      }
    } catch (error) {
      throw this.mapError(error, "move", `${from} -> ${to}`);
    }
  }

  async moveRecursive(from: string, to: string): Promise<void> {
    try {
      const { target: source } = await this.resolvePath(from);
      const target = await this.prepareWrite(to);
      try {
        // One rename moves the whole subtree, which is what lets this store
        // claim atomicDirectoryMove: no reader ever sees the tree half
        // moved, and no drive client uploads it twice.
        await Deno.rename(source, target);
        return;
      } catch (error) {
        // A lock is not something a walk can get past, and on Windows it is
        // the common case rather than an odd one.
        if (error instanceof Deno.errors.PermissionDenied) {
          throw this.renameFailure(error, to);
        }
        if (!isWalkableRenameFailure(error)) throw error;
      }
      await this.moveByWalk(source, target, to);
    } catch (error) {
      throw this.mapError(error, "move", `${from} -> ${to}`);
    }
  }

  async makeDirectory(path: string): Promise<void> {
    try {
      const { root, target } = await this.resolvePath(path);
      // resolvePath already proved the root is there, and creating it is
      // connect()'s job, not a caller's.
      if (target === root) return;
      await Deno.mkdir(target, { recursive: true });
      // mkdir follows symlinks for the directories along the way, so the
      // containment check has to happen against what was actually created.
      this.assertInside(root, await Deno.realPath(target), path);
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new SyncError(
          `Cannot create the folder ${path} in ${this.root}: a file of ` +
            `that name is in the way.`,
          "conflict",
        );
      }
      throw this.mapError(error, "create the folder", path);
    }
  }

  async verifyUpload(path: string, expectedLength: number): Promise<void> {
    try {
      const { target } = await this.resolvePath(path);
      const info = await statOrUndefined(target);
      if (info === undefined) {
        throw new SyncError(
          `Upload verification failed: ${path} is not in the sync folder ` +
            `${this.root}`,
          "corrupt-data",
        );
      }
      if (info.size !== expectedLength) {
        throw new SyncError(
          `Upload verification failed: ${path} holds ${info.size} bytes, ` +
            `expected ${expectedLength}`,
          "corrupt-data",
        );
      }
    } catch (error) {
      throw this.mapError(error, "verify", path);
    }
  }

  scope(prefix: string): RemoteStore {
    return scopedStore(this, prefix);
  }

  // ---- path resolution ----

  /**
   * The canonical root, resolved afresh on every call.
   *
   * Caching it would save a syscall and be exactly wrong: a cached path
   * outlives the mount it names, so an unplugged stick would surface as
   * "that directory does not exist" — which list() is required to report as
   * an empty directory — instead of "the folder is gone".
   */
  private async resolveRoot(): Promise<string> {
    try {
      return await Deno.realPath(this.root);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new SyncError(
          `The sync folder ${this.root} is not there. A removable drive or ` +
            `a network share is probably not mounted; nothing will be read ` +
            `or written until it is back.`,
          "network",
        );
      }
      throw error;
    }
  }

  /** Where `path` lives, proven to be inside the root. */
  private async resolvePath(
    path: string,
  ): Promise<{ root: string; target: string }> {
    const root = await this.resolveRoot();
    const target = join(root, ...segmentsOf(path));
    this.assertInside(root, target, path);
    return { root, target };
  }

  /**
   * Where to read `path` from, or undefined when there is nothing there.
   *
   * A shared Dropbox or NAS folder is written by people who are not us, so
   * a symlink is resolved and re-checked rather than followed: one pointing
   * out of the root would hand the decryptor a file we were never meant to
   * read.
   */
  private async locateForRead(path: string): Promise<string | undefined> {
    const { root, target } = await this.resolvePath(path);
    const info = await lstatOrUndefined(target);
    if (info === undefined) return undefined;
    if (!info.isSymlink) return target;
    const real = await realPathOrUndefined(target);
    if (real === undefined) return undefined;
    this.assertInside(root, real, path);
    return real;
  }

  /**
   * Where to write `path`, with the parent directory in place and the
   * destination proven not to be a symlink.
   */
  private async prepareWrite(path: string): Promise<string> {
    const { root, target } = await this.resolvePath(path);
    if (target === root) {
      throw new SyncError(
        `${JSON.stringify(path)} names the sync folder itself, not a file ` +
          `in it`,
        "corrupt-data",
      );
    }

    const parent = dirname(target);
    let parentReal = await realPathOrUndefined(parent);
    if (parentReal === undefined) {
      // Drive clients prune directories that have gone empty, and a folder
      // freshly cloned onto a new device never contains one. Recreating the
      // parent here keeps an ordinary state from failing every write.
      await Deno.mkdir(parent, { recursive: true });
      parentReal = await Deno.realPath(parent);
    }
    // Resolving the parent, not just checking the joined string, is what
    // catches a subdirectory that has been replaced by a link out of the
    // root — the write would otherwise land wherever it points.
    this.assertInside(root, parentReal, path);

    const resolved = join(parentReal, basename(target));
    const existing = await lstatOrUndefined(resolved);
    if (existing?.isSymlink) {
      throw new SyncError(
        `${path} in ${this.root} is a symbolic link. A shared folder is not ` +
          `a trustworthy place to follow one, so nothing was written.`,
        "forbidden",
      );
    }
    return resolved;
  }

  private assertInside(root: string, candidate: string, path: string): void {
    const rel = relative(root, candidate);
    const escapes = isAbsolute(rel) || rel === ".." ||
      rel.startsWith(`..${SEPARATOR}`);
    if (!escapes) return;
    throw new SyncError(
      `${JSON.stringify(path)} resolves to ${candidate}, outside the sync ` +
        `folder ${root}`,
      "corrupt-data",
    );
  }

  /**
   * Refuse to answer "nothing here" when the folder is no longer the one we
   * connected to.
   *
   * Unmounting a share or pulling a stick usually leaves the mount point
   * behind as an empty directory, so "the root still exists" is not enough
   * on its own. The device id of the filesystem under it changes when the
   * mount goes, which is the cheapest signal available, and an empty
   * listing is the only place it matters — that is the listing the engine
   * is entitled to build a new, empty generation over. connect() records
   * the id again, so a folder that legitimately came back on a new mount
   * recovers on the next connect.
   */
  private async assertStillMounted(root: string): Promise<void> {
    if (this.rootDevice === undefined) return;
    const info = await statOrUndefined(root);
    if (info !== undefined && info.dev === this.rootDevice) return;
    throw new SyncError(
      `The sync folder ${this.root} looks empty because the drive it lives ` +
        `on is no longer mounted. Refusing to treat it as an empty ` +
        `repository; reconnect the drive and sync will carry on.`,
      "network",
    );
  }

  // ---- writing ----

  /**
   * Write `body` where nothing can observe a partial file: a temp name in
   * the destination's own directory, renamed over the destination. The same
   * directory means the same filesystem, so the rename cannot fail with
   * EXDEV, and a drive client has one directory to watch rather than two.
   */
  private async writeAtomically(
    target: string,
    body: Uint8Array,
    path: string,
  ): Promise<void> {
    const temp = temporaryPathFor(target);
    try {
      await Deno.writeFile(temp, body);
    } catch (error) {
      await discard(temp);
      throw error;
    }
    try {
      await Deno.rename(temp, target);
    } catch (error) {
      await discard(temp);
      throw this.renameFailure(error, path);
    }
  }

  /**
   * Exclusive create for filesystems with no hard links (FAT32/exFAT: the
   * USB stick). `createNew` still refuses an occupied name, so the contract
   * holds — but here the name appears before the bytes do, leaving a window
   * in which a reader sees a short file. That window is what
   * capabilities.settleMs exists to cover.
   */
  private async createWithoutLink(
    target: string,
    body: Uint8Array,
    path: string,
  ): Promise<void> {
    let file: Deno.FsFile;
    try {
      file = await Deno.open(target, { createNew: true, write: true });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw this.alreadyTaken(path);
      }
      throw error;
    }

    let failure: unknown;
    try {
      let written = 0;
      while (written < body.length) {
        const chunk = await file.write(body.subarray(written));
        // A short write is normal and the loop handles it; a zero-length one
        // means no progress is possible and would spin here forever.
        if (chunk <= 0) {
          throw new SyncError(
            `Writing ${path} to ${this.root} stalled after ${written} of ` +
              `${body.length} bytes`,
            "server-error",
          );
        }
        written += chunk;
      }
    } catch (error) {
      failure = error;
    } finally {
      file.close();
    }
    if (failure !== undefined) {
      // The close above has to come first: Windows will not delete a file
      // that is still open. Leaving a short file behind would be worse than
      // the failure itself — the name would be taken, so every later
      // attempt at this journal entry would report precondition-failed.
      await discard(target);
      throw failure;
    }
  }

  /**
   * Move a subtree entry by entry, for what a directory rename cannot do: a
   * destination that already exists (rename will not merge into one) and a
   * subtree spanning two filesystems, which happens inside a single root as
   * soon as a subdirectory is its own mount point or a Windows junction.
   */
  private async moveByWalk(
    source: string,
    target: string,
    path: string,
  ): Promise<void> {
    const info = await lstatOrUndefined(source);
    if (info === undefined) {
      throw new SyncError(
        `Cannot move ${path}: the source is not in ${this.root}`,
        "not-found",
      );
    }
    if (!info.isDirectory) {
      await this.relocateFile(source, target, path);
      return;
    }

    await Deno.mkdir(target, { recursive: true });
    for await (const child of Deno.readDir(source)) {
      const childPath = `${path}/${child.name}`;
      const from = join(source, child.name);
      const to = join(target, child.name);
      if (child.isDirectory) await this.moveByWalk(from, to, childPath);
      else await this.relocateFile(from, to, childPath);
    }
    // Non-recursive on purpose: if something wrote into the directory while
    // we walked it, this fails loudly instead of deleting a file that was
    // never moved.
    await Deno.remove(source);
  }

  private async relocateFile(
    source: string,
    target: string,
    path: string,
  ): Promise<void> {
    try {
      await Deno.rename(source, target);
      return;
    } catch (error) {
      if (!isWalkableRenameFailure(error)) throw error;
    }
    // A rename across two filesystems cannot work at all, so copy instead —
    // through the same temp-and-rename put() uses, so a watching drive
    // client still never sees a half-copied file — and only then drop the
    // original.
    await this.writeAtomically(target, await Deno.readFile(source), path);
    await Deno.remove(source);
  }

  // ---- failures ----

  private alreadyTaken(path: string): SyncError {
    return new SyncError(
      `Refusing to overwrite ${path}: it already exists in ${this.root}`,
      "precondition-failed",
    );
  }

  /**
   * The error to raise for a rename that failed.
   *
   * Windows refuses to replace a file another process holds open, and a
   * cloud client indexing the folder holds files open constantly. The write
   * lands a moment later, so this has to stay retryable rather than stop
   * sync over a lock — on POSIX the same rename would simply have succeeded.
   */
  private renameFailure(error: unknown, path: string): unknown {
    if (error instanceof Deno.errors.PermissionDenied) {
      return new SyncError(
        `Could not replace ${path} in ${this.root}: it is open in another ` +
          `program, most likely the drive client indexing the folder. This ` +
          `usually succeeds on the next attempt.`,
        "server-error",
      );
    }
    return error;
  }

  /** Map a filesystem failure onto the codes the engine reacts to. */
  private mapError(error: unknown, action: string, path: string): SyncError {
    if (error instanceof SyncError) return error;
    const what = `${action} ${JSON.stringify(path)} in ${this.root}`;
    const detail = error instanceof Error ? error.message : String(error);

    if (error instanceof Deno.errors.NotFound) {
      return new SyncError(`Cannot ${what}: it is not there`, "not-found");
    }
    if (
      error instanceof Deno.errors.PermissionDenied ||
      error instanceof Deno.errors.NotCapable
    ) {
      return new SyncError(`Cannot ${what}: ${detail}`, "forbidden");
    }
    if (error instanceof Deno.errors.AlreadyExists) {
      return new SyncError(
        `Cannot ${what}: something else is already there`,
        "conflict",
      );
    }
    if (
      error instanceof Deno.errors.IsADirectory ||
      error instanceof Deno.errors.NotADirectory
    ) {
      return new SyncError(`Cannot ${what}: ${detail}`, "corrupt-data");
    }
    // Everything left — EIO from a failing stick, ESTALE from an NFS mount
    // that reconnected, a OneDrive placeholder that could not be hydrated —
    // is much more often a bad minute than a bad folder, so it stays
    // retryable and the engine backs off instead of switching sync off.
    return new SyncError(`Cannot ${what}: ${detail}`, "server-error");
  }
}

/** Validated, separator-free segments of a store path. */
function segmentsOf(path: string): string[] {
  assertSafePath(path);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    // assertSafePath splits on "/" only, but Windows separates on "\" as
    // well, so a segment like "..\\.." reaches here intact and would name a
    // file outside the root once join() normalized it away.
    if (segment.includes("\\")) {
      throw new SyncError(
        `Backslash in store path ${JSON.stringify(path)}`,
        "corrupt-data",
      );
    }
  }
  return segments;
}

/**
 * A temp name beside its destination. The leading dot and the .tmp suffix
 * are both load-bearing: list() hides them, so a file that is still being
 * written is never mistaken for a journal entry or an object. The random
 * middle keeps two processes writing the same destination — two app windows,
 * or two machines sharing one NAS folder — off each other's temp file.
 */
function temporaryPathFor(target: string): string {
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  const suffix = Array.from(
    random,
    (byte) => byte.toString(16).padStart(2, "0"),
  )
    .join("");
  return join(dirname(target), `.${basename(target)}.${suffix}.tmp`);
}

/**
 * Only this store's own in-flight writes are hidden, matched by the exact
 * shape temporaryPathFor produces. Hiding every dotfile would also hide
 * `.staging-<generation>` and `.retired-<timestamp>`, which the rebuild path
 * creates at the repository root and then expects to find again.
 */
const TEMPORARY_NAME = /^\..+\.[0-9a-f]{16}\.tmp$/;

function isHiddenName(name: string): boolean {
  return TEMPORARY_NAME.test(name);
}

/**
 * FAT32 and exFAT have no hard links, and the kernel reports that as a bare
 * EPERM rather than anything more specific; a Windows share that does not
 * support them answers much the same way.
 */
function isHardLinkUnsupported(error: unknown): boolean {
  if (error instanceof Deno.errors.NotSupported) return true;
  if (error instanceof Deno.errors.PermissionDenied) return true;
  const code = errnoOf(error);
  return code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "ENOSYS";
}

/**
 * Rename failures a file-by-file walk can still get past. Deno surfaces
 * these as plain Errors carrying an errno rather than as one of its own
 * error classes, so the code is the only thing to match on.
 */
function isWalkableRenameFailure(error: unknown): boolean {
  if (error instanceof Deno.errors.AlreadyExists) return true;
  if (error instanceof Deno.errors.NotSupported) return true;
  const code = errnoOf(error);
  return code === "ENOTEMPTY" || code === "EEXIST" || code === "EXDEV";
}

function errnoOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function statOrUndefined(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function lstatOrUndefined(
  path: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function realPathOrUndefined(
  path: string,
): Promise<string | undefined> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

/**
 * Best-effort cleanup of a file the caller has given up on. A failure here
 * must not replace the error that made it give up: a stray temp file is
 * invisible to list() and costs a few bytes, while a masked error costs the
 * user any chance of understanding what went wrong.
 */
async function discard(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // Deliberately ignored; see above.
  }
}
