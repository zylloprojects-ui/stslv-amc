import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readBackupConfig, type DatabaseSource } from "../src/ops/backup/config";
import { dumpKey, listDatabaseBackups, manifestKey, pruneDatabaseBackups, runDatabaseBackup } from "../src/ops/backup/db-backup";
import { restoreDatabaseBackup } from "../src/ops/backup/db-restore";
import { docsManifestKey, encryptedDocKey, latestDocumentsRun, restoreDocuments, runDocumentsBackup } from "../src/ops/backup/documents";
import { newestFirst, newRunId, runIdTime } from "../src/ops/backup/run-id";
import { gpgPathArg } from "../src/ops/backup/gpg";
import { createLogger } from "../src/ops/backup/log";
import { readState } from "../src/ops/backup/notify";
import { LocalDirStore, ObjectExistsError, readOnly } from "../src/ops/backup/store";
import { childEnv, runTool, sha256File } from "../src/ops/backup/tools";

// End-to-end backup and restore on DISPOSABLE resources only: a throwaway PostgreSQL database created and dropped
// here (stslv_p0_src_*), a restore target (stslv_restore_*), a throwaway GnuPG key in a temporary keyring and
// temporary folders standing in for the off-site bucket and the document bucket. Nothing touches Neon, Supabase,
// stslv_amc_dev or the stslv_test schema.

const PG_DUMP = process.env.PG_DUMP_PATH ?? "pg_dump";
const PG_RESTORE = process.env.PG_RESTORE_PATH ?? "pg_restore";
const suffix = randomBytes(4).toString("hex");
const SOURCE_DB = `stslv_p0_src_${suffix}`;
const RESTORE_DB = `stslv_restore_p0_${suffix}`;
const DB_PASSWORD = process.env.DB_PASSWORD ?? "";

const server = { host: process.env.DB_HOST ?? "localhost", port: Number(process.env.DB_PORT ?? 5432), user: process.env.DB_USER ?? "postgres", password: DB_PASSWORD };
const source: DatabaseSource = { ...server, database: SOURCE_DB, sslMode: null };

let root = "";
let gnupgHome = "";
let fingerprint = "";
let toolsAvailable = false;
const lines: string[] = [];
const alerts: string[] = [];
const fetchImpl = async (url: string, init: { body?: string }) => {
  alerts.push(`${url} ${init.body ?? ""}`);
  return { ok: true, status: 200 };
};

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ ...server, database: "postgres" });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function backupVars(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "test",
    BACKUP_WORK_DIR: path.join(root, "work"),
    BACKUP_STATE_DIR: path.join(root, "state"),
    BACKUP_GPG_RECIPIENT: fingerprint,
    GNUPGHOME: gnupgHome,
    BACKUP_ALERT_WEBHOOK_URL: "https://alerts.example.invalid/hook",
    BACKUP_HEARTBEAT_DB_URL: "https://heartbeat.example.invalid/db",
    BACKUP_HEARTBEAT_DOCS_URL: "https://heartbeat.example.invalid/docs",
    PG_DUMP_PATH: PG_DUMP,
    PG_RESTORE_PATH: PG_RESTORE,
    DB_PASSWORD,
    ...extra,
  };
}

const logger = (secrets: string[]) => createLogger(secrets, (line) => lines.push(line));

