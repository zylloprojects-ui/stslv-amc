import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackupConfig } from "./config";
import { configArchiveKey, configKindKey, configManifestKey, listConfigBackups } from "./config-backup";
import { dumpKey, kindMarkerKey, listDatabaseBackups, manifestKey } from "./db-backup";
import { docsManifestKey } from "./documents";
import { describeFailure, type Logger } from "./log";
import { readState, writeState } from "./notify";
import type { RecoveryKind } from "./retention";
import { newestFirst } from "./run-id";
import { backupDay } from "./schedule";
import type { WritableStore } from "./store";
import { sha256File } from "./tools";

// Encrypted copies kept on the VPS as well as in Google Drive (approved 2026-11-18).
//
// The scheduled jobs (no second schedule) make each typed backup — database dump, configuration archive — FIRST in a
// local store on the VPS (BACKUP_LOCAL_COPY_DIR, e.g. /var/lib/stslv-amc-backup/local, owner stslv-backup, 0700),
// complete and verified, and only then upload THE SAME ENCRYPTED FILES to the Google Drive folder of their type
// (size + MD5 by rclone, then a download compared by SHA-256). So:
//   - a Google Drive failure never costs the backup: it stays on the VPS, the step FAILS and says so, it is not
//     recorded as done, and the next job uploads every local backup still missing in Drive before anything else;
//   - Drive and VPS hold byte-identical copies under one backup id.
// Documents (content-addressed encrypted copies) are written to the local store and to Drive by the same document
// job twice; they are never deleted (the same rule as in Drive).
//
// Local retention: the backups of the latest N calendar days (Asia/Kolkata, BACKUP_LOCAL_RETAIN_DAYS, default 7) —
// daily, weekly and monthly alike; for documents, the run manifests of those days (the shared encrypted files stay). Never removed: the newest backup, and any backup not confirmed present in its Drive
// folder (if Drive cannot be asked, nothing is removed). Only the local store's own folder is ever touched.
// Everything here is encrypted with the backup PUBLIC key; no plain copy and no private key is ever kept.

export type TypedStep = "database" | "configuration";

const DOCS_RUN_PREFIX = "stslv-docs";

export interface LocalCopySettings {
  store: WritableStore;
  /** The folder of the local store (for the free-space check). */
  dir: string;
  retainDays: number;
  /** Below this many free bytes on the folder's file system, no local copy is made (Drive only, logged). */
  minFreeBytes: number;
}

/** The objects of one typed backup, in upload order: data first, type marker, manifest LAST (the manifest marks it complete). */
export function typedBackupKeys(step: TypedStep, id: string, kind: RecoveryKind): string[] {
  return step === "database" ? [dumpKey(id), kindMarkerKey(id, kind), manifestKey(id)] : [configArchiveKey(id), configKindKey(id, kind), configManifestKey(id)];
}

const manifestOf = (step: TypedStep, id: string) => (step === "database" ? manifestKey(id) : configManifestKey(id));

