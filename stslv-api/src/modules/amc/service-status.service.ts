import { pool } from "../../config/database";
import { featureUnavailable } from "../../middleware/require-schema";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { AppError, conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { hasAdminAccess } from "../../shared/role-model";
import { schemaHas } from "../../shared/schema-features";
import { escapeLike } from "../../shared/validation";
import { holdsPermission } from "../../shared/permissions";
import { hiddenColumnsOf, type AuthContext } from "../auth/access";
import type { ServiceStatusColumn } from "./service-status.schemas";
import type { ContractStatus, ServiceStatus, VisitStatus } from "./amc.constants";
import type { ListServiceStatusQuery, SaveServiceStatusInput } from "./amc.schemas";
import { env } from "../../config/env";
import { SERVICE_REPORT_JSON_SQL, SERVICE_REPORT_TYPES_TEXT, serviceReportsAvailable, toServiceReport, type ServiceReport } from "./service-reports.service";
import { applyExecution } from "./visits.service";
import { hasStoredReference, referenceSql, serviceOrderSql } from "./contract-reference";
import { SERVICE_IN_SCOPE } from "./service-scope";
import { BUSINESS_TODAY_SQL } from "../../shared/business-date";
import { NO_AMOUNT_SOURCE_SQL } from "./value-source";
import { SERVICE_ACKNOWLEDGEMENT_SQL, serviceAcknowledgementsVisible, toServiceAcknowledgement, type ServiceAcknowledgement } from "../invoice-acknowledgements/service-acknowledgement";

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
  /** 0104: the uploaded service report document. */
  reports: boolean;
  /** 0105: the stored AMC Reference Number. */
  storedReference: boolean;
  /** 0110: the Service Engineer typed on a service (labelled "Sales Engineer Name" until the client UAT of 2026-11-16). */
  engineerName: boolean;
  /** 0121: the Number of Working Days typed on a service. */
  workingDays: boolean;
  /** 0122: the Number of Manpower typed on a service. */
  manpowerCount: boolean;
}

async function features(): Promise<Features> {
  const [masters, renewals, frequencies, reportNumber, reports, storedReference, engineerName, workingDays, manpowerCount] = await Promise.all([
    schemaHas(["amc_contracts.sales_engineer_id", "amc_contracts.system_type_id", "sales_engineers", "system_types"]),
    schemaHas(["amc_contracts.renewed_from_id"]),
    schemaHas(["maintenance_frequencies"]),
    schemaHas(["amc_visits.service_report_no"]),
    serviceReportsAvailable(),
    hasStoredReference(),
    schemaHas(["amc_visits.sales_engineer_name"]),
    schemaHas(["amc_visits.working_days"]),
    schemaHas(["amc_visits.manpower_count"]),
  ]);

  return { masters, renewals, frequencies, reportNumber, reports, storedReference, engineerName, workingDays, manpowerCount };
}

/** Names of the four built-in frequencies, for a database without the frequency master. */
const BUILT_IN_FREQUENCY_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  HALF_YEARLY: "Half-yearly",
  ANNUALLY: "Annually",
};

/** The derived service status. See SERVICE_STATUSES for the rule. */
export function serviceStatusSql(f: Pick<Features, "renewals">): string {
  const noOpenRenewal = f.renewals
    ? "AND NOT EXISTS (SELECT 1 FROM amc_contracts r WHERE r.renewed_from_id = c.id AND r.status <> 'CANCELLED')"
    : "";

  return `CASE
    WHEN v.status = 'COMPLETED' THEN 'COMPLETED'
    WHEN (c.status = 'EXPIRED' OR c.valid_to < ${BUSINESS_TODAY_SQL}) ${noOpenRenewal} THEN 'WAITING_FOR_RENEWAL'
    ELSE 'NOT_COMPLETED'
  END`;
}

// Cancelled and historical visits are left out; so is outstanding unpaid work of a
// cancelled contract. Completed and Paid services always stay. The shared rule of
// Dashboard, Accounts and Master AMC Status: see service-scope.ts.
export const IN_SCOPE = SERVICE_IN_SCOPE;

