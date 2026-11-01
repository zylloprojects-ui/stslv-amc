import { z } from "zod";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, exportFormatSchema, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import { dateSchema } from "../../shared/money";
import { idSchema } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { RENEWAL_QUEUE_SQL } from "../amc/renewal-queue.service";
import { IN_SCOPE } from "../amc/service-status.service";

// Consolidated reports: each one is a single read-only query over the same
// records and scope as its source module, so its totals match that module. All
// totals are calculated by PostgreSQL.

const filters = {
  from: dateSchema("From date").optional(),
  to: dateSchema("To date").optional(),
  clientId: idSchema.optional(),
  salesEngineerId: idSchema.optional(),
};
type Filters = { from?: string | undefined; to?: string | undefined; clientId?: string | undefined; salesEngineerId?: string | undefined };

export const reportQuerySchema = z.object({ ...filters, page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) });
export const reportExportSchema = z.object({ ...filters, format: exportFormatSchema });

const REFERENCE = "'AMC-' || lpad(c.id::text, 4, '0')";
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
    SELECT string_agg(i.invoice_number, ', ' ORDER BY i.invoice_date, i.id) AS numbers
    FROM invoice_allocations al JOIN invoices i ON i.id = al.invoice_id
    WHERE al.amc_visit_id = v.id AND i.status <> 'CANCELLED'
  ) inv ON true`;

const VISIT_COLUMNS = `${REFERENCE} AS reference, cl.name AS client, c.system_description AS system,
  COALESCE(mf.label, c.maintenance_frequency) AS frequency, v.service_code AS service, v.scheduled_date::text AS scheduled_date,
  initcap(replace(v.status, '_', ' ')) AS status, v.service_report_no AS report_no, inv.numbers AS invoice_no,
  se.name AS engineer, v.visit_amount AS value`;
const VISIT_REPORT_COLUMNS = [
  IDENT("reference", "AMC Reference"), TEXT("client", "Client", 26), TEXT("system", "System", 16), TEXT("frequency", "Frequency", 15),
  IDENT("service", "Service"), DATE("scheduled_date", "Scheduled Date"), TEXT("status", "Status", 13), IDENT("report_no", "Service Report No."),
  IDENT("invoice_no", "Invoice No."), TEXT("engineer", "Sales Engineer", 16), MONEY("value", "Visit Value"),
];

type Where = (query: Filters, add: (value: unknown) => string) => string[];

/** Date range on the scheduled date, client and engineer, for reports over visits. */
const visitWhere: Where = (query, add) => {
  const out = [IN_SCOPE];
  if (query.from) out.push(`v.scheduled_date >= ${add(query.from)}::date`);
  if (query.to) out.push(`v.scheduled_date <= ${add(query.to)}::date`);
  if (query.clientId) out.push(`c.client_id = ${add(query.clientId)}`);
  if (query.salesEngineerId) out.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
  return out;
};

interface ReportSpec {
  title: string;
  description: string;
  /** The filters the page should offer. */
  filters: ("dates" | "client" | "engineer")[];
  columns: ReportColumn[];
  sql: (where: string) => string;
  where: Where;
  orderBy: string;
  notes?: string[];
}

const groupedVisits = (keyColumns: string, group: string) => (where: string) => `
  SELECT ${keyColumns}, count(DISTINCT c.id)::int AS contracts, count(*)::int AS services,
         count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
         count(*) FILTER (WHERE v.status <> 'COMPLETED')::int AS pending,
         count(*) FILTER (WHERE inv.numbers IS NOT NULL)::int AS invoice_recorded,
         count(*) FILTER (WHERE inv.numbers IS NULL)::int AS not_recorded,
         COALESCE(sum(v.visit_amount), 0)::numeric(16,3) AS value
  ${VISITS} WHERE ${where} GROUP BY ${group}`;
const GROUP_COLUMNS = [
  COUNT("contracts", "Contracts"), COUNT("services", "Services"), COUNT("completed", "Completed"), COUNT("pending", "Pending"),
  COUNT("invoice_recorded", "Invoice Recorded"), COUNT("not_recorded", "Not Recorded"), MONEY("value", "Visit Value"),
];
const PAYMENT_NOTE = "An invoice number shows that an invoice was recorded, not that it was paid.";

export const REPORTS = {
  "contract-summary": {
    title: "AMC Contract Summary",
    description: "Every contract with its validity, amounts and service progress.",
    filters: ["dates", "client", "engineer"],
    columns: [
      IDENT("reference", "AMC Reference"), TEXT("client", "Client", 26), TEXT("system", "System", 16), TEXT("frequency", "Frequency", 15), TEXT("engineer", "Sales Engineer", 16),
      DATE("valid_from", "Valid From"), DATE("valid_to", "Valid To"), TEXT("status", "Status", 10), MONEY("contract_value", "Contract Value"), MONEY("final_credit", "Final Credit"),
      TEXT("billing_basis", "Billing Basis", 13), COUNT("services", "Services"), COUNT("completed", "Completed"),
    ],
    sql: (where) => `
      SELECT ${REFERENCE} AS reference, cl.name AS client, c.system_description AS system, COALESCE(mf.label, c.maintenance_frequency) AS frequency,
             se.name AS engineer, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to, initcap(c.status) AS status,
             c.contract_value, c.final_credit,
             CASE c.billing_basis WHEN 'CONTRACT_VALUE' THEN 'Contract Value' WHEN 'FINAL_CREDIT' THEN 'Final Credit' WHEN 'CUSTOM' THEN 'Custom' END AS billing_basis,
             (SELECT count(*)::int FROM amc_visits v WHERE v.amc_contract_id = c.id AND v.status <> 'CANCELLED') AS services,
             (SELECT count(*)::int FROM amc_visits v WHERE v.amc_contract_id = c.id AND v.status = 'COMPLETED') AS completed
      FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
      LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
      LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
      WHERE ${where}`,
    // A contract is in a period when its validity overlaps it.
    where: (query, add) => {
      const out = ["true"];
      if (query.from) out.push(`c.valid_to >= ${add(query.from)}::date`);
      if (query.to) out.push(`c.valid_from <= ${add(query.to)}::date`);
      if (query.clientId) out.push(`c.client_id = ${add(query.clientId)}`);
      if (query.salesEngineerId) out.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
      return out;
    },
    orderBy: "client, reference",
  },
  "scheduled-services": {
    title: "Scheduled Services",
    description: "Every scheduled service, completed or not.",
    filters: ["dates", "client", "engineer"],
    columns: VISIT_REPORT_COLUMNS,
    sql: (where) => `SELECT ${VISIT_COLUMNS} ${VISITS} WHERE ${where}`,
    where: visitWhere,
    orderBy: "scheduled_date, client, reference",
    notes: [PAYMENT_NOTE],
  },
  "completed-services": {
    title: "Completed Services",
    description: "Services marked completed.",
    filters: ["dates", "client", "engineer"],
    columns: VISIT_REPORT_COLUMNS,
    sql: (where) => `SELECT ${VISIT_COLUMNS} ${VISITS} WHERE ${where}`,
    where: (query, add) => [...visitWhere(query, add), "v.status = 'COMPLETED'"],
    orderBy: "scheduled_date, client, reference",
    notes: [PAYMENT_NOTE],
  },
  "pending-services": {
    title: "Pending Services",
    description: "Services not yet completed.",
    filters: ["dates", "client", "engineer"],
    columns: VISIT_REPORT_COLUMNS,
    sql: (where) => `SELECT ${VISIT_COLUMNS} ${VISITS} WHERE ${where}`,
    where: (query, add) => [...visitWhere(query, add), "v.status <> 'COMPLETED'"],
    orderBy: "scheduled_date, client, reference",
  },
  "monthly-maintenance": {
    title: "Monthly Maintenance",
    description: "Services per scheduled month.",
    filters: ["dates", "client", "engineer"],
    columns: [TEXT("month", "Month", 12), ...GROUP_COLUMNS],
    sql: groupedVisits("to_char(v.scheduled_date, 'YYYY-MM') AS month", "to_char(v.scheduled_date, 'YYYY-MM')"),
    where: visitWhere,
    orderBy: "month",
    notes: [PAYMENT_NOTE],
  },
  renewal: {
    title: "AMC Renewal",
    description: "Contracts due for renewal or with a renewal, as on AMC Renewal.",
    filters: ["client"],
    columns: [
      IDENT("reference", "AMC Reference"), TEXT("client", "Client", 26), TEXT("system", "System", 16), DATE("valid_to", "Valid To"), COUNT("days_left", "Days Left"),
      TEXT("renewal_state", "Renewal Status", 16), MONEY("contract_value", "Contract Value"),
    ],
    sql: (where) => `
      SELECT 'AMC-' || lpad(q.id::text, 4, '0') AS reference, q.client_name AS client, q.system_description AS system, q.valid_to, q.days_left,
             initcap(replace(q.renewal_state, '_', ' ')) AS renewal_state, q.contract_value::numeric(16,3) AS contract_value
      FROM ${RENEWAL_QUEUE_SQL} WHERE ${where}`,
    where: (query, add) => ["q.renewal_state IS NOT NULL", ...(query.clientId ? [`q.client_id = ${add(query.clientId)}`] : [])],
    orderBy: "valid_to, client, reference",
  },
  accounts: {
    title: "Accounts / Invoice Recorded Summary",
    description: "Services by whether they are completed and an invoice number is recorded, over the same rows as Accounts.",
    filters: ["dates", "client", "engineer"],
    columns: [TEXT("service_state", "Service", 16), TEXT("invoice_state", "Invoice", 18), COUNT("services", "Services"), MONEY("value", "Visit Value")],
    sql: (where) => `
      SELECT CASE WHEN v.status = 'COMPLETED' THEN 'Completed' ELSE 'Not Completed' END AS service_state,
             CASE WHEN inv.numbers IS NULL THEN 'Not Recorded' ELSE 'Invoice Recorded' END AS invoice_state,
             count(*)::int AS services, COALESCE(sum(v.visit_amount), 0)::numeric(16,3) AS value
      ${VISITS} WHERE ${where} GROUP BY 1, 2`,
    where: visitWhere,
    orderBy: "service_state, invoice_state",
    notes: [PAYMENT_NOTE, "Payment is not recorded in STSLV AMC."],
  },
  "client-summary": {
    title: "Client-wise Summary",
    description: "Services and values per client.",
    filters: ["dates", "client", "engineer"],
    columns: [TEXT("client", "Client", 30), ...GROUP_COLUMNS],
    sql: groupedVisits("cl.name AS client", "cl.id, cl.name"),
    where: visitWhere,
    orderBy: "client",
    notes: [PAYMENT_NOTE],
  },
  "engineer-summary": {
    title: "Sales Engineer-wise Summary",
    description: "Services and values per sales engineer.",
    filters: ["dates", "client", "engineer"],
    columns: [TEXT("engineer", "Sales Engineer", 28), ...GROUP_COLUMNS],
    sql: groupedVisits("COALESCE(se.name, 'Not linked') AS engineer", "se.id, se.name"),
    where: visitWhere,
    orderBy: "engineer",
    notes: [PAYMENT_NOTE],
  },
} satisfies Record<string, ReportSpec>;

export type ReportType = keyof typeof REPORTS;
export const reportTypeSchema = z.enum(Object.keys(REPORTS) as [ReportType, ...ReportType[]], { error: "Select a report." });

export function reportCatalogue() {
  return Object.entries(REPORTS).map(([id, spec]) => ({ id, title: spec.title, description: spec.description, filters: spec.filters }));
}

const totalled = (columns: ReportColumn[]) => columns.filter((column) => column.kind === "money" || column.kind === "count").filter((column) => column.key !== "days_left");

async function run(spec: ReportSpec, query: Filters, limit: number | null, offset: number) {
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const inner = spec.sql(spec.where(query, add).join(" AND "));
  const money = totalled(spec.columns);
  const aggregates = money.map((column) => `COALESCE(sum(r.${column.key}), 0)${column.kind === "money" ? "::numeric(16,3)" : ""}::text AS ${column.key}`);
  const summary = await pool.query<Record<string, string>>(`SELECT ${["count(*)::text AS row_count", ...aggregates].join(", ")} FROM (${inner}) r`, params);
  const rows = await pool.query<ReportRow>(`SELECT * FROM (${inner}) r ORDER BY ${spec.orderBy}${limit === null ? "" : ` LIMIT ${limit} OFFSET ${offset}`}`, params);
  const { row_count: rowCount, ...totals } = summary.rows[0] ?? {};

  return { rows: rows.rows, total: Number(rowCount ?? 0), totals };
}

export async function getReport(type: ReportType, query: z.infer<typeof reportQuerySchema>) {
  const { page, pageSize, ...rest } = query;
  const spec: ReportSpec = REPORTS[type];
  const { rows, total, totals } = await run(spec, rest, pageSize, (page - 1) * pageSize);

  return { id: type, title: spec.title, columns: spec.columns.map(({ key, header, kind }) => ({ key, header, kind })), rows, total, page, pageSize, totals, notes: spec.notes ?? [] };
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

  const report: ReportDefinition = {
    title: spec.title,
    period: rest.from || rest.to ? `${rest.from ?? "Start"} to ${rest.to ?? "End"}` : null,
    filters: described,
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: `report-${type}`,
    tables: [{ name: spec.title.slice(0, 31).replace(/[/\\?*[\]:]/g, "-"), columns: spec.columns, rows, totals: { label: `Total (${total} rows)`, values: totals }, ...(spec.notes ? { notes: spec.notes } : {}) }],
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
