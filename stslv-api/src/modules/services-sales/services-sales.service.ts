import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { AppError, conflict, notFound } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import { escapeLike } from "../../shared/validation";
import { holdsPermission } from "../../shared/permissions";
import type { AuthContext } from "../auth/access";
import { readStoredFile } from "../attachments/attachments.service";
import type { ContractStatus, VisitStatus } from "../amc/amc.constants";
import { hasStoredReference, referenceSql } from "../amc/contract-reference";
import { SERVICE_IN_SCOPE } from "../amc/service-scope";
import type { ListServicesSalesQuery, SalesStatus, SaveQuotationInput, ServiceStatus } from "./services-sales.schemas";

// The Services Sales page: one row per scheduled maintenance visit (amc_visits),
// never one per contract. It reads the same visit records as Service Status,
// the AMC Schedule and the Calendar. The only thing it writes is the visit's
// quotation number (migration 0078); completion is changed on Service Status.
//
// The routes require migration 0078. Every database that has it also has
// 0070 (sales engineer and system type links), 0075 (frequency master) and
// 0076 (service codes), so this module reads those without checking.


// The visits on the page, the same as on Service Status: cancelled and
// historical visits are left out, and so is outstanding unpaid work of a cancelled
// contract. Completed and Paid services always stay (service-scope.ts).
const IN_SCOPE = SERVICE_IN_SCOPE;

const SERVICE_STATUS_SQL = "CASE WHEN v.status = 'COMPLETED' THEN 'COMPLETED' ELSE 'NOT_COMPLETED' END";

/** See SALES_STATUSES. A number recorded on a visit that is not completed does not make it quoted. */
const SALES_STATUS_SQL = `CASE
    WHEN v.status <> 'COMPLETED' THEN 'NOT_COMPLETED'
    WHEN v.quotation_no IS NULL THEN 'QUOTE_PENDING'
    ELSE 'QUOTED'
  END`;

const FROM = `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
  LEFT JOIN system_types st ON st.id = c.system_type_id
  LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
  LEFT JOIN users qu ON qu.id = v.quotation_updated_by`;

// The Service Report document of a visit is uploaded on Service Status (migration 0104): an attachments row with
// entity_type 'amc_visits', category 'SERVICE_REPORT' and entity_id = the visit id, at most one current per visit.
// This page only reads it, always by the visit id, never by contract, client, month or report number. Replacing a
// report on Service Status makes the new version the current row, so the page shows it on its next read.
const REPORT_WHERE = "a.entity_type = 'amc_visits' AND a.category = 'SERVICE_REPORT' AND a.is_current";

/** Whether this database holds service reports (the unique index of migration 0104). Before it, every row shows none. */
export function serviceReportsAvailable(): Promise<boolean> {
  return schemaHas(["attachments_service_report_uq"]);
}

/** The current report's metadata as JSON ("v" is the visit). The storage key and checksum never leave the API. */
const SERVICE_REPORT_SQL = `(
  SELECT jsonb_build_object('id', a.id::text, 'originalName', a.original_name, 'mimeType', a.mime_type,
                            'sizeBytes', a.size_bytes, 'uploadedAt', a.uploaded_at)
  FROM attachments a WHERE ${REPORT_WHERE} AND a.entity_id = v.id)`;

/**
 * The row columns. `storedReference` is whether migration 0105 stores the AMC Reference Number; `reports` is whether
 * migration 0104 holds service reports.
 */
const selectSql = (storedReference: boolean, reports: boolean) => `
  SELECT v.id, c.id AS contract_id, ${referenceSql("c", storedReference)} AS contract_reference, c.status AS contract_status,
         cl.id AS client_id, cl.name AS client_name, c.system_description,
         st.id AS system_type_id, st.name AS system_type_name,
         c.maintenance_frequency, mf.label AS frequency_label,
         v.sequence_no, v.cycle_no, v.service_code,
         v.period_start::text AS period_start, v.period_end::text AS period_end, v.scheduled_date::text AS scheduled_date,
         v.status, v.completed_date::text AS completed_date, v.service_report_no,
         se.id AS sales_engineer_id, se.name AS sales_engineer_name,
         v.quotation_no, v.quotation_updated_at, qu.full_name AS quotation_updated_by_name,
         ${SERVICE_STATUS_SQL} AS service_status,
         ${SALES_STATUS_SQL} AS sales_status,
         ${reports ? SERVICE_REPORT_SQL : "NULL::jsonb"} AS service_report,
         -- The AMC Value / Year of this visit's own contract period (its contract row: a renewal version has its own).
         c.contract_value::text AS amc_value,
         v.updated_at`;