function fromSql(f: Features): string {
  return `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id
  ${f.masters ? "LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id LEFT JOIN system_types st ON st.id = c.system_type_id" : ""}
  ${f.frequencies ? "LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency" : ""}`;
}

function selectSql(f: Features, acknowledgements = false): string {
  return `
  SELECT v.id, c.id AS contract_id, ${referenceSql("c", f.storedReference)} AS contract_reference, c.status AS contract_status, c.valid_to::text AS valid_to,
         cl.id AS client_id, cl.name AS client_name, c.system_description,
         ${f.masters ? "st.id AS system_type_id, st.name AS system_type_name" : "NULL::bigint AS system_type_id, NULL::text AS system_type_name"},
         c.maintenance_frequency, ${f.frequencies ? "mf.label" : "NULL::text"} AS frequency_label,
         v.sequence_no,
         -- Migration 0076 columns, read so that a database without them still works (they are then null).
         (to_jsonb(v) ->> 'cycle_no')::int AS cycle_no, to_jsonb(v) ->> 'service_code' AS service_code,
         v.period_start::text AS period_start, v.period_end::text AS period_end, v.scheduled_date::text AS scheduled_date,
         v.status, v.completed_date::text AS completed_date,
         (v.status IN ('SCHEDULED', 'POSTPONED') AND v.scheduled_date < ${BUSINESS_TODAY_SQL}) AS is_overdue,
         ${f.masters ? "se.id AS sales_engineer_id, se.name AS sales_engineer_name" : "NULL::bigint AS sales_engineer_id, NULL::text AS sales_engineer_name"},
         ${f.reportNumber ? "v.service_report_no" : "NULL::text"} AS service_report_no,
         ${f.engineerName ? "v.sales_engineer_name" : "NULL::text"} AS manual_engineer_name,
         ${f.workingDays ? "v.working_days" : "NULL::int"} AS working_days,
         ${f.manpowerCount ? "v.manpower_count" : "NULL::int"} AS manpower_count,
         -- The contract's AMC Value / Year (OMR excluding VAT). Read from the contract, never copied onto the visit.
         c.contract_value::text AS amc_value,
         -- This service's own value: amc_visits.visit_amount, the same field Master AMC Status shows as its Service Value
         -- (the per-service share of the billing basis, or the manual Cost per Visit). Never recalculated here.
         v.visit_amount::text AS service_value,
         ${NO_AMOUNT_SOURCE_SQL} AS no_amount_source,
         ${acknowledgements ? SERVICE_ACKNOWLEDGEMENT_SQL : "NULL::jsonb"} AS acknowledgement,
         (v.manual_invoice_no IS NOT NULL) AS is_paid,
         ${serviceStatusSql(f)} AS service_status,
         ${f.reports ? SERVICE_REPORT_JSON_SQL : "NULL::jsonb"} AS service_report,
         v.updated_at`;
}

interface ServiceRow {
  id: string;
  contract_id: string;
  contract_reference: string;
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
  manual_engineer_name: string | null;
  working_days: number | null;
  manpower_count: number | null;
  amc_value: string;
  service_value: string | null;
  no_amount_source: boolean;
  acknowledgement: unknown;
  is_paid: boolean;
  service_status: ServiceStatus;
  service_report: unknown;
  updated_at: Date;
}

/**
 * Service Report No. lock (P1 fixes; rule APPROVED BY THE OWNER 2026-11-09): the number is
 * editable until the service is Paid (manual Invoice No. entered) and locked afterwards. Only an
 * administrator (Super Admin or Admin role) may then change it, with a mandatory reason that goes
 * into the Audit Log. Production activation is separate from approval: the lock applies only with
 * SERVICE_REPORT_NO_LOCK_ENABLED=true (default off, so current behaviour is kept until the approved
 * release). Read on every request, so the switch needs no code change.
 */
export function reportNumberLockEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.SERVICE_REPORT_NO_LOCK_ENABLED?.trim().toLowerCase() === "true";
}

