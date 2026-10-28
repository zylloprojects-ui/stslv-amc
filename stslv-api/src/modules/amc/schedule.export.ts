import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import {
  assertExportSize,
  displayMonth,
  displayPeriod,
  type ReportColumn,
  type ReportDefinition,
  type ReportRow,
} from "../../shared/export/report";
import { schemaHas } from "../../shared/schema-features";
import type { AuthContext } from "../auth/access";
import type { BillingStatus, InvoiceEligibility, VisitStatus } from "./amc.constants";
import type { ExportVisitsQuery } from "./amc.schemas";
import { listAllVisits, type ScheduleVisit } from "./visits.service";

// The AMC Schedule as a report: the visits the schedule screen lists for the
// same filters, with the same figures. Nothing here is calculated: every value
// comes from the visit records, and the total is the schedule's own total.

/** The words the application shows for each status. */
export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  SCHEDULED: "Scheduled",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  POSTPONED: "Postponed",
  CANCELLED: "Cancelled",
  HISTORICAL: "Historical",
};

export const INVOICE_ELIGIBILITY_LABELS: Record<InvoiceEligibility, string> = {
  NOT_COMPLETED: "Not completed",
  AMOUNT_REQUIRED: "Amount required",
  NO_INVOICE_REQUIRED: "No invoice required",
  READY_FOR_INVOICE: "Ready for invoice",
  INVOICED: "Invoiced",
  HISTORICAL: "Historical",
};

export const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  INVOICED: "Invoiced",
  NOT_YET_INVOICED: "Not yet invoiced",
  NO_INVOICE_REQUIRED: "No invoice required",
  NOT_COMPLETED: "Not completed",
  CANCELLED: "Cancelled",
};

/** The frequency's name from the frequency master (migration 0075), or its code on a database without it. */
async function frequencyLabel(code: string): Promise<string> {
  if (!(await schemaHas(["maintenance_frequencies"]))) {
    return code;
  }

  const result = await pool.query<{ label: string }>("SELECT label FROM maintenance_frequencies WHERE code = $1", [code]);

  return result.rows[0]?.label ?? code;
}

export const SCHEDULE_COLUMNS: ReportColumn[] = [
  { key: "number", header: "#", kind: "count", width: 6 },
  { key: "scheduledDate", header: "Scheduled date", kind: "date", width: 14 },
  { key: "originalScheduledDate", header: "Original date", kind: "date", width: 14, excelOnly: true },
  { key: "client", header: "Client", kind: "text", width: 30, wrap: true },
  { key: "system", header: "System", kind: "text", width: 20, wrap: true },
  { key: "sequenceNo", header: "Visit no.", kind: "count", width: 9 },
  { key: "periodStart", header: "Period start", kind: "date", width: 14 },
  { key: "periodEnd", header: "Period end", kind: "date", width: 14 },
  { key: "assignedTo", header: "Assigned to", kind: "text", width: 22, wrap: true },
  // The PDF says "Scheduled (overdue)"; the workbook keeps the status clean and has its own Overdue column to filter on.
  { key: "status", header: "Status", kind: "text", width: 17, pdfKey: "statusWithOverdue" },
  { key: "overdue", header: "Overdue", kind: "text", width: 10, excelOnly: true },
  { key: "visitAmount", header: "Amount", kind: "money", width: 14 },
  { key: "invoicing", header: "Invoicing", kind: "text", width: 19 },
  { key: "completedDate", header: "Completed date", kind: "date", width: 14 },
  { key: "notes", header: "Notes", kind: "text", width: 44, wrap: true, excelOnly: true },
];