interface SalesRow {
  id: string;
  contract_id: string;
  contract_reference: string;
  contract_status: ContractStatus;
  client_id: string;
  client_name: string;
  system_description: string;
  system_type_id: string | null;
  system_type_name: string | null;
  maintenance_frequency: string;
  frequency_label: string | null;
  sequence_no: number;
  cycle_no: number | null;
  service_code: string | null;
  period_start: string;
  period_end: string;
  scheduled_date: string;
  status: VisitStatus;
  completed_date: string | null;
  service_report_no: string | null;
  sales_engineer_id: string | null;
  sales_engineer_name: string | null;
  quotation_no: string | null;
  quotation_updated_at: Date | null;
  quotation_updated_by_name: string | null;
  service_status: ServiceStatus;
  sales_status: SalesStatus;
  service_report: { id: string; originalName: string; mimeType: string; sizeBytes: number | string; uploadedAt: string } | null;
  amc_value: string;
  updated_at: Date;
}

/** The Service Report uploaded on Service Status for this visit. Read only on this page. */
export interface ServicesSalesReport {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface ServicesSalesItem {
  /** The visit id: every save names exactly this one visit. */
  id: string;
  reference: string;
  contract: { id: string; status: ContractStatus };
  client: { id: string; name: string };
  system: { description: string; typeId: string | null; typeName: string | null };
  frequency: { code: string; label: string };
  /** Service code and contract year from migration 0076 ("Q3", year 2); null on older visits, which show their visit number. */
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null };
  periodStart: string;
  periodEnd: string;
  scheduledDate: string;
  visitStatus: VisitStatus;
  /** Read only on this page. */
  serviceStatus: ServiceStatus;
  salesStatus: SalesStatus;
  completedDate: string | null;
  /** amc_visits.service_report_no as entered on Service Status. Read only on this page. */
  serviceReportNo: string | null;
  salesEngineer: { id: string; name: string } | null;
  quotationNo: string | null;
  quotationUpdatedAt: string | null;
  quotationUpdatedBy: string | null;
  /** A quotation number is recorded but the visit is not completed (for example, reopened after quoting). Kept, and reported. */
  quotationBeforeCompletion: boolean;
  /** The current Service Report of this visit (0104), or null when none is uploaded or the database has no reports yet. */
  serviceReport: ServicesSalesReport | null;
  /**
   * The AMC Value / Year of the visit's contract period, OMR excluding VAT. Null unless the user holds AMC Contracts:
   * View: the value is then never sent. Not an invoice value and not money received.
   */
  amcValue: string | null;
  updatedAt: string;
}

/** What the signed-in user may see beyond the page itself: contract values need AMC Contracts: View. */
export interface ServicesSalesAccess {
  amcValue: boolean;
}

const NO_EXTRA_ACCESS: ServicesSalesAccess = { amcValue: false };

export function servicesSalesAccess(auth: Pick<AuthContext, "permissions">): ServicesSalesAccess {
  // No permission set (an internal caller): nothing extra is shown.
  return { amcValue: auth.permissions ? holdsPermission(auth.permissions, "AMC_CONTRACTS:VIEW") : false };
}

