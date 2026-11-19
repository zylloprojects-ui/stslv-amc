import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";

// Migration 0122 (Number of Manpower) on the upgrade path: a schema migrated to everything below 0122 is upgraded
// with 0122 alone. The column appears on the table and, last, through the amc_visits view, with its CHECK; visits already
// present keep every value and stay blank. Runs in its own throwaway schema of the test database, never in "public".

const SCHEMA = "upgrade_0122";
const FILE = "0122_amc_visit_manpower_count.sql";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stslv-0122-"));
const upgradePool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: `-c search_path=${SCHEMA}`,
});

afterAll(async () => {
  await upgradePool.end();
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("migration 0122 upgrade path", () => {
  it("adds a blank manpower_count column without changing existing visits", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    // Every migration before 0122 that is in this branch (parallel branches may add 0119-0121).
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "0122")) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    }
    await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });

    // One existing visit, as an older database holds it.
    const userId = (
      await upgradePool.query<{ id: string }>(
        "INSERT INTO users (email, full_name, password_hash) VALUES ('upgrade-0122@example.com', 'Upgrade', 'x') RETURNING id"
      )
    ).rows[0]!.id;
    const clientId = (await upgradePool.query<{ id: string }>("INSERT INTO clients (name, created_by, updated_by) VALUES ('Upgrade Client', $1, $1) RETURNING id", [userId])).rows[0]!.id;
    const contractId = (
      await upgradePool.query<{ id: string }>(
        `INSERT INTO amc_contracts (client_id, system_description, valid_from, valid_to, maintenance_frequency, contract_value, status, created_by, updated_by, amc_reference)
         VALUES ($1, 'FIRE', '2027-01-01', '2027-12-31', 'QUARTERLY', 1200, 'DRAFT', $2, $2, 'AMC-UPG-0122') RETURNING id`,
        [clientId, userId]
      )
    ).rows[0]!.id;
    await upgradePool.query(
      `INSERT INTO amc_visits (amc_contract_id, sequence_no, period_start, period_end, scheduled_date, original_scheduled_date, status, visit_amount, created_by, updated_by)
       VALUES ($1, 1, '2027-01-01', '2027-03-31', '2027-01-15', '2027-01-15', 'SCHEDULED', 300, $2, $2)`,
      [contractId, userId]
    );
    const before = (await upgradePool.query("SELECT * FROM amc_visits")).rows[0] as Record<string, unknown>;
    const viewColumnsBefore = Number(
      (await upgradePool.query("SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'amc_visits'", [SCHEMA])).rows[0]!.count
    );

    fs.copyFileSync(path.join(MIGRATIONS_DIR, FILE), path.join(workDir, FILE));
    const result = await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });

    expect(result.applied).toEqual([FILE]);
    const viewColumns = (
      await upgradePool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'amc_visits' ORDER BY ordinal_position",
        [SCHEMA]
      )
    ).rows.map((row) => row.column_name);
    expect(viewColumns).toHaveLength(viewColumnsBefore + 1);
    expect(viewColumns.at(-1)).toBe("manpower_count");

    // The existing visit is unchanged and blank.
    const after = (await upgradePool.query("SELECT * FROM amc_visits")).rows[0] as Record<string, unknown>;
    expect(after).toEqual({ ...before, manpower_count: null });

    const check = await upgradePool.query<{ def: string }>(
      "SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.conname = 'amc_visits_manpower_count_ck' AND n.nspname = $1",
      [SCHEMA]
    );
    expect(check.rows[0]?.def).toContain(">= 0");
  });
});
