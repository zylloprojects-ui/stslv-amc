import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";
import { syncInvoices } from "../src/modules/invoice-acknowledgements/invoice-sync";

// Migrations 0114 (invoice identity) and 0115 (approved default grants) on the upgrade path, from a schema at 0113
// holding acknowledgements recorded per service by the earlier release:
//   M-1   one service, one confirmed acknowledgement with a document        -> adopted, still Acknowledged
//   Z-1   one Invoice Tracking record covering two services, each with its own confirmed acknowledgement
//                                                                           -> both kept, none chosen, flagged
// and a Finance Executive role Super Admin had customised. Own throwaway schema, never "public".

const SCHEMA = "upgrade_0114";
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stslv-0114-"));
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

const NEW = ["0114_acknowledgement_invoice_identity.sql", "0115_seed_invoice_acknowledgement_defaults.sql"];
const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => upgradePool.query<T>(sql, params).then((result) => result.rows);
const one = async (sql: string, params: unknown[] = []) => ((await q<{ id: string }>(sql, params))[0] as { id: string }).id;

describe("migrations 0114 and 0115 upgrade path", () => {
  it("keeps every earlier acknowledgement, adopts the unambiguous one and flags the conflict", async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name < "0114")) {
      fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    }
    await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir });

    const user = await one("INSERT INTO users (email, full_name, password_hash) VALUES ('u@example.com', 'U', 'x') RETURNING id");
    const client = await one("INSERT INTO clients_all (name, created_by, updated_by) VALUES ('Upgrade Client', $1, $1) RETURNING id", [user]);
    const contract = await one(
      `INSERT INTO amc_contracts_all (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, status, created_by, updated_by, amc_reference)
       VALUES ($1, '2026-01-01', '2026-12-31', 'FIRE', 1200, 'QUARTERLY', 'ACTIVE', $2, $2, 'UP-001') RETURNING id`,
      [client, user]
    );
    const visit = async (n: number, number: string) => {
      const id = await one(
        `INSERT INTO amc_visits_all (amc_contract_id, sequence_no, period_start, period_end, scheduled_date, original_scheduled_date, status, visit_amount, created_by, updated_by)
         VALUES ($1, $2, make_date(2026, $2::int * 3 - 2, 1), (make_date(2026, $2::int * 3 - 2, 1) + interval '3 months' - interval '1 day')::date,
                 make_date(2026, $2::int * 3 - 1, 15), make_date(2026, $2::int * 3 - 1, 15), 'SCHEDULED', 300, $3, $3) RETURNING id`,
        [contract, n, user]
      );
      await q(
        `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ('amc_visits', $1, 'SERVICE_REPORT', 'Service report', 'r.pdf', 'application/pdf', 1, repeat('0', 64), gen_random_uuid()::text || '.pdf', $2)`,
        [id, user]
      );
      await q("UPDATE amc_visits_all SET status = 'COMPLETED', completed_date = '2026-02-15', manual_invoice_no = $2, manual_invoice_at = now(), manual_invoice_by = $3 WHERE id = $1", [id, number, user]);
      return id;
    };
    const m1 = await visit(1, "M-1");
    const z1 = await visit(2, "Z-1");
    const z2 = await visit(3, "Z-1");
    const client2 = await upgradePool.connect();
    try {
      await client2.query("BEGIN");
      const zoho = (await client2.query<{ id: string }>("INSERT INTO invoices (invoice_number, client_id, invoice_date, amount_excl_vat, vat_amount, created_by) VALUES ('Z-1', $1, '2026-03-01', 600, 0, $2) RETURNING id", [client, user])).rows[0]!.id;
      await client2.query("INSERT INTO invoice_allocations (invoice_id, amc_visit_id, allocated_amount, created_by) VALUES ($1, $2, 300, $4), ($1, $3, 300, $4)", [zoho, z1, z2, user]);
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
    const legacy = async (visitId: string, number: string, file: string) => {
      const ack = await one("INSERT INTO invoice_acknowledgements (amc_visit_id, invoice_number, created_by) VALUES ($1, $2, $3) RETURNING id", [visitId, number, user]);
      const doc = await one(
        `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
         VALUES ('invoice_acknowledgements', $1, 'INVOICE_ACKNOWLEDGEMENT', 'Invoice acknowledgement', $2, 'application/pdf', 1, repeat('0', 64), gen_random_uuid()::text || '.pdf', $3) RETURNING id`,
        [ack, file, user]
      );
      await q("UPDATE attachments SET document_id = id WHERE id = $1", [doc]);
      await q("UPDATE invoice_acknowledgements SET status = 'ACKNOWLEDGED', acknowledged_at = '2026-11-08T10:00:00Z', acknowledged_by = $2 WHERE id = $1", [ack, user]);
      await q("INSERT INTO activity_logs (user_id, action, module, entity_type, entity_id, description) VALUES ($1, 'invoice_acknowledgement.confirmed', 'INVOICE_ACKNOWLEDGEMENTS', 'invoice_acknowledgements', $2, 'legacy')", [user, ack]);
      return ack;
    };
    const ackM = await legacy(m1, "M-1", "m1.pdf");
    const ackZ1 = await legacy(z1, "Z-1", "z1.pdf");
    const ackZ2 = await legacy(z2, "Z-1", "z2.pdf");

    // Super Admin had customised Finance Executive: Edit given on this module, Accounts Export taken away.
    await q("INSERT INTO role_permissions (role_id, module, action) SELECT id, 'INVOICE_ACKNOWLEDGEMENTS', 'EDIT' FROM roles WHERE code = 'FINANCE_EXECUTIVE'");
    await q("DELETE FROM role_permissions p USING roles r WHERE r.id = p.role_id AND r.code = 'FINANCE_EXECUTIVE' AND p.module = 'ACCOUNTS' AND p.action = 'EXPORT'");

    const snapshot = async () => ({
      acks: await q("SELECT id, amc_visit_id, invoice_number, status, acknowledged_at, acknowledged_by, created_by, created_at FROM invoice_acknowledgements ORDER BY id"),
      attachments: await q("SELECT * FROM attachments ORDER BY id"),
      visits: await q("SELECT * FROM amc_visits_all ORDER BY id"),
      invoices: await q("SELECT * FROM invoices ORDER BY id"),
      logs: await q("SELECT * FROM activity_logs ORDER BY id"),
    });
    const before = await snapshot();
    const grantsBefore = await q("SELECT r.code, p.module, p.action FROM role_permissions p JOIN roles r ON r.id = p.role_id ORDER BY 1, 2, 3");

    for (const file of NEW) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(workDir, file));
    expect((await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir })).applied).toEqual(NEW);

    // The migrations rewrite nothing and create no identity themselves.
    expect(await snapshot()).toEqual(before);
    expect(await q("SELECT * FROM ack_invoices")).toEqual([]);
    // 0115 only adds: the customised role keeps its Edit and stays without Accounts Export.
    const grantsAfter = await q<{ code: string; module: string; action: string }>("SELECT r.code, p.module, p.action FROM role_permissions p JOIN roles r ON r.id = p.role_id ORDER BY 1, 2, 3");
    expect(grantsAfter).toEqual(expect.arrayContaining(grantsBefore));
    const added = grantsAfter.filter((g) => !grantsBefore.some((old) => old.code === g.code && old.module === g.module && old.action === g.action));
    expect(added.map((g) => `${g.code}:${g.action}`).sort()).toEqual([
      "ADMINISTRATOR:CREATE", "ADMINISTRATOR:EDIT", "ADMINISTRATOR:EXPORT", "ADMINISTRATOR:VIEW",
      "FINANCE_EXECUTIVE:CREATE", "FINANCE_EXECUTIVE:EXPORT", "FINANCE_EXECUTIVE:VIEW",
    ]);
    expect(grantsAfter.some((g) => g.code === "VIEWER" && g.module === "INVOICE_ACKNOWLEDGEMENTS")).toBe(false);
    expect(grantsAfter.some((g) => g.code === "FINANCE_EXECUTIVE" && g.module === "ACCOUNTS" && g.action === "EXPORT")).toBe(false);

    // First synchronisation (what the API runs before any read): identities, associations, adoption.
    await syncInvoices(upgradePool);
    const invoices = await q<{ id: string; invoice_number: string; basis: string; current_acknowledgement_id: string | null; acknowledgement_conflict: boolean }>(
      "SELECT id, invoice_number, basis, current_acknowledgement_id, acknowledgement_conflict FROM ack_invoices ORDER BY invoice_number"
    );
    expect(invoices.map(({ id: _id, ...row }) => row)).toEqual([
      { invoice_number: "M-1", basis: "SERVICE", current_acknowledgement_id: ackM, acknowledgement_conflict: false },
      { invoice_number: "Z-1", basis: "ZOHO", current_acknowledgement_id: null, acknowledgement_conflict: true },
    ]);
    const zInvoice = invoices[1]!.id;
    expect(await q("SELECT amc_visit_id, basis FROM ack_invoice_services WHERE ack_invoice_id = $1 ORDER BY amc_visit_id", [zInvoice])).toEqual([
      { amc_visit_id: z1, basis: "ZOHO" },
      { amc_visit_id: z2, basis: "ZOHO" },
    ]);
    // Every earlier acknowledgement keeps its status, date, user and document; each now names its invoice.
    const after = await q<{ id: string; ack_invoice_id: string }>("SELECT id, amc_visit_id, invoice_number, status, acknowledged_at, acknowledged_by, created_by, created_at, ack_invoice_id FROM invoice_acknowledgements ORDER BY id");
    expect(after.map(({ ack_invoice_id: _a, ...row }) => row)).toEqual(before.acks);
    expect(after.map((row) => [row.id, row.ack_invoice_id])).toEqual([
      [ackM, invoices[0]!.id],
      [ackZ1, zInvoice],
      [ackZ2, zInvoice],
    ]);
    expect(await q("SELECT * FROM attachments ORDER BY id")).toEqual(before.attachments);
    expect(await q("SELECT * FROM amc_visits_all ORDER BY id")).toEqual(before.visits);
    // Audit: earlier entries untouched; adoption and the conflict recorded.
    const logs = await q<{ action: string }>("SELECT action FROM activity_logs ORDER BY id");
    expect(logs.slice(0, before.logs.length)).toEqual(before.logs.map((log) => ({ action: (log as { action: string }).action })));
    expect(logs.slice(before.logs.length).map((log) => log.action)).toEqual([
      "invoice_acknowledgement.adopted", "invoice_acknowledgement.adopted", "invoice_acknowledgement.adopted", "invoice_acknowledgement.conflict_flagged",
    ]);

    // Idempotent: a second run changes nothing; re-applying 0115 adds nothing.
    const stable = await q("SELECT * FROM ack_invoices ORDER BY id");
    await syncInvoices(upgradePool);
    expect(await q("SELECT * FROM ack_invoices ORDER BY id")).toEqual(stable);
    const count = (await q<{ n: number }>("SELECT count(*)::int AS n FROM role_permissions"))[0]!.n;
    await upgradePool.query(fs.readFileSync(path.join(MIGRATIONS_DIR, NEW[1]!), "utf8"));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM role_permissions"))[0]!.n).toBe(count);
    expect((await runMigrations(upgradePool, { schema: SCHEMA, dir: workDir })).applied).toEqual([]);
  });
});