// Each test starts without the restore target, whatever an earlier test left.
beforeEach(async () => {
  if (toolsAvailable) await admin((client) => client.query(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`));
});

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "stslv-p0-backup-"));
  gnupgHome = path.join(root, "gnupg");
  await mkdir(gnupgHome, { recursive: true, mode: 0o700 });

  const gpgEnv = childEnv({ GNUPGHOME: await gpgPathArg("gpg", gnupgHome) });
  const dumpVersion = await runTool(PG_DUMP, ["--version"], { env: childEnv({}), timeoutMs: 30_000 });
  const generated = await runTool("gpg", ["--batch", "--pinentry-mode", "loopback", "--passphrase", "", "--quick-gen-key", "STSLV backup test key <backup-test@example.invalid>", "default", "default", "never"], { env: gpgEnv, timeoutMs: 120_000 });
  const listed = await runTool("gpg", ["--batch", "--with-colons", "--list-keys"], { env: gpgEnv, timeoutMs: 30_000 });
  fingerprint = /^fpr:+([0-9A-F]{40,64}):/m.exec(listed.stdout)?.[1] ?? "";
  toolsAvailable = dumpVersion.code === 0 && generated.code === 0 && fingerprint !== "";

  if (!toolsAvailable) return;

  await admin((client) => client.query(`CREATE DATABASE ${SOURCE_DB}`));
  const db = new Client({ ...server, database: SOURCE_DB });
  await db.connect();
  await db.query(`
    CREATE TABLE schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO schema_migrations (version, name, checksum) VALUES ('0001', 'first', 'x'), ('0002', 'second', 'y');
    CREATE TABLE clients (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text NOT NULL);
    INSERT INTO clients (name) SELECT 'Client ' || g FROM generate_series(1, 25) g;
    CREATE TABLE invoices (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, client_id bigint REFERENCES clients (id), amount numeric(14,3) NOT NULL);
    INSERT INTO invoices (client_id, amount) SELECT (g % 25) + 1, g * 10.125 FROM generate_series(1, 40) g;
    CREATE TABLE empty_table (id int);
  `);
  await db.end();
}, 180_000);

afterAll(async () => {
  if (toolsAvailable) {
    await admin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${SOURCE_DB} WITH (FORCE)`);
      await client.query(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
    });
  }
  // gpg-agent may still hold its socket for a moment on Windows.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
}, 60_000);

