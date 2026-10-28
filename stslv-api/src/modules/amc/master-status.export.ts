import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayMoney, displayMonth, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { ServiceStatus } from "./amc.constants";
import { listAllMasterStatus, type MasterStatusItem } from "./master-status.service";
import type { ExportMasterStatusQuery, MasterStatusColumn, RowColour } from "./master-status.schemas";

// Master AMC Status as a report: the visits the page lists for the same
// filters, the same card figures, and only the columns the page shows.
// Nothing is calculated here.

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  NOT_COMPLETED: "Not Completed",
  COMPLETED: "Completed",
  WAITING_FOR_RENEWAL: "Waiting for Renewal",
};

export const ROW_COLOUR_LABELS: Record<RowColour, string> = {
  RED: "Red · Not completed",
  YELLOW: "Yellow · Invoice pending",
  BLUE: "Blue · Quote pending",
  GREEN: "Green · Invoiced and quoted",
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Every column in page order. `hideable` names the page column that hides it. */
const COLUMNS: (ReportColumn & { hideable?: MasterStatusColumn })[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 26, wrap: true, hideable: "client" },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true, hideable: "system" },
  { key: "frequency", header: "Frequency", kind: "text", width: 13, hideable: "frequency" },
  { key: "service", header: "Service", kind: "text", width: 12, hideable: "service" },
  { key: "scheduledMonth", header: "Scheduled Month", kind: "text", width: 15, hideable: "scheduledMonth" },
  { key: "visitValue", header: "Visit Value", kind: "money", width: 14, hideable: "visitValue" },
  { key: "serviceStatus", header: "Service Status", kind: "text", width: 18, hideable: "serviceStatus" },
  { key: "invoiceNo", header: "Invoice No.", kind: "identifier", width: 16, wrap: true, hideable: "invoiceNo" },
  { key: "quotationNo", header: "Quote No.", kind: "identifier", width: 15, hideable: "quotationNo" },
  { key: "salesEngineer", header: "Sales Engineer", kind: "text", width: 18, wrap: true, hideable: "salesEngineer" },
  { key: "colour", header: "Row Colour", kind: "text", width: 24 },
];

/** The report's columns: everything the page shows. AMC Reference and the row colour are always included. */
export function masterStatusColumns(hidden: readonly MasterStatusColumn[]): ReportColumn[] {
  return COLUMNS.filter((column) => !column.hideable || !hidden.includes(column.hideable)).map(({ hideable: _hideable, ...column }) => column);
}

/** "Year 2 · Q3", or the visit number on a visit generated before service codes existed. */
function serviceLabel(service: MasterStatusItem["service"]): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `No. ${service.sequenceNo}`;
}

function toRow(item: MasterStatusItem, index: number): ReportRow {
  return {
    number: index + 1,
    reference: item.reference,
    client: item.client.name,
    system: item.system.typeName ? `${item.system.typeName} · ${item.system.description}` : item.system.description,
    frequency: item.frequency.label,
    service: serviceLabel(item.service),
    scheduledMonth: displayMonth(item.scheduledDate),
    // The month heading of the PDF groups; never a column.
    scheduledDate: item.scheduledDate,
    visitValue: item.visitValue,
    serviceStatus: SERVICE_STATUS_LABELS[item.serviceStatus],
    invoiceNo: item.invoiceNumbers.length > 0 ? item.invoiceNumbers.join(", ") : null,
    quotationNo: item.quotationNo,
    salesEngineer: item.salesEngineer?.name ?? null,
    colour: ROW_COLOUR_LABELS[item.colour],
  };
}

/** The filters in words, for the head of the report. Names are read from the database, never taken from the request. */
async function describeFilters(query: ExportMasterStatusQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];
  const nameOf = async (table: "clients" | "sales_engineers", id: string, unknown: string) =>
    (await pool.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? unknown;

  if (query.clientId) filters.push({ label: "Client", value: await nameOf("clients", query.clientId, "Unknown client") });
  if (query.salesEngineerId) filters.push({ label: "Sales Engineer", value: await nameOf("sales_engineers", query.salesEngineerId, "Unknown sales engineer") });
  if (query.month) filters.push({ label: "Month", value: MONTH_NAMES[query.month - 1] ?? String(query.month) });
  if (query.year) filters.push({ label: "Year", value: String(query.year) });
  if (query.serviceStatus) filters.push({ label: "Service status", value: SERVICE_STATUS_LABELS[query.serviceStatus] });
  if (query.colour) filters.push({ label: "Row colour", value: ROW_COLOUR_LABELS[query.colour] });
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildMasterStatusExport(
  auth: AuthContext,
  query: ExportMasterStatusQuery
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden, ...filters } = query;
  const { items, kpis } = await listAllMasterStatus(filters, (count) => assertExportSize(format, count));
  const columns = masterStatusColumns(hidden);
  const notes = [
    `Total services ${kpis.total} · Green ${kpis.green} · Blue ${kpis.blue} · Yellow ${kpis.yellow} · Red ${kpis.red} · Total visit value ${displayMoney(kpis.totalValue)}.`,
    "Red: not completed. Yellow: completed, no invoice recorded. Blue: completed and invoiced, no quotation number. Green: completed, invoiced and quoted.",
    "An invoice number shows that an invoice was recorded, not that it was paid. Cancelled invoices are not counted.",
  ];

  if (kpis.valueMissing > 0) {
    notes.push(`${kpis.valueMissing} ${kpis.valueMissing === 1 ? "service has" : "services have"} no visit value set; not included in the total.`);
  }

  const report: ReportDefinition = {
    title: "Master AMC Status",
    period: null,
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "master-amc-status",
    tables: [
      {
        name: "Master AMC Status",
        columns,
        rows: items.map(toRow),
        groupBy: (row) => displayMonth(String(row.scheduledDate)),
        ...(hidden.includes("visitValue")
          ? {}
          : {
              totals: {
                label: `Total visit value (${kpis.total} ${kpis.total === 1 ? "service" : "services"})`,
                values: { visitValue: kpis.totalValue },
                excelFormulas: { visitValue: (range) => `SUM(${range("visitValue")})` },
              },
            }),
        notes,
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "master_amc_status.exported",
      module: "AMC_SCHEDULE",
      entityType: "amc_visits",
      entityId: null,
      description: `Exported Master AMC Status as ${format === "xlsx" ? "Excel" : "PDF"} (${kpis.total} ${kpis.total === 1 ? "service" : "services"}).`,
      metadata: { format, filters, hidden, rowCount: kpis.total },
    });

  return { report, recordExport };
}
