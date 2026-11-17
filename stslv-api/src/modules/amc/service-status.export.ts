import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayMoney, displayMonth, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ServiceStatus } from "./amc.constants";
import type { ExportServiceStatusQuery } from "./amc.schemas";
import type { ServiceStatusColumn } from "./service-status.schemas";
import { listAllServiceStatus, serviceStatusAccess, type ServiceStatusItem } from "./service-status.service";
import { acknowledgedLabel } from "../invoice-acknowledgements/service-acknowledgement";

// The Service Status page as a report: every visit that matches the page's
// filters (all pages, not only the one shown), with the same values and only
// the columns the page shows. Nothing here is calculated; the counts are the page's own card figures.

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

/** Every column in page order. `hideable` names the page column that hides it. */
const COLUMNS: (ReportColumn & { hideable?: ServiceStatusColumn })[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 28, wrap: true, hideable: "client" },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true, hideable: "system" },
  { key: "frequency", header: "Frequency", kind: "text", width: 14, wrap: true, hideable: "frequency" },
  { key: "service", header: "Service", kind: "text", width: 14, hideable: "service" },
  { key: "scheduledMonth", header: "Scheduled month", kind: "text", width: 15, excelOnly: true, hideable: "due" },
  { key: "dueDate", header: "Due date", kind: "date", width: 13, hideable: "due" },
  { key: "serviceStatus", header: "Service status", kind: "text", width: 18, hideable: "status" },
  { key: "completedDate", header: "Completed date", kind: "date", width: 14, hideable: "status" },
  // Client UAT 2026-11-16: CR-009 the contract's Sales Engineer; CR-010 the Service Engineer who performed the
  // service (amc_visits.sales_engineer_name, see service-engineer.ts); CR-021/CR-022 headings (amounts unchanged).
  { key: "salesEngineer", header: "Sales Engineer", kind: "text", width: 20, wrap: true, hideable: "engineer" },
  { key: "reportNumber", header: "Service report no.", kind: "identifier", width: 18, hideable: "report" },
  { key: "salesEngineerName", header: "Service Engineer", kind: "text", width: 20, wrap: true, hideable: "engineerName" },
  // The contract's AMC Value / Year on each of its services: repeated per service, so it is never totalled.
  { key: "amcValue", header: "AMC Value (ex VAT)", kind: "money", width: 16, hideable: "amcValue" },
  // 2026-11-11: this service's own value, the same visit_amount Master AMC Status shows (blank when none was
  // recorded). Same permission as AMC Value.
  { key: "serviceValue", header: "Service Value (ex VAT)", kind: "money", width: 14, hideable: "serviceValue" },
  { key: "acknowledgement", header: "Invoice Acknowledged", kind: "text", width: 18, wrap: true, hideable: "acknowledgement" },
];

/** The optional columns this export may carry: they depend on the database and on what the user may see. */
export interface ServiceStatusExportOptions {
  reportNumber: boolean;
  salesEngineerName?: boolean;
  amcValue?: boolean;
  acknowledgements?: boolean;
}

/** The report's columns: everything the page shows. AMC Reference is always included. */
export function serviceStatusColumns(options: ServiceStatusExportOptions | boolean, hidden: readonly ServiceStatusColumn[] = []): ReportColumn[] {
  const available = typeof options === "boolean" ? { reportNumber: options } : options;

  return COLUMNS.filter(
    (column) =>
      (column.key !== "reportNumber" || available.reportNumber) &&
      (column.key !== "salesEngineerName" || available.salesEngineerName === true) &&
      ((column.key !== "amcValue" && column.key !== "serviceValue") || available.amcValue === true) &&
      (column.key !== "acknowledgement" || available.acknowledgements === true) &&
      (!column.hideable || !hidden.includes(column.hideable))
  ).map(({ hideable: _hideable, ...column }) => column);
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
    salesEngineerName: item.salesEngineerName,
    amcValue: item.amcValue,
    serviceValue: item.serviceValue,
    acknowledgement: item.acknowledgement ? acknowledgedLabel(item.acknowledgement) : null,
  };
}

/** The filters in words. Names are read from the database, never taken from the request. */
async function describeFilters(query: ExportServiceStatusQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];
  const nameOf = async (sql: string, id: string, fallback: string) => (await pool.query<{ name: string }>(sql, [id])).rows[0]?.name ?? fallback;

  if (query.clientId) filters.push({ label: "Client", value: await nameOf("SELECT name FROM clients WHERE id = $1", query.clientId, "Unknown client") });
  if (query.salesEngineerId) {
    filters.push({ label: "Sales Engineer", value: await nameOf("SELECT name FROM sales_engineers WHERE id = $1", query.salesEngineerId, "Unknown engineer") });
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
  query: ExportServiceStatusQuery & { hidden?: readonly ServiceStatusColumn[] }
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden = [], ...filters } = query;
  const access = await serviceStatusAccess(auth);
  const { items, total, kpis, features, totals } = await listAllServiceStatus(filters, (count) => assertExportSize(format, count), access);
  const notes = [
    `Completed ${kpis.completed} · Not Completed ${kpis.notCompleted} · Waiting for Renewal ${kpis.waitingForRenewal} (of ${kpis.total} services matching the other filters).`,
    "Waiting for Renewal: not completed, and the contract has expired or ended without a renewal. Cancelled visits are not listed.",
  ];

  if (!features.reportNumber) notes.push("Service report numbers are not available on this database yet.");
  // CR-028: the AMC Value total counts each contract period once (summing the column would repeat it per service).
  if (totals && !hidden.includes("amcValue")) {
    notes.push(`AMC Value (ex VAT) of the matching contracts, each counted once: ${displayMoney(totals.amcValue)} (${totals.contracts} ${totals.contracts === 1 ? "contract period" : "contract periods"}).`);
  }
  if (totals && !hidden.includes("serviceValue") && totals.serviceValueMissing > 0) {
    notes.push(`${totals.serviceValueMissing} ${totals.serviceValueMissing === 1 ? "service has" : "services have"} no service value set; not included in the total.`);
  }
  const serviceValueTotal =
    totals && !hidden.includes("serviceValue")
      ? {
          totals: {
            label: `Total filtered (${totals.services} ${totals.services === 1 ? "service" : "services"})`,
            values: { serviceValue: totals.serviceValue },
            excelFormulas: { serviceValue: (range: (key: string) => string) => `SUM(${range("serviceValue")})` },
          },
        }
      : {};

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
        columns: serviceStatusColumns({ reportNumber: features.reportNumber, salesEngineerName: features.engineerName, amcValue: access.amcValue, acknowledgements: access.acknowledgements }, hidden),
        rows: items.map(toRow),
        groupBy: (row) => String(row.scheduledMonth),
        ...serviceValueTotal,
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
      metadata: { format, filters, hidden, rowCount: total },
    });

  return { report, recordExport };
}
