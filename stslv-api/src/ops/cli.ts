import { readdir } from "node:fs/promises";
import path from "node:path";
import { config as loadEnvFile } from "dotenv";
import { gdriveFolderName, openBackupStore, openDocumentSource, readBackupConfig, readDatabaseSource, type BackupConfig } from "./backup/config";
import { restoreConfigBackup, runConfigBackup } from "./backup/config-backup";
import { assertNoPrivateKey, assertPrivateFile } from "./backup/preflight";
import { promoteBackup } from "./backup/promote";
import { RcloneStore } from "./backup/rclone-store";
import type { WritableStore } from "./backup/store";
import { listDatabaseBackups, pgClient, pruneDatabaseBackups, runDatabaseBackup } from "./backup/db-backup";
import { restoreDatabaseBackup } from "./backup/db-restore";
import { readAttachmentInventory, restoreDocuments, runDocumentsBackup } from "./backup/documents";
import { createLogger, describeFailure } from "./backup/log";
import { readState } from "./backup/notify";
import { selectByKind } from "./backup/retention";
import { runScheduledBackup } from "./backup/scheduled";
import { acquireBackupLock, BACKUP_TIME_ZONE, BackupLockedError, isBackupKind, nextScheduledRuns, readScheduleState, type BackupKind } from "./backup/schedule";
import { LocalDirStore } from "./backup/store";

// STSLV AMC operations commands (backups and restore drills). Run on the server by systemd with the settings in
// /etc/stslv-amc/backup.env, or by an administrator with --env-file <file>. Never reads the API's .env by itself.
//
//   node dist/ops/cli.js scheduled-backup --kind daily|weekly|monthly what the timers run (see backup/schedule.ts):
//                                                                     daily (Sat–Thu) = database + documents;
//                                                                     weekly (Fridays) = + configuration, and on the
//                                                                     last Friday of the month it is the monthly backup
//   node dist/ops/cli.js schedule [--count 14]                        the next scheduled runs (18:00 Asia/Kolkata)
//   node dist/ops/cli.js db-backup                                    encrypted backup -> off-site store, then retention
//   node dist/ops/cli.js db-list                                      complete backups and what retention would keep
//   node dist/ops/cli.js db-prune [--apply]                           retention only (a dry run without --apply)
//   node dist/ops/cli.js db-restore-drill --target-db stslv_restore_<name> [--backup <id>|latest] [--drop-after]
//   node dist/ops/cli.js docs-backup [--verify-source]                encrypted copies of the document bucket
//   node dist/ops/cli.js docs-restore --to-dir <empty folder> [--run <id>|latest] [--current-only] [--local-layout]
//                                                                     --local-layout: files as "<key>", the VPS ATTACHMENTS_DIR layout
//   node dist/ops/cli.js config-restore --to-dir <empty folder> [--kind weekly|monthly] [--backup <id>|latest]
//                                                                     decrypts a configuration archive (admin PC, private key)
//   node dist/ops/cli.js config-backup                                uploads the encrypted configuration snapshot
//                                                                     made by deploy/hostinger/scripts/config-snapshot.sh
//   node dist/ops/cli.js status                                       last success/failure of each job
//   --kind daily|weekly|monthly on db-list, db-prune, db-restore-drill, docs-restore: which recovery-point type
//   (with Google Drive, which sub-folder: Daily, Weekly or Monthly). Default: daily.
//
// Exit codes: 0 success, 1 failure, 2 finished with problems that need attention (e.g. missing documents,
// restore drill mismatches), 64 wrong usage, 75 another backup is still running (backup commands never overlap:
// they all take the same lock and wait for a running backup to finish).

function args(argv: string[]): { command: string; flags: Map<string, string | true> } {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();

  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i] as string;
    if (!item.startsWith("--")) throw new Error(`Unexpected argument "${item}".`);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(item.slice(2), next);
      i += 1;
    } else {
      flags.set(item.slice(2), true);
    }
  }

  return { command, flags };
}

