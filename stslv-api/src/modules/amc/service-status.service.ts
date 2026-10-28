import { pool } from "../../config/database";
import { featureUnavailable } from "../../middleware/require-schema";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, notFound, validationError } from "../../shared/errors";
import { schemaHas } from "../../shared/schema-features";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import type { ContractStatus, ServiceStatus, VisitStatus } from "./amc.constants";
import type { ListServiceStatusQuery, SaveServiceStatusInput } from "./amc.schemas";
import { applyExecution } from "./visits.service";

// The Service Status page: one row per scheduled maintenance visit (amc_visits),
// never one per contract. It reads the same visit records as the AMC Schedule
// and Calendar and changes them only through the execution rules, so no other
// copy of a visit exists anywhere.

/** Which optional migrations this database has. Each one only adds columns or links; the page works without them. */
interface Features {
  /** 0070: sales engineer and system type links on contracts. */
  masters: boolean;
  /** 0072: renewals, for "waiting for renewal". */
  renewals: boolean;
  /** 0075: the frequency master, for frequency names. */
  frequencies: boolean;
  /** 0077: the service report number. */
  reportNumber: boolean;
}

async function features(): Promise<Features> {
  const [masters, renewals, frequencies, reportNumber] = await Promise.all([
    schemaHas(["amc_contracts.sales_engineer_id", "amc_contracts.system_type_id", "sales_engineers", "system_types"]),
    schemaHas(["amc_contracts.renewed_from_id"]),
    schemaHas(["maintenance_frequencies"]),
    schemaHas(["amc_visits.service_report_no"]),
  ]);

  return { masters, renewals, frequencies, reportNumber };
}

/** "AMC-0007" for contract 7: derived from the id, never stored. PROVISIONAL until the client confirms a contract numbering rule. */
export function amcReference(contractId: string): string {
  return `AMC-${contractId.padStart(4, "0")}`;
}

/** Names of the four built-in frequencies, for a database without the frequency master. */
const BUILT_IN_FREQUENCY_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  HALF_YEARLY: "Half-yearly",
  ANNUALLY: "Annually",
};

/** The derived service status. See SERVICE_STATUSES for the rule. */
function serviceStatusSql(f: Features): string {
  const noOpenRenewal = f.renewals
    ? "AND NOT EXISTS (SELECT 1 FROM amc_contracts r WHERE r.renewed_from_id = c.id AND r.status <> 'CANCELLED')"
    : "";

  return `CASE
    WHEN v.status = 'COMPLETED' THEN 'COMPLETED'
    WHEN (c.status = 'EXPIRED' OR c.valid_to < current_date) ${noOpenRenewal} THEN 'WAITING_FOR_RENEWAL'
    ELSE 'NOT_COMPLETED'
  END`;
}

// Cancelled and historical visits are left out; so is outstanding work of a
// cancelled contract (as on the execution list). Completed work always stays.
const IN_SCOPE = "v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED') AND (v.status = 'COMPLETED' OR c.status <> 'CANCELLED')";

function fromSql(f: Features): string {
  return `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id
  ${f.masters ? "LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id LEFT JOIN system_types st ON st.id = c.system_type_id" : ""}
  ${f.frequencies ? "LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency" : ""}`;
}

function selectSql(f: Features): string {
  return `
  SELECT v.id, c.id AS contract_id, c.status AS contract_status, c.valid_to::text AS valid_to,
         cl.id AS client_id, cl.name AS client_name, c.system_description,
         ${f.masters ? "st.id AS system_type_id, st.name AS system_type_name" : "NULL::bigint AS system_type_id, NULL::text AS system_type_name"},
         c.maintenance_frequency, ${f.frequencies ? "mf.label" : "NULL::text"} AS frequency_label,
         v.sequence_no,
         -- Migration 0076 columns, read so that a database without them still works (they are then null).
         (to_jsonb(v) ->> 'cycle_no')::int AS cycle_no, to_jsonb(v) ->> 'service_code' AS service_code,
         v.period_start::text AS period_start, v.period_end::text AS period_end, v.scheduled_date::text AS scheduled_date,
         v.status, v.completed_date::text AS completed_date,
         (v.status IN ('SCHEDULED', 'POSTPONED') AND v.scheduled_date < current_date) AS is_overdue,
         ${f.masters ? "se.id AS sales_engineer_id, se.name AS sales_engineer_name" : "NULL::bigint AS sales_engineer_id, NULL::text AS sales_engineer_name"},
         ${f.reportNumber ? "v.service_report_no" : "NULL::text"} AS service_report_no,
         ${serviceStatusSql(f)} AS service_status,
         v.updated_at`;
}

