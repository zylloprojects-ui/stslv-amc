import { pool } from "../src/config/database";

// Historical records are created only by the controlled import, which writes
// to the database directly. These helpers stand in for it: they insert the
// same rows it would, with SQL. No API route can create them.

/** A staging batch. Without a cutover date the database supplies its own current date. */
export async function insertBatch(label = "Test import", cutoverDate?: string): Promise<{ id: string; cutoverDate: string }> {
  const result =
    cutoverDate === undefined
      ? await pool.query<{ id: string; cutover_date: string }>(
          "INSERT INTO legacy_import_batches (label) VALUES ($1) RETURNING id, cutover_date::text AS cutover_date",
          [label]
        )
      : await pool.query<{ id: string; cutover_date: string }>(
          "INSERT INTO legacy_import_batches (label, cutover_date) VALUES ($1, $2) RETURNING id, cutover_date::text AS cutover_date",
          [label, cutoverDate]
        );
  const row = result.rows[0] as { id: string; cutover_date: string };

  return { id: row.id, cutoverDate: row.cutover_date };
}

export interface HistoricalProjectInput {
  jobNumber: string;
  legacyStatus?: string;
  /** First day of the month the source gives. */
  jobDate?: string;
  jobValue?: string;
  description?: string;
}

/** A job as the import stores it: HISTORICAL, source status kept, month-only date, no completion date. */
export async function insertHistoricalProject(clientId: string, input: HistoricalProjectInput): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (job_number, client_id, description, job_date, job_date_precision, job_value, vat_rate, status, legacy_status)
     VALUES ($1, $2, $3, $4, 'MONTH', $5, 5, 'HISTORICAL', $6)
     RETURNING id`,
    [
      input.jobNumber,
      clientId,
      input.description ?? "Historical job",
      input.jobDate ?? "2025-02-01",
      input.jobValue ?? "500.000",
      input.legacyStatus ?? "Completed",
    ]
  );

  return (result.rows[0] as { id: string }).id;
}

export interface ImportedContractInput {
  validFrom: string;
  validTo: string;
  /** The date of the import: no period that starts before it is ever generated. */
  cutoverDate: string;
  frequency?: string;
  system?: string;
  contractValue?: string;
  defaultVisitAmount?: string | null;
}

/** A contract as the import stores it: a draft carrying the cutover date of its import. */
export async function insertImportedContract(clientId: string, input: ImportedContractInput): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO amc_contracts
       (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency,
        default_visit_amount, status, schedule_cutover_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8)
     RETURNING id`,
    [
      clientId,
      input.validFrom,
      input.validTo,
      input.system ?? "FIRE",
      input.contractValue ?? "1620.000",
      input.frequency ?? "QUARTERLY",
      input.defaultVisitAmount === undefined ? "405.000" : input.defaultVisitAmount,
      input.cutoverDate,
    ]
  );

  return (result.rows[0] as { id: string }).id;
}

export interface HistoricalVisitInput {
  sequenceNo: number;
  periodStart: string;
  periodEnd: string;
  visitAmount?: string | null;
}

/** One period row of the source schedule: the period and the amount it gives, and nothing about execution. */
export async function insertHistoricalVisit(contractId: string, input: HistoricalVisitInput): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO amc_visits
       (amc_contract_id, sequence_no, period_start, period_end, original_scheduled_date, scheduled_date, status, visit_amount)
     VALUES ($1, $2, $3, $4, $3, $3, 'HISTORICAL', $5)
     RETURNING id`,
    [contractId, input.sequenceNo, input.periodStart, input.periodEnd, input.visitAmount === undefined ? "405.000" : input.visitAmount]
  );

  return (result.rows[0] as { id: string }).id;
}

export interface StagedRowInput {
  workbook?: string;
  sheet?: string;
  row: number;
  cell?: string;
  kind: "CLIENT" | "AMC_CONTRACT" | "AMC_VISIT" | "PROJECT";
  identifier: string;
  raw?: Record<string, unknown>;
  disposition?: "IMPORTED" | "HELD";
  holdReason?: string | null;
  clientId?: string | null;
  contractId?: string | null;
  visitId?: string | null;
  projectId?: string | null;
}

export function stageRow(batchId: string, input: StagedRowInput) {
  return pool.query<{ id: string }>(
    `INSERT INTO legacy_import_rows
       (batch_id, source_workbook, source_sheet, source_row, source_cell, record_kind, original_identifier, raw_values,
        disposition, hold_reason, client_id, amc_contract_id, amc_visit_id, project_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      batchId,
      input.workbook ?? "Job Register.xlsx",
      input.sheet ?? "Register",
      input.row,
      input.cell ?? "",
      input.kind,
      input.identifier,
      JSON.stringify(input.raw ?? {}),
      input.disposition ?? "IMPORTED",
      input.holdReason ?? null,
      input.clientId ?? null,
      input.contractId ?? null,
      input.visitId ?? null,
      input.projectId ?? null,
    ]
  );
}
