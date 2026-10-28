import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayMonth, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ExportServicesSalesQuery, SalesStatus, ServiceStatus } from "./services-sales.schemas";
import { listAllServicesSales, type ServicesSalesItem } from "./services-sales.service";

// Services Sales as a report: the visits the page lists for the same filters,
// with the same card figures. Nothing is calculated here.

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  NOT_COMPLETED: "Not Completed",
  COMPLETED: "Completed",
};

export const SALES_STATUS_LABELS: Record<SalesStatus, string> = {
  NOT_COMPLETED: "Not Completed",
  QUOTE_PENDING: "Completed / Quote Pending",
  QUOTED: "Quoted",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const SERVICES_SALES_COLUMNS: ReportColumn[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 28, wrap: true },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true },
  { key: "frequency", header: "Frequency", kind: "text", width: 14 },
  { key: "service", header: "Service", kind: "text", width: 14 },
  { key: "scheduledDate", header: "Due date", kind: "date", width: 13 },
  { key: "serviceStatus", header: "Service status", kind: "text", width: 15 },
  { key: "completedDate", header: "Completed date", kind: "date", width: 13, excelOnly: true },
  { key: "quotationNo", header: "Quote No.", kind: "identifier", width: 16 },
  { key: "salesStatus", header: "Sales status", kind: "text", width: 24 },
  { key: "salesEngineer", header: "Sales Engineer", kind: "text", width: 20, wrap: true },
];

/** "Year 2 · Q3", or the visit number on a visit generated before service codes existed. */
export function serviceLabel(service: ServicesSalesItem["service"]): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `No. ${service.sequenceNo}`;
}

function toRow(item: ServicesSalesItem, index: number): ReportRow {
  return {
    number: index + 1,
    reference: item.reference,
    client: item.client.name,
    system: item.system.typeName ? `${item.system.typeName} · ${item.system.description}` : item.system.description,
    frequency: item.frequency.label,
    service: serviceLabel(item.service),
    scheduledDate: item.scheduledDate,
    serviceStatus: SERVICE_STATUS_LABELS[item.serviceStatus],
    completedDate: item.completedDate,
    quotationNo: item.quotationNo,
    salesStatus: item.quotationBeforeCompletion ? `${SALES_STATUS_LABELS[item.salesStatus]} (quote recorded before completion)` : SALES_STATUS_LABELS[item.salesStatus],
    salesEngineer: item.salesEngineer?.name ?? null,
  };
}

/** The filters in words, for the head of the report. Names are read from the database, never taken from the request. */
async function describeFilters(query: ExportServicesSalesQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];
  const nameOf = async (table: "clients" | "sales_engineers" | "system_types", id: string, unknown: string) =>
    (await pool.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? unknown;

  if (query.clientId) filters.push({ label: "Client", value: await nameOf("clients", query.clientId, "Unknown client") });
  if (query.salesEngineerId) filters.push({ label: "Sales Engineer", value: await nameOf("sales_engineers", query.salesEngineerId, "Unknown sales engineer") });
  if (query.systemTypeId) filters.push({ label: "System", value: await nameOf("system_types", query.systemTypeId, "Unknown system type") });
  if (query.frequency) {
    const frequency = await pool.query<{ label: string }>("SELECT label FROM maintenance_frequencies WHERE code = $1", [query.frequency]);
    filters.push({ label: "Frequency", value: frequency.rows[0]?.label ?? query.frequency });
  }
  if (query.month) filters.push({ label: "Month", value: MONTH_NAMES[query.month - 1] ?? String(query.month) });
  if (query.year) filters.push({ label: "Year", value: String(query.year) });
  if (query.serviceStatus) filters.push({ label: "Service status", value: SERVICE_STATUS_LABELS[query.serviceStatus] });
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildServicesSalesExport(
  auth: AuthContext,
  query: ExportServicesSalesQuery
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, ...filters } = query;
  const { items, kpis } = await listAllServicesSales(filters, (count) => assertExportSize(format, count));
  const notes = [
    `Total services ${kpis.total} · Not Completed ${kpis.notCompleted} · Completed / Quote Pending ${kpis.quotePending} · Quoted ${kpis.quoted}.`,
    "A service counts as quoted only when it is completed and has a quotation number. An empty Quote No. means none is recorded.",
  ];

  if (kpis.quotationBeforeCompletion > 0) {
    notes.push(
      `${kpis.quotationBeforeCompletion} ${kpis.quotationBeforeCompletion === 1 ? "service has" : "services have"} a quotation number but ${
        kpis.quotationBeforeCompletion === 1 ? "is" : "are"
      } not completed; counted as Not Completed.`
    );
  }

  const report: ReportDefinition = {
    title: "Services Sales",
    period: null,
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "services-sales",
    tables: [
      {
        name: "Services Sales",
        columns: SERVICES_SALES_COLUMNS,
        rows: items.map(toRow),
        groupBy: (row) => displayMonth(String(row.scheduledDate)),
        notes,
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "services_sales.exported",
      module: "SERVICES_SALES",
      entityType: "amc_visits",
      entityId: null,
      description: `Exported Services Sales as ${format === "xlsx" ? "Excel" : "PDF"} (${kpis.total} ${kpis.total === 1 ? "service" : "services"}).`,
      metadata: { format, filters, rowCount: kpis.total },
    });

  return { report, recordExport };
}