interface ServiceRow {
  id: string;
  contract_id: string;
  contract_status: ContractStatus;
  valid_to: string;
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
  is_overdue: boolean;
  sales_engineer_id: string | null;
  sales_engineer_name: string | null;
  service_report_no: string | null;
  service_status: ServiceStatus;
  updated_at: Date;
}

export interface ServiceStatusItem {
  /** The visit id: every save names exactly this one visit. */
  id: string;
  reference: string;
  contract: { id: string; status: ContractStatus; validTo: string };
  client: { id: string; name: string };
  system: { description: string; typeId: string | null; typeName: string | null };
  frequency: { code: string; label: string };
  /** "Year 2 · Q3" labels from migration 0076; null on older visits, which show their visit number. */
  service: { sequenceNo: number; cycleNo: number | null; serviceCode: string | null };
  periodStart: string;
  periodEnd: string;
  scheduledDate: string;
  visitStatus: VisitStatus;
  serviceStatus: ServiceStatus;
  isOverdue: boolean;
  completedDate: string | null;
  salesEngineer: { id: string; name: string } | null;
  reportNumber: string | null;
  updatedAt: string;
}

function toItem(row: ServiceRow): ServiceStatusItem {
  return {
    id: row.id,
    reference: amcReference(row.contract_id),
    contract: { id: row.contract_id, status: row.contract_status, validTo: row.valid_to },
    client: { id: row.client_id, name: row.client_name },
    system: { description: row.system_description, typeId: row.system_type_id, typeName: row.system_type_name },
    frequency: {
      code: row.maintenance_frequency,
      label: row.frequency_label ?? BUILT_IN_FREQUENCY_LABELS[row.maintenance_frequency] ?? row.maintenance_frequency,
    },
    service: { sequenceNo: row.sequence_no, cycleNo: row.cycle_no, serviceCode: row.service_code },
    periodStart: row.period_start,
    periodEnd: row.period_end,
    scheduledDate: row.scheduled_date,
    visitStatus: row.status,
    serviceStatus: row.service_status,
    isOverdue: row.is_overdue,
    completedDate: row.completed_date,
    salesEngineer: row.sales_engineer_id && row.sales_engineer_name ? { id: row.sales_engineer_id, name: row.sales_engineer_name } : null,
    reportNumber: row.service_report_no,
    updatedAt: row.updated_at.toISOString(),
  };
}

export type ServiceStatusFilters = Omit<ListServiceStatusQuery, "page" | "pageSize">;

/** "AMC-0007", "amc7" or "7" names contract 7. */
const REFERENCE_PATTERN = /^(?:amc-?)?0*(\d{1,15})$/i;

/** The WHERE clause, with and without the service status filter: the cards count every status of the other filters. */
function filterSql(query: ServiceStatusFilters, f: Features) {
  const conditions: string[] = [IN_SCOPE];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.clientId) conditions.push(`c.client_id = ${add(query.clientId)}`);
  if (query.salesEngineerId || query.systemTypeId) {
    // The links exist only from migration 0070.
    if (!f.masters) throw featureUnavailable();
    if (query.salesEngineerId) conditions.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
    if (query.systemTypeId) conditions.push(`c.system_type_id = ${add(query.systemTypeId)}`);
  }
  if (query.frequency) conditions.push(`c.maintenance_frequency = ${add(query.frequency)}`);
  if (query.year) {
    // A date range, so the scheduled-date index can be used.
    const start = `make_date(${add(query.year)}::int, ${add(query.month ?? 1)}::int, 1)`;
    conditions.push(`v.scheduled_date >= ${start} AND v.scheduled_date < ${start} + ${query.month ? "interval '1 month'" : "interval '1 year'"}`);
  } else if (query.month) {
    conditions.push(`extract(month FROM v.scheduled_date) = ${add(query.month)}`);
  }
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    const matches = [
      `cl.name ILIKE ${p}`,
      `c.system_description ILIKE ${p}`,
      `(to_jsonb(v) ->> 'service_code') ILIKE ${p}`,
      ...(f.masters ? [`st.name ILIKE ${p}`] : []),
      ...(f.reportNumber ? [`v.service_report_no ILIKE ${p}`] : []),
    ];
    const reference = REFERENCE_PATTERN.exec(query.search);

    if (reference) matches.push(`c.id = ${add(reference[1])}::bigint`);
    conditions.push(`(${matches.join(" OR ")})`);
  }

  const withoutStatus = `WHERE ${conditions.join(" AND ")}`;
  const where = query.serviceStatus ? `${withoutStatus} AND (${serviceStatusSql(f)}) = ${add(query.serviceStatus)}` : withoutStatus;

  return { where, withoutStatus, params };
}