const text = (flags: Map<string, string | true>, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

type Vars = NodeJS.ProcessEnv;
type Log = ReturnType<typeof createLogger>;

async function databaseStep(config: BackupConfig, vars: Vars, log: Log, kind: BackupKind = "daily"): Promise<{ code: number; id: string }> {
  const store = await destination(vars, log, kind);
  const result = await runDatabaseBackup({ config, source: readDatabaseSource(vars), store, log, kind });
  return { code: 0, id: result.id };
}

async function documentsStep(config: BackupConfig, vars: Vars, log: Log, verifySource = false, kind: BackupKind = "daily"): Promise<number> {
  const source = readDatabaseSource(vars);
  const manifest = await runDocumentsBackup({
    config,
    source: openDocumentSource(vars),
    store: await destination(vars, log, kind),
    log,
    verifySource,
    inventory: async () => {
      const client = pgClient(source);
      await client.connect();
      try {
        return await readAttachmentInventory(client);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  });
  return manifest.summary["missing-in-bucket"] + manifest.summary["checksum-mismatch"] > 0 ? 2 : 0;
}

async function configurationStep(config: BackupConfig, vars: Vars, log: Log, kind: BackupKind = "weekly"): Promise<{ code: number; id: string }> {
  const result = await runConfigBackup({ config, store: await destination(vars, log, kind), log, kind });
  return { code: 0, id: result.id };
}

/**
 * The off-site store for a recovery-point type. Google Drive: the destination is verified first (the configured
 * folder ID is the one "STS-ELV Backup" in My Drive; the Daily/Weekly/Monthly sub-folder exists) and low free space
 * is reported.
 */
async function destination(vars: Vars, log: Log, kind: BackupKind): Promise<WritableStore> {
  const store = openBackupStore(vars, undefined, kind);
  if (vars.NODE_ENV === "production") {
    // The server may encrypt but never decrypt; the Google token stays private to the backup user.
    await assertNoPrivateKey(readBackupConfig(vars).gpg);
    if (store instanceof RcloneStore) await assertPrivateFile(vars.BACKUP_RCLONE_CONFIG ?? "", "The rclone configuration (Google OAuth token)");
  }
  if (store instanceof RcloneStore) {
    await store.verifyDestination(gdriveFolderName(vars));
    const space = await store.about().catch(() => null);
    if (space?.free !== undefined && space.free < 1024 ** 3) log.warn("gdrive.low_space", { freeBytes: space.free, totalBytes: space.total ?? null });
  }
  return store;
}

/** The recovery-point type a listing, prune or restore works on (Google Drive keeps one sub-folder per type). */
const kindFlag = (flags: Map<string, string | true>): BackupKind => {
  const value = text(flags, "kind") ?? "daily";
  if (!isBackupKind(value)) throw new Error("--kind must be daily, weekly or monthly.");
  return value;
};

/** A backup command run by hand: waits for a running backup (scheduled or not) instead of overlapping it. */
async function exclusively(config: BackupConfig, log: Log, job: string, work: () => Promise<number>): Promise<number> {
  let release: () => Promise<void>;
  try {
    release = await acquireBackupLock(config.stateDir, { label: job });
  } catch (error) {
    if (error instanceof BackupLockedError) {
      log.error("backup.locked", { job, holder: error.holder });
      return 75;
    }
    throw error;
  }
  try {
    return await work();
  } finally {
    await release();
  }
}

async function main(): Promise<number> {
  const { command, flags } = args(process.argv.slice(2));
  const envFile = text(flags, "env-file");

  if (envFile) loadEnvFile({ path: path.resolve(envFile), quiet: true });

  const vars = process.env;
  const config = readBackupConfig(vars);
  const log = createLogger(config.secrets);

  try {
    switch (command) {
      case "scheduled-backup": {
        const kind = text(flags, "kind");
        if (!isBackupKind(kind)) {
          log.error("usage", { message: "--kind daily|weekly|monthly is required" });
          return 64;
        }
        const result = await runScheduledBackup({
          kind,
          config,
          log,
          steps: {
            database: (kind) => databaseStep(config, vars, log, kind),
            documents: (kind) => documentsStep(config, vars, log, false, kind),
            configuration: (kind) => configurationStep(config, vars, log, kind),
          },
          promote: async (step, id, kind, from) => {
            if (step !== "database" && step !== "configuration") return;
            await destination(vars, log, kind);
            await promoteBackup({ step, id, from, to: kind, storeFor: (k) => openBackupStore(vars, undefined, k), workDir: config.workDir });
          },
        });
        return result.exitCode;
      }
      case "schedule": {
        const count = Number(text(flags, "count") ?? 14);
        for (const run of nextScheduledRuns(new Date(), Number.isInteger(count) && count > 0 && count <= 60 ? count : 14)) {
          log.info("schedule.next", { day: run.day, kind: run.kind, at_utc: run.at.toISOString(), time_zone: BACKUP_TIME_ZONE });
        }
        return 0;
      }
      case "db-backup": {
        return await exclusively(config, log, "db-backup", async () => (await databaseStep(config, vars, log)).code);
      }
      case "config-backup": {
        return await exclusively(config, log, "config-backup", async () => (await configurationStep(config, vars, log)).code);
      }
      case "db-list": {
        const store = openBackupStore(vars, undefined, kindFlag(flags));
        const backups = await listDatabaseBackups(store);
        const decision = selectByKind(backups, config.retention);
        for (const backup of backups) {
          log.info("db_backup.listed", { id: backup.id, createdAt: backup.createdAt.toISOString(), kind: backup.kind, retention: decision.reasons[backup.id] ?? ["would be removed"] });
        }
        return 0;
      }
      case "db-prune": {
        const store = openBackupStore(vars, undefined, kindFlag(flags));
        const backups = await listDatabaseBackups(store);
        if (flags.get("apply") !== true) {
          const decision = selectByKind(backups, config.retention);
          log.info("db_prune.dry_run", { keep: decision.keep.length, wouldRemove: decision.remove });
          return 0;
        }
        // Under the backup lock: never alongside a scheduled job's own pruning or promotion.
        return await exclusively(config, log, "db-prune", async () => {
          await pruneDatabaseBackups({ store, config, log, keepId: (await listDatabaseBackups(store))[0]?.id ?? "" });
          return 0;
        });
      }
      case "db-restore-drill": {
        const targetDb = text(flags, "target-db");
        if (!targetDb) {
          log.error("usage", { message: "--target-db stslv_restore_<name> is required" });
          return 64;
        }
        const source = vars.DB_HOST && vars.DB_NAME ? { host: vars.DB_HOST, database: vars.DB_NAME } : null;
        const report = await restoreDatabaseBackup({
          store: openBackupStore(vars, undefined, kindFlag(flags)),
          backupId: text(flags, "backup") ?? "latest",
          target: {
            host: vars.RESTORE_DB_HOST?.trim() || "localhost",
            port: Number(vars.RESTORE_DB_PORT?.trim() || 5432),
            user: vars.RESTORE_DB_USER?.trim() || "postgres",
            password: vars.RESTORE_DB_PASSWORD ?? "",
            database: targetDb,
            sslMode: vars.RESTORE_PGSSLMODE?.trim() || null,
          },
          source,
          gpg: { gpgPath: config.gpg.gpgPath, ...(config.gpg.homeDir ? { homeDir: config.gpg.homeDir } : {}), ...(vars.BACKUP_GPG_PASSPHRASE_FILE ? { passphraseFile: vars.BACKUP_GPG_PASSPHRASE_FILE } : {}) },
          pgRestorePath: config.pgRestorePath,
          workDir: config.workDir,
          log,
          dropAfter: flags.get("drop-after") === true,
        });
        return report.ok ? 0 : 2;
      }
      case "docs-backup": {
        return await exclusively(config, log, "docs-backup", () => documentsStep(config, vars, log, flags.get("verify-source") === true));
      }
      case "docs-restore": {
        const dir = text(flags, "to-dir");
        if (!dir) {
          log.error("usage", { message: "--to-dir <empty folder> is required" });
          return 64;
        }
        // An isolated destination only: a new or empty folder, never a folder that already holds documents.
        const existing = await readdir(path.resolve(dir)).catch(() => []);
        if (existing.length > 0) {
          log.error("usage", { message: "--to-dir must be a new or empty folder" });
          return 64;
        }
        const report = await restoreDocuments({
          store: openBackupStore(vars, undefined, kindFlag(flags)),
          runId: text(flags, "run") ?? "latest",
          destination: new LocalDirStore(path.resolve(dir)),
          gpg: { gpgPath: config.gpg.gpgPath, ...(config.gpg.homeDir ? { homeDir: config.gpg.homeDir } : {}), ...(vars.BACKUP_GPG_PASSPHRASE_FILE ? { passphraseFile: vars.BACKUP_GPG_PASSPHRASE_FILE } : {}) },
          workDir: config.workDir,
          log,
          currentOnly: flags.get("current-only") === true,
          layout: flags.get("local-layout") === true ? "local-folder" : "bucket",
        });
        return report.failed.length > 0 ? 2 : 0;
      }
      case "config-restore": {
        const dir = text(flags, "to-dir");
        if (!dir) {
          log.error("usage", { message: "--to-dir <new or empty folder> is required" });
          return 64;
        }
        if ((await readdir(path.resolve(dir)).catch(() => [])).length > 0) {
          log.error("usage", { message: "--to-dir must be a new or empty folder" });
          return 64;
        }
        await restoreConfigBackup({
          store: openBackupStore(vars, undefined, text(flags, "kind") ? kindFlag(flags) : "weekly"),
          backupId: text(flags, "backup") ?? "latest",
          toDir: path.resolve(dir),
          gpg: { gpgPath: config.gpg.gpgPath, ...(config.gpg.homeDir ? { homeDir: config.gpg.homeDir } : {}), ...(vars.BACKUP_GPG_PASSPHRASE_FILE ? { passphraseFile: vars.BACKUP_GPG_PASSPHRASE_FILE } : {}) },
          workDir: config.workDir,
          log,
        });
        return 0;
      }
      case "status": {
        for (const job of ["db-backup", "docs-backup", "config-backup"]) log.info("job.state", { ...(await readState(config.stateDir, job)) });
        log.info("schedule.state", { ...(await readScheduleState(config.stateDir)) });
        return 0;
      }
      default:
        log.error("usage", { message: "Commands: scheduled-backup --kind daily|weekly|monthly, schedule, db-backup, db-list, db-prune [--apply], db-restore-drill, docs-backup, docs-restore, config-backup, config-restore, status. See src/ops/cli.ts." });
        return 64;
    }
  } catch (error) {
    log.error("command.failed", { command, reason: describeFailure(error, log) });
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Configuration errors name variables, never values.
    process.stderr.write(`${error instanceof Error ? error.message : "Unexpected error"}\n`);
    process.exitCode = 1;
  }
);
