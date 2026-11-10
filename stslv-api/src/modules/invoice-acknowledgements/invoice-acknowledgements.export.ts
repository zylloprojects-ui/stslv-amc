import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { BUSINESS_TIME_ZONE } from "../../shared/business-date";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import { findContractReference } from "../amc/contract-reference";
import type { AuthContext } from "../auth/access";
import type { AcknowledgementColumn, ExportAcknowledgementsQuery } from "./invoice-acknowledgements.schemas";
import { ACKNOWLEDGEMENT_NOTE, listAllAcknowledgements, type AcknowledgementItem } from "./invoice-acknowledgements.service";

// Invoice Acknowledgements as a report: one row per invoice, as the page lists them for the same filters, with only
// the columns the page shows. Amounts only for a role that may view Accounts. Totals are PostgreSQL's, each invoice once.

const STATUS_LABELS = { PENDING: "Pending", ACKNOWLEDGED: "Acknowledged" } as const;
const DATE_BASIS_LABELS = { INVOICE_DATE: "Invoice date", ACKNOWLEDGED_DATE: "Acknowledged date" } as const;

const COLUMNS: (ReportColumn & { hideable?: AcknowledgementColumn; amount?: true })[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "invoiceNo", header: "Invoice No.", kind: "identifier", width: 16 },
  { key: "client", header: "Client", kind: "text", width: 24, wrap: true, hideable: "client" },
  { key: "contract", header: "AMC Contract / Version", kind: "identifier", width: 20, wrap: true, hideable: "contract" },
  { key: "invoiceDate", header: "Invoice Date", kind: "date", width: 13, hideable: "invoiceDate" },
  { key: "invoiceValue", header: "Invoice Value (Ex VAT, OMR)", kind: "money", width: 15, hideable: "invoiceValue", amount: true },
  { key: "serviceValue", header: "Service Value (Ex VAT, OMR)", kind: "money", width: 15, hideable: "serviceValue", amount: true },
  { key: "services", header: "Linked Services", kind: "count", width: 10, hideable: "services" },
  { key: "status", header: "Acknowledgement Status", kind: "text", width: 18 },
  { key: "acknowledgedAt", header: "Acknowledged (Oman time)", kind: "text", width: 18, hideable: "acknowledgedAt" },
  { key: "acknowledgedBy", header: "Acknowledged By", kind: "text", width: 18, wrap: true, hideable: "acknowledgedBy" },
  { key: "uploadedBy", header: "Uploaded By", kind: "text", width: 18, wrap: true, hideable: "uploadedBy" },
  { key: "document", header: "Document", kind: "text", width: 24, wrap: true, hideable: "document" },
];

export function acknowledgementColumns(hidden: readonly AcknowledgementColumn[], amountsVisible: boolean): ReportColumn[] {
  return COLUMNS.filter((column) => (!column.hideable || !hidden.includes(column.hideable)) && (!column.amount || amountsVisible)).map(
    ({ hideable: _hideable, amount: _amount, ...column }) => column
  );
}

const OMAN_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TIME_ZONE, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function statusText(item: AcknowledgementItem): string {
  if (item.reconciliation.length > 0) return `${STATUS_LABELS[item.status]} (needs reconciliation)`;
  if (item.document && item.status === "PENDING") return "Pending (document attached, not confirmed)";
  return STATUS_LABELS[item.status];
}

function toRow(item: AcknowledgementItem, index: number): ReportRow {
  return {
    number: index + 1,
    invoiceNo: item.invoiceNo,
    client: item.client.name,
    contract: item.contracts.map((contract) => contract.reference).join(", "),
    invoiceDate: item.invoiceDate,
    invoiceValue: item.invoiceValue,
    serviceValue: item.serviceValue,
    services: item.serviceCount,
    status: statusText(item),
    acknowledgedAt: item.acknowledgedAt ? OMAN_TIME.format(new Date(item.acknowledgedAt)) : null,
    acknowledgedBy: item.acknowledgedBy?.fullName ?? null,
    uploadedBy: item.document?.uploadedBy.fullName ?? null,
    document: item.document?.originalName ?? null,
  };
}

async function describeFilters(query: ExportAcknowledgementsQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];

  if (query.clientId) {
    const name = (await pool.query<{ name: string }>("SELECT name FROM clients_all WHERE id = $1", [query.clientId])).rows[0]?.name;
    filters.push({ label: "Client", value: name ?? "Unknown client" });
  }
  if (query.contractId) filters.push({ label: "AMC Contract", value: (await findContractReference(query.contractId)) ?? "Unknown contract" });
  if (query.invoiceNo) filters.push({ label: "Invoice No.", value: query.invoiceNo });
  if (query.status) filters.push({ label: "Acknowledgement", value: STATUS_LABELS[query.status] });
  if (query.reconciliation) filters.push({ label: "Reconciliation", value: "Needed" });
  if (query.fromDate || query.toDate) filters.push({ label: DATE_BASIS_LABELS[query.dateBasis], value: `${query.fromDate ?? "…"} to ${query.toDate ?? "…"}` });
  if (query.search) filters.push({ label: "Search", value: query.search });

  return filters;
}

export async function buildAcknowledgementsExport(
  auth: AuthContext,
  query: ExportAcknowledgementsQuery,
  amountsVisible: boolean
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, hidden, ...filters } = query;
  const { items, kpis } = await listAllAcknowledgements(filters, amountsVisible, (count) => assertExportSize(format, count));
  const notes = [
    `Invoices ${kpis.total} · Pending ${kpis.pending} (document attached, awaiting confirmation: ${kpis.awaitingConfirmation}) · Acknowledged ${kpis.acknowledged} · Needs reconciliation ${kpis.needsReconciliation}.`,
    ACKNOWLEDGEMENT_NOTE,
    "One row per invoice. An invoice may cover several services. Invoice Date and Invoice Value come from Invoice Tracking where a record exists (each invoice counted once); cancelled records are not used.",
  ];

  if (!amountsVisible) notes.push("Amounts are not included: your role cannot view Accounts.");

  const moneyKeys = (["invoiceValue", "serviceValue"] as const).filter((key) => amountsVisible && !hidden.includes(key));
  const totals = { invoiceValue: kpis.invoiceValueTotal ?? "0.000", serviceValue: kpis.serviceValueTotal ?? "0.000" };
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
        ...(moneyKeys.length > 0
          ? {
              totals: {
                label: `Total listed (${kpis.total} ${kpis.total === 1 ? "invoice" : "invoices"})`,
                values: Object.fromEntries(moneyKeys.map((key) => [key, totals[key]])),
                excelFormulas: Object.fromEntries(moneyKeys.map((key) => [key, (range: (key: string) => string) => `SUM(${range(key)})`])),
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
