import { z } from "zod";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayMoney, exportFormatSchema, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import { validationError } from "../../shared/errors";
import { dateSchema } from "../../shared/money";
import { idSchema } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { forbidden } from "../../shared/errors";
import { permissionKey, type Module, type PermissionKey } from "../../shared/permissions";
import { CONTRACT_STATUSES, VISIT_STATUSES } from "../amc/amc.constants";
import { renewalQueueSql } from "../amc/renewal-queue.service";
import { hasStoredReference, referenceSql } from "../amc/contract-reference";
import { RENEWAL_HISTORY_FROM } from "../amc/renewals.service";
import { EXPIRING_LIST_DAYS } from "../dashboard/operations.service";
import { PAID_STATUS_NOTE } from "../amc/manual-invoice.service";
import { IN_SCOPE } from "../amc/service-status.service";

// Consolidated reports: each one is a single read-only query over the same
// records and scope as its source module, so its totals match that module. All
// totals are calculated by PostgreSQL.

const filters = {
  from: dateSchema("From date").optional(),
  to: dateSchema("To date").optional(),
  clientId: idSchema.optional(),
  salesEngineerId: idSchema.optional(),
  // A system as entered on the contract (system_description), from GET /reports/options.
  system: z.string().trim().min(1).max(200).optional(),
  // The contract's status, or the visit's on a report over visits. Each report says which it accepts.
  status: z.enum([...new Set([...CONTRACT_STATUSES, ...VISIT_STATUSES])] as [string, ...string[]], { error: "Select a status." }).optional(),
  // Billing Schedule only. Paid: a manual Invoice No. is entered (a reference status).
  payment: z.enum(["PAID", "UNPAID"], { error: "Select Paid or Unpaid." }).optional(),
};
type Filters = {
  from?: string | undefined;
  to?: string | undefined;
  clientId?: string | undefined;
  salesEngineerId?: string | undefined;
  system?: string | undefined;
  status?: string | undefined;
  payment?: "PAID" | "UNPAID" | undefined;
};

export const reportQuerySchema = z.object({ ...filters, page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) });
export const reportExportSchema = z.object({ ...filters, format: exportFormatSchema });

/** What a report's SQL needs from the database: the AMC Reference Number of a contract alias (stored from 0105), and the renewal queue. */
interface SqlContext {
  reference: (alias: string) => string;
  renewalQueue: string;
}

const MONEY = (key: string, header: string): ReportColumn => ({ key, header, kind: "money", width: 15 });
const COUNT = (key: string, header: string): ReportColumn => ({ key, header, kind: "count", width: 11 });
const TEXT = (key: string, header: string, width = 20): ReportColumn => ({ key, header, kind: "text", width, wrap: true });
const IDENT = (key: string, header: string): ReportColumn => ({ key, header, kind: "identifier", width: 14 });
const DATE = (key: string, header: string): ReportColumn => ({ key, header, kind: "date", width: 12 });

/** The visits every service report reads: Accounts' and Service Status's scope. */
const VISITS = `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
  LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
  LEFT JOIN LATERAL (
    SELECT string_agg(i.invoice_number, ', ' ORDER BY i.invoice_date, i.id) AS numbers,
           -- The amounts of those invoices allocated to this visit, OMR excluding VAT. One allocation per invoice and
           -- visit (0060), and one row per visit here, so a grouped sum never counts an invoice twice.
           sum(al.allocated_amount)::numeric(16,3) AS amount
    FROM invoice_allocations al JOIN invoices i ON i.id = al.invoice_id
    WHERE al.amc_visit_id = v.id AND i.status <> 'CANCELLED'
  ) inv ON true`;

const visitColumns = (ctx: SqlContext) => `${ctx.reference("c")} AS reference, cl.name AS client, c.system_description AS system,
  COALESCE(mf.label, c.maintenance_frequency) AS frequency, v.service_code AS service, v.scheduled_date::text AS scheduled_date,
  initcap(replace(v.status, '_', ' ')) AS status, v.service_report_no AS report_no, v.manual_invoice_no AS invoice_no,
  CASE WHEN v.manual_invoice_no IS NULL THEN 'Unpaid' ELSE 'Paid' END AS payment, inv.numbers AS zoho_invoices,
  se.name AS engineer, v.visit_amount AS value, inv.amount AS zoho_invoice_value`;
