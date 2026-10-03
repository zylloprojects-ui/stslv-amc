import { appendFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { applyImport, type ApplyResult } from "../src/legacy-import/apply";
import type { ImportConfig } from "../src/legacy-import/config";
import { stagingRows } from "../src/legacy-import/dry-run";
import { parseApplyArguments } from "../src/scripts/legacy-import-apply";
import { activeContract, today } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { insertHistoricalProject } from "./historical-helpers";
import { writeFixtureWorkbooks } from "./legacy-import-fixtures";
import { insertClient, newProject, resetProjectData, type Session } from "./projects-helpers";

// The controlled import end to end, against workbooks laid out like the
// client's but with invented content, and against the test database.

let admin: Session;
let config: ImportConfig;
let directory: string;

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> => (await pool.query<T>(sql, params)).rows[0] as T;
const dashboard = async () => (await api().get("/api/dashboard/summary").set(admin.headers)).body.data;

/** A fingerprint of every row of every table, to prove that a run changed nothing. */
async function fingerprint(): Promise<string> {
  const tables = await pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name"
  );
  const parts: string[] = [];

  for (const { table_name: table } of tables.rows) {
    const rows = await pool.query<{ digest: string | null; count: number }>(
      `SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest, count(*)::int AS count FROM ${table} t`
    );

    parts.push(`${table}:${rows.rows[0]?.count}:${rows.rows[0]?.digest}`);
  }

  return parts.join("\n");
}

/** Operational data that is in the database before the import: a client, a live job and an active contract. */
async function seedOperationalData(): Promise<{ clientId: string; projectId: string }> {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);

  // Named as one of the workbook's clients, in another letter case.
  const clientId = await insertClient("alpha hotel");
  const project = await newProject(admin, clientId, { description: "Live job" });

  await activeContract(admin, clientId, { systemDescription: "LIVE FIRE" });
  // A live job that happens to carry a job number of the register.
  await pool.query("INSERT INTO projects (job_number, client_id, description, job_date, job_value, vat_rate) VALUES ('JOB0101', $1, 'Existing job', '2026-09-01', 10, 5)", [clientId]);

  return { clientId, projectId: project.id };
}

beforeAll(() => {
  ({ config, directory } = writeFixtureWorkbooks());
});
afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await closePool();
});