describe("database backup and restore (disposable database)", () => {
  it("backs up, encrypts, stores off-site, verifies and restores row-for-row", async (context) => {
    if (!toolsAvailable) context.skip();

    const config = readBackupConfig(backupVars());
    const store = new LocalDirStore(path.join(root, "offsite"));
    const log = logger(config.secrets);

    const result = await runDatabaseBackup({ config, source, store, log, fetchImpl });

    // Manifest: counts taken in the dump's own snapshot, migration recorded.
    expect(result.manifest.tables).toEqual([
      { schema: "public", table: "clients", rows: 25 },
      { schema: "public", table: "empty_table", rows: 0 },
      { schema: "public", table: "invoices", rows: 40 },
      { schema: "public", table: "schema_migrations", rows: 2 },
    ]);
    expect(result.manifest.latestMigration).toBe("0002_second");
    expect(await store.head(dumpKey(result.id))).not.toBeNull();
    expect(await store.head(manifestKey(result.id))).not.toBeNull();

    // The stored file is encrypted (no PostgreSQL custom-format header) and matches its manifest checksum.
    const stored = path.join(root, "offsite", ...dumpKey(result.id).split("/"));
    expect((await readFile(stored)).subarray(0, 5).toString()).not.toBe("PGDMP");
    expect(await sha256File(stored)).toBe(result.manifest.encrypted.sha256);

    // No plain dump or temporary file is left on the server.
    expect(await readdir(path.join(root, "work")).catch(() => [])).toEqual([]);

    // State for the monitor, heartbeat pinged, no alert.
    const state = await readState(config.stateDir, "db-backup");
    expect(state.lastSuccessAt).not.toBeNull();
    expect(state.lastRunId).toBe(result.id);
    expect(alerts.filter((a) => a.includes("alerts.example.invalid"))).toEqual([]);
    expect(alerts.some((a) => a.startsWith("https://heartbeat.example.invalid/db "))).toBe(true);

    const report = await restoreDatabaseBackup({
      store: readOnly(store),
      backupId: "latest",
      target: { ...server, database: RESTORE_DB, sslMode: null },
      source: { host: server.host, database: SOURCE_DB },
      gpg: { gpgPath: "gpg", homeDir: gnupgHome },
      pgRestorePath: PG_RESTORE,
      workDir: path.join(root, "work"),
      log,
      dropAfter: true,
    });

    expect(report).toMatchObject({ ok: true, mismatches: [], tablesChecked: 4, totalRows: 67, latestMigration: "0002_second" });
    // Dropped after the drill.
    expect((await admin((client) => client.query("SELECT 1 FROM pg_database WHERE datname = $1", [RESTORE_DB]))).rowCount).toBe(0);
    // No log line carries the database password.
    if (DB_PASSWORD.length >= 3) expect(lines.join("\n")).not.toContain(DB_PASSWORD);
  }, 180_000);

  it("refuses a tampered backup, a non-isolated target and the source database", async (context) => {
    if (!toolsAvailable) context.skip();

    const config = readBackupConfig(backupVars());
    const store = new LocalDirStore(path.join(root, "offsite-tamper"));
    const log = logger(config.secrets);
    const { id } = await runDatabaseBackup({ config, source, store, log, fetchImpl });
    const restore = (database: string, sourceDb = SOURCE_DB) =>
      restoreDatabaseBackup({
        store,
        backupId: id,
        target: { ...server, database, sslMode: null },
        source: { host: server.host, database: sourceDb },
        gpg: { gpgPath: "gpg", homeDir: gnupgHome },
        pgRestorePath: PG_RESTORE,
        workDir: path.join(root, "work"),
        log,
      });

    await expect(restore("stslv_amc_dev")).rejects.toThrow(/must start with "stslv_restore_"/);
    await expect(restore(RESTORE_DB, RESTORE_DB)).rejects.toThrow(/is the source database/);

    const stored = path.join(root, "offsite-tamper", ...dumpKey(id).split("/"));
    const bytes = await readFile(stored);
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff;
    await writeFile(stored, bytes);

    await expect(restore(RESTORE_DB)).rejects.toThrow(/does not match the checksum/);
    // Nothing was created by the refused restore.
    expect((await admin((client) => client.query("SELECT 1 FROM pg_database WHERE datname = $1", [RESTORE_DB]))).rowCount).toBe(0);
  }, 180_000);

  it("refuses to restore into a database that is not empty", async (context) => {
    if (!toolsAvailable) context.skip();

    const config = readBackupConfig(backupVars());
    const store = new LocalDirStore(path.join(root, "offsite-nonempty"));
    const log = logger(config.secrets);
    const { id } = await runDatabaseBackup({ config, source, store, log, fetchImpl });

    await admin((client) => client.query(`CREATE DATABASE ${RESTORE_DB}`));
    const db = new Client({ ...server, database: RESTORE_DB });
    await db.connect();
    await db.query("CREATE TABLE something_important (id int)");
    await db.end();

    await expect(
      restoreDatabaseBackup({ store, backupId: id, target: { ...server, database: RESTORE_DB, sslMode: null }, gpg: { gpgPath: "gpg", homeDir: gnupgHome }, pgRestorePath: PG_RESTORE, workDir: path.join(root, "work"), log })
    ).rejects.toThrow(/not empty/);

    await admin((client) => client.query(`DROP DATABASE ${RESTORE_DB} WITH (FORCE)`));
  }, 180_000);

  it("on failure alerts without credentials, records the failure and leaves no files behind", async (context) => {
    if (!toolsAvailable) context.skip();

    const wrongPassword = "wrong-password-Zq81x";
    const config = readBackupConfig(backupVars({ DB_PASSWORD: wrongPassword }));
    const store = new LocalDirStore(path.join(root, "offsite-fail"));
    const log = logger(config.secrets);
    const before = alerts.length;

    await expect(runDatabaseBackup({ config, source: { ...source, password: wrongPassword, user: "stslv_no_such_role" }, store, log, fetchImpl })).rejects.toThrow();

    const sent = alerts.slice(before);
    expect(sent.some((a) => a.startsWith("https://alerts.example.invalid/hook") && a.includes("DATABASE BACKUP FAILED"))).toBe(true);
    expect(sent.some((a) => a.startsWith("https://heartbeat.example.invalid/db/fail"))).toBe(true);
    expect(sent.join("\n")).not.toContain(wrongPassword);
    expect(lines.join("\n")).not.toContain(wrongPassword);
    expect((await readState(config.stateDir, "db-backup")).lastFailure).toBeTruthy();
    expect(await readdir(path.join(root, "work")).catch(() => [])).toEqual([]);
    expect(await store.list("db/")).toEqual([]);
  }, 120_000);
});

