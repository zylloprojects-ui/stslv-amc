import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { today } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { insertBatch, insertHistoricalProject, insertHistoricalVisit, insertImportedContract, stageRow } from "./historical-helpers";
import { insertClient, resetProjectData, type Session } from "./projects-helpers";

// legacy_import_batches and legacy_import_rows: the audit trail of a
// controlled import. Written by the import only. The application reads them
// through the Historical Data Review (tests/historical-data.test.ts) and has
// no route that writes them.

let admin: Session;
let clientId: string;
let batchId: string;
let now: string;

beforeEach(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await insertClient("Test Hotel One");
  batchId = (await insertBatch()).id;
  now = await today();
});
afterAll(closePool);

describe("import batch", () => {
  it("takes its cutover date from the database at the moment of the import", async () => {
    const batch = await insertBatch("Historical registers");

    expect(batch.cutoverDate).toBe(now);
  });

  it("keeps the source files and their checksums", async () => {
    const files = [{ name: "Job Register.xlsx", sha256: "0123456789abcdef" }];
    await pool.query("UPDATE legacy_import_batches SET source_files = $1::jsonb WHERE id = $2", [JSON.stringify(files), batchId]);

    expect((await pool.query("SELECT source_files FROM legacy_import_batches WHERE id = $1", [batchId])).rows[0].source_files).toEqual(files);
  });

  it("requires a label and a list of source files", async () => {
    await expect(pool.query("INSERT INTO legacy_import_batches (label) VALUES ('  ')")).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query("INSERT INTO legacy_import_batches (label, source_files) VALUES ('Import', '{}'::jsonb)")
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("cannot be deleted while it has rows", async () => {
    await stageRow(batchId, { row: 99, kind: "PROJECT", identifier: "GPSA0904", disposition: "HELD", holdReason: "Job Value is empty" });

    await expect(pool.query("DELETE FROM legacy_import_batches WHERE id = $1", [batchId])).rejects.toMatchObject({ code: "23503" });
  });
});

describe("source traceability", () => {
  it("links an imported project to its workbook, sheet, row, identifier and raw values", async () => {
    const projectId = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    const raw = { "S. No": "573", Status: "Completed", Month: "FEB", "Job Number": "GPSA0901", "Job Value": "500", "INVOICE NUMBER": "9003" };

    await stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901", raw, projectId });

    const found = await pool.query(
      `SELECT r.source_workbook, r.source_sheet, r.source_row, r.record_kind, r.original_identifier, r.raw_values,
              r.disposition, r.hold_reason, p.job_number, b.cutover_date::text AS cutover_date
       FROM legacy_import_rows r
       JOIN legacy_import_batches b ON b.id = r.batch_id
       JOIN projects p ON p.id = r.project_id
       WHERE r.project_id = $1`,
      [projectId]
    );

    expect(found.rows).toEqual([
      {
        source_workbook: "Job Register.xlsx",
        source_sheet: "Register",
        source_row: 57,
        record_kind: "PROJECT",
        original_identifier: "GPSA0901",
        raw_values: raw,
        disposition: "IMPORTED",
        hold_reason: null,
        job_number: "GPSA0901",
        cutover_date: now,
      },
    ]);
  });

  it("keeps the source invoice cell in the staged row, not on the project", async () => {
    const projectId = await insertHistoricalProject(clientId, { jobNumber: "GPSA0905" });
    await stageRow(batchId, { row: 7, kind: "PROJECT", identifier: "GPSA0905", raw: { "INVOICE NUMBER": "9001, 9002" }, projectId });

    const staged = await pool.query("SELECT raw_values ->> 'INVOICE NUMBER' AS invoice FROM legacy_import_rows WHERE project_id = $1", [projectId]);
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('projects', 'amc_visits') AND column_name ILIKE '%invoice%'`
    );

    expect(staged.rows[0].invoice).toBe("9001, 9002");
    expect(columns.rows).toEqual([]);
  });

  it("links clients, contracts and visits in the same way, several source names to one client", async () => {
    const contractId = await insertImportedContract(clientId, { validFrom: addDays(now, -100), validTo: addDays(now, 100), cutoverDate: now });
    const visitId = await insertHistoricalVisit(contractId, { sequenceNo: 1, periodStart: addDays(now, -100), periodEnd: addDays(now, -10) });

    await stageRow(batchId, { workbook: "Contract Register.xlsx", sheet: "Contracts", row: 7, kind: "CLIENT", identifier: "TEST HOTEL", clientId });
    await stageRow(batchId, { workbook: "Job Register.xlsx", row: 43, kind: "CLIENT", identifier: "TESTHOTEL", clientId });
    await stageRow(batchId, { workbook: "Contract Register.xlsx", sheet: "Contracts", row: 7, kind: "AMC_CONTRACT", identifier: "S. No 3", contractId });
    await stageRow(batchId, {
      workbook: "Maintenance Schedule.xlsx",
      sheet: "Schedule",
      row: 6,
      cell: "H6",
      kind: "AMC_VISIT",
      identifier: "TESTHOTEL FIRE Q2",
      raw: { "Inv. No.": "9004", Value: "400" },
      visitId,
    });

    const kinds = await pool.query<{ record_kind: string; n: number }>(
      "SELECT record_kind, count(*)::int AS n FROM legacy_import_rows GROUP BY record_kind ORDER BY record_kind"
    );

    expect(kinds.rows).toEqual([
      { record_kind: "AMC_CONTRACT", n: 1 },
      { record_kind: "AMC_VISIT", n: 1 },
      { record_kind: "CLIENT", n: 2 },
    ]);
  });

  it("stages the records that share one sheet row, told apart by their cell", async () => {
    for (const cell of ["B6", "H6", "N6"]) {
      await stageRow(batchId, {
        workbook: "Maintenance Schedule.xlsx",
        sheet: "Schedule",
        row: 6,
        cell,
        kind: "AMC_VISIT",
        identifier: `Period at ${cell}`,
        disposition: "HELD",
        holdReason: "Contract held",
      });
    }

    expect((await pool.query("SELECT 1 FROM legacy_import_rows")).rowCount).toBe(3);
  });
});

describe("duplicate source protection", () => {
  it("refuses to stage the same source record twice", async () => {
    await stageRow(batchId, { row: 99, kind: "PROJECT", identifier: "GPSA0904", disposition: "HELD", holdReason: "Job Value is empty" });

    await expect(
      stageRow(batchId, { row: 99, kind: "PROJECT", identifier: "GPSA0904", disposition: "HELD", holdReason: "Job Value is empty" })
    ).rejects.toMatchObject({ code: "23505", constraint: "legacy_import_rows_source_uq" });
  });

  it("refuses it in a later batch as well, so an import cannot be run twice", async () => {
    await stageRow(batchId, { row: 99, kind: "PROJECT", identifier: "GPSA0904", disposition: "HELD", holdReason: "Job Value is empty" });
    const second = await insertBatch("Second run");

    await expect(
      stageRow(second.id, { row: 99, kind: "PROJECT", identifier: "GPSA0904", disposition: "HELD", holdReason: "Still empty" })
    ).rejects.toMatchObject({ code: "23505", constraint: "legacy_import_rows_source_uq" });
  });

  it("refuses a second source record for one project", async () => {
    const projectId = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    await stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901", projectId });

    await expect(stageRow(batchId, { row: 53, kind: "PROJECT", identifier: "GPSA0901", projectId })).rejects.toMatchObject({
      code: "23505",
      constraint: "legacy_import_rows_project_id_uq",
    });
  });

  it("keeps both rows of a duplicated job number traceable, by their source rows", async () => {
    await stageRow(batchId, { row: 53, kind: "PROJECT", identifier: "GPSA0901", disposition: "HELD", holdReason: "Duplicate job number" });
    await stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901", disposition: "HELD", holdReason: "Duplicate job number" });

    const rows = await pool.query<{ source_row: number }>(
      "SELECT source_row FROM legacy_import_rows WHERE original_identifier = 'GPSA0901' ORDER BY source_row"
    );

    expect(rows.rows.map((row) => row.source_row)).toEqual([53, 57]);
  });
});

describe("held rows", () => {
  it("stages a held record with its reason and no link", async () => {
    await stageRow(batchId, {
      row: 99,
      kind: "PROJECT",
      identifier: "GPSA0904",
      raw: { "Job Number": "GPSA0904", "Job Value": null },
      disposition: "HELD",
      holdReason: "Job Value is empty",
    });

    const row = (await pool.query("SELECT disposition, hold_reason, project_id, raw_values FROM legacy_import_rows")).rows[0];

    expect(row).toEqual({ disposition: "HELD", hold_reason: "Job Value is empty", project_id: null, raw_values: { "Job Number": "GPSA0904", "Job Value": null } });
  });

  it("refuses a held record without a reason, and a reason on an imported record", async () => {
    const projectId = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });

    await expect(stageRow(batchId, { row: 99, kind: "PROJECT", identifier: "GPSA0904", disposition: "HELD" })).rejects.toMatchObject({
      constraint: "legacy_import_rows_hold_reason_ck",
    });
    await expect(
      stageRow(batchId, { row: 99, kind: "PROJECT", identifier: "GPSA0904", disposition: "HELD", holdReason: "   " })
    ).rejects.toMatchObject({ constraint: "legacy_import_rows_hold_reason_ck" });
    await expect(
      stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901", projectId, holdReason: "Why" })
    ).rejects.toMatchObject({ constraint: "legacy_import_rows_hold_reason_ck" });
  });

  it("refuses a held record that links a record, and an imported record that links none", async () => {
    const projectId = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });

    await expect(
      stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901", disposition: "HELD", holdReason: "Held", projectId })
    ).rejects.toMatchObject({ constraint: "legacy_import_rows_link_ck" });
    await expect(stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901" })).rejects.toMatchObject({
      constraint: "legacy_import_rows_link_ck",
    });
  });
});

describe("staging rules", () => {
  it("refuses a link that does not match the kind of record, and more than one link", async () => {
    const projectId = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });

    await expect(stageRow(batchId, { row: 57, kind: "CLIENT", identifier: "Test Hotel One", projectId })).rejects.toMatchObject({
      constraint: "legacy_import_rows_link_kind_ck",
    });
    await expect(stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901", projectId, clientId })).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("refuses an unknown kind or disposition, a blank source, and raw values that are not an object", async () => {
    const held = { disposition: "HELD" as const, holdReason: "Held" };

    await expect(stageRow(batchId, { row: 1, kind: "INVOICE" as never, identifier: "X", ...held })).rejects.toMatchObject({
      constraint: "legacy_import_rows_record_kind_ck",
    });
    await expect(stageRow(batchId, { row: 1, kind: "PROJECT", identifier: "X", disposition: "SKIPPED" as never, holdReason: "Held" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(stageRow(batchId, { row: 0, kind: "PROJECT", identifier: "X", ...held })).rejects.toMatchObject({
      constraint: "legacy_import_rows_source_ck",
    });
    await expect(stageRow(batchId, { row: 1, kind: "PROJECT", identifier: " ", ...held })).rejects.toMatchObject({
      constraint: "legacy_import_rows_source_ck",
    });
    await expect(
      pool.query(
        `INSERT INTO legacy_import_rows (batch_id, source_workbook, source_sheet, source_row, record_kind, original_identifier, raw_values, disposition, hold_reason)
         VALUES ($1, 'Job Register.xlsx', 'Register', 1, 'PROJECT', 'X', '[]'::jsonb, 'HELD', 'Held')`,
        [batchId]
      )
    ).rejects.toMatchObject({ constraint: "legacy_import_rows_raw_values_ck" });
  });

  it("does not let an imported record be deleted from under its staged row", async () => {
    const projectId = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    await stageRow(batchId, { row: 57, kind: "PROJECT", identifier: "GPSA0901", projectId });

    await expect(pool.query("DELETE FROM projects WHERE id = $1", [projectId])).rejects.toMatchObject({ code: "23503" });
  });
});

describe("no application route that imports", () => {
  it("offers no API path that stages or imports a record", async () => {
    for (const path of ["/api/legacy-import-rows", "/api/legacy-import-batches", "/api/legacy-import", "/api/import"]) {
      expect((await api().get(path).set(admin.headers)).status).toBe(404);
      expect((await api().post(path).set(admin.headers).send({})).status).toBe(404);
    }
    // The review routes read only.
    for (const path of ["/api/historical-data/rows", "/api/historical-data/import", "/api/historical-data/batches"]) {
      expect((await api().post(path).set(admin.headers).send({})).status).toBe(404);
    }

    expect((await pool.query("SELECT 1 FROM legacy_import_rows")).rowCount).toBe(0);
  });
});

describe("future invoice tracking", () => {
  it("can link historical projects and visits to invoices many-to-many, by ordinary foreign keys", async () => {
    const first = await insertHistoricalProject(clientId, { jobNumber: "GPSA0906" });
    const second = await insertHistoricalProject(clientId, { jobNumber: "GPSA0907" });
    const contractId = await insertImportedContract(clientId, { validFrom: addDays(now, -100), validTo: addDays(now, 100), cutoverDate: now });
    const visitId = await insertHistoricalVisit(contractId, { sequenceNo: 1, periodStart: addDays(now, -100), periodEnd: addDays(now, -10) });
    const client = await pool.connect();

    try {
      // A stand-in for the tables the Invoice Tracking module will add. Rolled back: nothing is left behind.
      await client.query("BEGIN");
      await client.query("CREATE TABLE trial_invoices (id bigint PRIMARY KEY, invoice_number text NOT NULL UNIQUE)");
      await client.query(
        `CREATE TABLE trial_invoice_allocations (
           invoice_id bigint NOT NULL REFERENCES trial_invoices (id),
           project_id bigint REFERENCES projects (id),
           amc_visit_id bigint REFERENCES amc_visits (id),
           CHECK (num_nonnulls(project_id, amc_visit_id) = 1)
         )`
      );
      await client.query("INSERT INTO trial_invoices (id, invoice_number) VALUES (1, '9005'), (2, '9006'), (3, '9007'), (4, '9004')");
      // One invoice on two jobs, two invoices on one job, and one invoice on a visit.
      await client.query(
        `INSERT INTO trial_invoice_allocations (invoice_id, project_id, amc_visit_id)
         VALUES (1, $1, NULL), (1, $2, NULL), (2, $1, NULL), (3, $1, NULL), (4, NULL, $3)`,
        [first, second, visitId]
      );

      const jobsOnInvoice = await client.query("SELECT 1 FROM trial_invoice_allocations WHERE invoice_id = 1");
      const invoicesOnJob = await client.query("SELECT 1 FROM trial_invoice_allocations WHERE project_id = $1", [first]);
      const invoicesOnVisit = await client.query("SELECT 1 FROM trial_invoice_allocations WHERE amc_visit_id = $1", [visitId]);

      expect([jobsOnInvoice.rowCount, invoicesOnJob.rowCount, invoicesOnVisit.rowCount]).toEqual([2, 3, 1]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