function toItem(row: SalesRow, access: ServicesSalesAccess = NO_EXTRA_ACCESS): ServicesSalesItem {
  return {
    id: row.id,
    reference: row.contract_reference,
    contract: { id: row.contract_id, status: row.contract_status },
    client: { id: row.client_id, name: row.client_name },
    system: { description: row.system_description, typeId: row.system_type_id, typeName: row.system_type_name },
    frequency: { code: row.maintenance_frequency, label: row.frequency_label ?? row.maintenance_frequency },
    service: { sequenceNo: row.sequence_no, cycleNo: row.cycle_no, serviceCode: row.service_code },
    periodStart: row.period_start,
    periodEnd: row.period_end,
    scheduledDate: row.scheduled_date,
    visitStatus: row.status,
    serviceStatus: row.service_status,
    salesStatus: row.sales_status,
    completedDate: row.completed_date,
    serviceReportNo: row.service_report_no,
    salesEngineer: row.sales_engineer_id && row.sales_engineer_name ? { id: row.sales_engineer_id, name: row.sales_engineer_name } : null,
    quotationNo: row.quotation_no,
    quotationUpdatedAt: row.quotation_updated_at ? row.quotation_updated_at.toISOString() : null,
    quotationUpdatedBy: row.quotation_updated_by_name,
    quotationBeforeCompletion: row.quotation_no !== null && row.status !== "COMPLETED",
    serviceReport: row.service_report
      ? {
          id: row.service_report.id,
          originalName: row.service_report.originalName,
          mimeType: row.service_report.mimeType,
          sizeBytes: Number(row.service_report.sizeBytes),
          uploadedAt: new Date(row.service_report.uploadedAt).toISOString(),
        }
      : null,
    amcValue: access.amcValue ? row.amc_value : null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export type ServicesSalesFilters = Omit<ListServicesSalesQuery, "page" | "pageSize">;

/** One WHERE clause for the rows, the cards and the export, so the three always agree. */
function filterSql(query: ServicesSalesFilters, storedReference: boolean) {
  const conditions: string[] = [IN_SCOPE];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.clientId) conditions.push(`c.client_id = ${add(query.clientId)}`);
  if (query.salesEngineerId) conditions.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
  if (query.systemTypeId) conditions.push(`c.system_type_id = ${add(query.systemTypeId)}`);
  if (query.frequency) conditions.push(`c.maintenance_frequency = ${add(query.frequency)}`);
  if (query.year) {
    // A date range, so the scheduled-date index can be used.
    const start = `make_date(${add(query.year)}::int, ${add(query.month ?? 1)}::int, 1)`;
    conditions.push(`v.scheduled_date >= ${start} AND v.scheduled_date < ${start} + ${query.month ? "interval '1 month'" : "interval '1 year'"}`);
  } else if (query.month) {
    conditions.push(`extract(month FROM v.scheduled_date) = ${add(query.month)}`);
  }
  if (query.serviceStatus) conditions.push(`(${SERVICE_STATUS_SQL}) = ${add(query.serviceStatus)}`);
  if (query.quoteSubmission === "SUBMITTED") conditions.push("v.quotation_no IS NOT NULL");
  if (query.quoteSubmission === "NOT_SUBMITTED") conditions.push("v.quotation_no IS NULL");
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    const matches = [
      `${referenceSql("c", storedReference)} ILIKE ${p}`,
      `cl.name ILIKE ${p}`,
      `c.system_description ILIKE ${p}`,
      `st.name ILIKE ${p}`,
      `v.service_code ILIKE ${p}`,
      `v.service_report_no ILIKE ${p}`,
      `v.quotation_no ILIKE ${p}`,
    ];

    conditions.push(`(${matches.join(" OR ")})`);
  }

  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

const ORDER = "ORDER BY v.scheduled_date, lower(cl.name), v.id";

export interface ServicesSalesKpis {
  total: number;
  notCompleted: number;
  quotePending: number;
  quoted: number;
  /** Visits that are not completed but carry a quotation number. Counted under notCompleted. */
  quotationBeforeCompletion: number;
}

/**
 * The filtered AMC Value total (client fixes, 2026-11-09): the AMC Value / Year of every UNIQUE contract period that
 * has at least one visit matching the filters, across all pages. A contract with several matching visits counts once;
 * a renewal is its own contract period (own row, own value) and counts separately. PostgreSQL adds the amounts.
 * Only computed for a user who may see contract values.
 */
export interface ServicesSalesAmcValueTotal {
  /** Sum of AMC Value / Year over the unique contract periods, OMR excluding VAT, three decimals. */
  total: string;
  /** How many unique contract periods the total covers. */
  contracts: number;
}

async function amcValueTotal(where: string, params: unknown[]): Promise<ServicesSalesAmcValueTotal> {
  const result = await pool.query<{ total: string; contracts: number }>(
    `SELECT COALESCE(sum(t.contract_value), 0)::numeric(16,3)::text AS total, count(*)::int AS contracts
     FROM (SELECT DISTINCT c.id, c.contract_value ${FROM} ${where}) t`,
    params
  );

  return { total: result.rows[0]?.total ?? "0.000", contracts: result.rows[0]?.contracts ?? 0 };
}

/** The card figures, over exactly the rows the filters select. total = notCompleted + quotePending + quoted. */
async function kpis(where: string, params: unknown[]): Promise<ServicesSalesKpis> {
  const result = await pool.query<{ total: number; not_completed: number; quote_pending: number; quoted: number; before_completion: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE (${SALES_STATUS_SQL}) = 'NOT_COMPLETED')::int AS not_completed,
            count(*) FILTER (WHERE (${SALES_STATUS_SQL}) = 'QUOTE_PENDING')::int AS quote_pending,
            count(*) FILTER (WHERE (${SALES_STATUS_SQL}) = 'QUOTED')::int AS quoted,
            count(*) FILTER (WHERE v.status <> 'COMPLETED' AND v.quotation_no IS NOT NULL)::int AS before_completion
     ${FROM} ${where}`,
    params
  );
  const row = result.rows[0];

  return {
    total: row?.total ?? 0,
    notCompleted: row?.not_completed ?? 0,
    quotePending: row?.quote_pending ?? 0,
    quoted: row?.quoted ?? 0,
    quotationBeforeCompletion: row?.before_completion ?? 0,
  };
}

export async function listServicesSales(query: ListServicesSalesQuery, access: ServicesSalesAccess = NO_EXTRA_ACCESS) {
  const [storedReference, reports] = await Promise.all([hasStoredReference(), serviceReportsAvailable()]);
  const { where, params } = filterSql(query, storedReference);
  const figures = await kpis(where, params);
  // Never computed, so never sent, for a user who may not see contract values.
  const amcValue = access.amcValue ? await amcValueTotal(where, params) : null;
  const rows = await pool.query<SalesRow>(
    `${selectSql(storedReference, reports)} ${FROM} ${where} ${ORDER}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map((row) => toItem(row, access)),
    total: figures.total,
    page: query.page,
    pageSize: query.pageSize,
    kpis: figures,
    serviceReportsAvailable: reports,
    amcValueVisible: access.amcValue,
    amcValueTotal: amcValue,
  };
}