const VISIT_REPORT_COLUMNS = [
  IDENT("reference", "AMC Reference"), TEXT("client", "Client", 26), TEXT("system", "System", 16), TEXT("frequency", "Frequency", 15),
  IDENT("service", "Service"), DATE("scheduled_date", "Scheduled Date"), TEXT("status", "Status", 13), IDENT("report_no", "Service Report No."),
  IDENT("invoice_no", "Invoice No."), TEXT("payment", "Paid / Unpaid", 9), IDENT("zoho_invoices", "Zoho Invoices"), TEXT("engineer", "Sales Engineer", 16), MONEY("value", "Value (Ex VAT)"),
  MONEY("zoho_invoice_value", "Zoho Invoice Value"),
];

type Where = (query: Filters, add: (value: unknown) => string) => string[];

/** Date range on the scheduled date, client and engineer, for reports over visits. */
const visitWhere: Where = (query, add) => {
  const out = [IN_SCOPE];
  if (query.from) out.push(`v.scheduled_date >= ${add(query.from)}::date`);
  if (query.to) out.push(`v.scheduled_date <= ${add(query.to)}::date`);
  if (query.clientId) out.push(`c.client_id = ${add(query.clientId)}`);
  if (query.salesEngineerId) out.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
  if (query.system) out.push(`c.system_description = ${add(query.system)}`);
  if (query.status) out.push(`v.status = ${add(query.status)}`);
  return out;
};

type ReportFilter = "dates" | "client" | "engineer" | "system" | "status" | "payment";

/** The visit statuses on these reports (IN_SCOPE), and those still open. */
const VISIT_REPORT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "POSTPONED", "COMPLETED"];
const OPEN_REPORT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "POSTPONED"];
const STANDARD_FILTERS: ReportFilter[] = ["dates", "client", "engineer", "system", "status"];

/** Client, engineer, system and the contract's status, for reports over contracts. */
const contractWhere: Where = (query, add) => {
  const out = ["true"];
  if (query.clientId) out.push(`c.client_id = ${add(query.clientId)}`);
  if (query.salesEngineerId) out.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
  if (query.system) out.push(`c.system_description = ${add(query.system)}`);
  if (query.status) out.push(`c.status = ${add(query.status)}`);
  return out;
};

/** A figure above a report's table: its row count, or one of its totals. Nothing is calculated outside PostgreSQL. */
interface ReportKpi {
  id: string;
  label: string;
  kind: "count" | "money";
  /** The key in the report's totals, or "rows" for the row count. */
  source: string;
  hint?: string;
}

interface ReportSpec {
  title: string;
  description: string;
  /**
   * The modules whose pages own this report's records and figures. Reading the report needs
   * REPORTS:VIEW and View of every one of them; exporting it also needs REPORTS:EXPORT and
   * Export of every one of them. Reports thus never show more than the source pages would.
   */
  sources: readonly Module[];
  /** The filters the page should offer. */
  filters: ReportFilter[];
  /** The statuses the Status filter accepts. A report without the filter accepts none. */
  statuses?: readonly string[];
  kpis?: ReportKpi[];
  columns: ReportColumn[];
  sql: (where: string, ctx: SqlContext) => string;
  where: Where;
  orderBy: string;
  notes?: string[];
}

const groupedVisits = (keyColumns: string, group: string) => (where: string) => `
  SELECT ${keyColumns}, count(DISTINCT c.id)::int AS contracts, count(*)::int AS services,
         count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
         count(*) FILTER (WHERE v.status <> 'COMPLETED')::int AS pending,
         count(*) FILTER (WHERE v.manual_invoice_no IS NOT NULL)::int AS paid,
         count(*) FILTER (WHERE v.manual_invoice_no IS NULL)::int AS unpaid,
         COALESCE(sum(v.visit_amount), 0)::numeric(16,3) AS value,
         COALESCE(sum(v.visit_amount) FILTER (WHERE v.manual_invoice_no IS NULL), 0)::numeric(16,3) AS unpaid_value,
         -- Client fixes, 2026-11-09: the invoiced side of each group, which the report did not show.
         COALESCE(sum(v.visit_amount) FILTER (WHERE v.manual_invoice_no IS NOT NULL), 0)::numeric(16,3) AS paid_value,
         COALESCE(sum(inv.amount), 0)::numeric(16,3) AS zoho_invoice_value,
         count(*) FILTER (WHERE v.visit_amount IS NULL)::int AS no_value
  ${VISITS} WHERE ${where} GROUP BY ${group}`;