const REPORT_NUMBER_LOCKED_MESSAGE =
  "The Service Report No. is locked because this service is Paid (an Invoice No. is entered). An administrator can change it with a reason.";

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
  /**
   * The Service Engineer typed on this service (0110; the field was labelled "Sales Engineer Name" until the client UAT
   * of 2026-11-16), or null. Free text, kept apart from salesEngineer above, which is the contract's Sales Engineer master
   * link (0070). The API name stays salesEngineerName for compatibility.
   */
  salesEngineerName: string | null;
  /**
   * Number of Working Days (0121), typed by hand on this service; a non-negative whole number, or null when nobody has
   * entered it. Never calculated from dates.
   */
  workingDays: number | null;
  /**
   * Number of Manpower (0122), typed by hand on this service; a non-negative whole number, or null when nobody has
   * entered it. Never calculated.
   */
  manpowerCount: number | null;
  /**
   * The linked contract's AMC Value / Year, OMR excluding VAT, as a decimal string. Null when the signed-in user may
   * not see contract values (needs AMC Contracts: View): it is then never sent.
   */
  amcValue: string | null;
  /**
   * This service's value (visit_amount), OMR excluding VAT: the per-service share of the billing basis, or the manual
   * Cost per Visit. Same permission as amcValue; null when not shown or when no value was recorded (never 0.000).
   */
  serviceValue: string | null;
  /** No service value, and the contract has neither a Billing Basis nor a Cost per Visit (as on Master AMC Status). */
  valueSourceMissing: boolean;
  /** The acknowledgement of this service's invoice; null when the user may not view Invoice Acknowledgements. */
  acknowledgement: ServiceAcknowledgement | null;
  /** The uploaded Service Report document (0104), or null. */
  serviceReport: ServiceReport | null;
  /** Completed and saved: the status and completion date can no longer change. */
  locked: boolean;
  /** Paid (manual Invoice No. entered): the reference status. Does not verify payment. */
  paid: boolean;
  /** The Service Report No. is locked (lock switched on and the service Paid): only an administrator may change it, with a reason. */
  reportNumberLocked: boolean;
  updatedAt: string;
}

/** What the signed-in user may see on Service Status beyond the page itself. */
export interface ServiceStatusAccess {
  /** The contract's AMC Value: the permission that shows contract values on AMC Contracts (AMC_CONTRACTS:VIEW). */
  amcValue: boolean;
  /** The invoice acknowledgement indicator: Invoice Acknowledgements: View (serviceAcknowledgementsVisible). */
  acknowledgements?: boolean;
  /** Columns hidden from the user's role (role visibility, 0123): their data is not sent. Read-only columns only. */
  hiddenColumns?: ReadonlySet<ServiceStatusColumn>;
}

/**
 * The Service Status columns role visibility can hide: only those shown read-only here. A column edited on this page
 * (report number, Service Engineer, working days, manpower, Service Report) is never withheld, so a save can never
 * be made from a blanked value.
 */
export const ROLE_HIDEABLE_SERVICE_COLUMNS = ["client", "system", "frequency", "service", "amcValue", "serviceValue", "acknowledgement", "engineer"] as const satisfies readonly ServiceStatusColumn[];

/** Nothing extra: the safe default for any caller that does not say who is asking. */
const NO_EXTRA_ACCESS: ServiceStatusAccess = { amcValue: false, acknowledgements: false };

export async function serviceStatusAccess(auth: Pick<AuthContext, "permissions" | "hidden">): Promise<ServiceStatusAccess> {
  // No permission set (an internal caller): nothing extra is shown.
  return {
    amcValue: auth.permissions ? holdsPermission(auth.permissions, "AMC_CONTRACTS:VIEW") : false,
    acknowledgements: await serviceAcknowledgementsVisible(auth),
    hiddenColumns: hiddenColumnsOf(auth, "serviceStatus", ROLE_HIDEABLE_SERVICE_COLUMNS),
  };
}

