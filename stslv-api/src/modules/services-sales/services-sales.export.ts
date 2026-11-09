import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayMoney, displayMonth, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ExportServicesSalesQuery, SalesStatus, ServicesSalesColumn, ServiceStatus } from "./services-sales.schemas";
import { listAllServicesSales, servicesSalesAccess, type ServicesSalesItem } from "./services-sales.service";

// Services Sales as a report: the visits the page lists for the same filters,
// with the same card figures, and only the columns the page shows. Nothing is calculated here.

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

/** Every column in page order. `hideable` names the page column that hides it. */
const COLUMNS: (ReportColumn & { hideable?: ServicesSalesColumn })[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 28, wrap: true, hideable: "client" },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true, hideable: "system" },
  { key: "frequency", header: "Frequency", kind: "text", width: 14, hideable: "frequency" },
  { key: "service", header: "Service", kind: "text", width: 14, hideable: "service" },
  { key: "scheduledDate", header: "Due date", kind: "date", width: 13, hideable: "dueDate" },
  { key: "serviceStatus", header: "Service status", kind: "text", width: 15, hideable: "serviceStatus" },
  { key: "completedDate", header: "Completed date", kind: "date", width: 13, excelOnly: true, hideable: "serviceStatus" },
  { key: "serviceReportNo", header: "Service Report No.", kind: "identifier", width: 16, hideable: "serviceReportNo" },
  { key: "quotationNo", header: "Quote No.", kind: "identifier", width: 16, hideable: "quotation" },
  { key: "salesStatus", header: "Sales status", kind: "text", width: 24 },
  { key: "salesEngineer", header: "Sales Engineer", kind: "text", width: 20, wrap: true, hideable: "salesEngineer" },
  // The contract period's AMC Value / Year, repeated on each of its services, so never totalled as a column: the
  // unique-contract total is in the notes. Only for a user with AMC Contracts: View.
  { key: "amcValue", header: "AMC Value / Year (OMR)", kind: "money", width: 16, hideable: "amcValue" },
];

/** The report's columns: everything the page shows. AMC Reference and the sales status are always included. */
export function servicesSalesColumns(hidden: readonly ServicesSalesColumn[], amcValue = false): ReportColumn[] {
  return COLUMNS.filter((column) => (column.key !== "amcValue" || amcValue) && (!column.hideable || !hidden.includes(column.hideable))).map(
    ({ hideable: _hideable, ...column }) => column
  );
}

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
    serviceReportNo: item.serviceReportNo,
    quotationNo: item.quotationNo,
    salesStatus: item.quotationBeforeCompletion ? `${SALES_STATUS_LABELS[item.salesStatus]} (quote recorded before completion)` : SALES_STATUS_LABELS[item.salesStatus],
    salesEngineer: item.salesEngineer?.name ?? null,
    amcValue: item.amcValue,
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
  if (query.quoteSubmission) filters.push({ label: "Quote", value: query.quoteSubmission === "SUBMITTED" ? "Quote Submitted" : "Not Submitted" });
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildServicesSalesExport(
  auth: AuthContext,
  query: ExportServicesSalesQuery
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden, ...filters } = query;
  const access = servicesSalesAccess(auth);
  const { items, kpis, amcValueTotal } = await listAllServicesSales(filters, (count) => assertExportSize(format, count), access);
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
  if (amcValueTotal && !hidden.includes("amcValue")) {
    notes.push(
      `Total AMC Value of matching contracts: ${displayMoney(amcValueTotal.total)} OMR excluding VAT, over ${amcValueTotal.contracts} unique contract ${
        amcValueTotal.contracts === 1 ? "period" : "periods"
      } (each counted once however many of its services match; a renewal is its own period). Not an invoice value or a payment.`
    );
  }

  const report: ReportDefinition = {
    title: "Service Sales",
    period: null,
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "service-sales",
    tables: [
      {
        name: "Service Sales",
        columns: servicesSalesColumns(hidden, access.amcValue),
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
      description: `Exported Service Sales as ${format === "xlsx" ? "Excel" : "PDF"} (${kpis.total} ${kpis.total === 1 ? "service" : "services"}).`,
      metadata: { format, filters, hidden, rowCount: kpis.total },
    });

  return { report, recordExport };
}
