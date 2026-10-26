import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { forbidden } from "../../shared/errors";
import {
  assertExportSize,
  displayDate,
  displayMoney,
  displayPeriod,
  displayToday,
  type ExportFormat,
  type ReportColumn,
  type ReportDefinition,
  type ReportRow,
  type ReportTable,
} from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import type { InvoiceState } from "../projects/projects.schemas";
import type { ExportBillableQuery, ExportInvoicesQuery, InvoiceStatus } from "./invoices.schemas";
import { listAllInvoices, listBillableWork, type Invoice, type InvoiceAllocation } from "./invoices.service";

// Invoice Tracking as reports. Both are records of what this system tracks:
// invoices are raised in Zoho, and nothing here is, or looks like, a tax
// invoice. Every figure comes from the recorded invoices or from the work
// records; nothing is calculated here and nothing missing is filled in.

/** Printed on every page of every invoice-related report. */
export const TRACKING_DISCLAIMER = "Internal tracking report. Not an official tax invoice.";

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = { ISSUED: "Issued", CANCELLED: "Cancelled" };

const NOT_CANCELLED = `"<>${INVOICE_STATUS_LABELS.CANCELLED}"`;

type RecordExport = () => Promise<void>;

// ---------------------------------------------------------------------------
// Invoices recorded
// ---------------------------------------------------------------------------

export const INVOICE_COLUMNS: ReportColumn[] = [
  { key: "invoiceNumber", header: "Invoice no.", kind: "identifier", width: 18 },
  { key: "invoiceDate", header: "Invoice date", kind: "date", width: 15 },
  { key: "client", header: "Client", kind: "text", width: 24, wrap: true },
  // The PDF adds the reason under a cancelled invoice, as the screen does; the workbook has a column for it.
  { key: "covers", header: "Covers", kind: "text", width: 34, wrap: true, pdfKey: "coversWithReason" },
  { key: "amountExclVat", header: "Excl. VAT", kind: "money", width: 13 },
  { key: "vatAmount", header: "VAT", kind: "money", width: 12 },
  { key: "totalAmount", header: "Total", kind: "money", width: 13 },
  { key: "status", header: "Status", kind: "text", width: 11 },
  { key: "sourceReference", header: "Zoho reference", kind: "identifier", width: 18, excelOnly: true },
  { key: "cancellationReason", header: "Cancellation reason", kind: "text", width: 30, wrap: true, excelOnly: true },
  { key: "notes", header: "Notes", kind: "text", width: 36, wrap: true, excelOnly: true },
  { key: "recordedBy", header: "Recorded by", kind: "text", width: 20, excelOnly: true },
];

export const ALLOCATION_COLUMNS: ReportColumn[] = [
  { key: "invoiceNumber", header: "Invoice no.", kind: "identifier", width: 16 },
  { key: "invoiceDate", header: "Invoice date", kind: "date", width: 14 },
  { key: "client", header: "Client", kind: "text", width: 28, wrap: true },
  { key: "status", header: "Invoice status", kind: "text", width: 14 },
  { key: "workType", header: "Work", kind: "text", width: 11 },
  { key: "reference", header: "Job no. / System", kind: "identifier", width: 22 },
  { key: "description", header: "Description", kind: "text", width: 36, wrap: true },
  { key: "periodStart", header: "Period start", kind: "date", width: 14 },
  { key: "periodEnd", header: "Period end", kind: "date", width: 14 },
  { key: "amount", header: "Allocated excl. VAT", kind: "money", width: 18 },
];

/** What one allocation covers, in the words of the invoice list. */
function allocationLabel(allocation: InvoiceAllocation): string {
  if (allocation.amcVisit) {
    const visit = allocation.amcVisit;

    return `AMC ${visit.systemDescription} · visit ${visit.sequenceNo} (${displayDate(visit.periodStart)} to ${displayDate(visit.periodEnd)})`;
  }

  return allocation.project ? `${allocation.project.jobNumber} — ${allocation.project.description}` : "";
}

function invoiceRow(invoice: Invoice): ReportRow {
  const several = invoice.allocations.length > 1;
  const covers = invoice.allocations
    .map((allocation) => `${allocationLabel(allocation)}${several ? ` · ${displayMoney(allocation.amount)}` : ""}`)
    .join("\n");

  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    client: invoice.client.name,
    covers,
    coversWithReason: invoice.status === "CANCELLED" && invoice.cancellationReason ? `${covers}\nCancelled: ${invoice.cancellationReason}` : covers,
    amountExclVat: invoice.amountExclVat,
    vatAmount: invoice.vatAmount,
    totalAmount: invoice.totalAmount,
    status: INVOICE_STATUS_LABELS[invoice.status],
    sourceReference: invoice.sourceReference,
    cancellationReason: invoice.cancellationReason,
    notes: invoice.notes,
    recordedBy: invoice.createdBy.fullName,
  };
}