const GROUP_COLUMNS = [
  COUNT("contracts", "Contracts"), COUNT("services", "Services"), COUNT("completed", "Completed"), COUNT("pending", "Pending"),
  COUNT("paid", "Paid"), COUNT("unpaid", "Unpaid"), MONEY("value", "Value (Ex VAT)"), MONEY("unpaid_value", "Unpaid Value"),
  MONEY("paid_value", "Paid Value (Invoice No. Entered)"), MONEY("zoho_invoice_value", "Zoho Invoice Value (Tracking)"), COUNT("no_value", "Services Without Value"),
];
/**
 * What the grouped value columns mean (client fixes, 2026-11-09). Paid Value is the reference status, not money received;
 * Zoho Invoice Value is what Invoice Tracking allocates to the services; a service with no amount adds nothing.
 */
const GROUP_VALUE_NOTE =
  "Value is each service's scheduled amount (OMR excluding VAT), grouped by its scheduled month. Paid Value: services with an Invoice No. entered (a reference status, not proof of payment). " +
  "Zoho Invoice Value: amounts of active Zoho invoices allocated to those services in Invoice Tracking; cancelled invoices are left out. " +
  "Services Without Value: no amount, because the contract has no Billing Basis and no Cost per Visit; no value is invented for them.";
const PAYMENT_NOTE = PAID_STATUS_NOTE;

