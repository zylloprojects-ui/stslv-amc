import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { BUSINESS_TIME_ZONE } from "../../shared/business-date";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import { findContractReference } from "../amc/contract-reference";
import type { AuthContext } from "../auth/access";
import type { AcknowledgementColumn, ExportAcknowledgementsQuery } from "./invoice-acknowledgements.schemas";
import { ACKNOWLEDGEMENT_NOTE, listAllAcknowledgements, type AcknowledgementItem } from "./invoice-acknowledgements.service";

// Invoice Acknowledgements as a report: the invoices the page lists for the same filters, with only the columns the
// page shows. Amounts appear only for a role that may view Accounts (the source of the amounts). Nothing is calculated here.

const STATUS_LABELS = { PENDING: "Pending", ACKNOWLEDGED: "Acknowledged" } as const;
const DATE_BASIS_LABELS = { INVOICE_DATE: "Invoice date", ACKNOWLEDGED_DATE: "Acknowledged date" } as const;

/** Every column in page order. `hideable` names the page column that hides it; `amount` columns need Accounts view. */
const COLUMNS: (ReportColumn & { hideable?: AcknowledgementColumn; amount?: true })[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "reference", header: "AMC Contract", kind: "identifier", width: 16 },
  { key: "client", header: "Client", kind: "text", width: 26, wrap: true, hideable: "client" },
  { key: "service", header: "Service", kind: "text", width: 14, hideable: "service" },
  { key: "invoiceNo", header: "Invoice No.", kind: "identifier", width: 16 },
  { key: "invoiceDate", header: "Invoice Date (Zoho)", kind: "date", width: 13, hideable: "invoiceDate" },
  { key: "serviceValue", header: "Service Value (Ex VAT, OMR)", kind: "money", width: 14, hideable: "serviceValue", amount: true },
  { key: "invoiceValue", header: "Zoho Invoice Value (Ex VAT, OMR)", kind: "money", width: 15, hideable: "invoiceValue", amount: true },
  { key: "serviceReportNo", header: "Service Report No.", kind: "identifier", width: 16, hideable: "serviceReportNo" },
  { key: "status", header: "Acknowledgement Status", kind: "text", width: 15 },
  { key: "acknowledgedAt", header: "Acknowledged (Oman time)", kind: "text", width: 18, hideable: "acknowledgedAt" },
  { key: "uploadedBy", header: "Uploaded By", kind: "text", width: 18, wrap: true, hideable: "uploadedBy" },
  { key: "document", header: "Document", kind: "text", width: 24, wrap: true, hideable: "document" },
];

export function acknowledgementColumns(hidden: readonly AcknowledgementColumn[], amountsVisible: boolean): ReportColumn[] {
  return COLUMNS.filter((column) => (!column.hideable || !hidden.includes(column.hideable)) && (!column.amount || amountsVisible)).map(
    ({ hideable: _hideable, amount: _amount, ...column }) => column
  );
}

const OMAN_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TIME_ZONE, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function serviceLabel(service: AcknowledgementItem["service"]): string {
  return service.serviceCode && service.cycleNo ? `Year ${service.cycleNo} · ${service.serviceCode}` : `No. ${service.sequenceNo}`;
}

function toRow(item: AcknowledgementItem, index: number): ReportRow {
  return {
    number: index + 1,
    reference: item.reference,
    client: item.client.name,
    service: serviceLabel(item.service),
    invoiceNo: item.invoiceNo,
    invoiceDate: item.invoiceDate,
    serviceValue: item.serviceValue,
    invoiceValue: item.invoiceValue,
    serviceReportNo: item.serviceReportNo,
    status: item.document && item.status === "PENDING" ? "Pending (document attached, not confirmed)" : STATUS_LABELS[item.status],
    acknowledgedAt: item.acknowledgedAt ? OMAN_TIME.format(new Date(item.acknowledgedAt)) : null,
    uploadedBy: item.document?.uploadedBy.fullName ?? null,
    document: item.document?.originalName ?? null,
  };
}

async function describeFilters(query: ExportAcknowledgementsQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];

  if (query.clientId) {
    const name = (await pool.query<{ name: string }>("SELECT name FROM clients WHERE id = $1", [query.clientId])).rows[0]?.name;
    filters.push({ label: "Client", value: name ?? "Unknown client" });
  }
  if (query.contractId) filters.push({ label: "AMC Contract", value: (await findContractReference(query.contractId)) ?? "Unknown contract" });
  if (query.invoiceNo) filters.push({ label: "Invoice No.", value: query.invoiceNo });
  if (query.status) filters.push({ label: "Acknowledgement", value: STATUS_LABELS[query.status] });
  if (query.fromDate || query.toDate) {
    filters.push({ label: DATE_BASIS_LABELS[query.dateBasis], value: `${query.fromDate ?? "…"} to ${query.toDate ?? "…"}` });
  }
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildAcknowledgementsExport(
  auth: AuthContext,
  query: ExportAcknowledgementsQuery,
  amountsVisible: boolean
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden, ...filters } = query;
  const { items, kpis } = await listAllAcknowledgements(filters, amountsVisible, (count) => assertExportSize(format, count));
  const notes = [
    `Invoices ${kpis.total} · Pending ${kpis.pending} (document attached, awaiting confirmation: ${kpis.awaitingConfirmation}) · Acknowledged ${kpis.acknowledged}.`,
    ACKNOWLEDGEMENT_NOTE,
    "Invoices are the services with a manual Invoice No. on Accounts. Invoice Date and Zoho Invoice Value come from Invoice Tracking where a Zoho invoice is recorded; cancelled Zoho invoices are not used.",
  ];

  if (!amountsVisible) notes.push("Amounts are not included: your role cannot view Accounts.");

  const showsMoney = amountsVisible && !(hidden.includes("serviceValue") && hidden.includes("invoiceValue"));
  const report: ReportDefinition = {
    title: "Invoice Acknowledgements",
    period: null,
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "invoice-acknowledgements",
    tables: [
      {
        name: "Invoice Acknowledgements",
        columns: acknowledgementColumns(hidden, amountsVisible),
        rows: items.map(toRow),
        ...(showsMoney
          ? {
              totals: {
                label: `Total listed (${kpis.total} ${kpis.total === 1 ? "invoice" : "invoices"})`,
                values: {
                  ...(hidden.includes("serviceValue") ? {} : { serviceValue: kpis.serviceValueTotal ?? "0.000" }),
                  ...(hidden.includes("invoiceValue") ? {} : { invoiceValue: kpis.invoiceValueTotal ?? "0.000" }),
                },
                excelFormulas: {
                  ...(hidden.includes("serviceValue") ? {} : { serviceValue: (range: (key: string) => string) => `SUM(${range("serviceValue")})` }),
                  ...(hidden.includes("invoiceValue") ? {} : { invoiceValue: (range: (key: string) => string) => `SUM(${range("invoiceValue")})` }),
                },
              },
            }
          : {}),
        notes,
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "invoice_acknowledgements.exported",
      module: "INVOICE_ACKNOWLEDGEMENTS",
      entityType: "invoice_acknowledgements",
      entityId: null,
      description: `Exported Invoice Acknowledgements as ${format === "xlsx" ? "Excel" : "PDF"} (${kpis.total} ${kpis.total === 1 ? "invoice" : "invoices"}).`,
      metadata: { format, filters, hidden, rowCount: kpis.total, amountsIncluded: amountsVisible },
    });

  return { report, recordExport };
}
