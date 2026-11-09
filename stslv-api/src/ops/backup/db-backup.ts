import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { pgToolEnv, type BackupConfig, type DatabaseSource } from "./config";
import { checkRecipient, encryptFile } from "./gpg";
import { describeFailure, type Logger } from "./log";
import { pingHeartbeat, readState, sendAlert, writeState, type Fetch } from "./notify";
import { selectRetained } from "./retention";
import { newestFirst, newRunId } from "./run-id";
import { ObjectExistsError, type WritableStore } from "./store";
import { childEnv, parseToolMajorVersion, runTool, sha256File } from "./tools";

// The daily database backup:
//   1. Open a read-only REPEATABLE READ transaction on the source and export its snapshot.
//   2. Count every table's rows inside that snapshot, and read the latest applied migration.
//   3. pg_dump --snapshot=<that snapshot>: the dump holds exactly the counted rows, so a restore can be checked
//      row-for-row against the manifest.
//   4. Verify the dump with pg_restore --list (every counted table has its data entry).
//   5. Encrypt with the backup PUBLIC key; delete the plain dump at once.
//   6. Upload to the off-site store (never over an existing object); check size, then download it again and
//      compare its SHA-256.
//   7. Upload the manifest last: a backup without a manifest is incomplete and is never counted or restored.
//   8. Apply the retention policy (7 daily / 4 weekly / 12 monthly by default).
// Any failure: alert, heartbeat "fail", state file updated, exit code 1. The plain dump never outlives the run.

export const DB_PREFIX = "db/";
export const MANIFEST_FORMAT = 1;
const ID_PREFIX = "stslv-db";
const DUMP_TIMEOUT_MS = 40 * 60 * 1000;

export interface TableCount {
  schema: string;
  table: string;
  rows: number;
}

export interface DatabaseManifest {
  format: number;
  kind: "database";
  id: string;
  environment: string;
  createdAt: string;
  finishedAt: string;
  serverVersion: string;
  pgDumpVersion: string;
  schemas: string[];
  latestMigration: string | null;
  tables: TableCount[];
  totalRows: number;
  plain: { bytes: number; sha256: string };
  encrypted: { key: string; bytes: number; sha256: string; recipient: string };
}

export const dumpKey = (id: string) => `${DB_PREFIX}${id}.dump.gpg`;
export const manifestKey = (id: string) => `${DB_PREFIX}${id}.manifest.json`;

export function newBackupId(environment: string, now: Date): string {
  return newRunId(ID_PREFIX, environment, now);
}

export function pgClient(source: DatabaseSource): Client {
  if (source.sslMode === "no-verify") throw new Error("PGSSLMODE=no-verify is not allowed: the server certificate must be verified.");

  return new Client({
    host: source.host,
    port: source.port,
    database: source.database,
    user: source.user,
    password: source.password,
    // require / verify-ca / verify-full: TLS with certificate verification. Unset or disable: no TLS (local only).
    ssl: source.sslMode && source.sslMode !== "disable" ? { rejectUnauthorized: true } : false,
    application_name: "stslv-amc-backup",
    connectionTimeoutMillis: 20_000,
  });
}

/** Table names listed by `pg_restore --list` as having a data entry: "schema.table". */
export function tablesWithData(listing: string): Set<string> {
  const out = new Set<string>();

  for (const line of listing.split(/\r?\n/)) {
    // e.g. "3456; 0 16390 TABLE DATA public users postgres"
    const match = /^\d+;\s+\d+\s+\d+\s+TABLE DATA\s+(\S+)\s+(\S+)\s/.exec(line);
    if (match) out.add(`${match[1]}.${match[2]}`);
  }

  return out;
}

export interface DbBackupDeps {
  config: BackupConfig;
  source: DatabaseSource;
  store: WritableStore;
  log: Logger;
  now?: () => Date;
  fetchImpl?: Fetch;
}

export interface DbBackupResult {
  id: string;
  manifest: DatabaseManifest;
  pruned: string[];
}

