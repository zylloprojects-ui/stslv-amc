import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import type { ImportConfig, WorkbookRole } from "./config";
import { readDatabase, type DatabaseSnapshot } from "./database";
import { buildPlan, type ImportPlan, type PlanRow } from "./plan";
import { parseContracts, parseJobs, parseSchedule, type SourceData } from "./source";
import { readWorkbook, type Sheet } from "./xlsx";

// The dry run: SOURCE -> PARSE -> NORMALIZE -> VALIDATE -> CLASSIFY -> PLAN,
// and then it stops. It opens the workbooks for reading, reads the database in
// a read-only transaction, and writes to neither. There is no code path from
// here to an INSERT.

export interface SourceFile {
  role: WorkbookRole;
  file: string;
  path: string;
  sheet: string;
  bytes: number;
  /** Last modification time of the file, as the file system reports it. */
  modified: string;
  sha256Expected: string;
  sha256: string;
}

/** A row as it would be written to legacy_import_rows. In a dry run it is only listed. */
export interface StagedRow {
  source_workbook: string;
  source_sheet: string;
  source_row: number;
  source_cell: string;
  record_kind: string;
  original_identifier: string;
  raw_values: Record<string, string | null>;
  disposition: "IMPORTED" | "HELD";
  hold_reason: string | null;
}

export interface DryRunResult {
  sources: SourceFile[];
  source: SourceData;
  database: DatabaseSnapshot;
  plan: ImportPlan;
  staging: StagedRow[];
  /** Proof that the run changed nothing: the same readings taken again at the end. */
  after: { database: DatabaseSnapshot; sources: SourceFile[] };
}

const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

function describe(config: ImportConfig, role: WorkbookRole, buffer: Buffer): SourceFile {
  const workbook = config.workbooks[role];
  const file = path.resolve(config.sourceDirectory, workbook.file);

  return {
    role,
    file: workbook.file,
    path: file,
    sheet: workbook.sheet,
    bytes: buffer.length,
    modified: statSync(file).mtime.toISOString(),
    sha256Expected: workbook.sha256.toLowerCase(),
    sha256: sha256(buffer),
  };
}

function sheetOf(buffer: Buffer, file: SourceFile): Sheet {
  const sheet = readWorkbook(buffer).sheets.find((candidate) => candidate.name === file.sheet);

  if (!sheet) {
    throw new Error(`${file.file} has no sheet named "${file.sheet}".`);
  }

  return sheet;
}

/**
 * Reads the three workbooks. Stops before parsing anything if a file is
 * missing or is not byte-for-byte the file that was analysed.
 */
export function loadSource(config: ImportConfig): { data: SourceData; files: SourceFile[] } {
  const roles: WorkbookRole[] = ["contracts", "schedule", "jobs"];
  const buffers = new Map<WorkbookRole, Buffer>();
  const files: SourceFile[] = [];

  for (const role of roles) {
    const file = path.resolve(config.sourceDirectory, config.workbooks[role].file);
    let buffer: Buffer;

    try {
      buffer = readFileSync(file);
    } catch {
      throw new Error(`Source workbook not found: ${file}. Nothing was read or changed.`);
    }

    buffers.set(role, buffer);
    files.push(describe(config, role, buffer));
  }

  const changed = files.filter((file) => file.sha256 !== file.sha256Expected);

  if (changed.length > 0) {
    throw new Error(
      `Source workbook(s) differ from the analysed files: ${changed.map((file) => `${file.file} (expected ${file.sha256Expected}, found ${file.sha256})`).join("; ")}. ` +
        "Nothing was parsed or changed."
    );
  }

  const file = (role: WorkbookRole) => files.find((candidate) => candidate.role === role) as SourceFile;
  const contracts = parseContracts(file("contracts").file, sheetOf(buffers.get("contracts") as Buffer, file("contracts")));
  const schedule = parseSchedule(file("schedule").file, sheetOf(buffers.get("schedule") as Buffer, file("schedule")));
  const jobs = parseJobs(file("jobs").file, sheetOf(buffers.get("jobs") as Buffer, file("jobs")));

  return {
    files,
    data: {
      contracts: contracts.contracts,
      schedule: schedule.schedule,
      jobs: jobs.jobs,
      jobsYear: jobs.jobsYear,
      totals: {
        contractValue: contracts.totals.contractValue,
        finalCredit: contracts.totals.finalCredit,
        jobValue: jobs.total,
        scheduleBlocks: schedule.blockTotals,
      },
      ignored: [...schedule.ignored, ...jobs.ignored],
    },
  };
}

/** The staging rows a real import would write, in source order. */
export function stagingRows(plan: ImportPlan): StagedRow[] {
  const rows: PlanRow<unknown>[] = [...plan.clientRows, ...plan.contracts, ...plan.visits, ...plan.projects];

  return rows.map((row) => ({
    source_workbook: row.source.workbook,
    source_sheet: row.source.sheet,
    source_row: row.source.row,
    source_cell: row.source.cell,
    record_kind: row.kind,
    original_identifier: row.identifier,
    raw_values: row.raw,
    disposition: row.disposition === "IMPORTABLE" ? "IMPORTED" : "HELD",
    hold_reason: row.disposition === "HELD" ? row.holdReasons.map((reason) => `${reason.code}: ${reason.message}`).join(" | ") : null,
  }));
}

export async function runDryRun(config: ImportConfig, pool: Pool): Promise<DryRunResult> {
  const { data, files } = loadSource(config);
  const database = await readDatabase(pool);
  const plan = buildPlan(data, database, { approvedClientAliases: config.approvedClientAliases });
  const staging = stagingRows(plan);

  // The same readings again: the database and the workbooks must be as they were.
  const after = {
    database: await readDatabase(pool),
    sources: (["contracts", "schedule", "jobs"] as WorkbookRole[]).map((role) =>
      describe(config, role, readFileSync(path.resolve(config.sourceDirectory, config.workbooks[role].file)))
    ),
  };

  return { sources: files, source: data, database, plan, staging, after };
}
