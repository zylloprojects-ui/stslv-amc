import path from "node:path";
import { resolveStorageConfig } from "../../config/storage-config";
import { assertFingerprint } from "./gpg";
import { LocalDirStore, readOnly, S3Store, type ReadableStore, type WritableStore } from "./store";
import type { RetentionPolicy } from "./retention";

// Settings of the backup jobs, read from their own environment file on the server (/etc/stslv-amc/backup.env),
// separate from the API's. Every name and its meaning: deploy/hostinger/env/backup.env.example.
// Nothing here ever prints a value; errors name the variable only.

type Vars = Record<string, string | undefined>;

export interface DatabaseSource {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** PGSSLMODE for the tools and the driver: "require" or "verify-full" for Neon. */
  sslMode: string | null;
}

export interface BackupConfig {
  environment: string;
  workDir: string;
  stateDir: string;
  gpg: { gpgPath: string; homeDir?: string; recipient: string };
  pgDumpPath: string;
  pgRestorePath: string;
  schemas: string[];
  retention: RetentionPolicy;
  prune: boolean;
  verifyDownload: boolean;
  alertWebhookUrl: string | null;
  heartbeatDbUrl: string | null;
  heartbeatDocsUrl: string | null;
  /** Every secret value, for redaction of logs and alerts. */
  secrets: string[];
}

const read = (vars: Vars, name: string) => vars[name]?.trim() ?? "";

function required(vars: Vars, name: string): string {
  const value = read(vars, name);

  if (!value) throw new Error(`${name} is not set.`);

  return value;
}

function wholeNumber(vars: Vars, name: string, fallback: number, min: number, max: number): number {
  const raw = read(vars, name);

  if (!raw) return fallback;

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number between ${min} and ${max}.`);

  return value;
}

function bool(vars: Vars, name: string, fallback: boolean): boolean {
  const raw = read(vars, name).toLowerCase();

  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function httpsUrl(vars: Vars, name: string, allowHttp: boolean): string | null {
  const raw = read(vars, name);

  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid web address.`);
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) throw new Error(`${name} must use https.`);

  return raw;
}

export function readDatabaseSource(vars: Vars): DatabaseSource {
  const port = wholeNumber(vars, "DB_PORT", 5432, 1, 65535);

  if (vars.DB_PASSWORD === undefined) throw new Error("DB_PASSWORD is not set.");

  return {
    host: required(vars, "DB_HOST"),
    port,
    database: required(vars, "DB_NAME"),
    user: required(vars, "DB_USER"),
    password: vars.DB_PASSWORD,
    sslMode: read(vars, "PGSSLMODE") || null,
  };
}

/** Environment for pg_dump / pg_restore / psql: connection through PG* variables, never arguments. */
export function pgToolEnv(source: Pick<DatabaseSource, "host" | "port" | "database" | "user" | "password" | "sslMode">): Record<string, string | undefined> {
  return {
    PGHOST: source.host,
    PGPORT: String(source.port),
    PGDATABASE: source.database,
    PGUSER: source.user,
    PGPASSWORD: source.password,
    PGSSLMODE: source.sslMode ?? undefined,
    PGCONNECT_TIMEOUT: "20",
    PGAPPNAME: "stslv-amc-backup",
  };
}

