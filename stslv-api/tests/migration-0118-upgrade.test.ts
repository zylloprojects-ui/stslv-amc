import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";

// Migration 0118 (Customer PO Value, client UAT CR-013) on the upgrade path: a schema migrated to 0117, with a contract
// already present, is upgraded to 0118. The column appears on the table and last on the amc_contracts view, with its
// CHECK; the existing contract keeps every value and gets no PO value (never backfilled). Runs in its own throwaway
// schema of the test database, never in "public".

const SCHEMA = "upgrade_0118";
const FILE = "0118_amc_contract_customer_po_value.sql";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stslv-0118-"));
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

describe("migration 0118 upgrade path", () => {
  it("upgrades a 0117 schema to 0118 without touching existing contracts", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "0118")) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    }
    await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });
    const tracked = async () => (await upgradePool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0]?.version;
    expect(await tracked()).toBe("0117");

    // An existing contract, as production holds them.
    const clientId = (await upgradePool.query<{ id: string }>("INSERT INTO clients (name) VALUES ('Upgrade Client') RETURNING id")).rows[0]!.id;
    await upgradePool.query(
      `INSERT INTO amc_contracts (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, status, amc_reference)
       VALUES ($1, '2026-01-01', '2028-12-31', 'CCTV', 1200.000, 'QUARTERLY', 'ACTIVE', 'AMC-UPG-0118')`,
      [clientId]
    );
    const snapshot = async () => (await upgradePool.query("SELECT to_jsonb(c) - 'customer_po_value' AS row FROM amc_contracts c ORDER BY id")).rows;
    const before = await snapshot();
    const viewColumnsBefore = Number((await upgradePool.query("SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'amc_contracts'", [SCHEMA])).rows[0]!.count);

    fs.copyFileSync(path.join(MIGRATIONS_DIR, FILE), path.join(workDir, FILE));
    const result = await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });

    expect(result.applied).toEqual([FILE]);
    expect(await tracked()).toBe("0118");
    const viewColumns = (
      await upgradePool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'amc_contracts' ORDER BY ordinal_position", [SCHEMA])
    ).rows.map((row) => row.column_name);
    expect(viewColumns).toHaveLength(viewColumnsBefore + 1);
    expect(viewColumns.at(-1)).toBe("customer_po_value");

    // Nothing backfilled, nothing else changed.
    expect((await upgradePool.query("SELECT customer_po_value FROM amc_contracts")).rows).toEqual([{ customer_po_value: null }]);
    expect(await snapshot()).toEqual(before);

    // Three decimals, never negative.
    await upgradePool.query("UPDATE amc_contracts SET customer_po_value = 3456.789");
    expect((await upgradePool.query("SELECT customer_po_value::text AS v FROM amc_contracts")).rows[0].v).toBe("3456.789");
    await expect(upgradePool.query("UPDATE amc_contracts SET customer_po_value = -1")).rejects.toThrow(/amc_contracts_customer_po_value_ck/);
  });
});