export async function runDatabaseBackup(deps: DbBackupDeps): Promise<DbBackupResult> {
  const { config, source, store, log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const id = newBackupId(config.environment, startedAt);
  const runDir = path.join(config.workDir, id);
  const plainFile = path.join(runDir, "database.dump");
  const encryptedFile = path.join(runDir, "database.dump.gpg");
  const state = await readState(config.stateDir, "db-backup");

  log.info("db_backup.start", { id, store: store.label, schemas: config.schemas });

  try {
    await checkRecipient(config.gpg, config.gpg.recipient);

    const versionResult = await runTool(config.pgDumpPath, ["--version"], { env: childEnv({}), timeoutMs: 30_000 });
    const pgDumpMajor = parseToolMajorVersion(versionResult.stdout);

    if (versionResult.code !== 0 || pgDumpMajor === null) throw new Error("pg_dump was not found or did not report its version (PG_DUMP_PATH).");

    await mkdir(runDir, { recursive: true, mode: 0o700 });

    const client = pgClient(source);
    let manifestBase: Omit<DatabaseManifest, "finishedAt" | "plain" | "encrypted">;

    await client.connect();
    try {
      const serverVersion = (await client.query<{ server_version: string; num: string }>("SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS num")).rows[0];
      const serverMajor = Math.floor(Number(serverVersion?.num ?? 0) / 10000);

      if (pgDumpMajor < serverMajor) throw new Error(`pg_dump ${pgDumpMajor} is older than the database server (${serverMajor}). Install PostgreSQL ${serverMajor} client tools.`);

      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshot = (await client.query<{ id: string }>("SELECT pg_export_snapshot() AS id")).rows[0]?.id as string;
      const tableRows = await client.query<{ schema: string; table: string }>(
        `SELECT schemaname AS schema, tablename AS table FROM pg_tables WHERE schemaname = ANY($1::text[]) ORDER BY 1, 2`,
        [config.schemas]
      );

      if (tableRows.rows.length === 0) throw new Error("The source database has no tables in the configured schemas (BACKUP_DB_SCHEMAS).");

      const tables: TableCount[] = [];
      for (const { schema, table } of tableRows.rows) {
        const count = await client.query<{ rows: string }>(`SELECT count(*)::bigint AS rows FROM ${client.escapeIdentifier(schema)}.${client.escapeIdentifier(table)}`);
        tables.push({ schema, table, rows: Number(count.rows[0]?.rows ?? 0) });
      }

      let latestMigration: string | null = null;
      for (const schema of config.schemas) {
        const exists = await client.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [`${schema}.schema_migrations`]);
        if (exists.rows[0]?.ok) {
          const latest = await client.query<{ v: string | null }>(`SELECT max(version || '_' || name) AS v FROM ${client.escapeIdentifier(schema)}.schema_migrations`);
          latestMigration = latest.rows[0]?.v ?? null;
        }
      }

      const dump = await runTool(
        config.pgDumpPath,
        ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`, ...config.schemas.map((schema) => `--schema=${schema}`), `--file=${plainFile}`],
        { env: childEnv(pgToolEnv(source)), timeoutMs: DUMP_TIMEOUT_MS }
      );

      if (dump.code !== 0) throw new Error(`pg_dump failed (exit ${dump.code}): ${log.redact(dump.stderrTail.split(/\r?\n/).pop() ?? "")}`);

      manifestBase = {
        format: MANIFEST_FORMAT,
        kind: "database",
        id,
        environment: config.environment,
        createdAt: startedAt.toISOString(),
        serverVersion: serverVersion?.server_version ?? "unknown",
        pgDumpVersion: versionResult.stdout.trim(),
        schemas: config.schemas,
        latestMigration,
        tables,
        totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
      };
      await client.query("COMMIT");
    } finally {
      await client.end().catch(() => undefined);
    }

    // Verification of the plain dump before it is encrypted.
    const listing = await runTool(config.pgRestorePath, ["--list", plainFile], { env: childEnv({}), timeoutMs: 5 * 60_000 });

    if (listing.code !== 0) throw new Error("The dump could not be read back by pg_restore --list.");

    const withData = tablesWithData(listing.stdout);
    const missing = manifestBase.tables.filter((table) => !withData.has(`${table.schema}.${table.table}`));

    if (missing.length > 0) throw new Error(`The dump lacks data for ${missing.length} table(s), e.g. ${missing[0]?.schema}.${missing[0]?.table}.`);

    const plain = { bytes: (await stat(plainFile)).size, sha256: await sha256File(plainFile) };

    await encryptFile(config.gpg, config.gpg.recipient, plainFile, encryptedFile);
    await rm(plainFile, { force: true });

    const encrypted = { key: dumpKey(id), bytes: (await stat(encryptedFile)).size, sha256: await sha256File(encryptedFile), recipient: config.gpg.recipient };

    await store.upload(encrypted.key, encryptedFile, "application/pgp-encrypted");

    const uploaded = await store.head(encrypted.key);

    if (!uploaded || uploaded.size !== encrypted.bytes) throw new Error("The uploaded backup has the wrong size in the off-site store.");
    if (config.verifyDownload) {
      const check = path.join(runDir, "verify.gpg");
      await store.download(encrypted.key, check);
      if ((await sha256File(check)) !== encrypted.sha256) throw new Error("The uploaded backup does not match its checksum when downloaded again.");
      await rm(check, { force: true });
    }

    const manifest: DatabaseManifest = { ...manifestBase, finishedAt: now().toISOString(), plain, encrypted };
    const manifestFile = path.join(runDir, "manifest.json");

    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await store.upload(manifestKey(id), manifestFile, "application/json");

    log.info("db_backup.stored", { id, tables: manifest.tables.length, totalRows: manifest.totalRows, encryptedBytes: encrypted.bytes, latestMigration: manifest.latestMigration });

    // The backup is safely stored at this point: a pruning problem is reported but does not fail the run.
    let pruned: string[] = [];
    if (config.prune) {
      try {
        pruned = await pruneDatabaseBackups({ store, config, log, keepId: id });
      } catch (error) {
        const reason = describeFailure(error, log);
        log.warn("db_backup.prune_failed", { id, reason });
        await sendAlert(config.alertWebhookUrl, `[STSLV AMC ${config.environment}] Database backup ${id} succeeded, but removing old backups failed: ${reason}`, log, deps.fetchImpl);
      }
    }

    await writeState(config.stateDir, {
      ...state,
      lastSuccessAt: now().toISOString(),
      lastRunId: id,
      details: { encryptedBytes: encrypted.bytes, tables: manifest.tables.length, totalRows: manifest.totalRows, latestMigration: manifest.latestMigration, pruned: pruned.length },
    });
    await pingHeartbeat(config.heartbeatDbUrl, true, log, deps.fetchImpl);
    log.info("db_backup.done", { id, pruned: pruned.length });

    return { id, manifest, pruned };
  } catch (error) {
    const reason = error instanceof ObjectExistsError ? error.message : describeFailure(error, log);

    log.error("db_backup.failed", { id, reason });
    await writeState(config.stateDir, { ...state, lastFailureAt: now().toISOString(), lastFailure: reason, lastRunId: id }).catch(() => undefined);
    await sendAlert(config.alertWebhookUrl, `[STSLV AMC ${config.environment}] DATABASE BACKUP FAILED (${id}): ${reason}`, log, deps.fetchImpl);
    await pingHeartbeat(config.heartbeatDbUrl, false, log, deps.fetchImpl);
    throw error;
  } finally {
    // The plain dump and every temporary file are removed whatever happened.
    await rm(runDir, { recursive: true, force: true });
  }
}

/** Complete backups (those with a manifest) in the store, newest first. */
export async function listDatabaseBackups(store: WritableStore | Pick<WritableStore, "list">): Promise<{ id: string; createdAt: Date }[]> {
  const objects = await store.list(DB_PREFIX);

  return newestFirst(
    ID_PREFIX,
    objects.map((object) => /^db\/(.+)\.manifest\.json$/.exec(object.key)?.[1]).filter((id): id is string => typeof id === "string")
  );
}

/**
 * Removes backups outside the retention policy. Never removes the backup just made, never runs when fewer
 * complete backups exist than the daily count, and removes the manifest last (an interrupted prune leaves a
 * manifest-less dump, which is ignored and removed by the next prune).
 */
export async function pruneDatabaseBackups(input: { store: WritableStore; config: Pick<BackupConfig, "retention">; log: Logger; keepId: string }): Promise<string[]> {
  const { store, config, log, keepId } = input;
  const backups = await listDatabaseBackups(store);

  if (backups.length <= config.retention.daily) return [];

  const decision = selectRetained(backups, config.retention);
  const removed: string[] = [];

  for (const id of decision.remove) {
    if (id === keepId) continue;
    await store.remove(dumpKey(id));
    await store.remove(manifestKey(id));
    removed.push(id);
  }

  // Dumps whose manifest never arrived (an upload interrupted mid-way), older than two days.
  const complete = new Set(backups.map((backup) => backup.id));
  const cutoff = Date.now() - 2 * 86_400_000;
  for (const object of await store.list(DB_PREFIX)) {
    const id = /^db\/(.+)\.dump\.gpg$/.exec(object.key)?.[1];
    if (id && id !== keepId && !complete.has(id) && object.lastModified && object.lastModified.getTime() < cutoff) {
      await store.remove(object.key);
      log.warn("db_backup.incomplete_removed", { id });
    }
  }

  if (removed.length > 0) log.info("db_backup.pruned", { removed, kept: decision.keep.length });

  return removed;
}