const ORDER = "ORDER BY v.scheduled_date, lower(cl.name), v.id";

export interface ServiceStatusKpis {
  total: number;
  completed: number;
  notCompleted: number;
  waitingForRenewal: number;
}

/** The card figures: every visit that matches the filters other than the service status. */
async function kpis(withoutStatus: string, params: unknown[], f: Features): Promise<ServiceStatusKpis> {
  // The status filter's own parameter is at the end of params; this query does not use it.
  const status = serviceStatusSql(f);
  const result = await pool.query<{ total: number; completed: number; not_completed: number; waiting: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE (${status}) = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE (${status}) = 'NOT_COMPLETED')::int AS not_completed,
            count(*) FILTER (WHERE (${status}) = 'WAITING_FOR_RENEWAL')::int AS waiting
     ${fromSql(f)} ${withoutStatus}`,
    params
  );
  const row = result.rows[0];

  return { total: row?.total ?? 0, completed: row?.completed ?? 0, notCompleted: row?.not_completed ?? 0, waitingForRenewal: row?.waiting ?? 0 };
}

function totalFor(figures: ServiceStatusKpis, status: ServiceStatus | undefined): number {
  if (status === "COMPLETED") return figures.completed;
  if (status === "NOT_COMPLETED") return figures.notCompleted;
  if (status === "WAITING_FOR_RENEWAL") return figures.waitingForRenewal;
  return figures.total;
}

export async function listServiceStatus(query: ListServiceStatusQuery) {
  const f = await features();
  const { where, withoutStatus, params } = filterSql(query, f);
  const statusParamCount = query.serviceStatus ? params.length - 1 : params.length;
  const figures = await kpis(withoutStatus, params.slice(0, statusParamCount), f);
  const rows = await pool.query<ServiceRow>(
    `${selectSql(f)} ${fromSql(f)} ${where} ${ORDER}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toItem),
    total: totalFor(figures, query.serviceStatus),
    page: query.page,
    pageSize: query.pageSize,
    kpis: figures,
    reportNumberAvailable: f.reportNumber,
  };
}

/**
 * Every visit that matches the filters, in the page's order, for an export.
 * `checkSize` is given the number of rows before any is read and throws when
 * the export cannot hold that many.
 */
export async function listAllServiceStatus(filters: ServiceStatusFilters, checkSize: (count: number) => void) {
  const f = await features();
  const { where, withoutStatus, params } = filterSql(filters, f);
  const statusParamCount = filters.serviceStatus ? params.length - 1 : params.length;
  const figures = await kpis(withoutStatus, params.slice(0, statusParamCount), f);
  const total = totalFor(figures, filters.serviceStatus);

  checkSize(total);

  const rows = await pool.query<ServiceRow>(`${selectSql(f)} ${fromSql(f)} ${where} ${ORDER}`, params);

  return { items: rows.rows.map(toItem), total, kpis: figures, features: f };
}

/** The lists for the page's filters, taken from the contracts that have visits on the page. */
export async function getServiceStatusOptions() {
  const f = await features();
  const from = `FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id WHERE ${IN_SCOPE}`;
  const frequencyColumns = f.frequencies
    ? "(SELECT mf.label FROM maintenance_frequencies mf WHERE mf.code = c.maintenance_frequency) AS label, (SELECT mf.sort_order FROM maintenance_frequencies mf WHERE mf.code = c.maintenance_frequency) AS sort_order"
    : "NULL::text AS label, 0 AS sort_order";
  const [clients, frequencies, years, engineers, systemTypes] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `SELECT cl.id, cl.name FROM clients cl WHERE cl.id IN (SELECT c.client_id ${from}) ORDER BY lower(cl.name), cl.id`
    ),
    pool.query<{ code: string; label: string | null }>(
      `SELECT DISTINCT c.maintenance_frequency AS code, ${frequencyColumns} ${from} ORDER BY sort_order, code`
    ),
    pool.query<{ year: number }>(`SELECT DISTINCT extract(year FROM v.scheduled_date)::int AS year ${from} ORDER BY year`),
    f.masters
      ? pool.query<{ id: string; name: string }>(
          `SELECT e.id, e.name FROM sales_engineers e WHERE e.id IN (SELECT c.sales_engineer_id ${from}) ORDER BY lower(e.name), e.id`
        )
      : null,
    f.masters
      ? pool.query<{ id: string; name: string }>(
          `SELECT t.id, t.name FROM system_types t WHERE t.id IN (SELECT c.system_type_id ${from}) ORDER BY lower(t.name), t.id`
        )
      : null,
  ]);

  return {
    clients: clients.rows,
    // Null when this database has no master links (migration 0070): the filter is then not offered.
    salesEngineers: engineers ? engineers.rows : null,
    systemTypes: systemTypes ? systemTypes.rows : null,
    frequencies: frequencies.rows.map((row) => ({ code: row.code, label: row.label ?? BUILT_IN_FREQUENCY_LABELS[row.code] ?? row.code })),
    years: years.rows.map((row) => row.year),
    reportNumberAvailable: f.reportNumber,
  };
}