/**
 * Every visit that matches the filters, in the page's order, for an export.
 * `checkSize` is given the number of rows before any is read and throws when
 * the export cannot hold that many.
 */
export async function listAllServicesSales(filters: ServicesSalesFilters, checkSize: (count: number) => void, access: ServicesSalesAccess = NO_EXTRA_ACCESS) {
  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(filters, storedReference);
  const figures = await kpis(where, params);

  checkSize(figures.total);

  const rows = await pool.query<SalesRow>(`${selectSql(storedReference, await serviceReportsAvailable())} ${FROM} ${where} ${ORDER}`, params);

  const amcValue = access.amcValue ? await amcValueTotal(where, params) : null;

  return { items: rows.rows.map((row) => toItem(row, access)), kpis: figures, amcValueTotal: amcValue };
}

/** The lists for the page's filters, taken from the contracts that have visits on the page. */
export async function getServicesSalesOptions() {
  const from = `FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id WHERE ${IN_SCOPE}`;
  const [clients, engineers, systemTypes, frequencies, years] = await Promise.all([
    pool.query<{ id: string; name: string }>(`SELECT cl.id, cl.name FROM clients cl WHERE cl.id IN (SELECT c.client_id ${from}) ORDER BY lower(cl.name), cl.id`),
    pool.query<{ id: string; name: string }>(
      `SELECT e.id, e.name FROM sales_engineers e WHERE e.id IN (SELECT c.sales_engineer_id ${from}) ORDER BY lower(e.name), e.id`
    ),
    pool.query<{ id: string; name: string }>(`SELECT t.id, t.name FROM system_types t WHERE t.id IN (SELECT c.system_type_id ${from}) ORDER BY lower(t.name), t.id`),
    pool.query<{ code: string; label: string | null }>(
      `SELECT f.code, mf.label
       FROM (SELECT DISTINCT c.maintenance_frequency AS code ${from}) f
       LEFT JOIN maintenance_frequencies mf ON mf.code = f.code
       ORDER BY mf.sort_order NULLS LAST, f.code`
    ),
    pool.query<{ year: number }>(`SELECT DISTINCT extract(year FROM v.scheduled_date)::int AS year ${from} ORDER BY year`),
  ]);

  return {
    clients: clients.rows,
    salesEngineers: engineers.rows,
    systemTypes: systemTypes.rows,
    frequencies: frequencies.rows.map((row) => ({ code: row.code, label: row.label ?? row.code })),
    years: years.rows.map((row) => row.year),
  };
}

