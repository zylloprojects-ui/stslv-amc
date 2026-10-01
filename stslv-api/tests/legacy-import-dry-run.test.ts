import { appendFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import type { ImportConfig } from "../src/legacy-import/config";
import { readDatabase, WATCHED_TABLES, withReadOnly } from "../src/legacy-import/database";
import { loadSource, runDryRun, stagingRows, type DryRunResult } from "../src/legacy-import/dry-run";
import { parseArguments } from "../src/legacy-import/options";
import { buildPlan } from "../src/legacy-import/plan";
import { renderJson, renderReport } from "../src/legacy-import/report";
import { columnLetters, columnNumber, readWorkbook, readZip, serialToIsoDate } from "../src/legacy-import/xlsx";
import { closePool } from "./helpers";
import { database, serial, workbook, writeFixtureWorkbooks, zip } from "./legacy-import-fixtures";
import { insertClient, resetProjectData } from "./projects-helpers";

// The dry run end to end, against workbooks laid out like the client's but
// with invented content, and against the test database.

let config: ImportConfig;
let directory: string;

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

beforeAll(async () => {
  await resetProjectData();
  ({ config, directory } = writeFixtureWorkbooks());
});
afterAll(async () => {
  rmSync(directory, { recursive: true, force: true });
  await closePool();
});

describe("workbook reader", () => {
  it("reads stored and deflated ZIP entries", () => {
    const files = readZip(zip([["a.txt", "deflated ".repeat(50)], ["b/c.txt", "stored"]]));

    expect(files.get("a.txt")?.toString()).toBe("deflated ".repeat(50));
    expect(files.get("b/c.txt")?.toString()).toBe("stored");
    expect(() => readZip(Buffer.from("not a zip"))).toThrow(/Not a ZIP archive/);
  });

  it("reads numbers as stored text, text, formulas and font colour, and skips cells that hold nothing", () => {
    const sheet = readWorkbook(
      workbook("Data & more", [
        { ref: "A1", value: "Name <&> \"quoted\"" },
        { ref: "B1", value: 1577.276, style: 1 },
        { ref: "C1", value: 78.8638, formula: "B1*0.05", style: 2 },
        { ref: "D1", value: 0, formula: "(shared)" },
        { ref: "E1", style: 1 },
        { ref: "AA3", value: "padded " },
      ])
    ).sheets[0];

    expect(sheet?.name).toBe("Data & more");
    expect(sheet?.cells.get("A1")).toMatchObject({ type: "text", value: 'Name <&> "quoted"', formula: null, fontColor: null });
    expect(sheet?.cells.get("B1")).toMatchObject({ type: "number", value: "1577.276", fontColor: "FF00B050" });
    expect(sheet?.cells.get("C1")).toMatchObject({ type: "number", value: "78.8638", formula: "B1*0.05", fontColor: "FFFF0000" });
    expect(sheet?.cells.get("D1")).toMatchObject({ value: "0", formula: "(shared)" });
    // Formatting alone is not a value.
    expect(sheet?.cells.has("E1")).toBe(false);
    // Text is not trimmed by the reader.
    expect(sheet?.cells.get("AA3")).toMatchObject({ value: "padded ", column: "AA", row: 3 });
    expect(sheet?.maxRow).toBe(3);
  });

  it("converts column letters and day serials", () => {
    expect([columnNumber("A"), columnNumber("Z"), columnNumber("AA"), columnLetters(1), columnLetters(26), columnLetters(27)]).toEqual([1, 26, 27, "A", "Z", "AA"]);
    expect(serialToIsoDate(String(serial("2026-02-28")))).toBe("2026-02-28");
    expect(serialToIsoDate("45839")).toBe("2025-07-01");
    expect([serialToIsoDate("12.5"), serialToIsoDate("abc"), serialToIsoDate("0")]).toEqual([null, null, null]);
  });
});

describe("source workbooks", () => {
  it("stops before reading anything when a workbook differs from the analysed file", () => {
    const { config: other, directory: folder } = writeFixtureWorkbooks();

    try {
      appendFileSync(path.join(folder, "Jobs.xlsx"), Buffer.from([0]));

      expect(() => loadSource(other)).toThrow(/differ from the analysed files: Jobs\.xlsx.*Nothing was parsed or changed/s);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("stops when a workbook is missing or its sheet is named differently", () => {
    expect(() => loadSource({ ...config, workbooks: { ...config.workbooks, jobs: { ...config.workbooks.jobs, file: "Missing.xlsx" } } })).toThrow(/Source workbook not found/);
    expect(() => loadSource({ ...config, workbooks: { ...config.workbooks, jobs: { ...config.workbooks.jobs, sheet: "Other" } } })).toThrow(/has no sheet named "Other"/);
  });

  it("finds the tables by their headings and reads every row with its raw values", () => {
    const { data } = loadSource(config);

    expect(data.contracts.map((row) => [row.ref.row, row.clientRaw, row.system, row.validFrom, row.validTo, row.value, row.finalCredit])).toEqual([
      [5, "ALPHA HOTEL", "FIRE", "2025-07-01", "2026-06-30", { kind: "VALUE", amount: "1600.000", isZero: false }, { kind: "VALUE", amount: "1600.000", isZero: false }],
      [6, "BETA TOWER", "CCTV", "2026-02-01", "2027-01-31", { kind: "VALUE", amount: "3100.000", isZero: false }, { kind: "VALUE", amount: "3100.000", isZero: false }],
      [7, "GAMMA ", "Automation", "2026-03-01", "2027-02-28", { kind: "VALUE", amount: "12000.000", isZero: false }, { kind: "VALUE", amount: "10000.000", isZero: false }],
    ]);
    // The formatted empty row inside the table is not a record, and the raw values are as written.
    expect(data.contracts[0]?.raw).toMatchObject({ "S. No": "1", Client: "ALPHA HOTEL", "From (Validity)": String(serial("2025-07-01")), Value: "1600", "FINAL CREDIT [formula]": "G5" });
    expect(data.contracts[2]?.raw.Client).toBe("GAMMA ");

    expect(data.schedule).toHaveLength(12);
    expect(data.schedule[0]).toMatchObject({ ref: { sheet: "Schedule", row: 6, cell: "B6" }, month: "2026-01-01", label: "ALPHA HOTEL FIRE Q3", systems: "FA/FF", invoice: { kind: "NUMBER", raw: "9101" } });
    expect(data.schedule.map((row) => row.ref.cell)).toEqual(["B6", "H6", "N6", "B16", "H16", "N16", "B26", "H26", "N26", "B36", "H36", "N36"]);
    expect(data.schedule.find((row) => row.ref.cell === "N6")?.invoice).toEqual({ kind: "TEXT", raw: "DONE" });
    expect(data.schedule.find((row) => row.ref.cell === "B16")).toMatchObject({ invoice: { kind: "BLANK" }, raw: { "Inv. No.": null, "[font colour]": "FFFF0000" } });
    expect(data.schedule.find((row) => row.ref.cell === "N16")?.value).toEqual({ kind: "VALUE", amount: "0.000", isZero: true });

    expect(data.jobsYear).toBe(2025);
    expect(data.jobs).toHaveLength(14);
    expect(data.jobs[1]).toMatchObject({ ref: { row: 6, cell: "" }, jobNumber: "JOB0102", clientRaw: "ECHO ", value: { kind: "VALUE", amount: "1577.276" }, invoice: { kind: "TEXT", raw: "9002, 9003" } });
    // An empty job value is blank, not zero; an entered zero is zero.
    expect(data.jobs.find((row) => row.jobNumber === "JOB0108")?.value).toEqual({ kind: "BLANK" });
    expect(data.jobs.find((row) => row.jobNumber === "JOB0106")?.value).toEqual({ kind: "VALUE", amount: "0.000", isZero: true });
    expect(data.jobs.find((row) => row.jobNumber === "JOB0108")?.raw).toMatchObject({ "Job Value": null, VAT: "0", "VAT [formula]": "(shared)" });
    expect(data.jobs[0]?.raw).toMatchObject({ "Job Number": "JOB0101", PROFIT: "50", "INVOICE NUMBER": "9001", "[font colour]": "FF00B050" });

    expect(data.totals.jobValue?.value).toEqual({ kind: "VALUE", amount: "11451.609", isZero: false });
    expect(data.totals.scheduleBlocks).toHaveLength(12);
    expect(data.ignored.map((item) => item.ref.cell)).toEqual(["A38", "N10"]);
  });

  it("gives the expected plan for the fixture workbooks", () => {
    const plan = buildPlan(loadSource(config).data, database(), { approvedClientAliases: [] });

    expect(plan.checks.filter((check) => !check.passed)).toEqual([]);
    expect(plan.totals.clients).toEqual({ rawNames: 14, masters: 10, existing: 0, proposedNew: 5, deferred: 3, heldMasters: 2, heldAliases: 2 });
    expect(plan.totals.contracts).toMatchObject({ source: 3, importable: 2, held: 1, sourceValue: "16700.000", importableValue: "4700.000", heldValue: "12000.000", sourceFinalCredit: "14700.000" });
    expect(plan.totals.visits).toMatchObject({ source: 12, importable: 5, held: 7, generatedWithoutSource: 0, sourceAmount: "16700.000", importableAmount: "3125.000", heldAmount: "13575.000" });
    expect(plan.totals.visits.heldByReason).toEqual({ CONTRACT_HELD: 4, NOT_HISTORY_AT_CUTOVER: 1, POSSIBLE_RENEWAL: 2 });
    expect(plan.totals.projects).toMatchObject({ source: 14, importable: 8, held: 6, sourceValue: "11451.609", importableValue: "4810.609", heldValue: "6641.000" });
    expect(plan.totals.projects.heldByReason).toEqual({ CLIENT_ALIAS_NOT_APPROVED: 2, CLIENT_IDENTITY_UNCONFIRMED: 1, DUPLICATE_JOB_NUMBER: 2, JOB_VALUE_BLANK: 1 });
    expect(plan.totals.invoices.jobs).toEqual({
      INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT: 2,
      JOB_HAS_MULTIPLE_INVOICES: 1,
      NON_NUMERIC_MARKER: 1,
      NO_INVOICE_REFERENCE: 7,
      ONE_JOB_ONE_INVOICE: 3,
    });
    expect(plan.totals.invoices.schedule).toEqual({ AMC_PERIOD_ONE_INVOICE: 2, NON_NUMERIC_MARKER: 2, NO_INVOICE_REFERENCE: 8 });
    // Every proposed job number is the one in the register.
    expect(plan.projects.map((row) => row.proposed.jobNumber)).toEqual(loadSource(config).data.jobs.map((row) => row.jobNumber));
  });

  it("releases the alias jobs when, and only when, the alias is approved in the configuration", () => {
    const { data } = loadSource(config);
    const approved = buildPlan(data, database(), { approvedClientAliases: [{ alias: "DELTAHOUSE", master: "DELTA HOUSE" }] });

    expect(approved.totals.projects).toMatchObject({ importable: 9, held: 5 });
    expect(approved.totals.projects.heldByReason.CLIENT_ALIAS_NOT_APPROVED).toBe(1);
  });
});

describe("dry run against the database", () => {
  let before: string;
  let result: DryRunResult;
  let existingClient: string;

  beforeAll(async () => {
    // A client and a job that are already in the database.
    existingClient = await insertClient("alpha hotel");
    await pool.query("INSERT INTO projects (job_number, client_id, description, job_date, job_value, vat_rate) VALUES ('JOB0101', $1, 'Existing job', '2026-09-01', 10, 5)", [existingClient]);
    before = await fingerprint();
    result = await runDryRun(config, pool);
  });

  it("writes nothing: every row of every table is exactly as it was", async () => {
    expect(await fingerprint()).toBe(before);
    expect(result.after.database.counts).toEqual(result.database.counts);
    expect(Object.keys(result.database.counts)).toEqual([...WATCHED_TABLES]);
    expect(result.database.counts).toMatchObject({ clients: 1, projects: 1, amc_contracts: 0, amc_visits: 0, legacy_import_batches: 0, legacy_import_rows: 0 });
  });

  it("reads the database inside a read-only transaction, where a write is refused by PostgreSQL", async () => {
    await expect(withReadOnly(pool, (client) => client.query("INSERT INTO clients (name) VALUES ('Should not exist')"))).rejects.toMatchObject({ code: "25006" });
    await expect(withReadOnly(pool, (client) => client.query("INSERT INTO legacy_import_batches (label) VALUES ('Should not exist')"))).rejects.toMatchObject({ code: "25006" });
    expect(await fingerprint()).toBe(before);
    // The connection is returned usable.
    expect((await readDatabase(pool)).schema).toBe("stslv_test");
  });

  it("leaves the source workbooks byte for byte as they were", () => {
    expect(result.after.sources.map((file) => file.sha256)).toEqual(result.sources.map((file) => file.sha256));
    expect(result.sources.map((file) => file.sha256)).toEqual([config.workbooks.contracts.sha256, config.workbooks.schedule.sha256, config.workbooks.jobs.sha256]);
  });

  it("takes the cutover date from the database at the time of the run", async () => {
    const today = (await pool.query<{ today: string }>("SELECT current_date::text AS today")).rows[0]?.today;

    expect(result.plan.asOf).toBe(today);
    expect(result.plan.contracts.every((row) => row.proposed.scheduleCutoverDate === today)).toBe(true);
  });

  it("matches the existing client instead of proposing a duplicate, and holds the job number that already exists", () => {
    expect(result.plan.clients.names.find((name) => name.raw === "ALPHA HOTEL")).toMatchObject({ outcome: "EXISTING_CLIENT", existingClientId: existingClient });
    expect(result.plan.totals.clients).toMatchObject({ existing: 1, proposedNew: 4 });
    expect(result.plan.projects.find((row) => row.identifier === "JOB0101")?.holdReasons.map((reason) => reason.code)).toEqual(["JOB_NUMBER_ALREADY_IN_DATABASE"]);
  });

  it("is deterministic: a second run gives exactly the same data and the same report", async () => {
    const again = await runDryRun(config, pool);

    expect(renderJson(again)).toBe(renderJson(result));
    expect(renderReport(again)).toBe(renderReport(result));
  });

  it("prepares one staging row per source record, traceable to its workbook, sheet, row and raw values", () => {
    const staging = stagingRows(result.plan);
    const keys = staging.map((row) => [row.source_workbook, row.source_sheet, row.source_row, row.source_cell, row.record_kind].join("|"));

    expect(staging).toHaveLength(result.plan.clientRows.length + 3 + 12 + 14);
    expect(new Set(keys).size).toBe(staging.length);
    expect(staging.every((row) => (row.disposition === "HELD") === (row.hold_reason !== null))).toBe(true);
    expect(staging.find((row) => row.original_identifier === "JOB0102")).toMatchObject({
      source_workbook: "Jobs.xlsx",
      source_sheet: "Register",
      source_row: 6,
      record_kind: "PROJECT",
      disposition: "IMPORTED",
      hold_reason: null,
      // The original values survive normalization: the trailing space and the invoice cell are both here.
      raw_values: { Client: "ECHO ", "Job Value": "1577.276", "INVOICE NUMBER": "9002, 9003" },
    });
    expect(staging.find((row) => row.original_identifier === "JOB0108")).toMatchObject({ disposition: "HELD", hold_reason: expect.stringMatching(/^JOB_VALUE_BLANK: /) });
    expect(staging.filter((row) => row.record_kind === "AMC_VISIT")).toHaveLength(12);
  });

  it("prepares held rows that the staging table accepts as they are", async () => {
    const held = stagingRows(result.plan).filter((row) => row.disposition === "HELD");
    const client = await pool.connect();

    try {
      // Written and rolled back: proof that the rows fit migration 0031, with nothing left behind.
      await client.query("BEGIN");
      const batch = await client.query<{ id: string }>("INSERT INTO legacy_import_batches (label) VALUES ('Trial') RETURNING id");

      for (const row of held) {
        await client.query(
          `INSERT INTO legacy_import_rows (batch_id, source_workbook, source_sheet, source_row, source_cell, record_kind, original_identifier, raw_values, disposition, hold_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
          [batch.rows[0]?.id, row.source_workbook, row.source_sheet, row.source_row, row.source_cell, row.record_kind, row.original_identifier, JSON.stringify(row.raw_values), row.disposition, row.hold_reason]
        );
      }

      expect((await client.query("SELECT 1 FROM legacy_import_rows")).rowCount).toBe(held.length);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    expect(await fingerprint()).toBe(before);
  });

  it("writes a report with every required section and the confirmations", () => {
    const report = renderReport(result);

    for (let section = 1; section <= 23; section += 1) {
      expect(report).toMatch(new RegExp(`^## ${section}\\. `, "m"));
    }
    expect(report).toContain("# STSLEV AMC HISTORICAL EXCEL IMPORT DRY-RUN REPORT");
    expect(report).toContain("Generated without a source row | 0 |");
    expect(report).toMatch(/## 22\. No Excel business data was imported\n\nConfirmed\./);
    expect(report).toMatch(/## 23\. Source workbooks unchanged\n\nConfirmed\./);
    expect(report).not.toContain("NOT CONFIRMED");
    expect(report).not.toContain("FAILED");
    // The duplicate is reported with both source rows and no corrected number.
    expect(report).toContain("Job number JOB0109 is on 2 rows of the register (rows 9, 13)");
    expect(report).not.toContain("JOB0105");
  });

  it("carries the same plan as data", () => {
    const data = JSON.parse(renderJson(result)) as { dryRun: boolean; projects: unknown[]; visits: unknown[]; staging: unknown[]; database: { countsBefore: unknown; countsAfter: unknown } };

    expect(data.dryRun).toBe(true);
    expect(data.projects).toHaveLength(14);
    expect(data.visits).toHaveLength(12);
    expect(data.database.countsAfter).toEqual(data.database.countsBefore);
  });
});

describe("dry-run script options", () => {
  it("accepts a configuration file and an output folder", () => {
    expect(parseArguments([])).toEqual({ config: null, out: null });
    expect(parseArguments(["--config", "a.json", "--out", "folder"])).toEqual({ config: "a.json", out: "folder" });
  });

  it("has no option that imports: anything else stops the run", () => {
    for (const argument of ["--execute", "--import", "--apply", "--commit", "--no-dry-run", "--dry-run=false", "execute"]) {
      expect(() => parseArguments([argument])).toThrow(/only performs a dry run; it has no option that imports data/);
    }
    expect(() => parseArguments(["--config"])).toThrow(/Unknown or incomplete option/);
    expect(() => parseArguments(["--config", "--execute"])).toThrow(/Unknown or incomplete option/);
  });

  it("contains no statement that writes to a business table", () => {
    const folder = path.resolve(__dirname, "..", "src", "legacy-import");
    const sources = ["clients", "config", "database", "dry-run", "money", "options", "plan", "report", "source", "xlsx"].map((name) => readFileSync(path.join(folder, `${name}.ts`), "utf8"));
    const script = readFileSync(path.resolve(__dirname, "..", "src", "scripts", "legacy-import.ts"), "utf8");

    for (const text of [...sources, script]) {
      expect(text).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE)\b/i);
    }
  });
});
