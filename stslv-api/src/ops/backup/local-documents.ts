import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { assertStorageKey } from "../../shared/storage";
import type { ObjectInfo, ReadableStore } from "./store";

// The VPS keeps uploaded documents in one local folder (ATTACHMENTS_DIR, /var/lib/stslv-amc/attachments), flat:
// "<uuid>.<ext>", exactly as the API's LocalDiskStorage writes them. The document backup speaks the bucket layout
// ("attachments/<key>", OBJECT_KEY_PREFIX in shared/object-storage.ts), so its manifests, encrypted copies and
// restores are the same whichever storage the server uses. This source maps one to the other, READ-ONLY:
//
//   - only REGULAR files directly in the folder whose names are keys the application generates are offered;
//     symbolic links, subfolders, hidden or temporary files and any other name are never listed or read
//     (they are counted and reported, so an unexpected file is noticed, but nothing unrelated is backed up);
//   - a key is validated before any path is built (no "..", no separators: shared/storage.ts assertStorageKey);
//   - a file is opened without following links (O_NOFOLLOW where the system has it), and the opened file must be
//     the same regular file that was checked (device and inode), inside the real folder; a file that changes size
//     while it is copied fails the copy instead of producing a torn backup;
//   - an EMPTY folder is normal (no documents yet); a MISSING folder is a configuration error and fails loudly.

export const LOCAL_SOURCE_PREFIX = "attachments/";

export interface LocalSourceScan {
  files: ObjectInfo[];
  /** Entries that are not application documents: never read. */
  ignored: { name: string; reason: "symbolic-link" | "not-a-file" | "unexpected-name" }[];
}

export class LocalAttachmentsSource implements ReadableStore {
  readonly label: string;
  /** Reading is local and cheap: the document backup re-hashes every file on every run (see documents.ts). */
  readonly cheapReads = true;
  private realRoot: string | null = null;
  private lastIgnored: LocalSourceScan["ignored"] = [];

  constructor(private readonly root: string) {
    this.label = `local folder ${path.resolve(root)}`;
  }

  /** The entries skipped by the last listing (for the run's report). */
  get ignored(): LocalSourceScan["ignored"] {
    return this.lastIgnored;
  }

  private async rootDir(): Promise<string> {
    if (this.realRoot) return this.realRoot;
    try {
      const resolved = await realpath(this.root);
      const info = await lstat(resolved);
      if (!info.isDirectory()) throw new Error("not a folder");
      this.realRoot = resolved;
      return resolved;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        code === "ENOENT"
          ? `The document folder ${path.resolve(this.root)} does not exist (ATTACHMENTS_DIR).`
          : code === "EACCES"
            ? `The backup user cannot read the document folder ${path.resolve(this.root)} (see docs/BACKUP_AUTOMATION.md "VPS permissions").`
            : `The document folder ${path.resolve(this.root)} cannot be used: ${(error as Error).message}`
      );
    }
  }

  /** The application key behind an "attachments/<key>" object key, or null when it is not one. */
  private keyOf(objectKey: string): string | null {
    if (!objectKey.startsWith(LOCAL_SOURCE_PREFIX)) return null;
    const key = objectKey.slice(LOCAL_SOURCE_PREFIX.length);
    try {
      assertStorageKey(key);
      return key;
    } catch {
      return null;
    }
  }

  async scan(): Promise<LocalSourceScan> {
    const root = await this.rootDir();
    const files: ObjectInfo[] = [];
    const ignored: LocalSourceScan["ignored"] = [];

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        ignored.push({ name: entry.name, reason: "symbolic-link" });
        continue;
      }
      if (!entry.isFile()) {
        ignored.push({ name: entry.name, reason: "not-a-file" });
        continue;
      }
      try {
        assertStorageKey(entry.name);
      } catch {
        ignored.push({ name: entry.name, reason: "unexpected-name" });
        continue;
      }
      const info = await lstat(path.join(root, entry.name));
      // Re-checked with lstat: the entry may have been replaced since the directory was read.
      if (!info.isFile()) {
        ignored.push({ name: entry.name, reason: info.isSymbolicLink() ? "symbolic-link" : "not-a-file" });
        continue;
      }
      files.push({ key: `${LOCAL_SOURCE_PREFIX}${entry.name}`, size: info.size, lastModified: info.mtime });
    }

    files.sort((a, b) => a.key.localeCompare(b.key));
    this.lastIgnored = ignored;

    return { files, ignored };
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    // Everything this source offers sits under "attachments/".
    if (!LOCAL_SOURCE_PREFIX.startsWith(prefix) && !prefix.startsWith(LOCAL_SOURCE_PREFIX)) return [];

    return (await this.scan()).files.filter((file) => file.key.startsWith(prefix));
  }

  async head(objectKey: string): Promise<ObjectInfo | null> {
    const key = this.keyOf(objectKey);
    if (!key) return null;

    try {
      const info = await lstat(path.join(await this.rootDir(), key));
      return info.isFile() ? { key: objectKey, size: info.size, lastModified: info.mtime } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async download(objectKey: string, destinationFile: string): Promise<void> {
    const key = this.keyOf(objectKey);
    if (!key) throw new Error(`Not an application document: "${objectKey.slice(0, 80)}".`);

    const root = await this.rootDir();
    const file = path.join(root, key);
    const before = await lstat(file);

    if (!before.isFile()) throw new Error(`${key} is not a regular file; it is not read.`);

    // O_NOFOLLOW: refuse a link swapped in after the check (Linux, macOS); 0 where the system has no such flag.
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error(`${key} changed while it was being opened; it is not read.`);
      if (path.dirname(await realpath(file)) !== root) throw new Error(`${key} is not inside the document folder; it is not read.`);

      await pipeline(createReadStream("", { fd: handle.fd, autoClose: false, start: 0 }), createWriteStream(destinationFile, { flags: "wx", mode: 0o600 }));

      const after = await handle.stat();
      const copied = await lstat(destinationFile);
      if (after.size !== opened.size || copied.size !== opened.size) {
        await rm(destinationFile, { force: true });
        throw new Error(`${key} changed size while it was being copied; it will be copied again by the next run.`);
      }
    } finally {
      await handle.close();
    }
  }
}