async function findSalesRow(db: Queryable, id: string): Promise<SalesRow> {
  const [storedReference, reports] = await Promise.all([hasStoredReference(), serviceReportsAvailable()]);
  const result = await db.query<SalesRow>(`${selectSql(storedReference, reports)} ${FROM} WHERE v.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) throw notFound("AMC visit not found.");
  return row;
}

/**
 * Records, changes or clears the quotation number of ONE visit. Nothing else on
 * the visit (status, dates, amount, notes) and no other visit is changed, and
 * no quotation document or invoice is created.
 *
 * A new number needs a completed visit. Clearing is always allowed, so a
 * number recorded before a visit was reopened can be removed on purpose; it is
 * never removed automatically.
 */
export async function saveQuotation(auth: AuthContext, id: string, input: SaveQuotationInput): Promise<ServicesSalesItem> {
  return withTransaction(async (client) => {
    await client.query("SELECT id FROM amc_visits WHERE id = $1 FOR UPDATE", [id]);
    const row = await findSalesRow(client, id);

    if (row.status === "HISTORICAL" || row.status === "CANCELLED") {
      throw conflict(`This visit is ${row.status === "HISTORICAL" ? "a historical record" : "cancelled"} and is not managed on the Service Sales page.`);
    }
    // Compared in the database's own precision, so the check does not depend on how the page rounded the time.
    const unchanged = await client.query<{ same: boolean }>(
      "SELECT date_trunc('milliseconds', $1::timestamptz) = date_trunc('milliseconds', updated_at) AS same FROM amc_visits WHERE id = $2",
      [input.expectedUpdatedAt, id]
    );
    if (!unchanged.rows[0]?.same) {
      throw conflict("This service was changed by someone else after the page was loaded. Reload to see the latest values, then save again.");
    }

    const changes = diffFields({ quotationNo: row.quotation_no }, { quotationNo: input.quotationNo }, ["quotationNo"]);

    if (Object.keys(changes).length === 0) {
      return toItem(row, servicesSalesAccess(auth));
    }
    if (input.quotationNo !== null && row.status !== "COMPLETED") {
      throw conflict("A quotation number can only be recorded once the service is completed. Complete it on Service Status first.", [
        { field: "quotationNo", message: "Complete the service before recording a quotation number." },
      ]);
    }

    await client.query(
      `UPDATE amc_visits
       SET quotation_no = $1, quotation_updated_at = now(), quotation_updated_by = $2, updated_by = $2
       WHERE id = $3`,
      [input.quotationNo, auth.user.id, id]
    );
    await logActivity(client, {
      userId: auth.user.id,
      action: "amc_visit.quotation_changed",
      module: "SERVICES_SALES",
      entityType: "amc_visits",
      entityId: id,
      description: `Quotation number of AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) ${
        input.quotationNo ? `set to ${input.quotationNo}` : "cleared"
      }.`,
      metadata: { changes, reference: row.contract_reference },
    });

    return toItem(await findSalesRow(client, id), servicesSalesAccess(auth));
  });
}

/**
 * The file of the Service Report uploaded on Service Status for ONE visit on this page, for View and Download.
 * Read only: nothing is stored, copied or changed. The visit must be on the page (cancelled, historical and
 * recycled work is not), and the report is looked up by that visit's id alone, so a report of another service or
 * contract is never served. The file is checked against the checksum recorded at upload.
 */
export async function readServicesSalesReport(visitId: string) {
  if (!(await serviceReportsAvailable())) {
    throw new AppError(503, "FEATURE_UNAVAILABLE", "Service reports are not available until the database is updated (migration 0104).");
  }

  const visit = await pool.query(`SELECT 1 FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id WHERE v.id = $1 AND ${IN_SCOPE}`, [visitId]);

  if (visit.rowCount === 0) throw notFound("AMC visit not found.");

  const result = await pool.query<{ original_name: string; mime_type: string; sha256: string; storage_key: string }>(
    `SELECT a.original_name, a.mime_type, a.sha256, a.storage_key FROM attachments a WHERE ${REPORT_WHERE} AND a.entity_id = $1`,
    [visitId]
  );
  const row = result.rows[0];

  if (!row) throw new AppError(404, "SERVICE_REPORT_NOT_FOUND", "No service report has been uploaded for this service.");

  const data = await readStoredFile(row.storage_key, row.sha256, "The service report file could not be found. Ask for it to be uploaded again on Service Status.");

  return { data, mimeType: row.mime_type, fileName: row.original_name };
}
