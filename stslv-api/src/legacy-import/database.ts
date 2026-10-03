import type { Pool, PoolClient } from "pg";
import type { DatabaseState } from "./plan";

// What a dry run reads from the database. It reads only: every statement runs
// inside a READ ONLY transaction, so PostgreSQL itself refuses a write.

/** The tables a real import would write to, and the ones it must leave alone. */
export const WATCHED_TABLES = [
  "clients",
  "amc_contracts",
  "amc_visits",
  "projects",
  "procurement_requests",
  "project_expenses",
  "activity_logs",
  "number_sequences",
  "legacy_import_batches",
  "legacy_import_rows",
] as const;

export interface DatabaseSnapshot extends DatabaseState {
  database: string;
  schema: string;
  /** Row count of each watched table, to show before and after that nothing changed. */
  counts: Record<string, number>;
}

/** Runs fn inside a READ ONLY transaction and always rolls it back. */
export async function withReadOnly<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");

    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

/** The snapshot itself, on a connection whose transaction the caller owns. */
export async function readSnapshot(client: PoolClient): Promise<DatabaseSnapshot> {
  const target = await client.query<{ database: string; schema: string; today: string }>(
    "SELECT current_database() AS database, current_schema() AS schema, current_date::text AS today"
  );
  const clients = await client.query<{ id: string; name: string }>("SELECT id, name FROM clients ORDER BY id");
  const projects = await client.query<{ job_number: string }>("SELECT job_number FROM projects ORDER BY job_number");
  const counts: Record<string, number> = {};

  for (const table of WATCHED_TABLES) {
    counts[table] = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`)).rows[0]?.count ?? 0;
  }

  const row = target.rows[0] as { database: string; schema: string; today: string };

  return {
    database: row.database,
    schema: row.schema,
    asOf: row.today,
    clients: clients.rows,
    jobNumbers: projects.rows.map((project) => project.job_number),
    counts,
  };
}

export function readDatabase(pool: Pool): Promise<DatabaseSnapshot> {
  return withReadOnly(pool, readSnapshot);
}
