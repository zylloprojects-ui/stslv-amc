import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pgToolEnv, type DatabaseSource } from "./config";
import { dumpKey, listDatabaseBackups, manifestKey, MANIFEST_FORMAT, pgClient, type DatabaseManifest } from "./db-backup";
import { decryptFile, type GpgOptions } from "./gpg";
import type { Logger } from "./log";
import type { ReadableStore } from "./store";
import { childEnv, runTool, sha256File } from "./tools";

// Restores a backup into an ISOLATED database and proves it complete: checksums of the encrypted and decrypted
// file, a clean pg_restore, then every table's row count and the latest migration against the manifest.
//
// Guards (this is a drill / isolated recovery tool, never a way to overwrite production):
//   - the target database name must start with "stslv_restore_";
//   - the target must not be the configured source database (DB_HOST + DB_NAME);
//   - an existing target database must be empty; it is created when absent;
//   - pg_restore runs in a single transaction with --exit-on-error: a failure leaves the target empty.
// Needs the backup PRIVATE key in the GnuPG keyring, so it runs on an administrator's machine, not the server.
// Replacing the production database is a separate, approved, manual procedure (docs/BACKUP_AUTOMATION.md).

export const RESTORE_NAME_PATTERN = /^stslv_restore_[a-z0-9_]{1,40}$/;

export interface RestoreTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: string | null;
}

export interface RestoreReport {
  backupId: string;
  target: string;
  tablesChecked: number;
  totalRows: number;
  latestMigration: string | null;
  mismatches: string[];
  ok: boolean;
}

export async function readManifest(store: ReadableStore, id: string, workDir: string): Promise<DatabaseManifest> {
  const file = path.join(workDir, `${id}.manifest.json`);

  await store.download(manifestKey(id), file);

  const manifest = JSON.parse(await readFile(file, "utf8")) as DatabaseManifest;

  if (manifest.format !== MANIFEST_FORMAT || manifest.kind !== "database" || manifest.id !== id) throw new Error("The backup manifest is not a database manifest of this backup.");

  return manifest;
}

export async function resolveBackupId(store: ReadableStore, requested: string): Promise<string> {
  if (requested !== "latest") return requested;

  const newest = (await listDatabaseBackups(store))[0];

  if (!newest) throw new Error("There is no complete database backup in the store.");

  return newest.id;
}

export async function restoreDatabaseBackup(input: {
  store: ReadableStore;
  backupId: string;
  target: RestoreTarget;
  /** The production source, when known, so it can never be chosen as the target. */
  source?: Pick<DatabaseSource, "host" | "database"> | null;
  gpg: GpgOptions;
  pgRestorePath: string;
  workDir: string;
  log: Logger;
  dropAfter?: boolean;
}): Promise<RestoreReport> {
  const { store, target, log } = input;

  if (!RESTORE_NAME_PATTERN.test(target.database)) throw new Error('The restore target database name must start with "stslv_restore_" (lowercase letters, digits, underscores).');
  if (input.source && input.source.host === target.host && input.source.database === target.database) throw new Error("The restore target is the source database. Refused.");

  const id = await resolveBackupId(store, input.backupId);
  const runDir = path.join(input.workDir, `restore-${id}`);

  await mkdir(runDir, { recursive: true, mode: 0o700 });
  log.info("db_restore.start", { id, target: target.database });

  try {
    const manifest = await readManifest(store, id, runDir);
    const encryptedFile = path.join(runDir, "database.dump.gpg");
    const plainFile = path.join(runDir, "database.dump");

    await store.download(dumpKey(id), encryptedFile);
    if ((await sha256File(encryptedFile)) !== manifest.encrypted.sha256) throw new Error("The encrypted backup does not match the checksum in its manifest.");

    await decryptFile(input.gpg, encryptedFile, plainFile);
    await rm(encryptedFile, { force: true });
    if ((await sha256File(plainFile)) !== manifest.plain.sha256) throw new Error("The decrypted backup does not match the checksum in its manifest.");

    // Create the target, or check that an existing one is empty.
    const admin = pgClient({ ...target, database: "postgres" });
    await admin.connect();
    try {
      const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [target.database]);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(target.database)}`);
        log.info("db_restore.database_created", { target: target.database });
      }
    } finally {
      await admin.end().catch(() => undefined);
    }

    const db = pgClient(target);
    await db.connect();
    try {
      const used = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'"
      );
      if ((used.rows[0]?.n ?? 0) > 0) throw new Error("The restore target database is not empty. Use a new stslv_restore_* name.");
    } finally {
      await db.end().catch(() => undefined);
    }

    // --clean --if-exists: a dump made with --schema=public carries "CREATE SCHEMA public", which a new database
    // already has. The target was just checked to hold no table, so only that empty default schema is replaced.
    const restoreArgs = ["--no-owner", "--no-privileges", "--clean", "--if-exists", "--exit-on-error", "--single-transaction", `--dbname=${target.database}`, plainFile];
    const restored = await runTool(input.pgRestorePath, restoreArgs, {
      env: childEnv(pgToolEnv(target)),
      timeoutMs: 60 * 60_000,
    });

    await rm(plainFile, { force: true });
    if (restored.code !== 0) throw new Error(`pg_restore failed (exit ${restored.code}): ${log.redact(restored.stderrTail.split(/\r?\n/).pop() ?? "")}`);

    // Row-for-row comparison with the counts taken inside the dump's own snapshot.
    const check = pgClient(target);
    const mismatches: string[] = [];
    let latestMigration: string | null = null;
    let totalRows = 0;

    await check.connect();
    try {
      for (const table of manifest.tables) {
        const result = await check.query<{ rows: string }>(`SELECT count(*)::bigint AS rows FROM ${check.escapeIdentifier(table.schema)}.${check.escapeIdentifier(table.table)}`).catch(() => null);
        const rows = result ? Number(result.rows[0]?.rows ?? -1) : -1;
        totalRows += Math.max(rows, 0);
        if (rows !== table.rows) mismatches.push(`${table.schema}.${table.table}: expected ${table.rows}, restored ${rows < 0 ? "missing" : rows}`);
      }
      for (const schema of manifest.schemas) {
        const exists = await check.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [`${schema}.schema_migrations`]);
        if (exists.rows[0]?.ok) {
          latestMigration = (await check.query<{ v: string | null }>(`SELECT max(version || '_' || name) AS v FROM ${check.escapeIdentifier(schema)}.schema_migrations`)).rows[0]?.v ?? null;
        }
      }
    } finally {
      await check.end().catch(() => undefined);
    }

    if (latestMigration !== manifest.latestMigration) mismatches.push(`latest migration: expected ${manifest.latestMigration}, restored ${latestMigration}`);

    const report: RestoreReport = { backupId: id, target: target.database, tablesChecked: manifest.tables.length, totalRows, latestMigration, mismatches, ok: mismatches.length === 0 };

    log[report.ok ? "info" : "error"]("db_restore.verified", { ...report });

    if (input.dropAfter) {
      const cleanup = pgClient({ ...target, database: "postgres" });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE ${cleanup.escapeIdentifier(target.database)} WITH (FORCE)`);
        log.info("db_restore.database_dropped", { target: target.database });
      } finally {
        await cleanup.end().catch(() => undefined);
      }
    }

    return report;
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
