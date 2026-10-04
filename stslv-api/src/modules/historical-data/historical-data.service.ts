import { pool } from "../../config/database";
import { notFound } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { ListRowsQuery, RecordKind } from "./historical-data.schemas";

// Historical Data Review: the staged source records of the controlled import
// (legacy_import_batches, legacy_import_rows), read-only.
//
// Every source record is here, imported or not. An imported record links the
// client, contract, visit or project it produced. A provisional record is a
// held staging row: it exists nowhere else in the application, so it is in no
// dashboard figure, schedule, invoice state or margin.
//
// This module only reads. Nothing here changes a staging row or a record.

export type ReviewStatus = "IMPORTED" | "PROVISIONAL";

export interface ReviewLink {
  type: "client" | "contract" | "visit" | "project";
  id: string;
  /** What the linked record is called in the application. */
  label: string;
}

export interface ReviewRow {
  id: string;
  batchId: string;
  kind: RecordKind;
  status: ReviewStatus;
  source: { workbook: string; sheet: string; row: number; cell: string };
  identifier: string;
  /** Every source value, by column heading, exactly as read. Null is an empty cell. */
  rawValues: Record<string, string | null>;
  /** The headings of rawValues in the order of the sheet. */
  sourceColumns: string[];
  /** What the import proposes to store. A value the source does not give is null. */
  proposedValues: Record<string, unknown>;
  holdReasons: { code: string; message: string }[];
  warnings: string[];
  invoiceReference: { rawCell: string | null; numbers: string[]; classification: string; notes: string[] } | null;
  link: ReviewLink | null;
}

interface RowRecord {
  id: string;
  batch_id: string;
  record_kind: RecordKind;
  disposition: "IMPORTED" | "HELD";
  source_workbook: string;
  source_sheet: string;
  source_row: number;
  source_cell: string;
  original_identifier: string;
  raw_values: ReviewRow["rawValues"];
  source_columns: string[];
  proposed_values: ReviewRow["proposedValues"];
  hold_reasons: ReviewRow["holdReasons"];
  warnings: string[];
  invoice_reference: ReviewRow["invoiceReference"];
  client_id: string | null;
  amc_contract_id: string | null;
  amc_visit_id: string | null;
  project_id: string | null;
  client_name: string | null;
  contract_label: string | null;
  visit_label: string | null;
  job_number: string | null;
}

const SELECT_ROWS = `
  SELECT r.id, r.batch_id, r.record_kind, r.disposition, r.source_workbook, r.source_sheet, r.source_row, r.source_cell,
         r.original_identifier, r.raw_values, r.source_columns, r.proposed_values, r.hold_reasons, r.warnings, r.invoice_reference,
         r.client_id, r.amc_contract_id, r.amc_visit_id, r.project_id,
         c.name AS client_name,
         cc.name || ' / ' || ac.system_description AS contract_label,
         vcc.name || ' / ' || vac.system_description || ' / ' || to_char(v.period_start, 'YYYY-MM-DD') AS visit_label,
         p.job_number
  FROM legacy_import_rows r
  LEFT JOIN clients c ON c.id = r.client_id
  LEFT JOIN amc_contracts ac ON ac.id = r.amc_contract_id
  LEFT JOIN clients cc ON cc.id = ac.client_id
  LEFT JOIN amc_visits v ON v.id = r.amc_visit_id
  LEFT JOIN amc_contracts vac ON vac.id = v.amc_contract_id
  LEFT JOIN clients vcc ON vcc.id = vac.client_id
  LEFT JOIN projects p ON p.id = r.project_id`;

function linkOf(row: RowRecord): ReviewLink | null {
  if (row.client_id !== null) return { type: "client", id: row.client_id, label: row.client_name ?? "" };
  if (row.amc_contract_id !== null) return { type: "contract", id: row.amc_contract_id, label: row.contract_label ?? "" };
  if (row.amc_visit_id !== null) return { type: "visit", id: row.amc_visit_id, label: row.visit_label ?? "" };
  if (row.project_id !== null) return { type: "project", id: row.project_id, label: row.job_number ?? "" };

  return null;
}

