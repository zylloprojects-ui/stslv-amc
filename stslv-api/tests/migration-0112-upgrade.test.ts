import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";

// Migrations 0112 (Invoice Acknowledgements) and 0113 (Super Admin's grants) on the upgrade path: a schema at 0111 with
// an invoiced service, a service report and saved role grants is upgraded. Nothing existing changes; Super Admin alone
// receives the new module; the new guards work. Own throwaway schema, never "public".

const SCHEMA = "upgrade_0112";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stslv-0112-"));
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

const NEW = ["0112_invoice_acknowledgements.sql", "0113_seed_invoice_acknowledgement_permissions.sql"];

describe("migrations 0112 and 0113 upgrade path", () => {
  it("adds the module from 0111 without changing existing records or grants", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "0112")) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    }
    await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });

    // An existing invoiced, completed service with its service report.
    const user = (await upgradePool.query<{ id: string }>("INSERT INTO users (email, full_name, password_hash) VALUES ('u@example.com', 'U', 'x') RETURNING id")).rows[0]!.id;
    const client = (await upgradePool.query<{ id: string }>("INSERT INTO clients_all (name, created_by, updated_by) VALUES ('Upgrade Client', $1, $1) RETURNING id", [user])).rows[0]!.id;
    const contract = (
      await upgradePool.query<{ id: string }>(
        `INSERT INTO amc_contracts_all (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, status, created_by, updated_by, amc_reference)
         VALUES ($1, '2026-01-01', '2026-12-31', 'FIRE', 1200, 'QUARTERLY', 'ACTIVE', $2, $2, 'UP-001') RETURNING id`,
        [client, user]
      )
    ).rows[0]!.id;
    const visit = (
      await upgradePool.query<{ id: string }>(
        `INSERT INTO amc_visits_all (amc_contract_id, sequence_no, period_start, period_end, scheduled_date, original_scheduled_date, status, completed_date, visit_amount, manual_invoice_no, manual_invoice_at, created_by, updated_by)
         VALUES ($1, 1, '2026-01-01', '2026-03-31', '2026-02-15', '2026-02-15', 'SCHEDULED', NULL, 300, NULL, NULL, $2, $2) RETURNING id`,
        [contract, user]
      )
    ).rows[0]!.id;
    await upgradePool.query(
      `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ('amc_visits', $1, 'SERVICE_REPORT', 'Service report', 'r.pdf', 'application/pdf', 1, repeat('0', 64), gen_random_uuid()::text || '.pdf', $2)`,
      [visit, user]
    );
    await upgradePool.query(
      "UPDATE amc_visits_all SET status = 'COMPLETED', completed_date = '2026-02-15', manual_invoice_no = 'UP-INV-1', manual_invoice_at = now(), manual_invoice_by = $2 WHERE id = $1",
      [visit, user]
    );

    const snapshot = async () => ({
      visits: (await upgradePool.query("SELECT * FROM amc_visits_all ORDER BY id")).rows,
      contracts: (await upgradePool.query("SELECT * FROM amc_contracts_all ORDER BY id")).rows,
      attachments: (await upgradePool.query("SELECT * FROM attachments ORDER BY id")).rows,
      grants: (await upgradePool.query("SELECT role_id, module, action FROM role_permissions WHERE module <> 'INVOICE_ACKNOWLEDGEMENTS' ORDER BY 1, 2, 3")).rows,
    });
    const before = await snapshot();

    for (const file of NEW) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    const result = await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });
    expect(result.applied).toEqual(NEW);

    expect(await snapshot()).toEqual(before);
    const holders = await upgradePool.query("SELECT r.code, count(*)::int AS actions FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE p.module = 'INVOICE_ACKNOWLEDGEMENTS' GROUP BY r.code");
    expect(holders.rows).toEqual([{ code: "ADMIN", actions: 7 }]);
    expect((await upgradePool.query("SELECT count(*)::int AS n FROM invoice_acknowledgements")).rows[0].n).toBe(0);

    // The existing invoice can now be acknowledged once, with a document, and the guards hold.
    const ack = (await upgradePool.query<{ id: string }>("INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, created_by) VALUES ($1, 'UP-INV-1', $2) RETURNING id", [visit, user])).rows[0]!.id;
    await expect(upgradePool.query("INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, created_by) VALUES ($1, 'UP-INV-1', $2)", [visit, user])).rejects.toThrow(/invoice_acknowledgements_invoice_uq/);
    await expect(upgradePool.query("UPDATE invoice_acknowledgements SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1", [ack, user])).rejects.toThrow(/no document/);
    await expect(
      upgradePool.query(
        `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ('invoice_acknowledgements', $1, 'SERVICE_REPORT', 'x', 'x.pdf', 'application/pdf', 1, repeat('0', 64), gen_random_uuid()::text || '.pdf', $2)`,
        [ack, user]
      )
    ).rejects.toThrow(/attachments_invoice_ack_ck/);
    await upgradePool.query(
      `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ('invoice_acknowledgements', $1, 'INVOICE_ACKNOWLEDGEMENT', 'Invoice acknowledgement', 'a.pdf', 'application/pdf', 1, repeat('0', 64), gen_random_uuid()::text || '.pdf', $2)`,
      [ack, user]
    );
    await upgradePool.query("UPDATE invoice_acknowledgements SET status = 'ACKNOWLEDGED', acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1", [ack, user]);
    await expect(upgradePool.query("DELETE FROM invoice_acknowledgements WHERE id = $1", [ack])).rejects.toThrow(/cannot be deleted/);
    // A visit with an acknowledgement cannot be removed underneath it.
    await expect(upgradePool.query("DELETE FROM amc_visits_all WHERE id = $1", [visit])).rejects.toThrow(/invoice_acknowledgements_visit_fk|completed and locked|violates/);

    // Re-running is a no-op; 0113 is idempotent on its own.
    expect((await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir })).applied).toEqual([]);
    const seed = fs.readFileSync(path.join(MIGRATIONS_DIR, NEW[1]!), "utf8");
    await upgradePool.query(seed);
    expect((await upgradePool.query("SELECT count(*)::int AS n FROM role_permissions WHERE module = 'INVOICE_ACKNOWLEDGEMENTS'")).rows[0].n).toBe(7);
  });
});
