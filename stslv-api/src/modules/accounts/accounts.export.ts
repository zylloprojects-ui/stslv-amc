import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, displayMoney, displayMonth, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import { SERVICE_STATUS_LABELS } from "../amc/master-status.export";
import type { AuthContext } from "../auth/access";
import type { AccountsColour, AccountsColumn, ExportAccountsQuery } from "./accounts.schemas";
import { listAllAccounts, type AccountsItem } from "./accounts.service";

// Accounts as a report: the visits the page lists for the same filters, the
// same card figures, and only the columns the page shows. Nothing is calculated here.

export const ACCOUNTS_COLOUR_LABELS: Record<AccountsColour, string> = {
  RED: "Red · Service not completed",
  BLUE: "Blue · Completed, no invoice number",
  GREEN: "Green · Completed, invoice number recorded",
};

const SERVICE_FILTER_LABELS = { COMPLETED: "Completed", NOT_COMPLETED: "Not Completed" } as const;
const INVOICE_FILTER_LABELS = { RECORDED: "Invoice recorded", NOT_RECORDED: "No invoice recorded" } as const;

/** Shown wherever paid / unpaid would be: payment is not recorded in STSLV AMC. */
export const PAYMENT_NOT_AVAILABLE = "Not available";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Every column in page order. `hideable` names the page column that hides it. */
const COLUMNS: (ReportColumn & { hideable?: AccountsColumn })[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Reference", kind: "identifier", width: 13 },
  { key: "client", header: "Client", kind: "text", width: 26, wrap: true, hideable: "client" },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true, hideable: "system" },
  { key: "frequency", header: "Frequency", kind: "text", width: 13, hideable: "frequency" },
  { key: "service", header: "Service", kind: "text", width: 12, hideable: "service" },
  { key: "scheduledMonth", header: "Scheduled Month", kind: "text", width: 15, hideable: "scheduledMonth" },
  { key: "visitValue", header: "Visit Value", kind: "money", width: 14, hideable: "visitValue" },
  { key: "serviceStatus", header: "Service Status", kind: "text", width: 18, hideable: "serviceStatus" },
  { key: "serviceReportNo", header: "Service Report No.", kind: "identifier", width: 16, hideable: "serviceReportNo" },
  { key: "invoiceNo", header: "Invoice No.", kind: "identifier", width: 16, wrap: true, hideable: "invoiceNo" },
  { key: "payment", header: "Paid / Unpaid", kind: "text", width: 13, hideable: "payment" },
  { key: "salesEngineer", header: "Sales Engineer", kind: "text", width: 18, wrap: true, hideable: "salesEngineer" },
  { key: "colour", header: "Row Colour", kind: "text", width: 30 },
];

/** The report's columns: everything the page shows. AMC Reference and the row colour are always included. */
export function accountsColumns(hidden: readonly AccountsColumn[]): ReportColumn[] {
  return COLUMNS.filter((column) => !column.hideable || !hidden.includes(column.hideable)).map(({ hideable: _hideable, ...column }) => column);
}

/** "Year 2 · Q3", or the visit number on a visit generated before service codes existed. */
function serviceLabel(service: AccountsItem["service"]): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `No. ${service.sequenceNo}`;
}

function toRow(item: AccountsItem, index: number): ReportRow {
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
    serviceReportNo: item.serviceReportNo,
    invoiceNo: item.invoiceNumbers.length > 0 ? item.invoiceNumbers.join(", ") : null,
    payment: PAYMENT_NOT_AVAILABLE,
    salesEngineer: item.salesEngineer?.name ?? null,
    colour: ACCOUNTS_COLOUR_LABELS[item.colour],
  };
}

/** The filters in words, for the head of the report. Names are read from the database, never taken from the request. */
async function describeFilters(query: ExportAccountsQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];
  const nameOf = async (table: "clients" | "sales_engineers", id: string, unknown: string) =>
    (await pool.query<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id])).rows[0]?.name ?? unknown;

  if (query.clientId) filters.push({ label: "Client", value: await nameOf("clients", query.clientId, "Unknown client") });
  if (query.salesEngineerId) filters.push({ label: "Sales Engineer", value: await nameOf("sales_engineers", query.salesEngineerId, "Unknown sales engineer") });
  if (query.month) filters.push({ label: "Month", value: MONTH_NAMES[query.month - 1] ?? String(query.month) });
  if (query.year) filters.push({ label: "Year", value: String(query.year) });
  if (query.serviceStatus) filters.push({ label: "Service status", value: SERVICE_FILTER_LABELS[query.serviceStatus] });
  if (query.invoiceStatus) filters.push({ label: "Invoice", value: INVOICE_FILTER_LABELS[query.invoiceStatus] });
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildAccountsExport(auth: AuthContext, query: ExportAccountsQuery): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden, ...filters } = query;
  const { items, kpis } = await listAllAccounts(filters, (count) => assertExportSize(format, count));
  const notes = [
    `Rows ${kpis.rows} · Completed ${kpis.completed} · Not completed ${kpis.notCompleted} · Invoice no. filled ${kpis.invoiceFilled} · Total visit value ${displayMoney(kpis.totalValue)}.`,
    "Red: service not completed. Blue: completed, no invoice number recorded. Green: completed, invoice number recorded.",
    "An invoice number shows that an invoice was recorded, not that it was paid. Payment is not recorded in STSLV AMC. Cancelled invoices are not counted.",
    "Visit value is the scheduled amount of each visit; whether it includes VAT is not confirmed.",
  ];

  if (kpis.valueMissing > 0) {
    notes.push(`${kpis.valueMissing} ${kpis.valueMissing === 1 ? "service has" : "services have"} no visit value set; not included in the total.`);
  }

  const report: ReportDefinition = {
    title: "Accounts",
    period: null,
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "accounts",
    tables: [
      {
        name: "Accounts",
        columns: accountsColumns(hidden),
        rows: items.map(toRow),
        groupBy: (row) => displayMonth(String(row.scheduledDate)),
        ...(hidden.includes("visitValue")
          ? {}
          : {
              totals: {
                label: `Total visit value (${kpis.rows} ${kpis.rows === 1 ? "service" : "services"})`,
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
      action: "accounts.exported",
      module: "INVOICES",
      entityType: "amc_visits",
      entityId: null,
      description: `Exported Accounts as ${format === "xlsx" ? "Excel" : "PDF"} (${kpis.rows} ${kpis.rows === 1 ? "service" : "services"}).`,
      metadata: { format, filters, hidden, rowCount: kpis.rows },
    });

  return { report, recordExport };
}
