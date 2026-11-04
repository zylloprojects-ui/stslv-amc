import { z } from "zod";
import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, exportFormatSchema, type ReportColumn, type ReportDefinition } from "../../shared/export/report";
import { escapeLike, idSchema } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { PAID_STATUS_NOTE } from "./manual-invoice.service";
import { IN_SCOPE } from "./service-status.service";
import { hasStoredReference, referenceSql } from "./contract-reference";

// The consolidated monthly schedule: one row per AMC contract with its services
// of that month. A read-only grouping of amc_visits; the visit records and the
// visit-level pages are unchanged. Same visits as Service Status and Accounts.

const filters = {
  month: z.string({ error: "Select a month." }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Select a month."),
  clientId: idSchema.optional(),
  salesEngineerId: idSchema.optional(),
  system: z.string().trim().max(200).optional(),
  search: z.string().trim().max(200).optional(),
};

export const monthlyScheduleSchema = z.object({
  ...filters,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export const exportMonthlyScheduleSchema = z.object({ ...filters, format: exportFormatSchema });
type MonthlyFilters = Omit<z.infer<typeof monthlyScheduleSchema>, "page" | "pageSize">;

export interface MonthlyService {
  id: string;
  serviceCode: string | null;
  sequenceNo: number;
  scheduledDate: string;
  status: string;
  visitValue: string | null;
  /** The manual Invoice No.: entered = Paid, cleared = Unpaid. A reference status. */
  manualInvoiceNo: string | null;
  /** Zoho numbers from Invoice Tracking. They do not decide Paid or Unpaid. */
  invoiceNumbers: string[];
}

function filterSql(query: MonthlyFilters, storedReference: boolean) {
  const params: unknown[] = [`${query.month}-01`];
  const conditions = [IN_SCOPE, "v.scheduled_date >= $1::date", "v.scheduled_date < $1::date + interval '1 month'"];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.clientId) conditions.push(`c.client_id = ${add(query.clientId)}`);
  if (query.salesEngineerId) conditions.push(`c.sales_engineer_id = ${add(query.salesEngineerId)}`);
  if (query.system) conditions.push(`lower(btrim(c.system_description)) = lower(btrim(${add(query.system)}))`);
  if (query.search) {
    const p = add(`%${escapeLike(query.search)}%`);
    conditions.push(`(cl.name ILIKE ${p} OR c.system_description ILIKE ${p} OR ${referenceSql("c", storedReference)} ILIKE ${p})`);
  }

  return { where: conditions.join(" AND "), params };
}

const FROM = `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id`;

async function load(query: MonthlyFilters, limit: number | null, offset: number) {
  const storedReference = await hasStoredReference();
  const { where, params } = filterSql(query, storedReference);
  const totals = await pool.query<{ contracts: number; services: number; completed: number; total_value: string }>(
    `SELECT count(DISTINCT c.id)::int AS contracts, count(*)::int AS services,
            count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
            COALESCE(sum(v.visit_amount), 0)::numeric(16,3)::text AS total_value
     ${FROM} WHERE ${where}`,
    params
  );
  const rows = await pool.query<{
    id: string; reference: string; client_id: string; client_name: string; system_description: string; frequency: string; engineer: string | null;
    services: MonthlyService[]; total_value: string;
  }>(
    `SELECT c.id, ${referenceSql("c", storedReference)} AS reference, cl.id AS client_id, cl.name AS client_name, c.system_description,
            COALESCE(mf.label, c.maintenance_frequency) AS frequency, se.name AS engineer,
            COALESCE(sum(v.visit_amount), 0)::numeric(16,3)::text AS total_value,
            json_agg(json_build_object(
              'id', v.id::text, 'serviceCode', v.service_code, 'sequenceNo', v.sequence_no,
              'scheduledDate', v.scheduled_date::text, 'status', v.status, 'visitValue', v.visit_amount::text,
              'manualInvoiceNo', v.manual_invoice_no,
              'invoiceNumbers', COALESCE((
                SELECT json_agg(i.invoice_number ORDER BY i.invoice_date, i.id)
                FROM invoice_allocations al JOIN invoices i ON i.id = al.invoice_id
                WHERE al.amc_visit_id = v.id AND i.status <> 'CANCELLED'), '[]'::json)
            ) ORDER BY v.scheduled_date, v.sequence_no) AS services
     ${FROM}
     LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
     LEFT JOIN sales_engineers se ON se.id = c.sales_engineer_id
     WHERE ${where}
     GROUP BY c.id, ${referenceSql("c", storedReference)}, cl.id, cl.name, c.system_description, mf.label, c.maintenance_frequency, se.name
     ORDER BY lower(cl.name), c.id
     ${limit === null ? "" : `LIMIT ${limit} OFFSET ${offset}`}`,
    params
  );
  const figure = totals.rows[0];

  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      reference: row.reference,
      client: { id: row.client_id, name: row.client_name },
      systemDescription: row.system_description,
      frequency: row.frequency,
      salesEngineer: row.engineer,
      services: row.services,
      totalValue: row.total_value,
    })),
    totals: { contracts: figure?.contracts ?? 0, services: figure?.services ?? 0, completed: figure?.completed ?? 0, totalValue: figure?.total_value ?? "0.000" },
  };
}

