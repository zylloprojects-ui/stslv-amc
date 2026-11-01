import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../../config/database";
import { env } from "../../config/env";
import { logActivity } from "../../shared/activity-log";
import { AppError, conflict, notFound } from "../../shared/errors";
import type { AuthContext } from "../auth/access";

// Manual database backups, run by the server with pg_dump and kept in a folder
// that must be configured on purpose (BACKUP_DIR). In production the folder must
// also be declared durable (BACKUP_STORAGE_DURABLE=true), because a hosting
// disk may not survive a restart. Until then nothing runs. There is no schedule
// and no restore: restoring is a supervised procedure outside the application.
//
// Connection details go to pg_dump through its environment, never its arguments,
// and its error output is never returned to the caller.

export type BackupState = "RUNNING" | "VERIFIED" | "FAILED";

export interface BackupRecord {
  id: string;
  state: BackupState;
  startedAt: string;
  finishedAt: string | null;
  startedBy: string;
  sizeBytes: number | null;
  sha256: string | null;
  tableEntries: number | null;
  failure: string | null;
}

const ID_PATTERN = /^backup_\d{8}T\d{6}Z_[a-f0-9]{8}$/;
const TIMEOUT_MS = 15 * 60 * 1000;
/** The backups this server process is running. A record marked RUNNING but not here was interrupted. */
const running = new Set<string>();

function pgEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PGHOST: process.env.DB_HOST,
    PGPORT: process.env.DB_PORT,
    PGDATABASE: process.env.DB_NAME,
    PGUSER: process.env.DB_USER,
    PGPASSWORD: process.env.DB_PASSWORD,
    ...(process.env.PGSSLMODE ? { PGSSLMODE: process.env.PGSSLMODE } : {}),
  } as NodeJS.ProcessEnv;
}

