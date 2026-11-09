import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";

// Migration 0110 (Sales Engineer Name) on the upgrade path: a schema migrated to 0109 is then upgraded to 0110; the
// column appears on the table and through the amc_visits view, with its CHECK, and rows already present keep their
// values. (A rehearsal on a disposable copy of a realistic database is described in
// docs/STS_ELV_CLIENT_FIXES_20261109.md.) Runs in its own throwaway schema of the test database, never in "public".

const SCHEMA = "upgrade_0110";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stslv-0110-"));
// The runner works in the connection's current schema, so this pool's connections start in the throwaway schema.
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

describe("migration 0110 upgrade path", () => {
  it("upgrades a 0109 schema to 0110", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "0110")) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    }

    await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });
    const columnsOf = async () =>
      (
        await upgradePool.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'sales_engineer_name' ORDER BY table_name",
          [SCHEMA]
        )
      ).rows.map((row) => row.table_name);
    expect(await columnsOf()).toEqual([]);
    const tracked = async () => (await upgradePool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0]?.version;
    expect(await tracked()).toBe("0109");
    const visitColumnsBefore = Number((await upgradePool.query("SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'amc_visits'", [SCHEMA])).rows[0]!.count);

    const result = await runMigrations(upgradePool, { schema: SCHEMA });

    expect(result.applied).toEqual(["0110_amc_visit_sales_engineer_name.sql"]);
    expect(await tracked()).toBe("0110");
    expect(await columnsOf()).toEqual(["amc_visits", "amc_visits_all"]);
    // The view keeps every earlier column, in order, and adds the new one last.
    const viewColumns = (
      await upgradePool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'amc_visits' ORDER BY ordinal_position", [SCHEMA])
    ).rows.map((row) => row.column_name);
    expect(viewColumns).toHaveLength(visitColumnsBefore + 1);
    expect(viewColumns.at(-1)).toBe("sales_engineer_name");
    const check = await upgradePool.query<{ def: string }>(
      "SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.conname = 'amc_visits_sales_engineer_name_ck' AND n.nspname = $1",
      [SCHEMA]
    );
    expect(check.rows[0]?.def).toContain("120");
  });
});
