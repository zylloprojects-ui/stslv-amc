import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles, MIGRATIONS_DIR, runMigrations } from "../src/db/migrate";
import { syncInvoices } from "../src/modules/invoice-acknowledgements/invoice-sync";

// The whole release chain 0108-0116 on the upgrade path, with representative data, from:
//   * 0107 - the level of local alpha / origin alpha (c6d8d19) and the production database;
//   * 0109 - the earlier P0-P3 integration baseline (249a68b).
// Every pre-existing row must survive unchanged (compared by checksum over its original columns), applied migration
// checksums must match the files, a second run must apply nothing, and the invoice identities of 0114 must form from
// the existing data on the first synchronisation. Own throwaway schemas, never "public".

const pools: Pool[] = [];
const dirs: string[] = [];
const schemas: string[] = [];

function schemaPool(schema: string): Pool {
  const p = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: `-c search_path=${schema}`,
  });
  pools.push(p);
  return p;
}

afterAll(async () => {
  for (const p of pools) await p.end();
  for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A schema migrated up to (and including) `upTo`, with only those files in its own folder. */
async function schemaAt(schema: string, upTo: string): Promise<{ db: Pool; dir: string }> {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  schemas.push(schema);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stslv-${schema}-`));
  dirs.push(dir);
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name.slice(0, 4) <= upTo)) {
    fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
  }
  const db = schemaPool(schema);
  await runMigrations(db, { schema, dir });
  return { db, dir };
}

/** Representative data, written directly as an application at that level would have stored it. */
async function seed(db: Pool) {
  const one = async (sql: string, params: unknown[] = []) => ((await db.query<{ id: string }>(sql, params)).rows[0] as { id: string }).id;
  const user = await one("INSERT INTO users (email, full_name, password_hash) VALUES ('owner@example.com', 'Owner', 'x') RETURNING id");
  await db.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'ADMIN'", [user]);
  const client = await one("INSERT INTO clients_all (name, created_by, updated_by) VALUES ('Chain Hotel', $1, $1) RETURNING id", [user]);
  const other = await one("INSERT INTO clients_all (name, created_by, updated_by) VALUES ('Chain Mall', $1, $1) RETURNING id", [user]);
  const contract = async (clientId: string, reference: string, from: string, to: string, renewedFrom: string | null) =>
    one(
      `INSERT INTO amc_contracts_all (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, status, created_by, updated_by, amc_reference, renewed_from_id)
       VALUES ($1, $2, $3, 'FIRE ALARM', 1200, 'QUARTERLY', 'ACTIVE', $4, $4, $5, $6) RETURNING id`,
      [clientId, from, to, user, reference, renewedFrom]
    );
  const c1 = await contract(client, "CH-001", "2025-01-01", "2025-12-31", null);
  // A renewal made before 0111, with its own number (kept).
  const c2 = await contract(client, "CH-002", "2026-01-01", "2026-12-31", c1);
  const c3 = await contract(other, "CM-001", "2026-01-01", "2026-12-31", null);
  await db.query(
    `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     SELECT 'amc_contracts', id, 'SIGNED_CONTRACT', 'Contract document', 'contract.pdf', 'application/pdf', 10, repeat('a', 64), gen_random_uuid()::text || '.pdf', $1
     FROM amc_contracts_all`,
    [user]
  );
  const visits: string[] = [];
  for (const [contractId, start] of [[c1, 2025], [c2, 2026], [c3, 2026]] as const) {
    for (let q = 1; q <= 4; q++) {
      const month = q * 3 - 2;
      visits.push(
        await one(
          `INSERT INTO amc_visits_all (amc_contract_id, sequence_no, period_start, period_end, scheduled_date, original_scheduled_date, status, visit_amount, created_by, updated_by)
           VALUES ($1, $2, make_date($3, $4, 1), (make_date($3, $4, 1) + interval '3 months' - interval '1 day')::date, make_date($3, $4 + 1, 15), make_date($3, $4 + 1, 15), 'SCHEDULED', 300, $5, $5) RETURNING id`,
          [contractId, q, start, month, user]
        )
      );
    }
  }
  // Complete, report and invoice some services: one Zoho invoice covering two services, manual numbers elsewhere.
  for (const visit of visits.slice(0, 6)) {
    await db.query(
      `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ('amc_visits', $1, 'SERVICE_REPORT', 'Service report', 'report.pdf', 'application/pdf', 10, repeat('b', 64), gen_random_uuid()::text || '.pdf', $2)`,
      [visit, user]
    );
    await db.query("UPDATE amc_visits_all SET status = 'COMPLETED', completed_date = scheduled_date, completed_by = $2, service_report_no = 'SR-' || id WHERE id = $1", [visit, user]);
  }
  const manual = [
    [visits[0], "Z-100"], [visits[1], "Z-100"], [visits[2], "M-200"], [visits[4], "M-300"], [visits[5], "M-300"],
  ] as const;
  for (const [visit, number] of manual) {
    await db.query("UPDATE amc_visits_all SET manual_invoice_no = $2, manual_invoice_at = '2026-02-01T08:00:00Z', manual_invoice_by = $3 WHERE id = $1", [visit, number, user]);
  }
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const zoho = (await tx.query<{ id: string }>("INSERT INTO invoices (invoice_number, client_id, invoice_date, amount_excl_vat, vat_amount, created_by) VALUES ('Z-100', $1, '2025-06-30', 600, 30, $2) RETURNING id", [client, user])).rows[0]!.id;
    await tx.query("INSERT INTO invoice_allocations (invoice_id, amc_visit_id, allocated_amount, created_by) VALUES ($1, $2, 300, $4), ($1, $3, 300, $4)", [zoho, visits[0], visits[1], user]);
    await tx.query("COMMIT");
  } finally {
    tx.release();
  }
  // A role Super Admin had customised, and audit history.
  await db.query("DELETE FROM role_permissions p USING roles r WHERE r.id = p.role_id AND r.code = 'FINANCE_EXECUTIVE' AND p.module = 'ACCOUNTS' AND p.action = 'EXPORT'");
  for (let i = 0; i < 25; i++) {
    await db.query("INSERT INTO activity_logs (user_id, action, module, entity_type, entity_id, description) VALUES ($1, 'fixture.event', 'AMC_CONTRACTS', 'amc_contracts', $2, $3)", [user, c1, `event ${i}`]);
  }
  return { user, client, other, contracts: [c1, c2, c3], visits };
}

const TABLES = ["users", "user_roles", "roles", "clients_all", "amc_contracts_all", "amc_visits_all", "attachments", "invoices", "invoice_allocations", "activity_logs"];

interface Fingerprint {
  columns: string[];
  hasId: boolean;
  maxId: string | null;
  rows: number;
  md5: string;
}

/** Order-independent checksum of rows over the given columns; with `maxId`, only the rows that already existed. */
async function checksum(db: Pool, table: string, columns: string[], maxId: string | null) {
  const where = maxId === null ? "" : `WHERE id <= ${Number(maxId)}`;
  const result = await db.query<{ rows: number; md5: string | null }>(
    `SELECT count(*)::int AS rows, md5(COALESCE(string_agg(h, ',' ORDER BY h), '')) AS md5
     FROM (SELECT md5(row(${columns.map((c) => `"${c}"`).join(", ")})::text) AS h FROM ${table} ${where}) t`
  );
  return result.rows[0] as { rows: number; md5: string };
}

/**
 * Columns a later migration changes on purpose, left out of the checksum and checked on their own: 0117 renames three
 * built-in roles (its BEFORE UPDATE trigger also stamps updated_at). Every other column of every row must not change.
 */
const CHANGED_ON_PURPOSE: Record<string, string[]> = { roles: ["name", "description", "updated_at"] };

/** Checksums of every pre-existing row over the columns it had before the upgrade. */
async function fingerprint(db: Pool, schema: string): Promise<Record<string, Fingerprint>> {
  const out: Record<string, Fingerprint> = {};
  for (const table of TABLES) {
    const columns = (
      await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position", [schema, table])
    )
      .rows.map((row) => row.column_name)
      .filter((column) => !(CHANGED_ON_PURPOSE[table] ?? []).includes(column));
    const hasId = columns.includes("id");
    const maxId = hasId ? ((await db.query<{ m: string | null }>(`SELECT max(id)::text AS m FROM ${table}`)).rows[0]!.m ?? "0") : null;
    out[table] = { columns, hasId, maxId, ...(await checksum(db, table, columns, maxId)) };
  }
  return out;
}

/** Every row that existed before is unchanged on its original columns (tables with an id may have gained rows). */
async function sameRowsAfter(db: Pool, before: Record<string, Fingerprint>) {
  for (const [table, info] of Object.entries(before)) {
    const now = await checksum(db, table, info.columns, info.maxId);
    expect({ table, ...now }, table).toEqual({ table, rows: info.rows, md5: info.md5 });
  }
}

const applied = (from: string) => loadMigrationFiles().filter((m) => m.version > from).map((m) => m.filename);

describe("release chain 0108-0116 on the upgrade path", () => {
  for (const [label, level, schema] of [
    ["from 0107 (alpha / production level)", "0107", "chain_from_0107"],
    ["from 0109 (earlier P0-P3 integration baseline)", "0109", "chain_from_0109"],
  ] as const) {
    it(`upgrades ${label} with every existing record preserved`, async () => {
      const { db, dir } = await schemaAt(schema, level);
      const data = await seed(db);
      const before = await fingerprint(db, schema);
      const descriptionsBefore = (await db.query<{ code: string; description: string | null }>("SELECT code, description FROM roles ORDER BY id")).rows;
      const grantsBefore = (await db.query("SELECT r.code, p.module, p.action FROM role_permissions p JOIN roles r ON r.id = p.role_id ORDER BY 1, 2, 3")).rows;

      // The rest of the chain, from the real migration folder.
      for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql") && name.slice(0, 4) > level)) {
        fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
      }
      const result = await runMigrations(db, { schema, dir });
      expect(result.applied).toEqual(applied(level));

      // Applied migrations are recorded with the checksums of the files (an edited applied file would be refused).
      const recorded = await db.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
      const files = new Map(loadMigrationFiles().map((m) => [m.version, m.checksum]));
      for (const row of recorded.rows) expect(row.checksum, row.version).toBe(files.get(row.version));
      expect(recorded.rows.map((row) => row.version)).toEqual([...files.keys()]);

      await sameRowsAfter(db, before);
      // 0117: the three client role names, nothing else about any role (the checksum above covers the other columns).
      expect(Object.fromEntries((await db.query<{ code: string; name: string }>("SELECT code, name FROM roles")).rows.map((row) => [row.code, row.name]))).toEqual({
        ADMIN: "Super Admin",
        ADMINISTRATOR: "Service Dept",
        FINANCE_EXECUTIVE: "Accounts",
        MASTER_DATA_EXECUTIVE: "AMC Sales",
        AMC_OPERATIONS_EXECUTIVE: "AMC Operations Executive",
        VIEWER: "Viewer",
        ACCOUNTANT: "Accountant",
        PROCUREMENT: "Procurement",
        EXECUTION: "Execution",
        INVOICING: "Invoicing",
      });
      // 0117 changes one description (Super Admin's mention of the Admin role); every other is as before.
      const descriptionsAfter = (await db.query<{ code: string; description: string | null }>("SELECT code, description FROM roles ORDER BY id")).rows;
      expect(descriptionsAfter.filter((row) => row.code !== "ADMIN")).toEqual(descriptionsBefore.filter((row) => row.code !== "ADMIN"));
      expect(descriptionsAfter.find((row) => row.code === "ADMIN")?.description).toBe(
        "Full access to every module, including Service Dept accounts and all role permissions. Cannot be changed."
      );
      // Grants only gain the new module's approved defaults; the customised role keeps its removal.
      const grantsAfter = (await db.query<{ code: string; module: string; action: string }>("SELECT r.code, p.module, p.action FROM role_permissions p JOIN roles r ON r.id = p.role_id ORDER BY 1, 2, 3")).rows;
      expect(grantsAfter).toEqual(expect.arrayContaining(grantsBefore));
      expect(new Set(grantsAfter.filter((g) => !grantsBefore.some((o) => o.code === g.code && o.module === g.module && o.action === g.action)).map((g) => g.module))).toEqual(new Set(["INVOICE_ACKNOWLEDGEMENTS"]));
      expect(grantsAfter.some((g) => g.code === "FINANCE_EXECUTIVE" && g.module === "ACCOUNTS" && g.action === "EXPORT")).toBe(false);

      // 0111: every existing contract is version 1 of its own number; the pre-0111 renewal keeps its own number.
      expect((await db.query("SELECT id, amc_reference, contract_version, version_root_id FROM amc_contracts_all ORDER BY id")).rows).toEqual(
        data.contracts.map((id, i) => ({ id, amc_reference: ["CH-001", "CH-002", "CM-001"][i], contract_version: 1, version_root_id: id }))
      );
      // 0109: the audit log is append-only from now on.
      await expect(db.query("DELETE FROM activity_logs WHERE id = (SELECT min(id) FROM activity_logs)")).rejects.toThrow();
      // 0108: sessions table exists and is empty (everyone signs in again).
      expect((await db.query("SELECT count(*)::int AS n FROM user_sessions")).rows[0].n).toBe(0);

      // First synchronisation: identities from the existing invoices, nothing merged by number alone.
      await syncInvoices(db);
      const invoices = (await db.query("SELECT invoice_number, basis, (SELECT count(*)::int FROM ack_invoice_services s WHERE s.ack_invoice_id = a.id) AS services FROM ack_invoices a ORDER BY invoice_number, id")).rows;
      expect(invoices).toEqual([
        { invoice_number: "M-200", basis: "SERVICE", services: 1 },
        { invoice_number: "M-300", basis: "SERVICE", services: 1 },
        { invoice_number: "M-300", basis: "SERVICE", services: 1 },
        { invoice_number: "Z-100", basis: "ZOHO", services: 2 },
      ]);
      // The synchronisation changed no existing record either.
      await sameRowsAfter(db, before);

      // Re-running applies nothing.
      expect((await runMigrations(db, { schema, dir })).applied).toEqual([]);
    });
  }
});