function toRow(visit: ScheduleVisit, index: number): ReportRow {
  const status = VISIT_STATUS_LABELS[visit.status];

  return {
    number: index + 1,
    scheduledDate: visit.scheduledDate,
    originalScheduledDate: visit.originalScheduledDate,
    client: visit.client.name,
    system: visit.contract.systemDescription,
    sequenceNo: visit.sequenceNo,
    periodStart: visit.periodStart,
    periodEnd: visit.periodEnd,
    assignedTo: visit.assignedTo,
    status,
    statusWithOverdue: visit.isOverdue ? `${status} (overdue)` : status,
    overdue: visit.isOverdue ? "Yes" : "No",
    visitAmount: visit.visitAmount,
    invoicing: INVOICE_ELIGIBILITY_LABELS[visit.invoiceEligibility],
    completedDate: visit.completedDate,
    notes: visit.notes,
  };
}

/** The filters in words, for the head of the report. Names are read from the database, never taken from the request. */
async function describeFilters(query: ExportVisitsQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [];

  if (query.clientId) {
    const client = await pool.query<{ name: string }>("SELECT name FROM clients WHERE id = $1", [query.clientId]);

    filters.push({ label: "Client", value: client.rows[0]?.name ?? "Unknown client" });
  }
  if (query.contractId) {
    const contract = await pool.query<{ name: string; system_description: string }>(
      `SELECT cl.name, c.system_description
       FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
       WHERE c.id = $1`,
      [query.contractId]
    );
    const row = contract.rows[0];

    filters.push({ label: "Contract", value: row ? `${row.name}, ${row.system_description}` : "Unknown contract" });
  }
  if (query.system) {
    filters.push({ label: "System", value: query.system });
  }
  if (query.status && query.status.length > 0) {
    filters.push({ label: "Status", value: query.status.map((status) => VISIT_STATUS_LABELS[status]).join(", ") });
  }
  if (query.invoiceEligibility) {
    filters.push({ label: "Invoicing", value: INVOICE_ELIGIBILITY_LABELS[query.invoiceEligibility] });
  }
  if (query.salesEngineerId) {
    // listAllVisits has already refused this filter on a database without the link (migration 0070).
    const engineer = await pool.query<{ name: string }>("SELECT name FROM sales_engineers WHERE id = $1", [query.salesEngineerId]);

    filters.push({ label: "Sales engineer", value: engineer.rows[0]?.name ?? "Unknown sales engineer" });
  }
  if (query.frequency) {
    filters.push({ label: "Frequency", value: await frequencyLabel(query.frequency) });
  }
  if (query.billingStatus) {
    filters.push({ label: "Billing status", value: BILLING_STATUS_LABELS[query.billingStatus] });
  }
  if (query.overdue) {
    filters.push({ label: "Overdue", value: query.overdue === "true" ? "Overdue only" : "Not overdue" });
  }
  if (query.search) {
    filters.push({ label: "Search", value: query.search });
  }

  return filters;
}

/** The report, and the audit entry to write once the file has been produced. */
export async function buildScheduleExport(
  auth: AuthContext,
  query: ExportVisitsQuery
): Promise<{ report: ReportDefinition; recordExport: () => Promise<void> }> {
  const { format, ...filters } = query;
  const { items, total, totals } = await listAllVisits(filters, (count) => assertExportSize(format, count));
  const notes = ["Total amount excludes cancelled visits."];

  if (totals.amountMissingCount > 0) {
    notes.push(`${totals.amountMissingCount} ${totals.amountMissingCount === 1 ? "visit has" : "visits have"} no amount.`);
  }

  const report: ReportDefinition = {
    title: "AMC Schedule",
    period: displayPeriod(query.from, query.to),
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "amc-schedule",
    tables: [
      {
        name: "AMC Schedule",
        columns: SCHEDULE_COLUMNS,
        rows: items.map(toRow),
        groupBy: (row) => displayMonth(String(row.scheduledDate)),
        totals: {
          label: `Total amount (${total} ${total === 1 ? "visit" : "visits"})`,
          values: { visitAmount: totals.visitAmount },
          excelFormulas: {
            // The schedule's rule: cancelled visits are not counted.
            visitAmount: (range) => `SUMIFS(${range("visitAmount")},${range("status")},"<>${VISIT_STATUS_LABELS.CANCELLED}")`,
          },
        },
        notes,
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
      description: `Exported the AMC schedule as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${total === 1 ? "visit" : "visits"}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}
