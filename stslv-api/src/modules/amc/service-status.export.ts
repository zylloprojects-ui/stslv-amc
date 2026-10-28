import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayMonth, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ServiceStatus } from "./amc.constants";
import type { ExportServiceStatusQuery } from "./amc.schemas";
import { listAllServiceStatus, type ServiceStatusItem } from "./service-status.service";

// The Service Status page as a report: every visit that matches the page's
// filters (all pages, not only the one shown), with the same values. Nothing
// here is calculated; the counts are the page's own card figures.

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  NOT_COMPLETED: "Not Completed",
  COMPLETED: "Completed",
  WAITING_FOR_RENEWAL: "Waiting for Renewal",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Year 2 · Q3" for a visit labelled at generation, otherwise "Visit 7". */
export function serviceLabel(service: ServiceStatusItem["service"]): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `Visit ${service.sequenceNo}`;
}

function columns(reportNumber: boolean): ReportColumn[] {
  return [
    { key: "number", header: "#", kind: "count", width: 6 },
    { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
    { key: "client", header: "Client", kind: "text", width: 28, wrap: true },
    { key: "system", header: "System", kind: "text", width: 20, wrap: true },
    { key: "frequency", header: "Frequency", kind: "text", width: 14, wrap: true },
    { key: "service", header: "Service", kind: "text", width: 14 },
    { key: "scheduledMonth", header: "Scheduled month", kind: "text", width: 15, excelOnly: true },
    { key: "dueDate", header: "Due date", kind: "date", width: 13 },
    { key: "serviceStatus", header: "Service status", kind: "text", width: 18 },
    { key: "completedDate", header: "Completed date", kind: "date", width: 14 },
    { key: "salesEngineer", header: "Sales engineer", kind: "text", width: 20, wrap: true },
    ...(reportNumber ? [{ key: "reportNumber", header: "Service report no.", kind: "identifier", width: 18 } satisfies ReportColumn] : []),
  ];
}

function toRow(item: ServiceStatusItem, index: number): ReportRow {
  return {
    number: index + 1,
    reference: item.reference,
    client: item.client.name,
    system: item.system.typeName ? `${item.system.typeName} (${item.system.description})` : item.system.description,
    frequency: item.frequency.label,
    service: serviceLabel(item.service),
    scheduledMonth: displayMonth(item.scheduledDate),
    dueDate: item.scheduledDate,
    serviceStatus: SERVICE_STATUS_LABELS[item.serviceStatus],
    completedDate: item.completedDate,
    salesEngineer: item.salesEngineer?.name ?? null,
    reportNumber: item.reportNumber,
  };
}

/** The filters in words. Names are read from the database, never taken from the request. */
async function describeFilters(query: ExportServiceStatusQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];
  const nameOf = async (sql: string, id: string, fallback: string) => (await pool.query<{ name: string }>(sql, [id])).rows[0]?.name ?? fallback;

  if (query.clientId) filters.push({ label: "Client", value: await nameOf("SELECT name FROM clients WHERE id = $1", query.clientId, "Unknown client") });
  if (query.salesEngineerId) {
    filters.push({ label: "Sales engineer", value: await nameOf("SELECT name FROM sales_engineers WHERE id = $1", query.salesEngineerId, "Unknown engineer") });
  }
  if (query.systemTypeId) {
    filters.push({ label: "System", value: await nameOf("SELECT name FROM system_types WHERE id = $1", query.systemTypeId, "Unknown system type") });
  }
  if (query.frequency) filters.push({ label: "Frequency", value: query.frequency });
  if (query.month) filters.push({ label: "Month", value: MONTH_NAMES[query.month - 1] ?? String(query.month) });
  if (query.year) filters.push({ label: "Year", value: String(query.year) });
  if (query.serviceStatus) filters.push({ label: "Service status", value: SERVICE_STATUS_LABELS[query.serviceStatus] });
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

function period(query: ExportServiceStatusQuery): string | null {
  if (query.year && query.month) return `${MONTH_NAMES[query.month - 1]} ${query.year}`;
  if (query.year) return String(query.year);
  if (query.month) return `${MONTH_NAMES[query.month - 1]}, every year`;
  return null;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildServiceStatusExport(
  auth: AuthContext,
  query: ExportServiceStatusQuery
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, ...filters } = query;
  const { items, total, kpis, features } = await listAllServiceStatus(filters, (count) => assertExportSize(format, count));
  const notes = [
    `Completed ${kpis.completed} · Not Completed ${kpis.notCompleted} · Waiting for Renewal ${kpis.waitingForRenewal} (of ${kpis.total} services matching the other filters).`,
    "Waiting for Renewal: not completed, and the contract has expired or ended without a renewal. Cancelled visits are not listed.",
  ];

  if (!features.reportNumber) notes.push("Service report numbers are not available on this database yet.");

  const report: ReportDefinition = {
    title: "Service Status",
    period: period(query),
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "service-status",
    tables: [
      {
        name: "Service Status",
        columns: columns(features.reportNumber),
        rows: items.map(toRow),
        groupBy: (row) => String(row.scheduledMonth),
        notes,
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "amc_service_status.exported",
      module: "AMC_SCHEDULE",
      entityType: "amc_visits",
      entityId: null,
      description: `Exported Service Status as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${total === 1 ? "service" : "services"}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}