describe("backup store and retention", () => {
  it("never overwrites an existing object", async () => {
    const store = new LocalDirStore(path.join(root, "overwrite"));
    const file = path.join(root, "one.txt");
    await writeFile(file, "first");
    await store.upload("db/a.txt", file);
    await writeFile(file, "second");

    await expect(store.upload("db/a.txt", file)).rejects.toBeInstanceOf(ObjectExistsError);
    const copy = path.join(root, "copy.txt");
    await store.download("db/a.txt", copy);
    expect(await readFile(copy, "utf8")).toBe("first");
    await expect(store.upload("../escape.txt", file)).rejects.toThrow(/Invalid object key/);
  });

  it("the read-only view has no write or delete operations", () => {
    const view = readOnly(new LocalDirStore(path.join(root, "ro"))) as unknown as Record<string, unknown>;

    expect(Object.keys(view).sort()).toEqual(["download", "head", "label", "list"]);
  });

  it("prunes complete backups outside 7 daily / 4 weekly / 12 monthly", async () => {
    const store = new LocalDirStore(path.join(root, "prune"));
    const file = path.join(root, "blob.txt");
    await writeFile(file, "x");
    // One backup a day for 400 days up to 2026-11-09.
    const ids: string[] = [];
    for (let day = 0; day < 400; day += 1) {
      const date = new Date(Date.UTC(2026, 10, 9 - day, 2, 15, 0));
      const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
      const id = `stslv-db-production-${stamp}-${day.toString(16).padStart(6, "0")}`;
      ids.push(id);
      await store.upload(dumpKey(id), file);
      await store.upload(manifestKey(id), file);
    }

    const removed = await pruneDatabaseBackups({ store, config: { retention: { daily: 7, weekly: 4, monthly: 12 } }, log: logger([]), keepId: ids[0] as string });
    const kept = await listDatabaseBackups(store);

    // 7 days, plus weeks and months not already covered: at most 7 + 4 + 12, at least 12 distinct months.
    expect(kept.length).toBeGreaterThanOrEqual(12);
    expect(kept.length).toBeLessThanOrEqual(23);
    expect(kept[0]?.id).toBe(ids[0]);
    expect(new Set(kept.map((backup) => backup.createdAt.toISOString().slice(0, 7))).size).toBe(12);
    expect(removed.length).toBe(400 - kept.length);
    // A removed backup loses both files.
    expect(await store.head(dumpKey(removed[0] as string))).toBeNull();
  }, 120_000);
});

