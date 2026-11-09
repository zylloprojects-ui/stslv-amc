import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";

// Migration 0111 (contract versions) on the upgrade path: a schema at 0110 is upgraded to 0111. Existing contracts
// become version 1 of their own number with nothing else changed (numbers, values, updated_at). A data rehearsal on a
// copy of a realistic database is in docs/STS_ELV_CLIENT_FIXES_20261109.md. Own throwaway schema, never "public".

const SCHEMA = "upgrade_0111";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stslv-0111-"));
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

describe("migration 0111 upgrade path", () => {
  it("backfills every existing contract as version 1 of its own number, changing nothing else", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "0111")) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    }
    await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });

    // Two existing contracts, one renewing the other with its own number (the rule before 0111).
    const user = (await upgradePool.query<{ id: string }>("INSERT INTO users (email, full_name, password_hash) VALUES ('m@example.com', 'M', 'x') RETURNING id")).rows[0]!.id;
    const client = (await upgradePool.query<{ id: string }>("INSERT INTO clients_all (name, created_by, updated_by) VALUES ('Upgrade Client', $1, $1) RETURNING id", [user])).rows[0]!.id;
    const add = async (reference: string, renewedFrom: string | null) =>
      (
        await upgradePool.query<{ id: string }>(
          `INSERT INTO amc_contracts_all (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, status, created_by, updated_by, amc_reference, renewed_from_id)
           VALUES ($1, '2026-01-01', '2026-12-31', 'FIRE', 100, 'QUARTERLY', 'DRAFT', $2, $2, $3, $4) RETURNING id`,
          [client, user, reference, renewedFrom]
        )
      ).rows[0]!.id;
    const first = await add("OLD-001", null);
    const renewal = await add("OLD-002", first);
    const before = (await upgradePool.query("SELECT id, amc_reference, renewed_from_id, contract_value, updated_at FROM amc_contracts_all ORDER BY id")).rows;

    const result = await runMigrations(upgradePool, { schema: SCHEMA });
    expect(result.applied).toEqual(["0111_amc_contract_versions.sql"]);

    const after = await upgradePool.query("SELECT id, amc_reference, renewed_from_id, contract_value, updated_at, version_root_id, contract_version FROM amc_contracts_all ORDER BY id");
    expect(after.rows.map(({ version_root_id: _r, contract_version: _v, ...row }) => row)).toEqual(before);
    expect(after.rows.map((row) => [row.id, row.version_root_id, row.contract_version])).toEqual([
      [first, first, 1],
      [renewal, renewal, 1],
    ]);
    // The view shows the new columns; numbers stay unique among originals; history unchanged (one entry each).
    const viewColumns = (await upgradePool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'amc_contracts'", [SCHEMA])).rows.map((row) => row.column_name);
    expect(viewColumns).toEqual(expect.arrayContaining(["version_root_id", "contract_version"]));
    const index = await upgradePool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'amc_contracts_reference_uq'", [SCHEMA]);
    expect(index.rows[0]?.indexdef).toContain("WHERE (contract_version = 1)");
    const history = await upgradePool.query("SELECT amc_contract_id::text AS id, reference FROM amc_contract_references WHERE retired_at IS NULL ORDER BY amc_contract_id");
    expect(history.rows).toEqual([
      { id: first, reference: "OLD-001" },
      { id: renewal, reference: "OLD-002" },
    ]);
    // A new contract after the upgrade is version 1 of its own number.
    const fresh = await add("NEW-001", null);
    expect((await upgradePool.query("SELECT version_root_id, contract_version FROM amc_contracts_all WHERE id = $1", [fresh])).rows[0]).toEqual({ version_root_id: fresh, contract_version: 1 });
  });
});
