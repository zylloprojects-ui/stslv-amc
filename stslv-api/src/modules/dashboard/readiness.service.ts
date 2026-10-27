import { checkDatabaseHealth, pool } from "../../config/database";
import { env } from "../../config/env";
import { loadMigrationFiles } from "../../db/migrate";

// Production readiness, as far as this API can verify it itself at the moment
// of the request. There is no composite score: each check is reported on its
// own, and a check STSLV cannot verify says so instead of guessing.

export type CheckState = "OK" | "ATTENTION" | "UNAVAILABLE";

export interface ReadinessCheck {
  id: "api" | "database" | "migrations" | "backup" | "cors" | "signInLimits" | "failedSignIns";
  label: string;
  state: CheckState;
  detail: string;
}

export interface Readiness {
  checkedAt: string;
  checks: ReadinessCheck[];
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

  return {
    id: "migrations",
    label: "Database updates",
    state: pending.length === 0 ? "OK" : "ATTENTION",
    detail:
      pending.length === 0
        ? `All ${files.length} database updates are applied.`
        : `${pending.length} of ${files.length} database updates are not applied: ${pending.join(", ")}. Apply them only after approval and a fresh backup.`,
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

export async function getReadiness(): Promise<Readiness> {
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

  checks.push({
    id: "backup",
    label: "Last verified backup",
    state: "UNAVAILABLE",
    detail: "STSLV AMC does not record backups. Backups are taken outside the application, so no backup time can be shown here.",
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

  return { checkedAt: new Date().toISOString(), checks };
}