function toReviewRow(row: RowRecord): ReviewRow {
  return {
    id: row.id,
    batchId: row.batch_id,
    kind: row.record_kind,
    status: row.disposition === "IMPORTED" ? "IMPORTED" : "PROVISIONAL",
    source: { workbook: row.source_workbook, sheet: row.source_sheet, row: row.source_row, cell: row.source_cell },
    identifier: row.original_identifier,
    rawValues: row.raw_values,
    sourceColumns: row.source_columns,
    proposedValues: row.proposed_values,
    holdReasons: row.hold_reasons,
    warnings: row.warnings,
    invoiceReference: row.invoice_reference,
    link: linkOf(row),
  };
}

export async function listReviewRows(query: ListRowsQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);

    return `$${params.length}`;
  };

  if (query.kind !== "all") {
    conditions.push(`r.record_kind = ${param(query.kind)}`);
  }
  if (query.status !== "all") {
    conditions.push(`r.disposition = ${param(query.status === "imported" ? "IMPORTED" : "HELD")}`);
  }
  if (query.reason) {
    conditions.push(`r.hold_reasons @> ${param(JSON.stringify([{ code: query.reason }]))}::jsonb`);
  }
  if (query.invoice === "with") {
    conditions.push("r.invoice_reference->>'rawCell' IS NOT NULL");
  } else if (query.invoice === "shared") {
    conditions.push(
      "r.invoice_reference->>'classification' IN ('JOB_HAS_MULTIPLE_INVOICES', 'INVOICE_ON_MULTIPLE_JOBS_SAME_CLIENT', 'INVOICE_ON_MULTIPLE_JOBS_CROSS_CLIENT', 'JOB_HAS_MULTIPLE_INVOICES_AND_SHARED')"
    );
  } else if (query.invoice === "marker") {
    conditions.push("r.invoice_reference->>'classification' = 'NON_NUMERIC_MARKER'");
  }
  if (query.search) {
    const p = param(`%${escapeLike(query.search)}%`);

    conditions.push(`(r.original_identifier ILIKE ${p} OR r.raw_values::text ILIKE ${p} OR r.proposed_values::text ILIKE ${p})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM legacy_import_rows r ${where}`, params);
  // Staging rows are written in source order, so the id is that order.
  const rows = await pool.query<RowRecord>(`${SELECT_ROWS} ${where} ORDER BY r.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
    ...params,
    query.pageSize,
    (query.page - 1) * query.pageSize,
  ]);

  return {
    items: rows.rows.map(toReviewRow),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getReviewRow(id: string): Promise<ReviewRow> {
  const result = await pool.query<RowRecord>(`${SELECT_ROWS} WHERE r.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Historical record not found.");
  }

  return toReviewRow(row);
}

// The amount a record carries in its source, by kind. Client names carry none.
// It is read from the proposed values, where an empty source cell is null:
// an empty amount adds nothing and is never counted as zero.
const SOURCE_AMOUNT = `CASE r.record_kind
    WHEN 'PROJECT' THEN (r.proposed_values->>'jobValue')::numeric
    WHEN 'AMC_CONTRACT' THEN (r.proposed_values->>'contractValue')::numeric
    WHEN 'AMC_VISIT' THEN (r.proposed_values->>'visitAmount')::numeric
  END`;

