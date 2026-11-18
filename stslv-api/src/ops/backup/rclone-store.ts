import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { looksEncrypted } from "./config-backup";
import { childEnv, runTool } from "./tools";
import { assertObjectKey, ObjectExistsError, type ObjectInfo, type WritableStore } from "./store";

// Off-site backups in Google Drive (approved 2026-11-18): My Drive / "STS-ELV Backup", through rclone.
//
// Layout — one sub-folder per recovery-point type, each a complete, independently restorable set:
//   STS-ELV Backup/Daily/   db/…  docs/…  (database + documents)
//   STS-ELV Backup/Weekly/  db/…  docs/…  config/…  (+ VPS configuration)
//   STS-ELV Backup/Monthly/ db/…  docs/…  config/…
// The destination is the folder's Drive ID (BACKUP_GDRIVE_FOLDER_ID), never a name: Drive allows several folders
// with the same name. Before each run `verifyDestination` checks that the ID is a folder with the expected name.
//
// Safety, enforced here whatever the caller does:
//   - only ENCRYPTED data (OpenPGP: backups AND manifests) or the tiny plain type markers are uploaded; anything else (a plain
//     dump, a tar, a key file) is refused before rclone is started;
//   - nothing is ever overwritten: an existing name is ObjectExistsError; rclone runs with --immutable;
//   - every upload is checked: exactly one file of that name, the right size and the right MD5 (Drive's checksum);
//     the callers then download it again and compare SHA-256 (BACKUP_VERIFY_DOWNLOAD);
//   - removing goes to the Drive trash (rclone's default), so a pruned backup can still be recovered for 30 days;
//   - Drive errors are retried by rclone (pacer, --retries, --low-level-retries); an expired or revoked
//     authorization, a full Drive and rate limits are reported in plain words (and alerted by the callers).
//
// The rclone configuration (with the OAuth token) lives on the VPS in /var/lib/stslv-amc-backup/rclone/rclone.conf,
// owned by stslv-backup, mode 0600 — rclone writes the refreshed token back there. Never in GitHub or the app.

export const GDRIVE_KIND_FOLDERS = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" } as const;

export interface RcloneStoreOptions {
  /** The command that runs rclone, e.g. ["rclone"] or, in tests, [node, fake-rclone.cjs]. */
  command: string[];
  /** rclone configuration file (holds the OAuth token). */
  configFile: string;
  /** The remote name in that file, e.g. "stselv-gdrive". */
  remote: string;
  /** Drive ID of "STS-ELV Backup". */
  folderId: string;
  /** Sub-folder for this store, e.g. "Daily". */
  subFolder: string;
  timeoutMs?: number;
  /**
   * Names of environment variables passed to rclone, read at each call. rclone otherwise gets a minimal environment
   * (PATH, HOME, temp folders): never the database password or other secrets of the backup job. Tests only.
   */
  passEnv?: readonly string[];
}

export class RcloneError extends Error {
  constructor(message: string, readonly kind: "auth" | "quota" | "rate-limit" | "not-found" | "other") {
    super(message);
    this.name = "RcloneError";
  }
}

const COMMON_FLAGS = ["--retries", "3", "--low-level-retries", "10", "--retry-sleep", "10s", "--stats", "0", "--log-level", "ERROR", "--use-json-log=false"];
/** "<id>.kind-<daily|weekly|monthly>.json": the only plain (unencrypted) objects, holding id, type and times. */
const KIND_MARKER_KEY = /\.kind-(daily|weekly|monthly)\.json$/;
const MAX_MARKER_BYTES = 1024;

/** Turns rclone's error output into a plain explanation, without echoing tokens or paths of the config file. */
export function describeRcloneFailure(stderr: string): RcloneError {
  const text = stderr.replace(/"access_token"\s*:\s*"[^"]*"/g, '"access_token":"<redacted>"').replace(/"refresh_token"\s*:\s*"[^"]*"/g, '"refresh_token":"<redacted>"');
  if (/invalid_grant|token (has been )?expired|unauthorized_client|couldn't fetch token|oauth2: cannot fetch token|401 Unauthorized|Invalid Credentials/i.test(text)) {
    return new RcloneError("Google Drive authorization has expired or was revoked: authorize rclone again (docs/BACKUP_AUTOMATION.md \"Google Drive\").", "auth");
  }
  if (/storageQuotaExceeded|quotaExceeded|insufficient storage|The user's Drive storage quota has been exceeded/i.test(text)) {
    return new RcloneError("Google Drive is full (storage quota exceeded): free space or upgrade the storage plan.", "quota");
  }
  if (/rateLimitExceeded|userRateLimitExceeded|403 .*rate|429/i.test(text)) {
    return new RcloneError("Google Drive refused the requests because of its rate limits, even after retries; the next run will try again.", "rate-limit");
  }
  if (/not found|directory not found|object not found|fileNotFound|404/i.test(text)) return new RcloneError("Not found in Google Drive.", "not-found");

  return new RcloneError(`rclone failed: ${text.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400)}`, "other");
}