describe("backup identifiers: newest is decided by time, never by the random suffix", () => {
  const withSuffix = (id: string, suffix: string) => id.replace(/[0-9a-f]{6}$/, suffix);
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 9, 2, 15, 0, ms));

  it("orders runs within the same second by their milliseconds", () => {
    // Random suffixes in the opposite order of time: a text sort would pick the oldest run.
    const oldest = withSuffix(newRunId("stslv-docs", "production", at(5)), "ffffff");
    const middle = withSuffix(newRunId("stslv-docs", "production", at(400)), "888888");
    const newest = withSuffix(newRunId("stslv-docs", "production", at(999)), "000000");

    expect(newest).toBe("stslv-docs-production-20261109T021500999Z-000000");
    expect(newestFirst("stslv-docs", [oldest, newest, middle]).map((run) => run.id)).toEqual([newest, middle, oldest]);
  });

  it("never lets the random suffix decide between runs of the same instant shown in whole seconds", () => {
    // The ids that caused the 2026-11-09 failure: same second, so a text sort ranked them by the random suffix.
    const first = "stslv-docs-production-20261109T021500Z-ffffff";
    const second = "stslv-docs-production-20261109T021500Z-000000";

    expect([first, second].sort().at(-1)).toBe(first);
    // Same time: ordered deterministically by identifier, the same answer on every machine and every call.
    expect(newestFirst("stslv-docs", [second, first]).map((run) => run.id)).toEqual(newestFirst("stslv-docs", [first, second]).map((run) => run.id));
  });

  it("reads identifiers written with whole seconds, and orders them among millisecond ones", () => {
    const legacy = "stslv-db-production-20261109T021500Z-ffffff";
    const later = "stslv-db-production-20261109T021500001Z-000000";
    const earlier = "stslv-db-production-20261109T021459999Z-ffffff";

    expect(runIdTime("stslv-db", legacy)?.toISOString()).toBe("2026-11-09T02:15:00.000Z");
    expect(newestFirst("stslv-db", [legacy, earlier, later]).map((run) => run.id)).toEqual([later, legacy, earlier]);
  });

  it("ignores anything that is not an identifier of that kind", () => {
    expect(newestFirst("stslv-db", ["stslv-docs-production-20261109T021500Z-ffffff", "stslv-db-production-2026-11-09-aaaaaa", "notes"])).toEqual([]);
    expect(runIdTime("stslv-db", "stslv-db-production-20261399T021500Z-aaaaaa")).toBeNull();
  });

  it("restores from the newest document manifest even when several runs share a second", async () => {
    const store = new LocalDirStore(path.join(root, "latest-docs"));
    const file = path.join(root, "manifest-blob.json");
    await writeFile(file, "{}");
    const ids = [
      withSuffix(newRunId("stslv-docs", "production", at(10)), "ffffff"),
      withSuffix(newRunId("stslv-docs", "production", at(500)), "aaaaaa"),
      withSuffix(newRunId("stslv-docs", "production", at(990)), "000000"),
    ];
    for (const id of ids) await store.upload(docsManifestKey(id), file);

    expect(await latestDocumentsRun(store)).toBe(ids[2]);
  });

  it("lists database backups made within the same second newest first", async () => {
    const store = new LocalDirStore(path.join(root, "latest-db"));
    const file = path.join(root, "db-blob.json");
    await writeFile(file, "{}");
    const ids = [
      withSuffix(newRunId("stslv-db", "production", at(10)), "ffffff"),
      withSuffix(newRunId("stslv-db", "production", at(500)), "aaaaaa"),
      withSuffix(newRunId("stslv-db", "production", at(990)), "000000"),
    ];
    for (const id of ids) await store.upload(manifestKey(id), file);

    expect((await listDatabaseBackups(store)).map((backup) => backup.id)).toEqual([ids[2], ids[1], ids[0]]);
  });
});

