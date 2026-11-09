import { readdir } from "node:fs/promises";
import path from "node:path";
import { config as loadEnvFile } from "dotenv";
import { openBackupStore, openDocumentSource, readBackupConfig, readDatabaseSource } from "./backup/config";
import { listDatabaseBackups, pgClient, pruneDatabaseBackups, runDatabaseBackup } from "./backup/db-backup";
import { restoreDatabaseBackup } from "./backup/db-restore";
import { readAttachmentInventory, restoreDocuments, runDocumentsBackup } from "./backup/documents";
import { createLogger, describeFailure } from "./backup/log";
import { readState } from "./backup/notify";
import { selectRetained } from "./backup/retention";
import { LocalDirStore } from "./backup/store";

// STSLV AMC operations commands (backups and restore drills). Run on the server by systemd with the settings in
// /etc/stslv-amc/backup.env, or by an administrator with --env-file <file>. Never reads the API's .env by itself.
//
//   node dist/ops/cli.js db-backup                                    encrypted backup -> off-site store, then retention
//   node dist/ops/cli.js db-list                                      complete backups and what retention would keep
//   node dist/ops/cli.js db-prune [--apply]                           retention only (a dry run without --apply)
//   node dist/ops/cli.js db-restore-drill --target-db stslv_restore_<name> [--backup <id>|latest] [--drop-after]
//   node dist/ops/cli.js docs-backup [--verify-source]                encrypted copies of the document bucket
//   node dist/ops/cli.js docs-restore --to-dir <empty folder> [--run <id>|latest] [--current-only]
//   node dist/ops/cli.js status                                       last success/failure of each job
//
// Exit codes: 0 success, 1 failure, 2 finished with problems that need attention (e.g. missing documents,
// restore drill mismatches), 64 wrong usage.

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

async function main(): Promise<number> {
  const { command, flags } = args(process.argv.slice(2));
  const envFile = text(flags, "env-file");

  if (envFile) loadEnvFile({ path: path.resolve(envFile), quiet: true });

  const vars = process.env;
  const config = readBackupConfig(vars);
  const log = createLogger(config.secrets);

  try {
    switch (command) {
      case "db-backup": {
        await runDatabaseBackup({ config, source: readDatabaseSource(vars), store: openBackupStore(vars), log });
        return 0;
      }
      case "db-list": {
        const store = openBackupStore(vars);
        const backups = await listDatabaseBackups(store);
        const decision = selectRetained(backups, config.retention);
        for (const backup of backups) {
          log.info("db_backup.listed", { id: backup.id, createdAt: backup.createdAt.toISOString(), retention: decision.reasons[backup.id] ?? ["would be removed"] });
        }
        return 0;
      }
      case "db-prune": {
        const store = openBackupStore(vars);
        const backups = await listDatabaseBackups(store);
        if (flags.get("apply") !== true) {
          const decision = selectRetained(backups, config.retention);
          log.info("db_prune.dry_run", { keep: decision.keep.length, wouldRemove: decision.remove });
          return 0;
        }
        await pruneDatabaseBackups({ store, config, log, keepId: backups[0]?.id ?? "" });
        return 0;
      }
      case "db-restore-drill": {
        const targetDb = text(flags, "target-db");
        if (!targetDb) {
          log.error("usage", { message: "--target-db stslv_restore_<name> is required" });
          return 64;
        }
        const source = vars.DB_HOST && vars.DB_NAME ? { host: vars.DB_HOST, database: vars.DB_NAME } : null;
        const report = await restoreDatabaseBackup({
          store: openBackupStore(vars),
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
        const source = readDatabaseSource(vars);
        const manifest = await runDocumentsBackup({
          config,
          source: openDocumentSource(vars),
          store: openBackupStore(vars),
          log,
          verifySource: flags.get("verify-source") === true,
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
          store: openBackupStore(vars),
          runId: text(flags, "run") ?? "latest",
          destination: new LocalDirStore(path.resolve(dir)),
          gpg: { gpgPath: config.gpg.gpgPath, ...(config.gpg.homeDir ? { homeDir: config.gpg.homeDir } : {}), ...(vars.BACKUP_GPG_PASSPHRASE_FILE ? { passphraseFile: vars.BACKUP_GPG_PASSPHRASE_FILE } : {}) },
          workDir: config.workDir,
          log,
          currentOnly: flags.get("current-only") === true,
        });
        return report.failed.length > 0 ? 2 : 0;
      }
      case "status": {
        for (const job of ["db-backup", "docs-backup"]) log.info("job.state", { ...(await readState(config.stateDir, job)) });
        return 0;
      }
      default:
        log.error("usage", { message: "Commands: db-backup, db-list, db-prune [--apply], db-restore-drill, docs-backup, docs-restore, status. See src/ops/cli.ts." });
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