/** Copies one object between stores and verifies it: never overwrites, and an existing copy must be identical. */
async function copyVerified(from: WritableStore, to: WritableStore, key: string, workDir: string, verifyDownload: boolean): Promise<"copied" | "present"> {
  const scratch = path.join(workDir, `replicate-${randomBytes(6).toString("hex")}`);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  try {
    const source = path.join(scratch, "source");
    await from.download(key, source);
    const size = (await stat(source)).size;
    const existing = await to.head(key);
    if (existing) {
      // Uploaded by an earlier, interrupted attempt: it must be the same file.
      if (existing.size !== size) throw new Error(`${key} already exists in the destination with a different size.`);
      return "present";
    }
    await to.upload(key, source);
    if (verifyDownload) {
      const check = path.join(scratch, "check");
      await to.download(key, check);
      if ((await sha256File(check)) !== (await sha256File(source))) throw new Error(`${key} does not match its checksum when downloaded again.`);
    }
    return "copied";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Uploads one complete local typed backup to its destination (manifest last), verified. */
export async function replicateBackup(input: { step: TypedStep; id: string; kind: RecoveryKind; from: WritableStore; to: WritableStore; workDir: string; verifyDownload: boolean }): Promise<void> {
  for (const key of typedBackupKeys(input.step, input.id, input.kind)) await copyVerified(input.from, input.to, key, input.workDir, input.verifyDownload);
}

/**
 * Uploads every complete local backup of the retention window that is missing from the Drive folder of its type
 * (a backup whose upload failed earlier). Returns the ids uploaded; throws if any could not be uploaded.
 */
export async function uploadMissingBackups(input: {
  local: WritableStore;
  storeFor: (kind: RecoveryKind) => WritableStore | Promise<WritableStore>;
  workDir: string;
  verifyDownload: boolean;
  log: Logger;
  skipIds?: readonly string[];
}): Promise<string[]> {
  const uploaded: string[] = [];
  const failures: string[] = [];
  const typed: { step: TypedStep; backups: { id: string; kind: RecoveryKind }[] }[] = [
    { step: "database", backups: await listDatabaseBackups(input.local) },
    { step: "configuration", backups: await listConfigBackups(input.local) },
  ];
  for (const { step, backups } of typed) {
    for (const backup of backups) {
      if (input.skipIds?.includes(backup.id)) continue;
      try {
        const remote = await input.storeFor(backup.kind);
        if (await remote.head(manifestOf(step, backup.id))) continue;
        await replicateBackup({ step, id: backup.id, kind: backup.kind, from: input.local, to: remote, workDir: input.workDir, verifyDownload: input.verifyDownload });
        uploaded.push(backup.id);
        input.log.info("local_copy.uploaded_late", { step, id: backup.id, kind: backup.kind });
      } catch (error) {
        failures.push(`${backup.id}: ${describeFailure(error, input.log)}`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} backup(s) kept on the VPS could not be uploaded to Google Drive: ${failures.join("; ")}`);
  return uploaded;
}

/** The plain list of encrypted document files one LOCAL document run references (local only, never uploaded). */
export const docsRefsKey = (runId: string) => `docs/refs/${runId}.json`;

/**
 * Records which encrypted document files a local document run references, as a plain JSON list of object keys
 * (the same names the files already have on disk: no content, no secret). The run's manifest itself is encrypted
 * with the public key, so without this list the server could never tell which shared document files are still
 * needed; with it, files no retained run references can be removed safely (pruneLocalCopies).
 */
export async function recordDocumentReferences(store: WritableStore, workDir: string, manifest: { id: string; entries: { encryptedKey: string | null }[] }): Promise<void> {
  const keys = [...new Set(manifest.entries.map((entry) => entry.encryptedKey).filter((key): key is string => typeof key === "string"))].sort();
  const scratch = path.join(workDir, `refs-${randomBytes(6).toString("hex")}.json`);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(scratch, `${JSON.stringify({ run: manifest.id, files: keys })}\n`, { mode: 0o600 });
    await store.upload(docsRefsKey(manifest.id), scratch);
  } finally {
    await rm(scratch, { force: true });
  }
}

async function readReferences(store: WritableStore, runId: string, workDir: string): Promise<string[] | null> {
  const scratch = path.join(workDir, `refs-read-${randomBytes(6).toString("hex")}.json`);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  try {
    if (!(await store.head(docsRefsKey(runId)))) return null;
    await store.download(docsRefsKey(runId), scratch);
    const parsed = JSON.parse(await readFile(scratch, "utf8")) as { run?: unknown; files?: unknown };
    if (parsed.run !== runId || !Array.isArray(parsed.files) || !parsed.files.every((key) => typeof key === "string")) return null;
    return parsed.files as string[];
  } catch {
    return null;
  } finally {
    await rm(scratch, { force: true });
  }
}

/**
 * Local retention for the latest `retainDays` calendar days (IST):
 *   - database backups: older ones are removed once confirmed in their Drive folder; the newest is always kept;
 *   - configuration backups: no longer made on the VPS (Drive-only); any left from earlier code or tests expire the
 *     same way once confirmed in Drive (no "keep the newest" rule, so they do not stay forever);
 *   - document runs: run manifests (and their reference lists) older than the window are removed, the newest kept;
 *   - document files (shared by every run holding that document version): removed only when NO retained run
 *     references them, only when EVERY retained run has its reference list (otherwise nothing is removed), and only
 *     when older than one day.
 * A backup not confirmed in Drive (`confirmedOffsite` false or failing) is never removed. Only the local store is
 * touched. Manifest first, then markers, then the data.
 */
export async function pruneLocalCopies(input: {
  local: WritableStore;
  retainDays: number;
  now: Date;
  confirmedOffsite: (step: TypedStep, id: string, kind: RecoveryKind) => Promise<boolean>;
  log: Logger;
  /** Scratch folder for reading reference lists (default: a temporary folder under the system temp dir). */
  workDir?: string;
}): Promise<string[]> {
  const removed: string[] = [];
  const oldestKeptDay = backupDay(new Date(input.now.getTime() - (input.retainDays - 1) * 86_400_000)).date;
  const typed: { step: TypedStep; keepNewest: boolean; backups: { id: string; createdAt: Date; kind: RecoveryKind }[] }[] = [
    { step: "database", keepNewest: true, backups: await listDatabaseBackups(input.local) },
    { step: "configuration", keepNewest: false, backups: await listConfigBackups(input.local) },
  ];

  for (const { step, keepNewest, backups } of typed) {
    // Newest first: index 0 is kept where the step still makes VPS copies (database).
    for (const backup of keepNewest ? backups.slice(1) : backups) {
      if (backupDay(backup.createdAt).date >= oldestKeptDay) continue;
      const offsite = await input.confirmedOffsite(step, backup.id, backup.kind).catch(() => false);
      if (!offsite) {
        input.log.warn("local_copy.kept_not_in_drive", { step, id: backup.id });
        continue;
      }
      const keys = typedBackupKeys(step, backup.id, backup.kind);
      const manifest = keys[2] as string;
      await input.local.remove(manifest);
      for (const kind of ["daily", "weekly", "monthly"] as const) await input.local.remove(typedBackupKeys(step, backup.id, kind)[1] as string);
      await input.local.remove(keys[0] as string);
      removed.push(backup.id);
    }
  }

  // Document runs: the run manifests of the latest `retainDays` days are kept, the newest always.
  const docRuns = newestFirst(
    DOCS_RUN_PREFIX,
    (await input.local.list("docs/manifests/")).map((object) => /^docs\/manifests\/(.+)\.json\.gpg$/.exec(object.key)?.[1]).filter((id): id is string => typeof id === "string")
  );
  const retainedRuns = docRuns.slice(0, 1).concat(docRuns.slice(1).filter((run) => backupDay(run.createdAt).date >= oldestKeptDay));
  for (const run of docRuns.slice(1)) {
    if (backupDay(run.createdAt).date >= oldestKeptDay) continue;
    await input.local.remove(docsManifestKey(run.id));
    await input.local.remove(docsRefsKey(run.id));
    removed.push(run.id);
  }

  // Document files no retained run references. Safe only when every retained run says what it references.
  const scratch = input.workDir ?? path.join(tmpdir(), "stslv-local-copy");
  const referenced = new Set<string>();
  let allKnown = retainedRuns.length > 0;
  for (const run of retainedRuns) {
    const keys = await readReferences(input.local, run.id, scratch);
    if (!keys) {
      allKnown = false;
      break;
    }
    for (const key of keys) referenced.add(key);
  }
  const fileCutoff = input.now.getTime() - 86_400_000;
  if (allKnown) {
    const unused: string[] = [];
    for (const object of await input.local.list("docs/files/")) {
      if (referenced.has(object.key)) continue;
      if (!object.lastModified || object.lastModified.getTime() >= fileCutoff) continue;
      await input.local.remove(object.key);
      unused.push(object.key);
    }
    if (unused.length > 0) input.log.info("local_copy.document_files_removed", { count: unused.length, retainedRuns: retainedRuns.length });
  } else if (retainedRuns.length > 0) {
    input.log.info("local_copy.document_files_kept", { reason: "a retained document run has no reference list (made before reference lists existed)" });
  }
  // Reference lists whose run manifest is gone (an interrupted prune), older than two days.
  const runIds = new Set(docRuns.map((run) => run.id));
  for (const object of await input.local.list("docs/refs/")) {
    const id = /^docs\/refs\/(.+)\.json$/.exec(object.key)?.[1];
    if (id && !runIds.has(id) && object.lastModified && object.lastModified.getTime() < input.now.getTime() - 2 * 86_400_000) await input.local.remove(object.key);
  }

  // Data files whose manifest never arrived (a local run interrupted mid-way), older than two days: not recoverable.
  const cutoff = input.now.getTime() - 2 * 86_400_000;
  const complete = new Set([...typed[0]!.backups, ...typed[1]!.backups].map((backup) => backup.id));
  for (const [prefix, pattern] of [["db/", /^db\/(.+)\.dump\.gpg$/], ["config/", /^config\/(.+)\.tar\.gpg$/]] as const) {
    for (const object of await input.local.list(prefix)) {
      const id = pattern.exec(object.key)?.[1];
      if (id && !complete.has(id) && object.lastModified && object.lastModified.getTime() < cutoff) {
        await input.local.remove(object.key);
        input.log.warn("local_copy.incomplete_removed", { id });
      }
    }
  }

  if (removed.length > 0) input.log.info("local_copy.pruned", { removed, retainDays: input.retainDays });
  return removed;
}

/** Free bytes on the file system holding `dir` (null if unknown). */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

/** True when a local copy may be written: enough free space (logged and recorded otherwise). */
export async function localCopyAllowed(settings: LocalCopySettings, log: Logger, free: (dir: string) => Promise<number | null> = freeBytes): Promise<boolean> {
  await mkdir(settings.dir, { recursive: true, mode: 0o700 });
  const available = await free(settings.dir);
  if (available !== null && available < settings.minFreeBytes) {
    log.error("local_copy.skipped_low_disk", { freeBytes: available, minFreeBytes: settings.minFreeBytes });
    return false;
  }
  return true;
}

/** Records a Google Drive failure for a backup that IS stored on the VPS, in that job's state file (read by `status`). */
export async function recordOffsiteFailure(config: Pick<BackupConfig, "stateDir">, job: string, id: string, reason: string, now: Date): Promise<void> {
  const state = await readState(config.stateDir, job);
  await writeState(config.stateDir, { ...state, lastFailureAt: now.toISOString(), lastFailure: `stored on the VPS (${id}), Google Drive copy failed: ${reason}`, lastRunId: id }).catch(() => undefined);
}

/**
 * One typed backup step with a local copy: `makeLocal` makes the complete, verified backup in the local store
 * (no pruning there); then the Drive copy is made — first any earlier local backups still missing in Drive, then this
 * one — and Drive retention applied. A Drive failure is thrown with a message that says the backup is on the VPS.
 * Local retention runs last, whatever happened in Drive.
 */
export async function runTypedStepWithLocalCopy(input: {
  step: TypedStep;
  kind: RecoveryKind;
  job: "db-backup" | "config-backup";
  local: LocalCopySettings;
  config: Pick<BackupConfig, "stateDir" | "workDir" | "verifyDownload">;
  log: Logger;
  makeLocal: () => Promise<{ id: string }>;
  openRemote: (kind: RecoveryKind) => Promise<WritableStore>;
  pruneRemote: (remote: WritableStore, keepId: string) => Promise<string[]>;
  now?: () => Date;
}): Promise<{ id: string }> {
  const now = input.now ?? (() => new Date());
  const { id } = await input.makeLocal();
  input.log.info("local_copy.stored", { step: input.step, id, kind: input.kind });

  let offsiteError: unknown = null;
  try {
    const remote = await input.openRemote(input.kind);
    await uploadMissingBackups({ local: input.local.store, storeFor: input.openRemote, workDir: input.config.workDir, verifyDownload: input.config.verifyDownload, log: input.log, skipIds: [id] }).catch((error) => {
      // Older backups still waiting: reported, but this backup is uploaded anyway.
      offsiteError = error;
    });
    await replicateBackup({ step: input.step, id, kind: input.kind, from: input.local.store, to: remote, workDir: input.config.workDir, verifyDownload: input.config.verifyDownload });
    input.log.info("local_copy.uploaded", { step: input.step, id, kind: input.kind });
    try {
      const pruned = await input.pruneRemote(remote, id);
      if (pruned.length > 0) input.log.info("offsite.pruned", { step: input.step, removed: pruned });
    } catch (error) {
      input.log.warn("offsite.prune_failed", { step: input.step, reason: describeFailure(error, input.log) });
    }
  } catch (error) {
    offsiteError = error;
  }

  try {
    await pruneLocalCopies({
      local: input.local.store,
      retainDays: input.local.retainDays,
      now: now(),
      log: input.log,
      workDir: input.config.workDir,
      confirmedOffsite: async (step, backupId, kind) => Boolean(await (await input.openRemote(kind)).head(manifestOf(step, backupId))),
    });
  } catch (error) {
    input.log.warn("local_copy.prune_failed", { reason: describeFailure(error, input.log) });
  }

  if (offsiteError) {
    const reason = describeFailure(offsiteError, input.log);
    input.log.error("offsite.failed", { step: input.step, id, reason });
    await recordOffsiteFailure(input.config, input.job, id, reason, now());
    throw new Error(`Backup ${id} is stored on the VPS, but the Google Drive copy failed: ${reason}`);
  }
  return { id };
}