/** Runs a PostgreSQL tool. stderr is dropped on purpose: it can name the host or user. */
function tool(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: pgEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

const manifestPath = (dir: string, id: string) => path.join(dir, `${id}.json`);
const dumpPath = (dir: string, id: string) => path.join(dir, `${id}.dump`);

async function writeManifest(dir: string, record: BackupRecord) {
  const target = manifestPath(dir, record.id);
  await writeFile(`${target}.tmp`, JSON.stringify(record, null, 2));
  // On Windows a rename fails briefly while another request is reading the file.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(`${target}.tmp`, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

async function readRecords(dir: string): Promise<BackupRecord[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json") && ID_PATTERN.test(name.slice(0, -5)))
      .map(async (name) => {
        try {
          const record = JSON.parse(await readFile(path.join(dir, name), "utf8")) as BackupRecord;
          return record.state === "RUNNING" && !running.has(record.id) ? { ...record, state: "FAILED" as const, failure: "Interrupted before it finished." } : record;
        } catch {
          return null;
        }
      })
  );

  return records.filter((record): record is BackupRecord => record !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const majorOf = (version: string | null | undefined) => {
  const match = /(\d+)/.exec(version ?? "");
  return match ? Number(match[1]) : null;
};

export interface BackupCheck {
  id: "storage" | "durable" | "writable" | "dumpTool" | "restoreTool" | "toolVersion" | "freeSpace";
  label: string;
  state: "OK" | "ATTENTION" | "NOT_CHECKED";
  detail: string;
}

/** Everything a backup needs, checked now. Nothing here writes to the disk or the database. */
export async function backupStatus() {
  const dir = env.backupDir;
  const isProduction = process.env.NODE_ENV === "production";
  const durable = env.backupStorageDurable || !isProduction;
  const [dump, restore, server] = await Promise.all([
    tool(env.pgDumpPath, ["--version"]),
    tool(env.pgRestorePath, ["--version"]),
    pool.query<{ server_version: string }>("SHOW server_version"),
  ]);
  const dumpVersion = dump.code === 0 ? (dump.stdout.trim().split(/\s/).pop() ?? null) : null;
  const dumpMajor = majorOf(dumpVersion);
  const serverMajor = majorOf(server.rows[0]?.server_version);

  let writable: boolean | null = null;
  let freeBytes: number | null = null;
  if (dir) {
    // The folder itself, or the nearest level that would be created for it.
    const target = await stat(dir).then(() => dir).catch(() => path.dirname(dir));
    writable = await access(target, constants.W_OK).then(() => true).catch(() => false);
    freeBytes = await statfs(target).then((disk) => disk.bavail * disk.bsize).catch(() => null);
  }

  const checks: BackupCheck[] = [
    { id: "storage", label: "Backup storage", state: dir ? "OK" : "ATTENTION", detail: dir ? "A folder is configured." : "No folder is configured (BACKUP_DIR)." },
    {
      id: "durable",
      label: "Durable storage",
      state: durable ? "OK" : "ATTENTION",
      detail: env.backupStorageDurable ? "Declared durable by the administrator (not something the application can prove)." : isProduction ? "Not declared durable (BACKUP_STORAGE_DURABLE)." : "Not required outside production.",
    },
    { id: "writable", label: "Storage is writable", state: writable === null ? "NOT_CHECKED" : writable ? "OK" : "ATTENTION", detail: writable === null ? "No folder to check." : writable ? "The server can write there." : "The server cannot write there." },
    { id: "dumpTool", label: "Backup tool (pg_dump)", state: dumpVersion ? "OK" : "ATTENTION", detail: dumpVersion ? `Version ${dumpVersion}.` : "Not found on this server." },
    { id: "restoreTool", label: "Verification tool (pg_restore)", state: restore.code === 0 ? "OK" : "ATTENTION", detail: restore.code === 0 ? "Found." : "Not found on this server." },
    {
      id: "toolVersion",
      label: "Tool matches the database",
      state: dumpMajor === null || serverMajor === null ? "NOT_CHECKED" : dumpMajor >= serverMajor ? "OK" : "ATTENTION",
      detail: dumpMajor === null || serverMajor === null ? "Needs the backup tool." : `Tool version ${dumpMajor}, database version ${serverMajor}. The tool must not be older than the database.`,
    },
    { id: "freeSpace", label: "Free disk space", state: freeBytes === null ? "NOT_CHECKED" : "OK", detail: freeBytes === null ? "No folder to check." : `${Math.floor(freeBytes / 1048576)} MB free.` },
  ];
  const available = checks.every((check) => check.state === "OK");
  const unavailableReason = !dir
    ? "Backup storage is not configured on this server."
    : !durable
      ? "The configured folder has not been declared durable storage."
      : (checks.find((check) => check.state !== "OK")?.detail ?? null);

  return { available, unavailableReason, automaticSchedule: false, storageConfigured: Boolean(dir), storageDeclaredDurable: env.backupStorageDurable, toolVersion: dumpVersion, checks };
}

export async function listBackups() {
  return { status: await backupStatus(), items: env.backupDir ? await readRecords(env.backupDir) : [] };
}

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function runBackup(dir: string, record: BackupRecord, userId: string) {
  const file = dumpPath(dir, record.id);
  const schema = process.env.DB_SCHEMA?.trim();
  let result: BackupRecord;

  try {
    const dumped = await tool(env.pgDumpPath, ["--format=custom", "--no-owner", `--file=${file}`, ...(schema ? [`--schema=${schema}`] : [])]);
    if (dumped.code !== 0) throw new Error("The backup tool did not finish successfully.");

    // Verified: the archive can be read and lists the tables it should hold.
    const listed = await tool(env.pgRestorePath, ["--list", file]);
    const tableEntries = listed.stdout.split("\n").filter((line) => / TABLE DATA /.test(line)).length;
    if (listed.code !== 0 || tableEntries === 0) throw new Error("The backup file could not be verified.");

    const size = (await stat(file)).size;
    result = { ...record, state: "VERIFIED", finishedAt: new Date().toISOString(), sizeBytes: size, sha256: await fileHash(file), tableEntries };
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined);
    result = { ...record, state: "FAILED", finishedAt: new Date().toISOString(), failure: error instanceof Error ? error.message : "The backup failed." };
  }

  // This runs after the request has been answered, so nothing here may escape: an unhandled
  // rejection would stop the whole API. A record that cannot be written shows as interrupted.
  try {
    await writeManifest(dir, result);
    await logActivity(pool, {
      userId,
      action: "backup.created",
      module: "SETTINGS",
      entityType: "backups",
      entityId: null,
      description: result.state === "VERIFIED" ? `Database backup ${record.id} created and verified.` : `Database backup ${record.id} failed.`,
      metadata: { backupId: record.id, state: result.state, sizeBytes: result.sizeBytes, sha256: result.sha256 },
    });
  } catch (error) {
    console.error(`Backup ${record.id} could not be recorded: ${error instanceof Error ? error.message : "Unknown error"}`);
  } finally {
    running.delete(record.id);
  }
}

/** Starts a backup and returns at once; its state is read from the list. One at a time. */
export async function startBackup(auth: AuthContext): Promise<BackupRecord> {
  const status = await backupStatus();

  if (!status.available || !env.backupDir) {
    throw new AppError(503, "BACKUP_UNAVAILABLE", status.unavailableReason ?? "Backups are not available.");
  }
  if (running.size > 0) {
    throw conflict("A backup is already running.");
  }

  await mkdir(env.backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const record: BackupRecord = {
    id: `backup_${stamp}_${randomBytes(4).toString("hex")}`,
    state: "RUNNING",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    startedBy: auth.user.fullName,
    sizeBytes: null,
    sha256: null,
    tableEntries: null,
    failure: null,
  };

  running.add(record.id);
  await writeManifest(env.backupDir, record);
  void runBackup(env.backupDir, record, auth.user.id);

  return record;
}

/** A verified backup whose file still matches its recorded checksum. The id is checked before any path is built. */
export async function verifiedBackupFile(auth: AuthContext, id: string): Promise<{ file: string; name: string; size: number }> {
  const dir = env.backupDir;
  if (!dir || !ID_PATTERN.test(id)) throw notFound("Backup not found.");

  const record = (await readRecords(dir)).find((item) => item.id === id);
  if (!record) throw notFound("Backup not found.");
  if (record.state !== "VERIFIED") throw conflict("Only a verified backup can be downloaded.");

  const file = dumpPath(dir, id);
  const hash = await fileHash(file).catch(() => null);
  if (hash === null || hash !== record.sha256) throw conflict("This backup file no longer matches its checksum and cannot be downloaded.");

  await logActivity(pool, {
    userId: auth.user.id,
    action: "backup.downloaded",
    module: "SETTINGS",
    entityType: "backups",
    entityId: null,
    description: `Database backup ${id} downloaded.`,
    metadata: { backupId: id },
  });

  return { file, name: `${id}.dump`, size: record.sizeBytes ?? 0 };
}

/** Test support: resolves once no backup is running. */
export async function waitForBackups(): Promise<void> {
  while (running.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
}