describe("import", () => {
  let existing: { clientId: string; projectId: string };
  let before: Awaited<ReturnType<typeof dashboard>>;
  let clientBefore: Record<string, unknown>;
  let projectBefore: Record<string, unknown>;
  let sequenceBefore: Record<string, unknown>;
  let result: ApplyResult;

  beforeAll(async () => {
    existing = await seedOperationalData();
    before = await dashboard();
    clientBefore = await one("SELECT * FROM clients WHERE id = $1", [existing.clientId]);
    projectBefore = await one("SELECT * FROM projects WHERE id = $1", [existing.projectId]);
    sequenceBefore = await one("SELECT * FROM number_sequences WHERE sequence_key = 'job_number'");
    result = await applyImport(config, pool);
  });

  it("stages every source record exactly once, imported or held", async () => {
    const expected = stagingRows(result.plan);
    const stagedRows = await pool.query<{ record_kind: string; disposition: string; count: number }>(
      "SELECT record_kind, disposition, count(*)::int AS count FROM legacy_import_rows GROUP BY 1, 2 ORDER BY 1, 2"
    );
    const counted = (kind: string, disposition: string) => expected.filter((row) => row.record_kind === kind && row.disposition === disposition).length;

    expect(result.sourceRecords).toBe(expected.length);
    expect(result.alreadyStaged).toBe(0);
    expect(result.staged.imported + result.staged.held).toBe(expected.length);
    expect((await one<{ count: number }>("SELECT count(*)::int AS count FROM legacy_import_rows")).count).toBe(expected.length);
    // All 3 contracts, all 12 schedule rows and all 14 job rows are there.
    expect(expected.filter((row) => row.record_kind === "AMC_CONTRACT")).toHaveLength(3);
    expect(expected.filter((row) => row.record_kind === "AMC_VISIT")).toHaveLength(12);
    expect(expected.filter((row) => row.record_kind === "PROJECT")).toHaveLength(14);

    for (const row of stagedRows.rows) {
      expect(row.count).toBe(counted(row.record_kind, row.disposition));
    }
  });

  it("creates only what the plan marks importable, and reconciles", async () => {
    expect(result.reconciliation.length).toBeGreaterThan(0);
    expect(result.reconciliation.filter((check) => !check.passed)).toEqual([]);
    // JOB0101 is already in the database, so it is held: 7 of the 8 otherwise importable jobs are created.
    expect(result.created).toEqual({ clients: 4, contracts: 2, visits: 2, projects: 7 });
    expect(result.existingClientsUsed).toBe(1);
    expect(result.staged).toEqual({
      imported: stagingRows(result.plan).filter((row) => row.disposition === "IMPORTED").length,
      held: stagingRows(result.plan).filter((row) => row.disposition === "HELD").length,
    });
  });

  it("links every imported staging row to its record, and no held row to anything", async () => {
    const links = await one<{ imported_unlinked: number; held_linked: number }>(
      `SELECT count(*) FILTER (WHERE disposition = 'IMPORTED' AND num_nonnulls(client_id, amc_contract_id, amc_visit_id, project_id) <> 1)::int AS imported_unlinked,
              count(*) FILTER (WHERE disposition = 'HELD' AND num_nonnulls(client_id, amc_contract_id, amc_visit_id, project_id) <> 0)::int AS held_linked
       FROM legacy_import_rows`
    );

    expect(links).toEqual({ imported_unlinked: 0, held_linked: 0 });
  });

  it("keeps the source row, the raw values, the proposal and the reasons on every staging row", async () => {
    const job = await one<Record<string, unknown>>("SELECT * FROM legacy_import_rows WHERE record_kind = 'PROJECT' AND original_identifier = 'JOB0102'");
    const blank = await one<Record<string, unknown>>("SELECT * FROM legacy_import_rows WHERE record_kind = 'PROJECT' AND original_identifier = 'JOB0108'");
    const alias = await one<Record<string, unknown>>("SELECT * FROM legacy_import_rows WHERE record_kind = 'CLIENT' AND original_identifier = 'DELTAHOUSE'");

    expect(job).toMatchObject({
      source_workbook: "Jobs.xlsx",
      source_sheet: "Register",
      source_row: 6,
      disposition: "IMPORTED",
      hold_reason: null,
      hold_reasons: [],
      raw_values: { Client: "ECHO ", "Job Value": "1577.276", "INVOICE NUMBER": "9002, 9003" },
      proposed_values: { jobNumber: "JOB0102", clientName: "ECHO", jobValue: "1577.276", status: "HISTORICAL", jobDatePrecision: "MONTH", completedDate: null },
      invoice_reference: { rawCell: "9002, 9003", numbers: ["9002", "9003"], classification: "JOB_HAS_MULTIPLE_INVOICES" },
    });
    // A missing value stays missing: null, not zero.
    expect(blank).toMatchObject({ disposition: "HELD", project_id: null, proposed_values: { jobNumber: "JOB0108", jobValue: null, vatAmount: null, grandValue: null } });
    expect((blank.hold_reasons as { code: string }[]).map((reason) => reason.code)).toEqual(["JOB_VALUE_BLANK"]);
    expect(blank.hold_reason).toMatch(/^JOB_VALUE_BLANK: /);
    // A client name carries its proposed mapping and why.
    expect(alias).toMatchObject({ disposition: "HELD", client_id: null, proposed_values: { rawName: "DELTAHOUSE", masterName: "DELTA HOUSE", classification: "PROPOSED_ALIAS", outcome: "HELD_ALIAS_NOT_APPROVED" } });
    expect((alias.proposed_values as { mappingReason: string }).mappingReason).toContain("spacing only");
  });

  it("creates nothing for a held record: it exists in staging only", async () => {
    // Both rows of the duplicated number, the job with no value, the unconfirmed client and the unapproved alias.
    const projects = await pool.query("SELECT 1 FROM projects WHERE job_number IN ('JOB0109', 'JOB0108', 'JOB0110', 'JOB0111', 'JOB0114')");
    const clients = await pool.query("SELECT 1 FROM clients WHERE upper(name) IN ('GAMMA', 'GAMMA HOLDINGS', 'GAMMA VILLA', 'DELTAHOUSE', 'BT', 'JULIET', 'HOTEL INDIA', 'KILO HOTEL')");
    const held = await one<{ jobs: number; contracts: number; visits: number }>(
      `SELECT count(*) FILTER (WHERE record_kind = 'PROJECT')::int AS jobs,
              count(*) FILTER (WHERE record_kind = 'AMC_CONTRACT')::int AS contracts,
              count(*) FILTER (WHERE record_kind = 'AMC_VISIT')::int AS visits
       FROM legacy_import_rows WHERE disposition = 'HELD'`
    );

    expect(projects.rowCount).toBe(0);
    expect(clients.rowCount).toBe(0);
    expect(held).toEqual({ jobs: 7, contracts: 1, visits: 10 });
    // Both rows of the duplicate are kept, each with its own source row.
    expect((await pool.query("SELECT source_row FROM legacy_import_rows WHERE original_identifier = 'JOB0109' ORDER BY source_row")).rows).toEqual([{ source_row: 9 }, { source_row: 13 }]);
  });

  it("imports contracts as drafts with the cutover date, and visits only for source rows", async () => {
    const now = await today();
    const contracts = await pool.query<Record<string, unknown>>(
      `SELECT c.status, c.schedule_cutover_date::text AS cutover, c.maintenance_frequency, c.contract_value, c.final_credit, cl.name
       FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
       WHERE c.id IN (SELECT amc_contract_id FROM legacy_import_rows WHERE amc_contract_id IS NOT NULL)
       ORDER BY c.valid_from`
    );
    const visits = await pool.query<Record<string, unknown>>(
      `SELECT v.status, v.sequence_no, v.period_start::text AS period_start, v.visit_amount, v.completed_date, v.completed_by, v.work_performed
       FROM amc_visits v WHERE v.status = 'HISTORICAL' ORDER BY v.period_start`
    );

    expect(contracts.rows).toEqual([
      // Linked to the client that already existed, under the name it already had.
      { status: "DRAFT", cutover: now, maintenance_frequency: "QUARTERLY", contract_value: "1600.000", final_credit: "1600.000", name: "alpha hotel" },
      { status: "DRAFT", cutover: now, maintenance_frequency: "QUARTERLY", contract_value: "3100.000", final_credit: "3100.000", name: "BETA TOWER" },
    ]);
    // Two source rows are importable, so there are two visits: no period is filled in, no completion is supplied.
    expect(visits.rows).toEqual([
      { status: "HISTORICAL", sequence_no: 3, period_start: "2026-01-01", visit_amount: "400.000", completed_date: null, completed_by: null, work_performed: null },
      { status: "HISTORICAL", sequence_no: 4, period_start: "2026-04-01", visit_amount: "400.000", completed_date: null, completed_by: null, work_performed: null },
    ]);
    expect((await one<{ count: number }>("SELECT count(*)::int AS count FROM amc_visits WHERE status = 'HISTORICAL'")).count).toBe(result.created.visits);
  });

  it("imports jobs as historical projects with the register's number, status, month and value", async () => {
    const project = await one<Record<string, unknown>>(
      `SELECT job_number, status, legacy_status, job_date::text AS job_date, job_date_precision, job_value, vat_rate, vat_amount, grand_value,
              completed_date, budget_amount, lpo_number, notes
       FROM projects WHERE job_number = 'JOB0102'`
    );
    const zero = await one<Record<string, unknown>>("SELECT job_value, status FROM projects WHERE job_number = 'JOB0106'");
    const totals = await one<{ count: number; value: string }>(
      "SELECT count(*)::int AS count, sum(job_value)::text AS value FROM projects WHERE status = 'HISTORICAL'"
    );

    expect(project).toEqual({
      job_number: "JOB0102",
      status: "HISTORICAL",
      legacy_status: "Completed",
      job_date: "2025-01-01",
      job_date_precision: "MONTH",
      job_value: "1577.276",
      vat_rate: "5.000",
      vat_amount: "78.864",
      grand_value: "1656.140",
      // Nothing the register does not give.
      completed_date: null,
      budget_amount: null,
      lpo_number: null,
      notes: null,
    });
    // An entered zero is a value.
    expect(zero).toEqual({ job_value: "0.000", status: "HISTORICAL" });
    expect(totals.count).toBe(7);
    expect(totals.value).toBe(
      result.plan.projects
        .filter((row) => row.disposition === "IMPORTABLE")
        .reduce((sum, row) => sum + Number(row.proposed.jobValue) * 1000, 0)
        .toFixed(0)
        .replace(/(\d{3})$/, ".$1")
    );
  });

  it("creates no invoice record: the source invoice cells stay in staging", async () => {
    const tables = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ILIKE '%invoice%' AND table_type = 'BASE TABLE'"
    );
    const columns = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('projects', 'amc_visits') AND column_name ILIKE '%invoice%'"
    );
    const references = await one<{ with_cell: number; shared: number; marker: number }>(
      `SELECT count(*) FILTER (WHERE invoice_reference->>'rawCell' IS NOT NULL)::int AS with_cell,
              count(*) FILTER (WHERE invoice_reference->>'classification' = 'INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT')::int AS shared,
              count(*) FILTER (WHERE invoice_reference->>'classification' = 'NON_NUMERIC_MARKER')::int AS marker
       FROM legacy_import_rows`
    );

    expect(tables.rows).toEqual([]);
    expect(columns.rowCount).toBe(0);
    expect(references).toEqual({ with_cell: 11, shared: 2, marker: 3 });
  });

  it("does not change a record that already existed", async () => {
    expect(await one("SELECT * FROM clients WHERE id = $1", [existing.clientId])).toEqual(clientBefore);
    expect(await one("SELECT * FROM projects WHERE id = $1", [existing.projectId])).toEqual(projectBefore);
    // The job of the register that carries a number already in use is held, not merged into the live job.
    expect(await one("SELECT status, description, job_value FROM projects WHERE job_number = 'JOB0101'")).toEqual({ status: "NEW", description: "Existing job", job_value: "10.000" });
    expect(await one("SELECT disposition, project_id, hold_reason FROM legacy_import_rows WHERE original_identifier = 'JOB0101'")).toMatchObject({
      disposition: "HELD",
      project_id: null,
      hold_reason: expect.stringMatching(/^JOB_NUMBER_ALREADY_IN_DATABASE: /),
    });
  });

  it("leaves the job-number sequence alone, and the next live job takes the next live number", async () => {
    expect(await one("SELECT * FROM number_sequences WHERE sequence_key = 'job_number'")).toEqual(sequenceBefore);
  });

  it("leaves every operational dashboard figure as it was", async () => {
    const after = await dashboard();
    const { historicalJobValue, historicalGrandValue, ...values } = after.projects.values;
    const { historicalJobValue: _job, historicalGrandValue: _grand, ...valuesBefore } = before.projects.values;

    expect(after.clients).toEqual({ ...before.clients, active: before.clients.active + result.created.clients });
    // Imported contracts are drafts: not active, and no schedule is generated for them.
    expect(after.amc.contracts).toEqual({ ...before.amc.contracts, draft: before.amc.contracts.draft + 2 });
    expect(after.amc.visits).toEqual({ ...before.amc.visits, historical: 2 });
    expect(after.amc.invoicing).toEqual(before.amc.invoicing);
    expect(after.projects.counts).toEqual({ ...before.projects.counts, total: before.projects.counts.total + 7, historical: 7 });
    expect(values).toEqual(valuesBefore);
    expect([historicalJobValue, historicalGrandValue]).not.toEqual(["0.000", "0.000"]);
    expect(after.projects.costs).toEqual(before.projects.costs);
  });

  it("records the batch with its source files and one audit entry", async () => {
    const batch = await one<Record<string, unknown>>("SELECT id, label, cutover_date::text AS cutover_date, source_files, created_by FROM legacy_import_batches");
    const log = await one<Record<string, unknown>>("SELECT action, module, entity_type, entity_id, user_id FROM activity_logs WHERE action = 'legacy_import.applied'");

    expect(batch).toMatchObject({ id: result.batchId, label: "Historical Excel import", cutover_date: await today(), created_by: null });
    expect(batch.source_files).toEqual([
      { name: "Contracts.xlsx", sheet: "Contracts", sha256: config.workbooks.contracts.sha256 },
      { name: "Schedule.xlsx", sheet: "Schedule", sha256: config.workbooks.schedule.sha256 },
      { name: "Jobs.xlsx", sheet: "Register", sha256: config.workbooks.jobs.sha256 },
    ]);
    expect(log).toEqual({ action: "legacy_import.applied", module: "HISTORICAL_DATA", entity_type: "legacy_import_batches", entity_id: result.batchId, user_id: null });
  });

  it("writes nothing when it is run again: no duplicate, no second batch", async () => {
    const fingerprintBefore = await fingerprint();
    const again = await applyImport(config, pool);

    expect(again.batchId).toBeNull();
    expect(again.alreadyStaged).toBe(again.sourceRecords);
    expect(again.created).toEqual({ clients: 0, contracts: 0, visits: 0, projects: 0 });
    expect(again.staged).toEqual({ imported: 0, held: 0 });
    expect(await fingerprint()).toBe(fingerprintBefore);

    // And a third time, to be sure the second left nothing behind.
    await applyImport(config, pool);
    expect(await fingerprint()).toBe(fingerprintBefore);
  });

  it("gives the next live job the next live number, after the import", async () => {
    const live = await newProject(admin, existing.clientId, { description: "Job created after the import" });

    expect(live.jobNumber).toBe("GPSA0002");
  });
});