function allocationRows(invoice: Invoice): ReportRow[] {
  return invoice.allocations.map((allocation) => ({
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    client: invoice.client.name,
    status: INVOICE_STATUS_LABELS[invoice.status],
    workType: allocation.amcVisit ? "AMC visit" : "Project",
    reference: allocation.amcVisit ? allocation.amcVisit.systemDescription : (allocation.project?.jobNumber ?? null),
    description: allocation.amcVisit ? `Visit ${allocation.amcVisit.sequenceNo}` : (allocation.project?.description ?? null),
    periodStart: allocation.amcVisit?.periodStart ?? null,
    periodEnd: allocation.amcVisit?.periodEnd ?? null,
    amount: allocation.amount,
  }));
}

async function clientName(clientId: string): Promise<string> {
  const client = await pool.query<{ name: string }>("SELECT name FROM clients WHERE id = $1", [clientId]);

  return client.rows[0]?.name ?? "Unknown client";
}

/** The filters in words. Names are read from the database, never taken from the request. */
async function describeInvoiceFilters(query: ExportInvoicesQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];

  if (query.clientId) {
    filters.push({ label: "Client", value: await clientName(query.clientId) });
  }
  if (query.projectId) {
    const project = await pool.query<{ job_number: string }>("SELECT job_number FROM projects WHERE id = $1", [query.projectId]);

    filters.push({ label: "Project", value: project.rows[0]?.job_number ?? "Unknown project" });
  }
  if (query.amcVisitId) {
    const visit = await pool.query<{ name: string; system_description: string; sequence_no: number }>(
      `SELECT cl.name, c.system_description, v.sequence_no
       FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id JOIN clients cl ON cl.id = c.client_id
       WHERE v.id = $1`,
      [query.amcVisitId]
    );
    const row = visit.rows[0];

    filters.push({ label: "AMC visit", value: row ? `${row.name}, ${row.system_description}, visit ${row.sequence_no}` : "Unknown visit" });
  }
  if (query.status) {
    filters.push({ label: "Status", value: INVOICE_STATUS_LABELS[query.status] });
  }
  if (query.search) {
    filters.push({ label: "Search", value: query.search });
  }

  return filters;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const formatName = (format: ExportFormat) => (format === "xlsx" ? "Excel" : "PDF");