/** The value totals without those of a hidden value column; null when neither is left. */
function totalsWithout(totals: ServiceStatusValueTotals | null, hidden: ReadonlySet<ServiceStatusColumn> | undefined): ServiceStatusValueTotals | null {
  if (!totals || !hidden || (!hidden.has("amcValue") && !hidden.has("serviceValue"))) return totals;
  if (hidden.has("amcValue") && hidden.has("serviceValue")) return null;
  const copy: Partial<ServiceStatusValueTotals> = { ...totals };
  if (hidden.has("amcValue")) delete copy.amcValue;
  if (hidden.has("serviceValue")) {
    delete copy.serviceValue;
    delete copy.serviceValueMissing;
  }
  return copy as ServiceStatusValueTotals;
}

function toItem(row: ServiceRow, access: ServiceStatusAccess = NO_EXTRA_ACCESS): ServiceStatusItem {
  const item = toFullItem(row, access);
  const hidden = access.hiddenColumns;
  if (!hidden || hidden.size === 0) return item;
  const off = (column: ServiceStatusColumn) => hidden.has(column);

  return {
    ...item,
    client: off("client") ? { id: item.client.id, name: "" } : item.client,
    system: off("system") ? { description: "", typeId: null, typeName: null } : item.system,
    frequency: off("frequency") ? { code: "", label: "" } : item.frequency,
    service: off("service") ? { sequenceNo: 0, cycleNo: null, serviceCode: null } : item.service,
    amcValue: off("amcValue") ? null : item.amcValue,
    serviceValue: off("serviceValue") ? null : item.serviceValue,
    valueSourceMissing: off("serviceValue") ? false : item.valueSourceMissing,
    acknowledgement: off("acknowledgement") ? null : item.acknowledgement,
    salesEngineer: off("engineer") ? null : item.salesEngineer,
  };
}

function toFullItem(row: ServiceRow, access: ServiceStatusAccess = NO_EXTRA_ACCESS): ServiceStatusItem {
  return {
    id: row.id,
    reference: row.contract_reference,
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
    salesEngineerName: row.manual_engineer_name,
    workingDays: row.working_days,
    manpowerCount: row.manpower_count,
    amcValue: access.amcValue ? row.amc_value : null,
    serviceValue: access.amcValue ? row.service_value : null,
    valueSourceMissing: access.amcValue ? row.service_value === null && row.no_amount_source : false,
    acknowledgement: access.acknowledgements ? toServiceAcknowledgement(row.acknowledgement) : null,
    serviceReport: toServiceReport(row.service_report),
    locked: row.status === "COMPLETED",
    paid: row.is_paid,
    reportNumberLocked: row.is_paid && reportNumberLockEnabled(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export type ServiceStatusFilters = Omit<ListServiceStatusQuery, "page" | "pageSize">;

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
      `${referenceSql("c", f.storedReference)} ILIKE ${p}`,
      `cl.name ILIKE ${p}`,
      `c.system_description ILIKE ${p}`,
      `(to_jsonb(v) ->> 'service_code') ILIKE ${p}`,
      ...(f.masters ? [`st.name ILIKE ${p}`] : []),
      ...(f.reportNumber ? [`v.service_report_no ILIKE ${p}`] : []),
      ...(f.engineerName ? [`v.sales_engineer_name ILIKE ${p}`] : []),
    ];

    conditions.push(`(${matches.join(" OR ")})`);
  }

  const withoutStatus = `WHERE ${conditions.join(" AND ")}`;
  const where = query.serviceStatus ? `${withoutStatus} AND (${serviceStatusSql(f)}) = ${add(query.serviceStatus)}` : withoutStatus;

  return { where, withoutStatus, params };
}

/** The default order (owner decision 2026-11-25): AMC Reference ascending, each contract's services in date order. */
const order = (storedReference: boolean) => `ORDER BY ${serviceOrderSql("c", "v", storedReference)}`;

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

/**
 * The totals row (client UAT 2026-11-16, CR-028), over EVERY service the filters select (status filter included), on
 * every page. It reuses the two totals the application already has:
 *   * Service Value: the sum of the services' own values (visit_amount), as Accounts and Master AMC Status add them up;
 *     services without a value add nothing and are counted, so an incomplete total says so;
 *   * AMC Value: each contract period's AMC Value / Year counted ONCE however many of its services match, as on Service
 *     Sales (2026-11-09). Summing the column would count a contract's value once per service.
 * Only for users who may see the values (the same rule as the columns); otherwise not computed or sent.
 */