export const REPORTS = {
  "contract-summary": {
    title: "AMC Contract Summary",
    sources: ["AMC_CONTRACTS"],
    description: "Every contract with its validity, amounts and service progress.",
    filters: STANDARD_FILTERS,
    statuses: CONTRACT_STATUSES,
    kpis: [
      { id: "contracts", label: "Contracts in Scope", kind: "count", source: "rows" },
      { id: "value", label: "AMC Value", kind: "money", source: "contract_value", hint: "AMC Value / Year as entered, excluding VAT" },
      { id: "scheduled", label: "Scheduled (Current Year)", kind: "money", source: "scheduled_current_year", hint: "Visit amounts scheduled this calendar year, excluding VAT" },
      { id: "unpaid", label: "Unpaid Amount", kind: "money", source: "unpaid_amount", hint: "Visits with no manual Invoice No., excluding VAT" },
    ],
    columns: [
      IDENT("reference", "AMC Reference"), TEXT("client", "Client", 26), TEXT("system", "System", 16), TEXT("frequency", "Frequency", 15), TEXT("engineer", "Sales Engineer", 16),
      DATE("valid_from", "Valid From"), DATE("valid_to", "Valid To"), TEXT("status", "Status", 10), MONEY("contract_value", "AMC Value / Year"), MONEY("final_credit", "Final Credit"),
      TEXT("billing_basis", "Billing Basis", 13), COUNT("services", "Services"), COUNT("completed", "Completed"), MONEY("scheduled_current_year", "Scheduled (Current Year)"), MONEY("unpaid_amount", "Unpaid Amount"),
    ],
    sql: (where, ctx) => `
      SELECT ${ctx.reference("c")} AS reference, cl.name AS client, c.system_description AS system, COALESCE(mf.label, c.maintenance_frequency) AS frequency,
             se.name AS engineer, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to, initcap(c.status) AS status,
             c.contract_value, c.final_credit,
             CASE c.billing_basis WHEN 'CONTRACT_VALUE' THEN 'AMC Value / Year' WHEN 'FINAL_CREDIT' THEN 'Final Credit' WHEN 'CUSTOM' THEN 'Custom' END AS billing_basis,
             (SELECT count(*)::int FROM amc_visits v WHERE v.amc_contract_id = c.id AND v.status <> 'CANCELLED') AS services,
             (SELECT count(*)::int FROM amc_visits v WHERE v.amc_contract_id = c.id AND v.status = 'COMPLETED') AS completed,
             (SELECT COALESCE(sum(v.visit_amount), 0)::numeric(16,3) FROM amc_visits v WHERE v.amc_contract_id = c.id AND date_trunc('year', v.scheduled_date) = date_trunc('year', current_date) AND ${IN_SCOPE}) AS scheduled_current_year,
             (SELECT COALESCE(sum(v.visit_amount), 0)::numeric(16,3) FROM amc_visits v WHERE v.amc_contract_id = c.id AND v.manual_invoice_no IS NULL AND ${IN_SCOPE}) AS unpaid_amount
      FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
      LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
      WHERE ${where}`,
    // A contract is in a period when its validity overlaps it.
    where: (query, add) => {
      const out = contractWhere(query, add);
      if (query.from) out.push(`c.valid_to >= ${add(query.from)}::date`);
      if (query.to) out.push(`c.valid_from <= ${add(query.to)}::date`);
      return out;
    },
    orderBy: "client, reference",
    notes: [PAID_STATUS_NOTE, "Amounts are OMR excluding VAT."],
  },
  "scheduled-services": {
    title: "Billing Schedule",
    sources: ["ACCOUNTS"],
    description: "Every scheduled service, completed or not, with its value and whether it is Paid or Unpaid.",
    filters: [...STANDARD_FILTERS, "payment"],
    statuses: VISIT_REPORT_STATUSES,
    columns: VISIT_REPORT_COLUMNS,
    sql: (where, ctx) => `SELECT ${visitColumns(ctx)} ${VISITS} WHERE ${where}`,
    where: (query, add) => {
      const out = visitWhere(query, add);
      if (query.payment === "PAID") out.push("v.manual_invoice_no IS NOT NULL");
      if (query.payment === "UNPAID") out.push("v.manual_invoice_no IS NULL");
      return out;
    },
    orderBy: "scheduled_date, client, reference",
    notes: [PAYMENT_NOTE],
  },
  "completed-services": {
    title: "Completed Services",
    sources: ["ACCOUNTS"],
    description: "Services marked completed.",
    filters: ["dates", "client", "engineer", "system"],
    columns: VISIT_REPORT_COLUMNS,
    sql: (where, ctx) => `SELECT ${visitColumns(ctx)} ${VISITS} WHERE ${where}`,
    where: (query, add) => [...visitWhere(query, add), "v.status = 'COMPLETED'"],
    orderBy: "scheduled_date, client, reference",
    notes: [PAYMENT_NOTE],
  },
  "pending-services": {
    title: "Pending Services",
    sources: ["ACCOUNTS"],
    description: "Services not yet completed.",
    filters: STANDARD_FILTERS,
    statuses: OPEN_REPORT_STATUSES,
    columns: VISIT_REPORT_COLUMNS,
    sql: (where, ctx) => `SELECT ${visitColumns(ctx)} ${VISITS} WHERE ${where}`,
    where: (query, add) => [...visitWhere(query, add), "v.status <> 'COMPLETED'"],
    orderBy: "scheduled_date, client, reference",
  },
  "monthly-maintenance": {
    title: "Monthly Maintenance",
    sources: ["ACCOUNTS"],
    description: "Services per scheduled month.",
    filters: STANDARD_FILTERS,
    statuses: VISIT_REPORT_STATUSES,
    columns: [TEXT("month", "Month", 12), ...GROUP_COLUMNS],
    sql: groupedVisits("to_char(v.scheduled_date, 'YYYY-MM') AS month", "to_char(v.scheduled_date, 'YYYY-MM')"),
    where: visitWhere,
    orderBy: "month",
    notes: [PAYMENT_NOTE, GROUP_VALUE_NOTE],
  },
  renewal: {
    title: "AMC Renewal",
    sources: ["AMC_RENEWAL"],
    description: "Contracts due for renewal or with a renewal, as on AMC Renewal.",
    filters: ["client", "system", "status"],
    statuses: CONTRACT_STATUSES,
    columns: [
      IDENT("reference", "AMC Reference"), TEXT("client", "Client", 26), TEXT("system", "System", 16), DATE("valid_to", "Valid To"), COUNT("days_left", "Days Left"),
      TEXT("renewal_state", "Renewal Status", 16), MONEY("contract_value", "Contract Value"),
    ],
    sql: (where, ctx) => `
      SELECT q.reference, q.client_name AS client, q.system_description AS system, q.valid_to, q.days_left,
             initcap(replace(q.renewal_state, '_', ' ')) AS renewal_state, q.contract_value::numeric(16,3) AS contract_value
      FROM ${ctx.renewalQueue} WHERE ${where}`,
    where: (query, add) => {
      const out = ["q.renewal_state IS NOT NULL"];
      if (query.clientId) out.push(`q.client_id = ${add(query.clientId)}`);
      if (query.system) out.push(`q.system_description = ${add(query.system)}`);
      if (query.status) out.push(`q.status = ${add(query.status)}`);
      return out;
    },
    orderBy: "valid_to, client, reference",
  },
  // The Dashboard's Expiring Contracts rule, so both give the same total. Every row is Active, so there is no Status filter.
  "expiry-renewal": {
    title: "Expiry & Renewal Due",
    sources: ["AMC_RENEWAL"],
    description: `Active contracts ending within ${EXPIRING_LIST_DAYS} days or already past validity, with days left and renewal state.`,
    filters: ["client", "engineer", "system"],
    columns: [
      IDENT("reference", "AMC Reference"), TEXT("client", "Client", 26), TEXT("system", "System", 16), TEXT("engineer", "Sales Engineer", 16), DATE("valid_to", "Valid To"), COUNT("days_left", "Days Left"),
      TEXT("renewal_state", "Renewal State", 18), IDENT("renewal_reference", "Renewal"), MONEY("contract_value", "AMC Value / Year"),
    ],
    sql: (where, ctx) => `
      SELECT q.reference, q.client_name AS client, q.system_description AS system, se.name AS engineer, q.valid_to, q.days_left,
             CASE q.renewal_state WHEN 'DUE' THEN 'Due / Expired' WHEN 'UNDER_APPROVAL' THEN 'Under Client Approval' WHEN 'RENEWED' THEN 'Renewed' WHEN 'CANCELLED' THEN 'Renewal Cancelled' ELSE 'Not Yet Due' END AS renewal_state,
             q.renewal_reference, q.contract_value::numeric(16,3) AS contract_value
      FROM ${ctx.renewalQueue}
      JOIN amc_contracts c ON c.id = q.id
      LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
      WHERE ${where}`,
    where: (query, add) => [`c.status = 'ACTIVE' AND c.valid_to <= current_date + ${EXPIRING_LIST_DAYS}`, ...contractWhere(query, add)],
    orderBy: "valid_to, client, reference",
    notes: ["A renewal is a separate contract; the contract it renews is not changed. Not Yet Due: no renewal has been started and the contract is outside the renewal window.", "Amounts are OMR excluding VAT."],
  },
  "renewal-history": {
    title: "Renewal History",
    sources: ["AMC_RENEWAL"],
    description: "Every renewal made, newest first, as on AMC Renewal: the renewal contract and the contract it renews.",
    filters: STANDARD_FILTERS,
    statuses: CONTRACT_STATUSES,
    columns: [
      IDENT("reference", "AMC Reference"), IDENT("renewed_from", "Renewed From"), TEXT("client", "Client", 26), TEXT("system", "System", 16), TEXT("engineer", "Sales Engineer", 16), DATE("source_valid_to", "Previous Valid To"),
      DATE("valid_from", "Valid From"), DATE("valid_to", "Valid To"), TEXT("status", "Status", 10), DATE("created_on", "Renewed On"), MONEY("source_value", "Previous AMC Value / Year"), MONEY("contract_value", "AMC Value / Year"),
    ],
    sql: (where, ctx) => `
      SELECT ${ctx.reference("c")} AS reference, ${ctx.reference("s")} AS renewed_from, cl.name AS client, c.system_description AS system, se.name AS engineer,
             s.valid_to::text AS source_valid_to, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to, initcap(c.status) AS status, c.created_at::date::text AS created_on,
             s.contract_value AS source_value, c.contract_value, c.id AS sort_id
      ${RENEWAL_HISTORY_FROM}
      LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
      WHERE ${where}`,
    // The period is the day the renewal was made.
    where: (query, add) => {
      const out = contractWhere(query, add);
      if (query.from) out.push(`c.created_at::date >= ${add(query.from)}::date`);
      if (query.to) out.push(`c.created_at::date <= ${add(query.to)}::date`);
      return out;
    },
    orderBy: "created_on DESC, sort_id DESC",
    notes: ["A renewal is a separate contract; the contract it renews is not changed. Amounts are OMR excluding VAT, as entered."],
  },
  accounts: {
    title: "Accounts / Paid and Unpaid Summary",
    sources: ["ACCOUNTS"],
    description: "Services by whether they are completed and Paid (a manual Invoice No. is entered), over the same rows as Accounts.",
    filters: STANDARD_FILTERS,
    statuses: VISIT_REPORT_STATUSES,
    columns: [TEXT("service_state", "Service", 16), TEXT("invoice_state", "Paid / Unpaid", 18), COUNT("services", "Services"), MONEY("value", "Value (Ex VAT)")],
    sql: (where) => `
      SELECT CASE WHEN v.status = 'COMPLETED' THEN 'Completed' ELSE 'Not Completed' END AS service_state,
             CASE WHEN v.manual_invoice_no IS NULL THEN 'Unpaid' ELSE 'Paid' END AS invoice_state,
             count(*)::int AS services, COALESCE(sum(v.visit_amount), 0)::numeric(16,3) AS value
      ${VISITS} WHERE ${where} GROUP BY 1, 2`,
    where: visitWhere,
    orderBy: "service_state, invoice_state",
    notes: [PAYMENT_NOTE],
  },
  "client-summary": {
    title: "Client-wise Summary",
    sources: ["ACCOUNTS"],
    description: "Services and values per client.",
    filters: STANDARD_FILTERS,
    statuses: VISIT_REPORT_STATUSES,
    columns: [TEXT("client", "Client", 30), ...GROUP_COLUMNS],
    sql: groupedVisits("cl.name AS client", "cl.id, cl.name"),
    where: visitWhere,
    orderBy: "client",
    notes: [PAYMENT_NOTE],
  },
  "engineer-summary": {
    title: "Sales Engineer-wise Summary",
    sources: ["ACCOUNTS"],
    description: "Services and values per sales engineer.",
    filters: STANDARD_FILTERS,
    statuses: VISIT_REPORT_STATUSES,
    columns: [TEXT("engineer", "Sales Engineer", 28), ...GROUP_COLUMNS],
    sql: groupedVisits("COALESCE(se.name, 'Not linked') AS engineer", "se.id, se.name"),
    where: visitWhere,
    orderBy: "engineer",
    notes: [PAYMENT_NOTE],
  },
  "contract-value-review": {
    title: "Contract Value Review",
    sources: ["AMC_CONTRACTS"],
    description: "Multi-year contracts whose value may be a whole-term amount rather than an annual one. Nothing is changed by this report.",
    filters: ["client", "engineer", "system", "status"],
    statuses: ["DRAFT", "ACTIVE", "EXPIRED"],
    columns: [
      IDENT("reference", "AMC Reference"), TEXT("client", "Client", 24), TEXT("system", "System", 16), DATE("valid_from", "Valid From"), DATE("valid_to", "Valid To"), COUNT("contract_years", "Contract Years"),
      TEXT("billing_basis", "Billing Basis", 13), MONEY("contract_value", "Value As Entered"), MONEY("visit_total", "Total Of Visit Amounts"), TEXT("assessment", "Assessment", 26),
    ],
    sql: (where, ctx) => `
      SELECT r.*, CASE
               WHEN r.visit_total = 0 THEN 'Unclear: no visit amounts'
               WHEN abs(r.contract_value - r.visit_total) <= r.visit_total * 0.001 THEN 'May be whole-term: equals all visit amounts'
               WHEN abs(r.contract_value * r.contract_years - r.visit_total) <= r.visit_total * 0.001 THEN 'Looks annual: repeats each year'
               ELSE 'Unclear: matches neither'
             END AS assessment
      FROM (
        SELECT ${ctx.reference("c")} AS reference, cl.name AS client, c.system_description AS system, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to,
               ceil(EXTRACT(EPOCH FROM age(c.valid_to + 1, c.valid_from)) / EXTRACT(EPOCH FROM interval '1 year'))::int AS contract_years,
               COALESCE(CASE c.billing_basis WHEN 'CONTRACT_VALUE' THEN 'AMC Value / Year' END, 'Not selected') AS billing_basis,
               c.contract_value,
               (SELECT COALESCE(sum(v.visit_amount), 0)::numeric(16,3) FROM amc_visits v WHERE v.amc_contract_id = c.id AND v.status NOT IN ('CANCELLED', 'HISTORICAL')) AS visit_total
        FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
        WHERE c.status <> 'CANCELLED' AND c.valid_to >= (c.valid_from + interval '1 year')::date
          AND (c.billing_basis IS NULL OR c.billing_basis = 'CONTRACT_VALUE') AND ${where}
      ) r`,
    where: contractWhere,
    orderBy: "client, reference",
    notes: [
      "AMC Value / Year is an annual amount. A value entered before that rule may be for the whole term, so it needs a person's review.",
      "The assessment is only a comparison with the visit amounts. No value is changed or reinterpreted automatically.",
    ],
  },
} satisfies Record<string, ReportSpec>;