async function md5File(file: string): Promise<string> {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface LsEntry {
  Path: string;
  Name: string;
  Size: number;
  ModTime?: string;
  IsDir: boolean;
  ID?: string;
  Hashes?: Record<string, string>;
}

export class RcloneStore implements WritableStore {
  readonly label: string;

  constructor(private readonly options: RcloneStoreOptions) {
    if (!/^[A-Za-z0-9_-]{10,}$/.test(options.folderId)) throw new Error("BACKUP_GDRIVE_FOLDER_ID is not a Google Drive folder ID.");
    if (!/^[A-Za-z0-9_.-]+$/.test(options.remote)) throw new Error("BACKUP_RCLONE_REMOTE must be a plain rclone remote name.");
    if (!/^[A-Za-z]+$/.test(options.subFolder)) throw new Error("Invalid backup sub-folder.");
    this.label = `Google Drive folder ${options.folderId.slice(0, 6)}…/${options.subFolder}`;
  }

  /** The same Drive folder, another recovery-point sub-folder. */
  withSubFolder(subFolder: string): RcloneStore {
    return new RcloneStore({ ...this.options, subFolder });
  }

  get subFolder(): string {
    return this.options.subFolder;
  }

  private remotePath(key = ""): string {
    if (key) assertObjectKey(key);
    return `${this.options.remote}:${this.options.subFolder}${key ? `/${key}` : ""}`;
  }

  private async rclone(args: string[], options: { root?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const [command, ...prefix] = this.options.command;
    const rootFlags = options.root === false ? [] : ["--drive-root-folder-id", this.options.folderId];
    const result = await runTool(command as string, [...prefix, "--config", this.options.configFile, ...COMMON_FLAGS, ...rootFlags, ...args], {
      env: childEnv(Object.fromEntries((this.options.passEnv ?? []).map((name) => [name, process.env[name]]))),
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 30 * 60_000,
    });

    if (result.code !== 0) throw describeRcloneFailure(result.stderrTail);

    return result.stdout;
  }

  private async entries(remotePath: string, flags: string[]): Promise<LsEntry[]> {
    try {
      return JSON.parse((await this.rclone(["lsjson", ...flags, remotePath])) || "[]") as LsEntry[];
    } catch (error) {
      if (error instanceof RcloneError && error.kind === "not-found") return [];
      throw error;
    }
  }

  /**
   * Confirms the destination before anything is written: the configured ID must be a folder in My Drive with the
   * expected name, the only folder of that name, and the recovery-point sub-folder must exist (created if absent).
   */
  async verifyDestination(expectedName: string): Promise<void> {
    // My Drive's top level (without the root-folder restriction), to check the ID against the folder's name.
    const rootListing = JSON.parse((await this.rclone(["lsjson", "--dirs-only", "--no-modtime", `${this.options.remote}:`], { root: false })) || "[]") as LsEntry[];
    const named = rootListing.filter((entry) => entry.IsDir && entry.Name === expectedName);

    if (named.length === 0) throw new Error(`There is no folder "${expectedName}" in My Drive.`);
    if (named.length > 1) throw new Error(`My Drive has ${named.length} folders named "${expectedName}": keep one (the configured ID) and rename the others.`);
    if (named[0]?.ID !== this.options.folderId) throw new Error(`The folder "${expectedName}" in My Drive is not the configured BACKUP_GDRIVE_FOLDER_ID: check the setting.`);

    const subFolders = await this.entries(`${this.options.remote}:`, ["--dirs-only", "--no-modtime"]);
    if (!subFolders.some((entry) => entry.IsDir && entry.Name === this.options.subFolder)) {
      await this.rclone(["mkdir", this.remotePath()]);
    }
  }

  /** Total, used and free bytes of the Drive (for the report and the low-space warning). */
  async about(): Promise<{ total?: number; used?: number; free?: number; trashed?: number }> {
    return JSON.parse(await this.rclone(["about", "--json", `${this.options.remote}:`], { root: false })) as { total?: number; used?: number; free?: number; trashed?: number };
  }

  async list(prefix: string): Promise<ObjectInfo[]> {
    const dir = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    const listing = await this.entries(dir ? this.remotePath(dir) : this.remotePath(), ["-R", "--files-only"]);

    return listing
      .map((entry) => ({ key: dir ? `${dir}/${entry.Path}` : entry.Path, size: entry.Size, ...(entry.ModTime ? { lastModified: new Date(entry.ModTime) } : {}) }))
      .filter((object) => object.key.startsWith(prefix))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  private async matching(key: string, withHash = false): Promise<LsEntry[]> {
    const slash = key.lastIndexOf("/");
    const dir = slash >= 0 ? key.slice(0, slash) : "";
    const name = slash >= 0 ? key.slice(slash + 1) : key;
    const listing = await this.entries(dir ? this.remotePath(dir) : this.remotePath(), ["--files-only", ...(withHash ? ["--hash", "--hash-type", "MD5"] : [])]);

    return listing.filter((entry) => entry.Name === name);
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertObjectKey(key);
    const found = await this.matching(key);
    if (found.length === 0) return null;
    if (found.length > 1) throw new Error(`Google Drive holds ${found.length} files named ${key}: refusing to guess.`);
    const entry = found[0] as LsEntry;

    return { key, size: entry.Size, ...(entry.ModTime ? { lastModified: new Date(entry.ModTime) } : {}) };
  }

  async download(key: string, destinationFile: string): Promise<void> {
    await this.head(key);
    await this.rclone(["copyto", this.remotePath(key), destinationFile]);
  }

  /** Refuses anything that is not encrypted backup data or a small JSON manifest/marker. */
  private async assertUploadable(key: string, sourceFile: string): Promise<void> {
    const info = await stat(sourceFile);
    const handle = await open(sourceFile, "r");
    const head = Buffer.alloc(Math.min(512, info.size));
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }

    if (key.endsWith(".gpg")) {
      if (!looksEncrypted(head)) throw new Error(`Refusing to upload ${key}: it is not encrypted.`);
      return;
    }
    // The only plain files: the tiny recovery-point type markers ({id, kind, time}); manifests are encrypted.
    if (KIND_MARKER_KEY.test(key) && info.size <= MAX_MARKER_BYTES) {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(sourceFile, "utf8");
      if (/PRIVATE KEY|BEGIN PGP|refresh_token|access_token/i.test(text)) throw new Error(`Refusing to upload ${key}: it contains key or token material.`);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const allowed = new Set(["id", "kind", "at", "promotedAt"]);
      if (Object.keys(parsed).some((field) => !allowed.has(field))) throw new Error(`Refusing to upload ${key}: a type marker holds only id, kind and times.`);
      return;
    }
    throw new Error(`Refusing to upload ${key}: only encrypted files (.gpg) and recovery-point type markers go to Google Drive.`);
  }

  async upload(key: string, sourceFile: string): Promise<void> {
    assertObjectKey(key);
    await this.assertUploadable(key, sourceFile);
    if ((await this.matching(key)).length > 0) throw new ObjectExistsError(key);

    const size = (await stat(sourceFile)).size;
    const md5 = await md5File(sourceFile);

    await this.rclone(["copyto", "--immutable", "--no-update-modtime", sourceFile, this.remotePath(key)]);

    const stored = await this.matching(key, true);
    if (stored.length !== 1) throw new Error(`Google Drive holds ${stored.length} files named ${key} after the upload.`);
    const entry = stored[0] as LsEntry;
    if (entry.Size !== size) throw new Error(`The copy of ${key} in Google Drive has the wrong size.`);
    const remoteMd5 = entry.Hashes?.md5 ?? entry.Hashes?.MD5;
    if (remoteMd5 && remoteMd5.toLowerCase() !== md5) throw new Error(`The copy of ${key} in Google Drive does not match its MD5 checksum.`);
  }

  /**
   * Copies a file into another recovery-point sub-folder on the Drive server (no download, no re-upload), then
   * checks the copy's size and MD5 against the original. An existing copy with the same content is accepted
   * (a promotion that was interrupted and is being finished); a different one is never overwritten.
   */
  async copyTo(key: string, target: RcloneStore): Promise<void> {
    assertObjectKey(key);
    const source = await this.matching(key, true);
    if (source.length !== 1) throw new Error(`Cannot copy ${key}: Google Drive holds ${source.length} files of that name.`);
    const original = source[0] as LsEntry;
    const existing = await target.matching(key, true);

    if (existing.length === 0) {
      await this.rclone(["copyto", "--immutable", this.remotePath(key), target.remotePath(key)]);
    }

    const copied = await target.matching(key, true);
    const sameHash = (a: LsEntry, b: LsEntry) => (a.Hashes?.md5 ?? a.Hashes?.MD5 ?? "x") === (b.Hashes?.md5 ?? b.Hashes?.MD5 ?? "y");
    if (copied.length !== 1 || copied[0]?.Size !== original.Size || !sameHash(copied[0] as LsEntry, original)) {
      throw new ObjectExistsError(`${target.subFolder}/${key} (a different file already has that name)`);
    }
  }

  /** Goes to the Drive trash (recoverable for 30 days), never a permanent deletion. */
  async remove(key: string): Promise<void> {
    assertObjectKey(key);
    if ((await this.matching(key)).length === 0) return;
    await this.rclone(["deletefile", "--drive-use-trash=true", this.remotePath(key)]);
  }
}