export async function getReviewSummary() {
  const batches = await pool.query<{ id: string; label: string; cutover_date: string; source_files: unknown; created_at: Date; rows: number }>(
    `SELECT b.id, b.label, b.cutover_date::text AS cutover_date, b.source_files, b.created_at,
            (SELECT count(*)::int FROM legacy_import_rows r WHERE r.batch_id = b.id) AS rows
     FROM legacy_import_batches b
     ORDER BY b.id`
  );
  const kinds = await pool.query<{ kind: RecordKind; imported: number; provisional: number; imported_amount: string | null; provisional_amount: string | null; without_amount: number }>(
    `SELECT r.record_kind AS kind,
            count(*) FILTER (WHERE r.disposition = 'IMPORTED')::int AS imported,
            count(*) FILTER (WHERE r.disposition = 'HELD')::int AS provisional,
            (sum(${SOURCE_AMOUNT}) FILTER (WHERE r.disposition = 'IMPORTED'))::numeric(16,3)::text AS imported_amount,
            (sum(${SOURCE_AMOUNT}) FILTER (WHERE r.disposition = 'HELD'))::numeric(16,3)::text AS provisional_amount,
            count(*) FILTER (WHERE r.record_kind <> 'CLIENT' AND ${SOURCE_AMOUNT} IS NULL)::int AS without_amount
     FROM legacy_import_rows r
     GROUP BY r.record_kind`
  );
  const names = await pool.query<{ distinct_names: number; linked_clients: number }>(
    `SELECT count(DISTINCT original_identifier)::int AS distinct_names, count(DISTINCT client_id)::int AS linked_clients
     FROM legacy_import_rows WHERE record_kind = 'CLIENT'`
  );
  const reasons = await pool.query<{ kind: RecordKind; code: string; count: number }>(
    `SELECT r.record_kind AS kind, h->>'code' AS code, count(*)::int AS count
     FROM legacy_import_rows r
     CROSS JOIN LATERAL jsonb_array_elements(r.hold_reasons) AS h
     GROUP BY r.record_kind, h->>'code'
     ORDER BY r.record_kind, h->>'code'`
  );
  const invoices = await pool.query<{ kind: RecordKind; classification: string; count: number }>(
    `SELECT r.record_kind AS kind, r.invoice_reference->>'classification' AS classification, count(*)::int AS count
     FROM legacy_import_rows r
     WHERE r.invoice_reference IS NOT NULL
     GROUP BY r.record_kind, r.invoice_reference->>'classification'
     ORDER BY r.record_kind, r.invoice_reference->>'classification'`
  );
  const numbers = await pool.query<{ mentions: number; distinct_numbers: number }>(
    `SELECT count(*)::int AS mentions, count(DISTINCT n)::int AS distinct_numbers
     FROM legacy_import_rows r
     CROSS JOIN LATERAL jsonb_array_elements_text(r.invoice_reference->'numbers') AS n
     WHERE r.invoice_reference IS NOT NULL`
  );
  const byKind = (["CLIENT", "AMC_CONTRACT", "AMC_VISIT", "PROJECT"] as const).map((kind) => {
    const row = kinds.rows.find((candidate) => candidate.kind === kind);

    return {
      kind,
      total: (row?.imported ?? 0) + (row?.provisional ?? 0),
      imported: row?.imported ?? 0,
      provisional: row?.provisional ?? 0,
      // Null for client names, which carry no amount. "0.000" when no record of that status carries one.
      importedAmount: kind === "CLIENT" ? null : (row?.imported_amount ?? "0.000"),
      provisionalAmount: kind === "CLIENT" ? null : (row?.provisional_amount ?? "0.000"),
      /** Records whose source gives no amount. They add nothing to the totals: an empty cell is not zero. */
      withoutAmount: row?.without_amount ?? 0,
    };
  });

  return {
    batches: batches.rows.map((batch) => ({
      id: batch.id,
      label: batch.label,
      cutoverDate: batch.cutover_date,
      sourceFiles: batch.source_files,
      createdAt: batch.created_at.toISOString(),
      rows: batch.rows,
    })),
    totals: {
      records: byKind.reduce((sum, kind) => sum + kind.total, 0),
      imported: byKind.reduce((sum, kind) => sum + kind.imported, 0),
      provisional: byKind.reduce((sum, kind) => sum + kind.provisional, 0),
    },
    byKind,
    clientNames: { distinct: names.rows[0]?.distinct_names ?? 0, clients: names.rows[0]?.linked_clients ?? 0 },
    holdReasons: reasons.rows,
    invoiceReferences: {
      byClassification: invoices.rows,
      numbersMentioned: numbers.rows[0]?.mentions ?? 0,
      distinctNumbers: numbers.rows[0]?.distinct_numbers ?? 0,
    },
  };
}