describe("document backup (temporary folders standing in for the buckets)", () => {
  const sourceRoot = () => path.join(root, "doc-source");
  const put = async (key: string, content: string) => {
    const file = path.join(sourceRoot(), ...key.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  const sha = (content: string) => createHash("sha256").update(content).digest("hex");
  const row = (id: number, storageKey: string, content: string, extra: Partial<{ sha256: string; is_current: boolean }> = {}) => ({
    id: String(id),
    document_id: String(id),
    version: 1,
    is_current: extra.is_current ?? true,
    entity_type: "amc_contracts",
    entity_id: "7",
    category: "SIGNED_CONTRACT",
    original_name: `contract-${id}.pdf`,
    mime_type: "application/pdf",
    size_bytes: String(content.length),
    sha256: extra.sha256 ?? sha(content),
    storage_key: storageKey,
    uploaded_at: new Date("2026-11-01T10:00:00Z"),
  });

  it("copies every file encrypted, reports missing and altered files, never overwrites, and restores verified copies", async (context) => {
    if (!toolsAvailable) context.skip();

    const config = readBackupConfig(backupVars());
    const store = new LocalDirStore(path.join(root, "doc-offsite"));
    const log = logger(config.secrets);
    await put("attachments/2026/11/a.pdf", "contract A");
    await put("attachments/2026/11/b.pdf", "report B");
    await put("attachments/2026/11/tampered.pdf", "changed on disk");
    await put("attachments/2026/11/orphan.pdf", "no database row");
    const rows = [
      row(1, "2026/11/a.pdf", "contract A"),
      row(2, "2026/11/b.pdf", "report B", { is_current: false }),
      row(3, "2026/11/missing.pdf", "never uploaded"),
      row(4, "2026/11/tampered.pdf", "original content"),
    ];
    const source = readOnly(new LocalDirStore(sourceRoot()));
    // A clock that keeps all three runs inside the same second, a few milliseconds apart, as on a fast machine:
    // "latest" must still be the last run, whatever the random part of the identifiers.
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 10, 9, 2, 15, 0, (tick += 3)));
    const run = () => runDocumentsBackup({ config, source, store, inventory: async () => rows, log, fetchImpl, now });
    const before = alerts.length;

    const first = await run();

    expect(first.summary).toMatchObject({ databaseRows: 4, bucketObjects: 4, copied: 2, "missing-in-bucket": 1, "checksum-mismatch": 1, "not-in-database": 1 });
    expect(alerts.slice(before).some((a) => a.includes("DOCUMENT BACKUP PROBLEMS"))).toBe(true);
    // Encrypted at rest: the stored copy is not the file.
    const stored = await readFile(path.join(root, "doc-offsite", ...encryptedDocKey("attachments/2026/11/a.pdf", sha("contract A")).split("/")));
    expect(stored.toString()).not.toContain("contract A");

    // Second run: nothing new to copy, nothing replaced.
    const objectsBefore = await store.list("docs/files/");
    const second = await run();
    expect(second.summary["already-backed-up"]).toBe(2);
    expect(second.summary.copied).toBe(0);
    expect(await store.list("docs/files/")).toEqual(objectsBefore);

    // A file changed in the bucket: a NEW version is stored, the earlier copy stays.
    await put("attachments/2026/11/a.pdf", "contract A, edited");
    rows[0] = row(1, "2026/11/a.pdf", "contract A, edited");
    await run();
    expect(await store.head(encryptedDocKey("attachments/2026/11/a.pdf", sha("contract A")))).not.toBeNull();
    expect(await store.head(encryptedDocKey("attachments/2026/11/a.pdf", sha("contract A, edited")))).not.toBeNull();

    // Restore into an isolated folder: checksums verified, missing file reported as unavailable.
    const target = new LocalDirStore(path.join(root, "doc-restore"));
    const report = await restoreDocuments({ store, runId: "latest", destination: target, gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: path.join(root, "work"), log });
    expect(report).toMatchObject({ restored: 4, unavailable: 1, failed: [] });
    expect(await readFile(path.join(root, "doc-restore", "attachments", "2026", "11", "a.pdf"), "utf8")).toBe("contract A, edited");
    expect(await readFile(path.join(root, "doc-restore", "attachments", "2026", "11", "orphan.pdf"), "utf8")).toBe("no database row");

    // Restoring again never overwrites what is there.
    const again = await restoreDocuments({ store, runId: "latest", destination: target, gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: path.join(root, "work"), log });
    expect(again).toMatchObject({ restored: 0, skippedExisting: 4 });

    // The production store can never be the restore destination.
    await expect(
      restoreDocuments({ store, runId: "latest", destination: target, productionLabel: target.label, gpg: { gpgPath: "gpg", homeDir: gnupgHome }, workDir: path.join(root, "work"), log })
    ).rejects.toThrow(/production document store/);
  }, 180_000);
});
