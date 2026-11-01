import type { Request } from "express";
import { checkDatabaseHealth, pool } from "../../config/database";
import { env } from "../../config/env";
import { loadMigrationFiles } from "../../db/migrate";
import { REPORT_TIME_ZONE, REPORT_TIME_ZONE_LABEL } from "../../shared/export/branding";
import { listBackups } from "../security/backups.service";

// Production readiness, as far as this API can verify it itself at the moment
// of the request. There is no composite score: each check is reported on its
// own, and a check STSLV cannot verify says so instead of guessing.

export type CheckState = "OK" | "ATTENTION" | "UNAVAILABLE";

export interface ReadinessCheck {
  id: "api" | "database" | "migrations" | "backup" | "cors" | "signInLimits" | "failedSignIns" | "runtime" | "https" | "mode";
  label: string;
  state: CheckState;
  detail: string;
}

export interface Readiness {
  checkedAt: string;
  checks: ReadinessCheck[];
}

/** What one request can say about how it reached the API. */
export interface RequestTransport {
  /** HTTPS, as Express sees it: on a direct connection, or as reported by a trusted proxy. */
  secure: boolean;
  /** TRUST_PROXY is set, so a proxy's X-Forwarded-Proto is believed. */
  proxyTrusted: boolean;
  /** The request carries X-Forwarded-Proto. */
  proxyReported: boolean;
}

export function transportOf(req: Request): RequestTransport {
  return {
    secure: req.secure,
    proxyTrusted: Boolean(req.app.get("trust proxy")),
    proxyReported: req.get("x-forwarded-proto") !== undefined,
  };
}

/** Says unknown unless the request itself shows it: the API has no way to see a proxy it does not trust. */
export function httpsCheck(transport: RequestTransport | null): ReadinessCheck {
  const check = { id: "https", label: "HTTPS" } as const;

  if (transport?.secure) {
    return { ...check, state: "OK", detail: "This request reached the API over HTTPS." };
  }
  if (transport?.proxyTrusted && transport.proxyReported) {
    return { ...check, state: "ATTENTION", detail: "The trusted proxy reports that this request arrived over plain HTTP." };
  }

  return {
    ...check,
    state: "UNAVAILABLE",
    detail: transport?.proxyTrusted
      ? "Unknown. The trusted proxy did not report how this request arrived."
      : "Unknown. TRUST_PROXY is not set, so the API cannot tell how a request reached the proxy in front of it, if there is one.",
  };
}

/** Only the known names are repeated; any other value of NODE_ENV is not shown. */
export function modeCheck(nodeEnv: string | undefined): ReadinessCheck {
  const check = { id: "mode", label: "Run mode" } as const;

  if (nodeEnv === "production") {
    return { ...check, state: "OK", detail: "Production mode (NODE_ENV is production)." };
  }

  const shown = nodeEnv === "development" || nodeEnv === "test" ? `NODE_ENV is ${nodeEnv}` : "NODE_ENV is not set to a known value";

  return { ...check, state: "ATTENTION", detail: `Not production mode (${shown}). Production-only safeguards, such as HSTS, are off.` };
}

const backupDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: REPORT_TIME_ZONE });

/** "31 Oct 2026, 14:00 Oman time", for reading. */
export function formatBackupDate(value: string): string {
  return `${backupDate.format(new Date(value))} ${REPORT_TIME_ZONE_LABEL}`;
}