describe("import that cannot complete", () => {
  it("stops before touching the database when a workbook is not the analysed file", async () => {
    await seedOperationalData();

    const { config: other, directory: folder } = writeFixtureWorkbooks();
    const before = await fingerprint();

    try {
      appendFileSync(path.join(folder, "Jobs.xlsx"), Buffer.from([0]));

      await expect(applyImport(other, pool)).rejects.toThrow(/differ from the analysed files: Jobs\.xlsx/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    expect(await fingerprint()).toBe(before);
  });

  it("rolls everything back when the result does not reconcile", async () => {
    const { clientId } = await seedOperationalData();

    // A historical project that no source row accounts for: the import must not leave the database in that state.
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0950" });

    const before = await fingerprint();

    await expect(applyImport(config, pool)).rejects.toThrow(/did not reconcile: Every historical project and visit is linked to its source row.*Everything was rolled back/s);
    expect(await fingerprint()).toBe(before);
    expect((await pool.query("SELECT 1 FROM legacy_import_rows")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM legacy_import_batches")).rowCount).toBe(0);
  });
});

describe("import script options", () => {
  it("requires the database to be named", () => {
    expect(() => parseApplyArguments([])).toThrow(/--confirm-database <database name> is required/);
    expect(() => parseApplyArguments(["--config", "a.json"])).toThrow(/--confirm-database <database name> is required/);
    expect(parseApplyArguments(["--confirm-database", "some_db", "--config", "a.json", "--label", "First import"])).toEqual({
      config: "a.json",
      confirmDatabase: "some_db",
      label: "First import",
    });
  });

  it("refuses anything else", () => {
    for (const argument of ["--force", "--overwrite", "--delete", "--confirm-database"]) {
      expect(() => parseApplyArguments([argument])).toThrow(/Unknown or incomplete option/);
    }
  });
});