async function findServiceRow(db: Queryable, id: string, f: Features): Promise<ServiceRow> {
  const result = await db.query<ServiceRow>(`${selectSql(f)} ${fromSql(f)} WHERE v.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) throw notFound("AMC visit not found.");
  return row;
}

/**
 * Saves the status, completion date and report number of ONE visit, in one
 * transaction. A status change goes through the execution rules (completion
 * date, reopening needs approval, invoiced work cannot be reopened); nothing
 * else on the visit, and no other visit, is changed.
 */
export async function saveServiceStatus(auth: AuthContext, id: string, input: SaveServiceStatusInput): Promise<ServiceStatusItem> {
  const f = await features();

  if (input.reportNumber !== undefined && !f.reportNumber) {
    throw featureUnavailable();
  }

  return withTransaction(async (client) => {
    await client.query("SELECT id FROM amc_visits WHERE id = $1 FOR UPDATE", [id]);
    const row = await findServiceRow(client, id, f);

    if (row.status === "HISTORICAL" || row.status === "CANCELLED") {
      throw conflict(`This visit is ${row.status === "HISTORICAL" ? "a historical record" : "cancelled"} and is not managed on the Service Status page.`);
    }
    // Compared in the database's own precision, so the check does not depend on how the page rounded the time.
    const unchanged = await client.query<{ same: boolean }>("SELECT date_trunc('milliseconds', $1::timestamptz) = date_trunc('milliseconds', updated_at) AS same FROM amc_visits WHERE id = $2", [
      input.expectedUpdatedAt,
      id,
    ]);
    if (!unchanged.rows[0]?.same) {
      throw conflict("This service was changed by someone else after the page was loaded. Reload to see the latest values, then save again.");
    }

    const wantsCompleted = input.status === "COMPLETED" || (input.status === undefined && row.status === "COMPLETED");

    if (input.completedDate !== undefined && !wantsCompleted) {
      throw validationError("A completion date can only be recorded on a completed service.", [
        { field: "completedDate", message: "A completion date can only be recorded on a completed service." },
      ]);
    }

    if (input.status === "COMPLETED") {
      await applyExecution(client, auth, id, { status: "COMPLETED", ...(input.completedDate !== undefined ? { completedDate: input.completedDate } : {}) });
    } else if (input.status === "NOT_COMPLETED" && row.status === "COMPLETED") {
      // Reopened work is scheduled again. An open visit (in progress, postponed) keeps its own status.
      await applyExecution(client, auth, id, { status: "SCHEDULED" });
    } else if (input.status === undefined && input.completedDate !== undefined) {
      await applyExecution(client, auth, id, { completedDate: input.completedDate });
    }

    if (input.reportNumber !== undefined) {
      const changes = diffFields({ serviceReportNo: row.service_report_no }, { serviceReportNo: input.reportNumber }, ["serviceReportNo"]);

      if (Object.keys(changes).length > 0) {
        await client.query("UPDATE amc_visits SET service_report_no = $1, updated_by = $2 WHERE id = $3", [input.reportNumber, auth.user.id, id]);
        await logActivity(client, {
          userId: auth.user.id,
          action: "amc_visit.service_report_changed",
          module: "AMC_EXECUTION",
          entityType: "amc_visits",
          entityId: id,
          description: `Service report number of AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) ${
            input.reportNumber ? `set to ${input.reportNumber}` : "cleared"
          }.`,
          metadata: { changes },
        });
      }
    }

    return toItem(await findServiceRow(client, id, f));
  });
}