export type ReportType = keyof typeof REPORTS;
export const reportTypeSchema = z.enum(Object.keys(REPORTS) as [ReportType, ...ReportType[]], { error: "Select a report." });

type Held = ReadonlySet<PermissionKey>;
const holdsAll = (held: Held, keys: PermissionKey[]) => keys.every((key) => held.has(key));

/** REPORTS:VIEW and View of every source module. */
export function canViewReport(held: Held, type: ReportType): boolean {
  const spec: ReportSpec = REPORTS[type];
  return holdsAll(held, [permissionKey("REPORTS", "VIEW"), ...spec.sources.map((module) => permissionKey(module, "VIEW"))]);
}

/** What canViewReport needs, plus REPORTS:EXPORT and Export of every source module. */
export function canExportReport(held: Held, type: ReportType): boolean {
  const spec: ReportSpec = REPORTS[type];
  return canViewReport(held, type) && holdsAll(held, [permissionKey("REPORTS", "EXPORT"), ...spec.sources.map((module) => permissionKey(module, "EXPORT"))]);
}

/** Refuses (403) a report the user may not read, or not export. A refusal names no figure. */
export function assertReportAccess(held: Held, type: ReportType, action: "VIEW" | "EXPORT") {
  if (!(action === "VIEW" ? canViewReport(held, type) : canExportReport(held, type))) {
    throw forbidden(action === "VIEW" ? "You do not have permission to open this report." : "You do not have permission to export this report.");
  }
}