export interface ServiceStatusValueTotals {
  services: number;
  serviceValue: string;
  serviceValueMissing: number;
  amcValue: string;
  contracts: number;
}

async function valueTotals(where: string, params: unknown[], f: Features): Promise<ServiceStatusValueTotals> {
  const [services, contracts] = await Promise.all([
    pool.query<{ services: number; service_value: string; missing: number }>(
      `SELECT count(*)::int AS services, COALESCE(sum(v.visit_amount), 0)::numeric(16,3)::text AS service_value,
              count(*) FILTER (WHERE v.visit_amount IS NULL)::int AS missing
       ${fromSql(f)} ${where}`,
      params
    ),
    pool.query<{ amc_value: string; contracts: number }>(
      `SELECT COALESCE(sum(t.contract_value), 0)::numeric(16,3)::text AS amc_value, count(*)::int AS contracts
       FROM (SELECT DISTINCT c.id, c.contract_value ${fromSql(f)} ${where}) t`,
      params
    ),
  ]);

  return {
    services: services.rows[0]?.services ?? 0,
    serviceValue: services.rows[0]?.service_value ?? "0.000",
    serviceValueMissing: services.rows[0]?.missing ?? 0,
    amcValue: contracts.rows[0]?.amc_value ?? "0.000",
    contracts: contracts.rows[0]?.contracts ?? 0,
  };
}

function totalFor(figures: ServiceStatusKpis, status: ServiceStatus | undefined): number {
  if (status === "COMPLETED") return figures.completed;
  if (status === "NOT_COMPLETED") return figures.notCompleted;
  if (status === "WAITING_FOR_RENEWAL") return figures.waitingForRenewal;
  return figures.total;
}

export async function listServiceStatus(query: ListServiceStatusQuery, access: ServiceStatusAccess = NO_EXTRA_ACCESS) {
  const f = await features();
  const { where, withoutStatus, params } = filterSql(query, f);
  const statusParamCount = query.serviceStatus ? params.length - 1 : params.length;
  const figures = await kpis(withoutStatus, params.slice(0, statusParamCount), f);
  // Never computed, so never sent, for a user who may not see the values.
  const totals = access.amcValue ? await valueTotals(where, params, f) : null;
  const rows = await pool.query<ServiceRow>(
    `${selectSql(f, access.acknowledgements)} ${fromSql(f)} ${where} ${order(f.storedReference)}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map((row) => toItem(row, access)),
    total: totalFor(figures, query.serviceStatus),
    page: query.page,
    pageSize: query.pageSize,
    kpis: figures,
    reportNumberAvailable: f.reportNumber,
    serviceReportsAvailable: f.reports,
    serviceReportLimits: { maxMb: env.attachmentMaxMb, allowedTypes: SERVICE_REPORT_TYPES_TEXT },
    reportNumberLockEnabled: reportNumberLockEnabled(),
    salesEngineerNameAvailable: f.engineerName,
    workingDaysAvailable: f.workingDays,
    manpowerCountAvailable: f.manpowerCount,
    amcValueVisible: access.amcValue,
    acknowledgementsVisible: access.acknowledgements === true && !access.hiddenColumns?.has("acknowledgement"),
    totals: totalsWithout(totals, access.hiddenColumns),
    // The columns this user's role does not see (role visibility): the page leaves them out.
    roleHiddenColumns: [...(access.hiddenColumns ?? [])],
  };
}

/** One service, by its visit id, for the View dialog. */
export async function getServiceStatusItem(id: string, access: ServiceStatusAccess = NO_EXTRA_ACCESS): Promise<ServiceStatusItem> {
  const f = await features();

  return toItem(await findServiceRow(pool, id, f, access.acknowledgements), access);
}

/**
 * Every visit that matches the filters, in the page's order, for an export.
 * `checkSize` is given the number of rows before any is read and throws when
 * the export cannot hold that many.
 */
export async function listAllServiceStatus(filters: ServiceStatusFilters, checkSize: (count: number) => void, access: ServiceStatusAccess = NO_EXTRA_ACCESS) {
  const f = await features();
  const { where, withoutStatus, params } = filterSql(filters, f);
  const statusParamCount = filters.serviceStatus ? params.length - 1 : params.length;
  const figures = await kpis(withoutStatus, params.slice(0, statusParamCount), f);
  const total = totalFor(figures, filters.serviceStatus);

  checkSize(total);

  const rows = await pool.query<ServiceRow>(`${selectSql(f, access.acknowledgements)} ${fromSql(f)} ${where} ${order(f.storedReference)}`, params);
  const totals = access.amcValue ? await valueTotals(where, params, f) : null;

  return { items: rows.rows.map((row) => toItem(row, access)), total, kpis: figures, features: f, totals: totalsWithout(totals, access.hiddenColumns) };
}

/** The lists for the page's filters, taken from the contracts that have visits on the page. */
export function getServiceStatusOptions() {
  return filterOptions(IN_SCOPE);
}

/**
 * Every visit the Monthly Calendar can show: the operational statuses, cancelled visits included, whatever the
 * contract's status. Imported HISTORICAL periods are not on the calendar. Service Status keeps IN_SCOPE.
 */
export const CALENDAR_SCOPE = "v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED', 'CANCELLED')";

/** The calendar's filter lists, taken from the visits it can show (see CALENDAR_SCOPE). */
export function getCalendarOptions() {
  return filterOptions(CALENDAR_SCOPE);
}

async function filterOptions(scope: string) {
  const f = await features();
  const from = `FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id WHERE ${scope}`;
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
    serviceReportsAvailable: f.reports,
  };
}

async function findServiceRow(db: Queryable, id: string, f: Features, acknowledgements = false): Promise<ServiceRow> {
  const result = await db.query<ServiceRow>(`${selectSql(f, acknowledgements)} ${fromSql(f)} WHERE v.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) throw notFound("AMC visit not found.");
  return row;
}

