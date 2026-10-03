import type { Pool, PoolClient } from "pg";
import { logActivity } from "../shared/activity-log";
import type { ImportConfig } from "./config";
import { readSnapshot, type DatabaseSnapshot } from "./database";
import { loadSource, planRows, stagedRow, type SourceFile, type StagedRow } from "./dry-run";
import { addAmounts } from "./money";
import { buildPlan, type ContractProposal, type ImportPlan, type PlanCheck, type PlanRow, type ProjectProposal, type VisitProposal } from "./plan";

// The controlled import: SOURCE -> PARSE -> NORMALIZE -> VALIDATE -> CLASSIFY
// -> PLAN (the same plan the dry run reports) -> WRITE -> RECONCILE.
//
// What it writes, in one transaction:
//   * one staging row for every source record, imported or held;
//   * for an importable record only, the client, DRAFT contract, HISTORICAL
//     visit or HISTORICAL project the plan proposes, linked from its staging row.
//
// What it never does:
//   * change or delete a record that already exists;
//   * create anything for a held record: it stays in staging, provisional;
//   * create an invoice, a visit the source does not list, or a value the
//     source does not give;
//   * touch the job-number sequence.
//
// Running it again is safe: a source record that is already staged is left
// exactly as it is, so a second run writes nothing.

/** One import at a time, in this database. */
const ADVISORY_LOCK_KEY = 5_031_001;

export interface ApplyOptions {
  /** Label of the batch. */
  label?: string;
  /** The signed-in user who started the import. Null from the command line. */
  createdBy?: string | null;
}

export interface ApplyResult {
  database: string;
  schema: string;
  sources: SourceFile[];
  plan: ImportPlan;
  /** Null when every source record was already staged and nothing was written. */
  batchId: string | null;
  cutoverDate: string;
  /** Source records in the plan, and how many of them an earlier run had already staged. */
  sourceRecords: number;
  alreadyStaged: number;
  staged: { imported: number; held: number };
  created: { clients: number; contracts: number; visits: number; projects: number };
  /** Clients that were already in the database and are used as they are. */
  existingClientsUsed: number;
  reconciliation: PlanCheck[];
  before: DatabaseSnapshot["counts"];
  after: DatabaseSnapshot["counts"];
}

const sourceKey = (row: Pick<StagedRow, "source_workbook" | "source_sheet" | "source_row" | "source_cell" | "record_kind">): string =>
  [row.source_workbook, row.source_sheet, row.source_row, row.source_cell, row.record_kind].join("|");

/** A value an importable row always has. Its absence means the plan and the import disagree. */
function required<T>(value: T | null | undefined, what: string, row: PlanRow<unknown>): T {
  if (value === null || value === undefined) {
    throw new Error(`The plan marks ${row.kind} "${row.identifier}" (row ${row.source.row}) as importable but gives no ${what}. Nothing was imported.`);
  }

  return value;
}

interface Links {
  client_id: string | null;
  amc_contract_id: string | null;
  amc_visit_id: string | null;
  project_id: string | null;
}

async function stage(client: PoolClient, batchId: string, row: StagedRow, links: Partial<Links>): Promise<void> {
  await client.query(
    `INSERT INTO legacy_import_rows
       (batch_id, source_workbook, source_sheet, source_row, source_cell, record_kind, original_identifier, raw_values,
        disposition, hold_reason, proposed_values, hold_reasons, warnings, invoice_reference,
        client_id, amc_contract_id, amc_visit_id, project_id, source_columns)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19::jsonb)`,
    [
      batchId,
      row.source_workbook,
      row.source_sheet,
      row.source_row,
      row.source_cell,
      row.record_kind,
      row.original_identifier,
      JSON.stringify(row.raw_values),
      row.disposition,
      row.hold_reason,
      JSON.stringify(row.proposed_values),
      JSON.stringify(row.hold_reasons),
      JSON.stringify(row.warnings),
      row.invoice_reference === null ? null : JSON.stringify(row.invoice_reference),
      links.client_id ?? null,
      links.amc_contract_id ?? null,
      links.amc_visit_id ?? null,
      links.project_id ?? null,
      JSON.stringify(row.source_columns),
    ]
  );
}