/** The reports this user may open, each with whether they may export it. Reports they may not open are left out. */
export function reportCatalogue(held: Held) {
  return (Object.entries(REPORTS) as [ReportType, ReportSpec][])
    .filter(([id]) => canViewReport(held, id))
    .map(([id, spec]) => ({
      id,
      title: spec.title,
      description: spec.description,
      filters: spec.filters,
      statuses: (spec.statuses ?? []).map((value) => ({ value, label: statusLabel(value) })),
      canExport: canExportReport(held, id),
    }));
}

/** "IN_PROGRESS" as "In Progress". */
function statusLabel(status: string): string {
  return status.toLowerCase().split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/** The lists for the page's filters. REPORTS:VIEW is enough, so the page does not depend on another module's permission. */
export async function getReportOptions() {
  const [clients, engineers, systems] = await Promise.all([
    pool.query<{ id: string; name: string }>("SELECT cl.id, cl.name FROM clients cl WHERE cl.id IN (SELECT client_id FROM amc_contracts) ORDER BY lower(cl.name), cl.id"),
    pool.query<{ id: string; name: string }>("SELECT e.id, e.name FROM sales_engineers e WHERE e.id IN (SELECT sales_engineer_id FROM amc_contracts) ORDER BY lower(e.name), e.id"),
    pool.query<{ system: string }>("SELECT DISTINCT system_description AS system FROM amc_contracts ORDER BY system"),
  ]);

  return { clients: clients.rows, salesEngineers: engineers.rows, systems: systems.rows.map((row) => row.system) };
}

/** A status or payment filter this report does not have would change what it means, so it is refused rather than ignored. */
function assertFiltersApply(spec: ReportSpec, query: Filters) {
  if (query.status && !spec.statuses?.includes(query.status)) {
    throw validationError("This report cannot be filtered by that status.", [{ field: "status", message: "This report cannot be filtered by that status." }]);
  }
  if (query.payment && !spec.filters.includes("payment")) {
    throw validationError("This report cannot be filtered by Paid or Unpaid.", [{ field: "payment", message: "This report cannot be filtered by Paid or Unpaid." }]);
  }
}

const totalled = (columns: ReportColumn[]) => columns.filter((column) => column.kind === "money" || column.kind === "count").filter((column) => column.key !== "days_left");

async function run(spec: ReportSpec, query: Filters, limit: number | null, offset: number) {
  assertFiltersApply(spec, query);

  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const stored = await hasStoredReference();
  const ctx: SqlContext = { reference: (alias) => referenceSql(alias, stored), renewalQueue: await renewalQueueSql() };
  const inner = spec.sql(spec.where(query, add).join(" AND "), ctx);
  const money = totalled(spec.columns);
  const aggregates = money.map((column) => `COALESCE(sum(r.${column.key}), 0)${column.kind === "money" ? "::numeric(16,3)" : ""}::text AS ${column.key}`);
  const summary = await pool.query<Record<string, string>>(`SELECT ${["count(*)::text AS row_count", ...aggregates].join(", ")} FROM (${inner}) r`, params);
  const rows = await pool.query<ReportRow>(`SELECT * FROM (${inner}) r ORDER BY ${spec.orderBy}${limit === null ? "" : ` LIMIT ${limit} OFFSET ${offset}`}`, params);
  const { row_count: rowCount, ...totals } = summary.rows[0] ?? {};

  return { rows: rows.rows, total: Number(rowCount ?? 0), totals };
}

/** The report's KPI figures, read from its PostgreSQL row count and totals. */
function kpisOf(spec: ReportSpec, total: number, totals: Record<string, string | undefined>) {
  return (spec.kpis ?? []).map(({ id, label, kind, source, hint }) => ({ id, label, kind, hint: hint ?? null, value: source === "rows" ? String(total) : totals[source] ?? "0.000" }));
}

export async function getReport(type: ReportType, query: z.infer<typeof reportQuerySchema>) {
  const { page, pageSize, ...rest } = query;
  const spec: ReportSpec = REPORTS[type];
  const { rows, total, totals } = await run(spec, rest, pageSize, (page - 1) * pageSize);

  return { id: type, title: spec.title, columns: spec.columns.map(({ key, header, kind }) => ({ key, header, kind })), rows, total, page, pageSize, totals, kpis: kpisOf(spec, total, totals), notes: spec.notes ?? [] };
}

export async function buildReportExport(auth: AuthContext, type: ReportType, query: z.infer<typeof reportExportSchema>) {
  const { format, ...rest } = query;
  const spec: ReportSpec = REPORTS[type];
  const { rows, total, totals } = await run(spec, rest, null, 0);

  assertExportSize(format, total);

  const nameOf = async (table: "clients" | "sales_engineers", id: string) => (await pool.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? "Unknown";
  const described: ReportDefinition["filters"] = [];
  if (rest.clientId) described.push({ label: "Client", value: await nameOf("clients", rest.clientId) });
  if (rest.salesEngineerId) described.push({ label: "Sales Engineer", value: await nameOf("sales_engineers", rest.salesEngineerId) });
  if (rest.system) described.push({ label: "System", value: rest.system });
  if (rest.status) described.push({ label: "Status", value: statusLabel(rest.status) });
  if (rest.payment) described.push({ label: "Paid / Unpaid", value: rest.payment === "PAID" ? "Paid" : "Unpaid" });

  const figures = kpisOf(spec, total, totals).map((kpi) => `${kpi.label} ${kpi.kind === "money" ? displayMoney(kpi.value) : kpi.value}`);
  const notes = [...(figures.length > 0 ? [figures.join(" · ")] : []), ...(spec.notes ?? [])];
  const report: ReportDefinition = {
    title: spec.title,
    period: rest.from || rest.to ? `${rest.from ?? "Start"} to ${rest.to ?? "End"}` : null,
    filters: described,
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: `report-${type}`,
    tables: [{ name: spec.title.slice(0, 31).replace(/[/\\?*[\]:]/g, "-"), columns: spec.columns, rows, totals: { label: `Total (${total} rows)`, values: totals }, ...(notes.length > 0 ? { notes } : {}) }],
  };
  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "report.exported",
      module: "REPORTS",
      entityType: "reports",
      entityId: null,
      description: `Exported ${spec.title} as ${format === "xlsx" ? "Excel" : "PDF"} (${total} rows).`,
      metadata: { format, report: type, filters: rest, rowCount: total },
    });

  return { report, recordExport };
}