export function readBackupConfig(vars: Vars, nodeEnv = vars.NODE_ENV): BackupConfig {
  const production = nodeEnv === "production";
  const recipient = required(vars, "BACKUP_GPG_RECIPIENT").toUpperCase().replace(/\s+/g, "");

  assertFingerprint(recipient);

  const schemas = (read(vars, "BACKUP_DB_SCHEMAS") || "public").split(",").map((schema) => schema.trim()).filter(Boolean);

  if (schemas.some((schema) => !/^[a-z_][a-z0-9_]*$/.test(schema))) throw new Error("BACKUP_DB_SCHEMAS must list lowercase PostgreSQL schema names separated by commas.");

  const environment = read(vars, "BACKUP_ENVIRONMENT") || (production ? "production" : "development");

  if (!/^[a-z0-9-]{1,30}$/.test(environment)) throw new Error("BACKUP_ENVIRONMENT must be 1 to 30 lowercase letters, digits or hyphens.");

  const secrets = [
    vars.DB_PASSWORD,
    vars.BACKUP_S3_SECRET_ACCESS_KEY,
    vars.BACKUP_S3_ACCESS_KEY_ID,
    vars.SUPABASE_S3_SECRET_ACCESS_KEY,
    vars.SUPABASE_S3_ACCESS_KEY_ID,
    vars.R2_SECRET_ACCESS_KEY,
    vars.R2_ACCESS_KEY_ID,
    vars.BACKUP_ALERT_WEBHOOK_URL,
    vars.BACKUP_HEARTBEAT_DB_URL,
    vars.BACKUP_HEARTBEAT_DOCS_URL,
    vars.RESTORE_DB_PASSWORD,
    vars.DB_HOST,
  ].filter((value): value is string => typeof value === "string" && value.trim().length >= 3).map((value) => value.trim());

  return {
    environment,
    workDir: path.resolve(required(vars, "BACKUP_WORK_DIR")),
    stateDir: path.resolve(read(vars, "BACKUP_STATE_DIR") || path.join(required(vars, "BACKUP_WORK_DIR"), "state")),
    gpg: { gpgPath: read(vars, "GPG_PATH") || "gpg", ...(read(vars, "GNUPGHOME") ? { homeDir: read(vars, "GNUPGHOME") } : {}), recipient },
    pgDumpPath: read(vars, "PG_DUMP_PATH") || "pg_dump",
    pgRestorePath: read(vars, "PG_RESTORE_PATH") || "pg_restore",
    schemas,
    retention: {
      daily: wholeNumber(vars, "BACKUP_RETAIN_DAILY", 7, 1, 366),
      weekly: wholeNumber(vars, "BACKUP_RETAIN_WEEKLY", 4, 0, 520),
      monthly: wholeNumber(vars, "BACKUP_RETAIN_MONTHLY", 12, 0, 600),
    },
    prune: bool(vars, "BACKUP_PRUNE", true),
    verifyDownload: bool(vars, "BACKUP_VERIFY_DOWNLOAD", true),
    alertWebhookUrl: httpsUrl(vars, "BACKUP_ALERT_WEBHOOK_URL", !production),
    heartbeatDbUrl: httpsUrl(vars, "BACKUP_HEARTBEAT_DB_URL", !production),
    heartbeatDocsUrl: httpsUrl(vars, "BACKUP_HEARTBEAT_DOCS_URL", !production),
    secrets,
  };
}

/**
 * The off-site backup destination: an S3-compatible bucket (BACKUP_S3_*) that must be independent of the
 * production providers (not Neon, not the Supabase project), or a folder (BACKUP_LOCAL_DIR) for development
 * and tests. Exactly one.
 */
export function openBackupStore(vars: Vars, nodeEnv = vars.NODE_ENV): WritableStore {
  const local = read(vars, "BACKUP_LOCAL_DIR");
  const s3 = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"].filter((name) => read(vars, name));

  if (local && s3.length > 0) throw new Error("Set either BACKUP_LOCAL_DIR or the BACKUP_S3_* settings, not both.");
  if (local) {
    if (nodeEnv === "production" && !bool(vars, "BACKUP_LOCAL_DIR_IS_OFFSITE", false)) {
      throw new Error("In production the backup destination must be off-site: use BACKUP_S3_*, or set BACKUP_LOCAL_DIR_IS_OFFSITE=true for a mounted remote share.");
    }
    return new LocalDirStore(path.resolve(local));
  }
  if (s3.length !== 4) throw new Error("The off-site backup bucket needs BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY.");

  const endpoint = httpsUrl(vars, "BACKUP_S3_ENDPOINT", nodeEnv !== "production") as string;
  const bucket = required(vars, "BACKUP_S3_BUCKET");
  const supabaseBucket = read(vars, "SUPABASE_S3_BUCKET");
  const supabaseRef = read(vars, "SUPABASE_PROJECT_REF");

  // Off-site means independent: the backup must not sit in the same Supabase project as the documents.
  if ((supabaseRef && endpoint.includes(supabaseRef)) || (supabaseBucket && bucket === supabaseBucket && endpoint === read(vars, "SUPABASE_S3_ENDPOINT"))) {
    throw new Error("The backup bucket must not be in the production Supabase project. Use an independent provider/account.");
  }

  const prefix = read(vars, "BACKUP_S3_PREFIX").replace(/^\/+/, "");

  return new S3Store({
    endpoint,
    region: read(vars, "BACKUP_S3_REGION") || "auto",
    bucket,
    accessKeyId: required(vars, "BACKUP_S3_ACCESS_KEY_ID"),
    secretAccessKey: required(vars, "BACKUP_S3_SECRET_ACCESS_KEY"),
    prefix: prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix,
    conditionalWrites: bool(vars, "BACKUP_S3_CONDITIONAL_WRITES", false),
  });
}

/**
 * The production document store, READ-ONLY: the same settings the API uses (SUPABASE_*, R2_* or ATTACHMENTS_DIR).
 * The returned object has no write or delete method at all.
 */
export function openDocumentSource(vars: Vars, nodeEnv = vars.NODE_ENV): ReadableStore {
  const config = resolveStorageConfig(vars, nodeEnv, process.cwd());

  if (!config) throw new Error("No document storage is configured (SUPABASE_*, R2_* or ATTACHMENTS_DIR).");
  if (config.driver === "local") return readOnly(new LocalDirStore(config.dir));

  return readOnly(
    new S3Store({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      prefix: "",
      conditionalWrites: false,
    })
  );
}