export async function applyImport(config: ImportConfig, pool: Pool, options: ApplyOptions = {}): Promise<ApplyResult> {
  // Stops here, before any connection, if a workbook is missing or is not the analysed file.
  const { data, files } = loadSource(config);
  const createdBy = options.createdBy ?? null;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_KEY]);

    const before = await readSnapshot(client);
    const plan = buildPlan(data, before, { approvedClientAliases: config.approvedClientAliases });
    const failed = plan.checks.filter((check) => !check.passed);

    if (failed.length > 0) {
      throw new Error(`The plan does not account for the source: ${failed.map((check) => `${check.name} (${check.detail})`).join("; ")}. Nothing was imported.`);
    }

    const sequenceBefore = await client.query<{ state: string }>("SELECT string_agg(s::text, '|' ORDER BY s.sequence_key) AS state FROM number_sequences s");
    const earlier = await client.query<{ source_workbook: string; source_sheet: string; source_row: number; source_cell: string; record_kind: string; amc_contract_id: string | null }>(
      "SELECT source_workbook, source_sheet, source_row, source_cell, record_kind, amc_contract_id FROM legacy_import_rows"
    );
    const staged = new Set(earlier.rows.map(sourceKey));
    const rows = planRows(plan).map((row) => ({ row, staging: stagedRow(plan, row) }));
    const pending = rows.filter(({ staging }) => !staged.has(sourceKey(staging)));
    const result: ApplyResult = {
      database: before.database,
      schema: before.schema,
      sources: files,
      plan,
      batchId: null,
      cutoverDate: plan.asOf,
      sourceRecords: rows.length,
      alreadyStaged: rows.length - pending.length,
      staged: { imported: 0, held: 0 },
      created: { clients: 0, contracts: 0, visits: 0, projects: 0 },
      existingClientsUsed: 0,
      reconciliation: [],
      before: before.counts,
      after: before.counts,
    };

    if (pending.length === 0) {
      // Every source record is already staged: there is nothing to write, not even a batch.
      await client.query("ROLLBACK");

      return result;
    }

    const batch = await client.query<{ id: string }>(
      "INSERT INTO legacy_import_batches (label, cutover_date, source_files, created_by) VALUES ($1, $2, $3::jsonb, $4) RETURNING id",
      [options.label ?? "Historical Excel import", plan.asOf, JSON.stringify(files.map((file) => ({ name: file.file, sheet: file.sheet, sha256: file.sha256 }))), createdBy]
    );
    const batchId = (batch.rows[0] as { id: string }).id;

    // --- clients: one record per master name, created the first time it is needed ---
    const clientIds = new Map<string, string>();
    const existingUsed = new Set<string>();
    const clientIdOf = async (raw: string | null, row: PlanRow<unknown>): Promise<string> => {
      const name = required(plan.clients.names.find((candidate) => candidate.raw === raw), "client", row);
      const known = clientIds.get(name.masterKey);

      if (known) {
        return known;
      }

      let id = name.existingClientId;

      if (id === null) {
        const created = await client.query<{ id: string }>("INSERT INTO clients (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id", [name.masterName, createdBy]);

        id = (created.rows[0] as { id: string }).id;
        result.created.clients += 1;
      } else {
        existingUsed.add(id);
      }

      clientIds.set(name.masterKey, id);

      return id;
    };
    const write = async (staging: StagedRow, links: Partial<Links>) => {
      await stage(client, batchId, staging, links);
      result.staged[staging.disposition === "IMPORTED" ? "imported" : "held"] += 1;
    };
    const pendingOf = (kind: StagedRow["record_kind"]) => pending.filter(({ row }) => row.kind === kind);

    for (const { row, staging } of pendingOf("CLIENT")) {
      await write(staging, row.disposition === "IMPORTABLE" ? { client_id: await clientIdOf(row.identifier, row) } : {});
    }

    // --- contracts: DRAFT, with the cutover date of this batch ---
    const contractIds = new Map<number, string>();
    const contractWorkbook = config.workbooks.contracts.file;

    for (const earlierRow of earlier.rows) {
      if (earlierRow.record_kind === "AMC_CONTRACT" && earlierRow.amc_contract_id !== null && earlierRow.source_workbook === contractWorkbook) {
        contractIds.set(earlierRow.source_row, earlierRow.amc_contract_id);
      }
    }

    for (const { row, staging } of pendingOf("AMC_CONTRACT")) {
      if (row.disposition !== "IMPORTABLE") {
        await write(staging, {});
        continue;
      }

      const proposed = row.proposed as ContractProposal;
      const created = await client.query<{ id: string }>(
        `INSERT INTO amc_contracts
           (client_id, responsible_engineer, valid_from, valid_to, system_description, contract_value, final_credit,
            maintenance_frequency, default_visit_amount, status, schedule_cutover_date, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'DRAFT', $10, $11, $11)
         RETURNING id`,
        [
          await clientIdOf(proposed.clientRaw, row),
          proposed.responsibleEngineer,
          required(proposed.validFrom, "start of validity", row),
          required(proposed.validTo, "end of validity", row),
          required(proposed.systemDescription, "system", row),
          required(proposed.contractValue, "contract value", row),
          proposed.finalCredit,
          required(proposed.maintenanceFrequency, "maintenance frequency", row),
          proposed.defaultVisitAmount,
          plan.asOf,
          createdBy,
        ]
      );
      const id = (created.rows[0] as { id: string }).id;

      contractIds.set(row.source.row, id);
      result.created.contracts += 1;
      await write(staging, { amc_contract_id: id });
    }

    // --- schedule rows: one HISTORICAL visit per importable source row, none otherwise ---
    for (const { row, staging } of pendingOf("AMC_VISIT")) {
      if (row.disposition !== "IMPORTABLE") {
        await write(staging, {});
        continue;
      }

      const proposed = row.proposed as VisitProposal;
      const contractId = required(contractIds.get(required(proposed.contractSourceRow, "contract", row)), "imported contract", row);
      const periodStart = required(proposed.periodStart, "period start", row);
      // The source gives a period, not a planned day: the mandatory date columns hold the period start.
      const created = await client.query<{ id: string }>(
        `INSERT INTO amc_visits
           (amc_contract_id, sequence_no, period_start, period_end, original_scheduled_date, scheduled_date, status, visit_amount, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $3, $3, 'HISTORICAL', $5, $6, $6)
         RETURNING id`,
        [contractId, required(proposed.sequenceNo, "period number", row), periodStart, required(proposed.periodEnd, "period end", row), proposed.visitAmount, createdBy]
      );

      result.created.visits += 1;
      await write(staging, { amc_visit_id: (created.rows[0] as { id: string }).id });
    }

    // --- jobs: HISTORICAL projects with the job number of the register ---
    const importedValues: string[] = [];

    for (const { row, staging } of pendingOf("PROJECT")) {
      if (row.disposition !== "IMPORTABLE") {
        await write(staging, {});
        continue;
      }

      const proposed = row.proposed as ProjectProposal;
      const created = await client.query<{ id: string; vat_amount: string; grand_value: string }>(
        `INSERT INTO projects
           (job_number, client_id, description, job_date, job_date_precision, job_value, vat_rate, status, legacy_status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'MONTH', $5, $6, 'HISTORICAL', $7, $8, $8)
         RETURNING id, vat_amount::text AS vat_amount, grand_value::text AS grand_value`,
        [
          required(proposed.jobNumber, "job number", row),
          await clientIdOf(proposed.clientRaw, row),
          required(proposed.description, "description", row),
          required(proposed.jobDate, "month", row),
          required(proposed.jobValue, "job value", row),
          required(proposed.vatRate, "VAT rate", row),
          required(proposed.legacyStatus, "source status", row),
          createdBy,
        ]
      );
      const stored = created.rows[0] as { id: string; vat_amount: string; grand_value: string };

      // The database generates VAT and grand value. They must be the figures the plan reported.
      if (stored.vat_amount !== proposed.vatAmount || stored.grand_value !== proposed.grandValue) {
        throw new Error(
          `Job ${proposed.jobNumber}: the database calculated VAT ${stored.vat_amount} and grand value ${stored.grand_value}, ` +
            `the plan ${proposed.vatAmount} and ${proposed.grandValue}. Nothing was imported.`
        );
      }

      importedValues.push(proposed.jobValue as string);
      result.created.projects += 1;
      await write(staging, { project_id: stored.id });
    }

    result.batchId = batchId;
    result.existingClientsUsed = existingUsed.size;

    // --- reconcile, inside the transaction: anything that does not add up rolls everything back ---
    const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await client.query(sql, params)).rows[0] as T;
    const after = await readSnapshot(client);
    const inBatch = await one<{ rows: number; imported: number; held: number; job_value: string; visit_amount: string; contract_value: string }>(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE r.disposition = 'IMPORTED')::int AS imported,
              count(*) FILTER (WHERE r.disposition = 'HELD')::int AS held,
              COALESCE(sum(p.job_value), 0)::numeric(16,3)::text AS job_value,
              COALESCE(sum(v.visit_amount), 0)::numeric(16,3)::text AS visit_amount,
              COALESCE(sum(c.contract_value), 0)::numeric(16,3)::text AS contract_value
       FROM legacy_import_rows r
       LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN amc_visits v ON v.id = r.amc_visit_id
       LEFT JOIN amc_contracts c ON c.id = r.amc_contract_id
       WHERE r.batch_id = $1`,
      [batchId]
    );
    const allStaged = await one<{ rows: number }>("SELECT count(*)::int AS rows FROM legacy_import_rows WHERE source_workbook = ANY($1::text[])", [files.map((file) => file.file)]);
    const unlinked = await one<{ projects: number; visits: number }>(
      `SELECT (SELECT count(*)::int FROM projects p WHERE p.status = 'HISTORICAL' AND NOT EXISTS (SELECT 1 FROM legacy_import_rows r WHERE r.project_id = p.id)) AS projects,
              (SELECT count(*)::int FROM amc_visits v WHERE v.status = 'HISTORICAL' AND NOT EXISTS (SELECT 1 FROM legacy_import_rows r WHERE r.amc_visit_id = v.id)) AS visits`
    );
    const sequenceAfter = await one<{ state: string }>("SELECT string_agg(s::text, '|' ORDER BY s.sequence_key) AS state FROM number_sequences s");
    const importable = (kind: StagedRow["record_kind"]) => pendingOf(kind).filter(({ row }) => row.disposition === "IMPORTABLE");
    const sum = (amounts: (string | null)[]) => addAmounts(amounts.filter((amount): amount is string => amount !== null));
    const grew = (table: string) => (after.counts[table] ?? 0) - (before.counts[table] ?? 0);
    const check = (name: string, passed: boolean, detail: string): PlanCheck => ({ name, passed, detail });

    result.after = after.counts;
    result.reconciliation = [
      check("Every source record is staged exactly once", allStaged.rows === rows.length, `${rows.length} source records, ${allStaged.rows} staging rows`),
      check("This run staged the records that were not staged before", inBatch.rows === pending.length, `${pending.length} pending, ${inBatch.rows} written`),
      check(
        "Imported and held staging rows match the plan",
        inBatch.imported === pending.filter(({ row }) => row.disposition === "IMPORTABLE").length && inBatch.held === pending.filter(({ row }) => row.disposition === "HELD").length,
        `${inBatch.imported} imported, ${inBatch.held} held`
      ),
      check("Clients created = clients table growth", grew("clients") === result.created.clients, `${result.created.clients} created, table grew by ${grew("clients")}`),
      check(
        "Contracts created = importable contract rows",
        grew("amc_contracts") === importable("AMC_CONTRACT").length && result.created.contracts === importable("AMC_CONTRACT").length,
        `${result.created.contracts} created, table grew by ${grew("amc_contracts")}`
      ),
      check(
        "Visits created = importable schedule rows: none without a source row",
        grew("amc_visits") === importable("AMC_VISIT").length && result.created.visits === importable("AMC_VISIT").length,
        `${result.created.visits} created, table grew by ${grew("amc_visits")}`
      ),
      check(
        "Projects created = importable job rows",
        grew("projects") === importable("PROJECT").length && result.created.projects === importable("PROJECT").length,
        `${result.created.projects} created, table grew by ${grew("projects")}`
      ),
      check("Imported job value = plan", inBatch.job_value === sum(importedValues), `database ${inBatch.job_value}, plan ${sum(importedValues)}`),
      check(
        "Imported visit amount = plan",
        inBatch.visit_amount === sum(importable("AMC_VISIT").map(({ row }) => (row.proposed as VisitProposal).visitAmount)),
        `database ${inBatch.visit_amount}`
      ),
      check(
        "Imported contract value = plan",
        inBatch.contract_value === sum(importable("AMC_CONTRACT").map(({ row }) => (row.proposed as ContractProposal).contractValue)),
        `database ${inBatch.contract_value}`
      ),
      check("Every historical project and visit is linked to its source row", unlinked.projects === 0 && unlinked.visits === 0, `${unlinked.projects} projects and ${unlinked.visits} visits without a staging row`),
      check("No procurement request or expense was created", grew("procurement_requests") === 0 && grew("project_expenses") === 0, "procurement_requests and project_expenses unchanged"),
      check("The job-number sequence is unchanged", sequenceAfter.state === sequenceBefore.rows[0]?.state, "number_sequences is as it was"),
    ];

    const broken = result.reconciliation.filter((item) => !item.passed);

    if (broken.length > 0) {
      throw new Error(`The import did not reconcile: ${broken.map((item) => `${item.name} (${item.detail})`).join("; ")}. Everything was rolled back.`);
    }

    await logActivity(client, {
      userId: createdBy,
      action: "legacy_import.applied",
      module: "HISTORICAL_DATA",
      entityType: "legacy_import_batches",
      entityId: batchId,
      description: `Historical Excel import: ${result.staged.imported} source records imported, ${result.staged.held} kept provisional.`,
      metadata: { created: result.created, staged: result.staged, cutoverDate: plan.asOf, sourceFiles: files.map((file) => ({ name: file.file, sha256: file.sha256 })) },
    });
    result.after = { ...after.counts, activity_logs: (after.counts.activity_logs ?? 0) + 1 };

    await client.query("COMMIT");

    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