/**
 * Saves the status and report number of ONE visit, in one transaction. A status
 * change goes through the execution rules: completing needs the visit's uploaded
 * service report (0104), the completion date is recorded automatically (today,
 * on the database's date) unless the request names one, and a completed visit
 * is locked (no reopening, no date change). Nothing else on the visit, and no
 * other visit, is changed.
 */
export async function saveServiceStatus(auth: AuthContext, id: string, input: SaveServiceStatusInput): Promise<ServiceStatusItem> {
  const f = await features();

  if (
    (input.reportNumber !== undefined && !f.reportNumber) ||
    (input.salesEngineerName !== undefined && !f.engineerName) ||
    (input.workingDays !== undefined && !f.workingDays) ||
    (input.manpowerCount !== undefined && !f.manpowerCount)
  ) {
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
      // The page no longer asks for a date: completion is recorded on today's date (the database's), as before when
      // the page pre-filled today. A request may still name the date when it completes the visit.
      const completedDate =
        input.completedDate ?? (row.status === "COMPLETED" ? undefined : (await client.query<{ today: string }>(`SELECT ${BUSINESS_TODAY_SQL}::text AS today`)).rows[0]?.today);

      await applyExecution(client, auth, id, { status: "COMPLETED", ...(completedDate !== undefined ? { completedDate } : {}) });
    } else if (input.status === "NOT_COMPLETED" && row.status === "COMPLETED") {
      // Refused by the completion lock in the execution rules (there is no reopening).
      await applyExecution(client, auth, id, { status: "SCHEDULED" });
    } else if (input.status === undefined && input.completedDate !== undefined) {
      await applyExecution(client, auth, id, { completedDate: input.completedDate });
    }

    if (input.reportNumber !== undefined) {
      const changes = diffFields({ serviceReportNo: row.service_report_no }, { serviceReportNo: input.reportNumber }, ["serviceReportNo"]);

      // The lock is decided on the stored Paid state, read under the row lock taken above, never from the request.
      const override = Object.keys(changes).length > 0 && row.is_paid && reportNumberLockEnabled();

      if (override) {
        if (!input.reportNumberOverrideReason) {
          throw new AppError(409, "REPORT_NUMBER_LOCKED", REPORT_NUMBER_LOCKED_MESSAGE);
        }
        if (!hasAdminAccess(auth.roles)) {
          throw forbidden("Only an administrator can change the Service Report No. of a Paid service.");
        }
      }

      if (Object.keys(changes).length > 0) {
        await client.query("UPDATE amc_visits SET service_report_no = $1, updated_by = $2 WHERE id = $3", [input.reportNumber, auth.user.id, id]);
        await logActivity(client, {
          userId: auth.user.id,
          action: override ? "amc_visit.service_report_no_override" : "amc_visit.service_report_changed",
          module: "AMC_EXECUTION",
          entityType: "amc_visits",
          entityId: id,
          description: `Service report number of AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) ${
            input.reportNumber ? `set to ${input.reportNumber}` : "cleared"
          }${override ? " by administrator override of the Paid lock" : ""}.`,
          metadata: override ? { changes, override: true, reason: input.reportNumberOverrideReason } : { changes },
        });
      }
    }

    if (input.salesEngineerName !== undefined) {
      const changes = diffFields({ salesEngineerName: row.manual_engineer_name }, { salesEngineerName: input.salesEngineerName }, ["salesEngineerName"]);

      // Free text beside the report number; not part of the Paid lock, and never the contract's Sales Engineer link.
      if (Object.keys(changes).length > 0) {
        await client.query("UPDATE amc_visits SET sales_engineer_name = $1, updated_by = $2 WHERE id = $3", [input.salesEngineerName, auth.user.id, id]);
        await logActivity(client, {
          userId: auth.user.id,
          action: "amc_visit.sales_engineer_name_changed",
          module: "AMC_EXECUTION",
          entityType: "amc_visits",
          entityId: id,
          // The action code stays (existing Audit Log entries and filters use it); the wording follows CR-010.
          description: `Service Engineer of AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) ${
            input.salesEngineerName ? `set to ${input.salesEngineerName}` : "cleared"
          }.`,
          metadata: { changes },
        });
      }
    }

    if (input.workingDays !== undefined) {
      const changes = diffFields({ workingDays: row.working_days }, { workingDays: input.workingDays }, ["workingDays"]);

      // Typed by hand, never calculated; like the Service Engineer it is not part of the completion or Paid locks and
      // changes nothing else on the visit.
      if (Object.keys(changes).length > 0) {
        await client.query("UPDATE amc_visits SET working_days = $1, updated_by = $2 WHERE id = $3", [input.workingDays, auth.user.id, id]);
        await logActivity(client, {
          userId: auth.user.id,
          action: "amc_visit.working_days_changed",
          module: "AMC_EXECUTION",
          entityType: "amc_visits",
          entityId: id,
          description: `Number of Working Days of AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) ${
            input.workingDays === null ? "cleared" : `set to ${input.workingDays}`
          }.`,
          metadata: { changes },
        });
      }
    }

    if (input.manpowerCount !== undefined) {
      const changes = diffFields({ manpowerCount: row.manpower_count }, { manpowerCount: input.manpowerCount }, ["manpowerCount"]);

      // Typed by hand, never calculated; like the Service Engineer it is not part of the completion or Paid locks and
      // changes nothing else on the visit (its own column only, so the Number of Working Days is never overwritten).
      if (Object.keys(changes).length > 0) {
        await client.query("UPDATE amc_visits SET manpower_count = $1, updated_by = $2 WHERE id = $3", [input.manpowerCount, auth.user.id, id]);
        await logActivity(client, {
          userId: auth.user.id,
          action: "amc_visit.manpower_count_changed",
          module: "AMC_EXECUTION",
          entityType: "amc_visits",
          entityId: id,
          description: `Number of Manpower of AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) ${
            input.manpowerCount === null ? "cleared" : `set to ${input.manpowerCount}`
          }.`,
          metadata: { changes },
        });
      }
    }

    const access = await serviceStatusAccess(auth);

    return toItem(await findServiceRow(client, id, f, access.acknowledgements), access);
  });
}