/** The invoices recorded, for the list's own filters, and the audit entry to write once the file has been produced. */
export async function buildInvoicesExport(
  auth: AuthContext,
  query: ExportInvoicesQuery
): Promise<{ report: ReportDefinition; recordExport: RecordExport }> {
  const { format, ...filters } = query;
  const { items, total, totals } = await listAllInvoices(filters, (count) => assertExportSize(format, count));

  const report: ReportDefinition = {
    title: "Invoice Tracking Report",
    period: displayPeriod(query.dateFrom, query.dateTo),
    filters: await describeInvoiceFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "portrait",
    disclaimer: TRACKING_DISCLAIMER,
    fileStem: "invoice-tracking",
    tables: [
      {
        name: "Invoices",
        columns: INVOICE_COLUMNS,
        rows: items.map(invoiceRow),
        totals: {
          label: `Total (${plural(total, "invoice", "invoices")})`,
          values: { amountExclVat: totals.amountExclVat, vatAmount: totals.vatAmount, totalAmount: totals.totalAmount },
          // The list's rule: a cancelled invoice is listed but never counted.
          excelFormulas: {
            amountExclVat: (range) => `SUMIFS(${range("amountExclVat")},${range("status")},${NOT_CANCELLED})`,
            vatAmount: (range) => `SUMIFS(${range("vatAmount")},${range("status")},${NOT_CANCELLED})`,
            totalAmount: (range) => `SUMIFS(${range("totalAmount")},${range("status")},${NOT_CANCELLED})`,
          },
        },
        notes: ["Totals exclude cancelled invoices. Invoices are raised in Zoho; this report lists the invoice details recorded in the system."],
      },
      {
        // One line per visit or project an invoice covers. The allocations of an
        // invoice add up exactly to its amount excluding VAT (enforced when it is
        // recorded), so their total is the invoices' own total excluding VAT.
        name: "Allocations",
        excelOnly: true,
        columns: ALLOCATION_COLUMNS,
        rows: items.flatMap(allocationRows),
        totals: {
          label: "Total allocated",
          values: { amount: totals.amountExclVat },
          excelFormulas: { amount: (range) => `SUMIFS(${range("amount")},${range("status")},${NOT_CANCELLED})` },
        },
        notes: ["Each line is the part of an invoice's amount excluding VAT that covers one AMC visit or project. The total excludes cancelled invoices."],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "invoices.exported",
      module: "INVOICES",
      entityType: "invoices",
      entityId: null,
      description: `Exported the invoice tracking report as ${formatName(format)} (${plural(total, "invoice", "invoices")}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}

// ---------------------------------------------------------------------------
// Pending invoices: completed work that no invoice covers yet
// ---------------------------------------------------------------------------

export const PENDING_VISIT_COLUMNS: ReportColumn[] = [
  { key: "client", header: "Client", kind: "text", width: 30, wrap: true },
  { key: "system", header: "System", kind: "text", width: 22, wrap: true },
  { key: "sequenceNo", header: "Visit no.", kind: "count", width: 9 },
  { key: "periodStart", header: "Period start", kind: "date", width: 14 },
  { key: "periodEnd", header: "Period end", kind: "date", width: 14 },
  { key: "completedDate", header: "Completed", kind: "date", width: 14 },
  { key: "visitAmount", header: "Visit amount", kind: "money", width: 15 },
];

export const PENDING_PROJECT_COLUMNS: ReportColumn[] = [
  { key: "jobNumber", header: "Job number", kind: "identifier", width: 15 },
  { key: "client", header: "Client", kind: "text", width: 26, wrap: true },
  { key: "description", header: "Description", kind: "text", width: 32, wrap: true },
  { key: "completedDate", header: "Completed", kind: "date", width: 14 },
  { key: "jobValue", header: "Job value", kind: "money", width: 14 },
  { key: "invoicedValue", header: "Invoiced", kind: "money", width: 14 },
  { key: "uninvoicedValue", header: "Not yet invoiced", kind: "money", width: 15 },
  { key: "invoicing", header: "Invoicing", kind: "text", width: 18, excelOnly: true },
];

const PENDING_STATE_LABELS: Partial<Record<InvoiceState, string>> = {
  READY_FOR_INVOICE: "Ready for invoice",
  PARTLY_INVOICED: "Partly invoiced",
};

/**
 * The work waiting for an invoice, exactly as Invoice Tracking lists it:
 * completed AMC visits with an amount that no active invoice covers, and
 * completed projects with job value that no active invoice covers yet. Work
 * that is already fully invoiced is never in it. A section the user may not
 * see on the screen is not in the file either.
 */
export async function buildPendingInvoicesExport(
  auth: AuthContext,
  query: ExportBillableQuery
): Promise<{ report: ReportDefinition; recordExport: RecordExport }> {
  const { format, clientId } = query;
  const work = await listBillableWork(auth, { clientId, includeInvoiced: "false" });

  if (work.amcVisits === null && work.projects === null) {
    throw forbidden("Work waiting for an invoice is listed for roles that may also view the AMC Schedule or Projects.");
  }

  const rowCount = (work.amcVisits?.items.length ?? 0) + (work.projects?.items.length ?? 0);
  const tables: ReportTable[] = [];

  assertExportSize(format, rowCount);

  if (work.amcVisits) {
    tables.push({
      name: "AMC visits",
      columns: PENDING_VISIT_COLUMNS,
      rows: work.amcVisits.items.map((visit) => ({
        client: visit.client.name,
        system: visit.systemDescription,
        sequenceNo: visit.sequenceNo,
        periodStart: visit.periodStart,
        periodEnd: visit.periodEnd,
        completedDate: visit.completedDate,
        visitAmount: visit.visitAmount,
      })),
      totals: {
        label: `Total (${plural(work.amcVisits.pendingCount, "visit", "visits")})`,
        values: { visitAmount: work.amcVisits.pendingAmount },
        excelFormulas: { visitAmount: (range) => `SUM(${range("visitAmount")})` },
      },
      notes: ["Completed AMC visits that no invoice covers yet. Visit amounts as entered."],
    });
  }
  if (work.projects) {
    tables.push({
      name: "Projects",
      columns: PENDING_PROJECT_COLUMNS,
      rows: work.projects.items.map((project) => ({
        jobNumber: project.jobNumber,
        client: project.client.name,
        description: project.description,
        completedDate: project.completedDate,
        jobValue: project.jobValue,
        invoicedValue: project.invoicedValue,
        uninvoicedValue: project.uninvoicedValue,
        invoicing: PENDING_STATE_LABELS[project.invoiceState] ?? null,
      })),
      totals: {
        label: `Total not yet invoiced (${plural(work.projects.pendingCount, "project", "projects")})`,
        values: { uninvoicedValue: work.projects.pendingValue },
        excelFormulas: { uninvoicedValue: (range) => `SUM(${range("uninvoicedValue")})` },
      },
      notes: ["Completed projects with job value that no invoice covers yet. Values exclude VAT."],
    });
  }

  const generatedAt = new Date();
  const report: ReportDefinition = {
    title: "Pending Invoices Report",
    period: `As at ${displayToday(generatedAt)}`,
    filters: clientId ? [{ label: "Client", value: await clientName(clientId) }] : [],
    generatedAt,
    generatedBy: auth.user.fullName,
    orientation: "portrait",
    disclaimer: TRACKING_DISCLAIMER,
    fileStem: "pending-invoices",
    tables,
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "invoices.pending_exported",
      module: "INVOICES",
      entityType: "invoices",
      entityId: null,
      description: `Exported the pending invoices report as ${formatName(format)} (${plural(rowCount, "item", "items")}).`,
      metadata: {
        format,
        filters: clientId ? { clientId } : {},
        rowCount,
        amcVisits: work.amcVisits ? work.amcVisits.items.length : null,
        projects: work.projects ? work.projects.items.length : null,
      },
    });

  return { report, recordExport };
}