export async function getMonthlySchedule(query: z.infer<typeof monthlyScheduleSchema>) {
  const { page, pageSize, ...rest } = query;
  const { items, totals } = await load(rest, pageSize, (page - 1) * pageSize);

  return { items, total: totals.contracts, page, pageSize, totals };
}

const COLUMNS: ReportColumn[] = [
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 28, wrap: true },
  { key: "system", header: "System", kind: "text", width: 18, wrap: true },
  { key: "frequency", header: "Frequency", kind: "text", width: 16, wrap: true },
  { key: "engineer", header: "Sales Engineer", kind: "text", width: 18, wrap: true },
  { key: "services", header: "Services", kind: "text", width: 28, wrap: true },
  { key: "invoices", header: "Invoice No.", kind: "identifier", width: 18, wrap: true },
  { key: "paid", header: "Paid / Unpaid", kind: "text", width: 14, wrap: true },
  { key: "zoho", header: "Zoho Invoice", kind: "identifier", width: 16, wrap: true },
  { key: "value", header: "Value (Ex VAT)", kind: "money", width: 14 },
];

/** The chosen filters in words. Names are read from the database, never taken from the request. */
async function describeFilters(query: MonthlyFilters): Promise<ReportDefinition["filters"]> {
  const found: ReportDefinition["filters"] = [];
  const nameOf = async (table: "clients" | "sales_engineers", id: string, unknown: string) =>
    (await pool.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? unknown;

  if (query.clientId) found.push({ label: "Client", value: await nameOf("clients", query.clientId, "Unknown client") });
  if (query.salesEngineerId) found.push({ label: "Sales Engineer", value: await nameOf("sales_engineers", query.salesEngineerId, "Unknown sales engineer") });
  if (query.system) found.push({ label: "System", value: query.system });
  if (query.search) found.push({ label: "Search", value: query.search });

  return found;
}

export async function buildMonthlyScheduleExport(auth: AuthContext, query: z.infer<typeof exportMonthlyScheduleSchema>) {
  const { format, ...rest } = query;
  const { items, totals } = await load(rest, null, 0);

  assertExportSize(format, items.length);

  const report: ReportDefinition = {
    title: "Consolidated Monthly Schedule",
    period: query.month,
    filters: await describeFilters(rest),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "amc-monthly-schedule",
    tables: [
      {
        name: "Monthly Schedule",
        columns: COLUMNS,
        rows: items.map((item) => ({
          reference: item.reference,
          client: item.client.name,
          system: item.systemDescription,
          frequency: item.frequency,
          engineer: item.salesEngineer,
          services: item.services.map((service) => `${service.serviceCode ?? `No. ${service.sequenceNo}`} (${service.manualInvoiceNo ? "Paid" : "Unpaid"})`).join(", "),
          // One number may cover several services.
          invoices: [...new Set(item.services.flatMap((service) => (service.manualInvoiceNo ? [service.manualInvoiceNo] : [])))].join(", ") || null,
          paid: `${item.services.filter((service) => service.manualInvoiceNo).length} Paid, ${item.services.filter((service) => !service.manualInvoiceNo).length} Unpaid`,
          zoho: item.services.flatMap((service) => service.invoiceNumbers).join(", ") || null,
          value: item.totalValue,
        })),
        totals: { label: `Total (${totals.contracts} contracts, ${totals.services} services)`, values: { value: totals.totalValue } },
        notes: [PAID_STATUS_NOTE, "A Zoho Invoice number shows that an invoice was recorded in Invoice Tracking; it does not decide Paid or Unpaid."],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "amc_schedule.exported",
      module: "AMC_SCHEDULE",
      entityType: "amc_visits",
      entityId: null,
      description: `Exported the consolidated monthly schedule for ${query.month} as ${format === "xlsx" ? "Excel" : "PDF"}.`,
      metadata: { format, filters: rest, rowCount: items.length },
    });

  return { report, recordExport };
}