async function migrationCheck(): Promise<ReadinessCheck> {
  const files = loadMigrationFiles();
  const table = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass(current_schema() || '.schema_migrations') IS NOT NULL AS exists"
  );
  const applied = table.rows[0]?.exists
    ? new Set((await pool.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((row) => row.version))
    : new Set<string>();
  const pending = files.filter((file) => !applied.has(file.version)).map((file) => file.version);
  // Versions sort as text because they are fixed width. One this code does not know is named by its number.
  const latestVersion = [...applied].sort().at(-1);
  const latest = latestVersion ? (files.find((file) => file.version === latestVersion)?.filename.replace(/\.sql$/, "") ?? latestVersion) : null;
  const latestText = latest ? `Latest applied: ${latest}.` : "None applied yet.";

  return {
    id: "migrations",
    label: "Database updates",
    state: pending.length === 0 ? "OK" : "ATTENTION",
    detail:
      pending.length === 0
        ? `All ${files.length} database updates are applied. ${latestText}`
        : `${pending.length} of ${files.length} database updates are not applied: ${pending.join(", ")}. Apply them only after approval and a fresh backup. ${latestText}`,
  };
}

async function failedSignInCheck(): Promise<ReadinessCheck> {
  const result = await pool.query<{ failed: number }>(
    "SELECT count(*)::int AS failed FROM activity_logs WHERE action = 'auth.login_failed' AND created_at > now() - interval '24 hours'"
  );
  const failed = result.rows[0]?.failed ?? 0;

  // A count, not a judgement: what is normal for this business is not defined.
  return {
    id: "failedSignIns",
    label: "Failed sign-ins (last 24 hours)",
    state: "OK",
    detail: `${failed} failed sign-in ${failed === 1 ? "attempt" : "attempts"} recorded. See Login History for details.`,
  };
}

export async function getReadiness(transport: RequestTransport | null = null): Promise<Readiness> {
  const checks: ReadinessCheck[] = [
    // This answer itself proves the API is running.
    { id: "api", label: "API", state: "OK", detail: "The API answered this request." },
  ];

  let databaseUp = false;

  try {
    await checkDatabaseHealth();
    databaseUp = true;
    checks.push({ id: "database", label: "Database", state: "OK", detail: "Connected." });
  } catch (error) {
    console.error(`Readiness database check failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    checks.push({ id: "database", label: "Database", state: "ATTENTION", detail: "The database did not answer." });
  }

  if (databaseUp) {
    checks.push(await migrationCheck());
  } else {
    checks.push({ id: "migrations", label: "Database updates", state: "UNAVAILABLE", detail: "Cannot be checked while the database is unreachable." });
  }

  const { status: backup, items: backups } = await listBackups();
  const lastVerified = backups.find((item) => item.state === "VERIFIED");
  checks.push({
    id: "backup",
    label: "Last verified backup",
    state: lastVerified ? "OK" : backup.available ? "ATTENTION" : "UNAVAILABLE",
    // A date, not a judgement: how fresh a backup must be has not been decided.
    detail: lastVerified
      ? `Last verified backup from this application: ${lastVerified.finishedAt ? formatBackupDate(lastVerified.finishedAt) : "time not recorded"}.`
      : backup.available
        ? "No verified backup has been made from this application yet."
        : "Backups are not available from this application here, so no backup time can be shown. Backups taken outside it are not visible to it.",
  });

  const wildcard = env.corsOrigins.includes("*");
  checks.push({
    id: "cors",
    label: "Allowed web origins",
    state: wildcard ? "ATTENTION" : "OK",
    detail: wildcard
      ? "Any web origin may call the API (CORS_ORIGIN contains *)."
      : `${env.corsOrigins.length} configured web ${env.corsOrigins.length === 1 ? "origin" : "origins"}.`,
  });

  checks.push({
    id: "signInLimits",
    label: "Sign-in limits",
    state: "OK",
    detail: `${env.loginRateLimit} sign-in attempts per network address per 15 minutes; ${env.loginFailureLimit} failed attempts per address and email per 15 minutes.`,
  });

  if (databaseUp) {
    checks.push(await failedSignInCheck());
  }

  // The version in use. Which version is required has not been decided, so this passes no judgement.
  checks.push({ id: "runtime", label: "Node runtime", state: "OK", detail: `Running Node.js ${process.version}.` });
  checks.push(httpsCheck(transport));
  checks.push(modeCheck(process.env.NODE_ENV));

  return { checkedAt: new Date().toISOString(), checks };
}
