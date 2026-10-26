import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SCHEDULE_COLUMNS } from "../modules/amc/schedule.export";
import {
  ALLOCATION_COLUMNS,
  INVOICE_COLUMNS,
  PENDING_PROJECT_COLUMNS,
  PENDING_VISIT_COLUMNS,
  TRACKING_DISCLAIMER,
} from "../modules/invoices/invoices.export";
import { displayDate, displayMoney, displayMonth, displayToday, exportFileName, type ReportDefinition, type ReportRow } from "../shared/export/report";
import { renderReport } from "../shared/export/send";

// Writes a sample Excel workbook and a sample PDF of each report, so the look
// of the company template can be reviewed. The reports use the columns of the
// real exports, but the data is invented here: no database is read, and no
// client, invoice, amount or person in it is real.
//
//   npm run export:sample
//
// The files go to export-samples/ in the project root, which Git ignores.

const OUTPUT = path.resolve(__dirname, "..", "..", "..", "export-samples");

const CLIENTS = ["Sample Hotel One", "Sample Hotel Two", "Sample Trading Company LLC", "Sample Hospital", "Sample Business Tower"];
const SYSTEMS = ["FIRE ALARM", "CCTV", "ACCESS CONTROL", "FIRE FIGHTING"];
const ENGINEERS = ["Sample Engineer A", "Sample Engineer B", null];
const SAMPLE_FILTER = { label: "Data", value: "SAMPLE DATA, not real records" };
const NOT_CANCELLED = '"<>Cancelled"';

const iso = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad3 = (value: number) => String(value % 1000).padStart(3, "0");

const toThousandths = (value: string): bigint => {
  const [whole = "0", fraction = ""] = value.split(".");

  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
};

function fromThousandths(value: bigint): string {
  const digits = value.toString().padStart(4, "0");

  return `${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

/** Adds amounts exactly, in thousandths, the way PostgreSQL would. */
const sum = (values: (string | null)[]): string => fromThousandths(values.reduce((total, value) => (value === null ? total : total + toThousandths(value)), 0n));

// ---------------------------------------------------------------------------
// Invoice Tracking
// ---------------------------------------------------------------------------

function sampleInvoices(): ReportDefinition {
  const invoices: ReportRow[] = [];
  const allocations: ReportRow[] = [];

  for (let index = 0; index < 46; index += 1) {
    const month = 1 + (index % 6);
    const cancelled = index % 15 === 7;
    const client = CLIENTS[index % CLIENTS.length] as string;
    const status = cancelled ? "Cancelled" : "Issued";
    const invoiceNumber = `SAMPLE-${String(index + 1).padStart(5, "0")}`;
    const invoiceDate = iso(2027, month, 3 + ((index * 5) % 24));
    const system = SYSTEMS[index % SYSTEMS.length] as string;
    const periodStart = iso(2027, month, 1);
    const periodEnd = iso(2027, month, lastDay(2027, month));
    const period = `${displayDate(periodStart)} to ${displayDate(periodEnd)}`;
    const jobNumber = `SAMPLE${String(500 + index).padStart(4, "0")}`;
    const firstAmount = `${200 + ((index * 135) % 2400)}.${pad3(index * 250)}`;
    const lines =
      index % 3 === 1
        ? [{ label: `${jobNumber} — Sample supply and installation works`, type: "Project", reference: jobNumber, description: "Sample supply and installation works", visit: false, amount: firstAmount }]
        : [{ label: `AMC ${system} · visit ${month} (${period})`, type: "AMC visit", reference: system, description: `Visit ${month}`, visit: true, amount: firstAmount }];

    if (index % 7 === 3) {
      lines.push({ label: `AMC CCTV · visit ${month} (${period})`, type: "AMC visit", reference: "CCTV", description: `Visit ${month}`, visit: true, amount: `${100 + index * 10}.500` });
    }

    const amountExclVat = sum(lines.map((line) => line.amount));
    // As copied from an invoice: sometimes none, otherwise an invented figure.
    const vatAmount = index % 5 === 0 ? "0.000" : fromThousandths(toThousandths(amountExclVat) / 20n);
    const covers = lines.map((line) => `${line.label}${lines.length > 1 ? ` · ${displayMoney(line.amount)}` : ""}`).join("\n");
    const reason = cancelled ? "Sample reason: raised twice in Zoho" : null;

    invoices.push({
      invoiceNumber,
      invoiceDate,
      client,
      covers,
      coversWithReason: reason ? `${covers}\nCancelled: ${reason}` : covers,
      amountExclVat,
      vatAmount,
      totalAmount: sum([amountExclVat, vatAmount]),
      status,
      sourceReference: index % 4 === 0 ? `ZB-${String(9000 + index).padStart(6, "0")}` : null,
      cancellationReason: reason,
      notes: index % 9 === 2 ? "Sample note recorded with the invoice." : null,
      recordedBy: "Sample User",
    });
    for (const line of lines) {
      allocations.push({
        invoiceNumber,
        invoiceDate,
        client,
        status,
        workType: line.type,
        reference: line.reference,
        description: line.description,
        periodStart: line.visit ? periodStart : null,
        periodEnd: line.visit ? periodEnd : null,
        amount: line.amount,
      });
    }
  }

  const newestFirst = (a: ReportRow, b: ReportRow) => String(b.invoiceDate).localeCompare(String(a.invoiceDate));
  const counted = invoices.filter((invoice) => invoice.status !== "Cancelled");
  const total = (key: string) => sum(counted.map((invoice) => invoice[key] as string));

  invoices.sort(newestFirst);
  allocations.sort(newestFirst);

  return {
    title: "Invoice Tracking Report",
    period: "01 Jan 2027 to 30 Jun 2027",
    filters: [SAMPLE_FILTER],
    generatedAt: new Date(),
    generatedBy: "Sample User",
    orientation: "portrait",
    disclaimer: TRACKING_DISCLAIMER,
    fileStem: "sample-invoice-tracking",
    tables: [
      {
        name: "Invoices",
        columns: INVOICE_COLUMNS,
        rows: invoices,
        totals: {
          label: `Total (${invoices.length} invoices)`,
          values: { amountExclVat: total("amountExclVat"), vatAmount: total("vatAmount"), totalAmount: total("totalAmount") },
          excelFormulas: {
            amountExclVat: (range) => `SUMIFS(${range("amountExclVat")},${range("status")},${NOT_CANCELLED})`,
            vatAmount: (range) => `SUMIFS(${range("vatAmount")},${range("status")},${NOT_CANCELLED})`,
            totalAmount: (range) => `SUMIFS(${range("totalAmount")},${range("status")},${NOT_CANCELLED})`,
          },
        },
        notes: ["Totals exclude cancelled invoices. Invoices are raised in Zoho; this report lists the invoice details recorded in the system."],
      },
      {
        name: "Allocations",
        excelOnly: true,
        columns: ALLOCATION_COLUMNS,
        rows: allocations,
        totals: {
          label: "Total allocated",
          values: { amount: total("amountExclVat") },
          excelFormulas: { amount: (range) => `SUMIFS(${range("amount")},${range("status")},${NOT_CANCELLED})` },
        },
        notes: ["Each line is the part of an invoice's amount excluding VAT that covers one AMC visit or project. The total excludes cancelled invoices."],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Pending Invoices
// ---------------------------------------------------------------------------

function samplePending(): ReportDefinition {
  const visits: ReportRow[] = Array.from({ length: 14 }, (_, index) => {
    const month = 1 + (index % 5);

    return {
      client: CLIENTS[index % CLIENTS.length] as string,
      system: SYSTEMS[index % SYSTEMS.length] as string,
      sequenceNo: month,
      periodStart: iso(2027, month, 1),
      periodEnd: iso(2027, month, lastDay(2027, month)),
      completedDate: iso(2027, month, 6 + index),
      visitAmount: `${150 + index * 45}.${pad3(index * 125)}`,
    };
  });
  const projects: ReportRow[] = Array.from({ length: 9 }, (_, index) => {
    const jobValue = `${1800 + index * 730}.${pad3(index * 250)}`;
    const partly = index % 4 === 2;
    const invoicedValue = partly ? `${600 + index * 100}.000` : "0.000";

    return {
      jobNumber: `SAMPLE${String(610 + index).padStart(4, "0")}`,
      client: CLIENTS[(index + 2) % CLIENTS.length] as string,
      description: index % 2 === 0 ? "Sample supply and installation works" : "Sample replacement of control panel and commissioning",
      completedDate: iso(2027, 2 + (index % 4), 4 + index * 2),
      jobValue,
      invoicedValue,
      uninvoicedValue: fromThousandths(toThousandths(jobValue) - toThousandths(invoicedValue)),
      invoicing: partly ? "Partly invoiced" : "Ready for invoice",
    };
  });
  const generatedAt = new Date();

  return {
    title: "Pending Invoices Report",
    period: `As at ${displayToday(generatedAt)}`,
    filters: [SAMPLE_FILTER],
    generatedAt,
    generatedBy: "Sample User",
    orientation: "portrait",
    disclaimer: TRACKING_DISCLAIMER,
    fileStem: "sample-pending-invoices",
    tables: [
      {
        name: "AMC visits",
        columns: PENDING_VISIT_COLUMNS,
        rows: visits,
        totals: {
          label: `Total (${visits.length} visits)`,
          values: { visitAmount: sum(visits.map((visit) => visit.visitAmount as string)) },
          excelFormulas: { visitAmount: (range) => `SUM(${range("visitAmount")})` },
        },
        notes: ["Completed AMC visits that no invoice covers yet. Visit amounts as entered."],
      },
      {
        name: "Projects",
        columns: PENDING_PROJECT_COLUMNS,
        rows: projects,
        totals: {
          label: `Total not yet invoiced (${projects.length} projects)`,
          values: { uninvoicedValue: sum(projects.map((project) => project.uninvoicedValue as string)) },
          excelFormulas: { uninvoicedValue: (range) => `SUM(${range("uninvoicedValue")})` },
        },
        notes: ["Completed projects with job value that no invoice covers yet. Values exclude VAT."],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// AMC Schedule
// ---------------------------------------------------------------------------

function sampleSchedule(): ReportDefinition {
  const rows: ReportRow[] = [];
  let missing = 0;

  for (let month = 1; month <= 6; month += 1) {
    for (let n = 0; n < 9; n += 1) {
      const index = rows.length;
      const cancelled = index % 17 === 5;
      const completed = !cancelled && month <= 3;
      const overdue = !completed && !cancelled && month === 4 && n < 3;
      const status = cancelled ? "Cancelled" : completed ? "Completed" : n === 7 ? "Postponed" : "Scheduled";
      const amount = index % 13 === 9 ? null : `${150 + ((index * 85) % 1900)}.${pad3(index * 125)}`;
      const day = 2 + n * 3;

      if (!cancelled && amount === null) {
        missing += 1;
      }

      rows.push({
        number: index + 1,
        scheduledDate: iso(2027, month, day),
        originalScheduledDate: iso(2027, month, n === 7 ? 1 : day),
        client: CLIENTS[index % CLIENTS.length] as string,
        system: SYSTEMS[index % SYSTEMS.length] as string,
        sequenceNo: month,
        periodStart: iso(2027, month, 1),
        periodEnd: iso(2027, month, lastDay(2027, month)),
        assignedTo: ENGINEERS[index % ENGINEERS.length] ?? null,
        status,
        statusWithOverdue: overdue ? `${status} (overdue)` : status,
        overdue: overdue ? "Yes" : "No",
        visitAmount: amount,
        invoicing: cancelled ? "Not completed" : completed ? (amount === null ? "Amount required" : index % 2 === 0 ? "Invoiced" : "Ready for invoice") : "Not completed",
        completedDate: completed ? iso(2027, month, Math.min(day + 1, 28)) : null,
        notes: index % 11 === 3 ? "Sample note: access to the plant room must be arranged with building security one day before the visit." : null,
      });
    }
  }

  return {
    title: "AMC Schedule",
    period: "01 Jan 2027 to 30 Jun 2027",
    filters: [SAMPLE_FILTER],
    generatedAt: new Date(),
    generatedBy: "Sample User",
    orientation: "landscape",
    fileStem: "sample-amc-schedule",
    tables: [
      {
        name: "AMC Schedule",
        columns: SCHEDULE_COLUMNS,
        rows,
        groupBy: (row) => displayMonth(String(row.scheduledDate)),
        totals: {
          label: `Total amount (${rows.length} visits)`,
          values: { visitAmount: sum(rows.filter((row) => row.status !== "Cancelled").map((row) => row.visitAmount as string | null)) },
          excelFormulas: { visitAmount: (range) => `SUMIFS(${range("visitAmount")},${range("status")},${NOT_CANCELLED})` },
        },
        notes: ["Total amount excludes cancelled visits.", `${missing} visits have no amount.`],
      },
    ],
  };
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT, { recursive: true });
  for (const report of [sampleInvoices(), samplePending(), sampleSchedule()]) {
    for (const format of ["xlsx", "pdf"] as const) {
      const file = path.join(OUTPUT, exportFileName(report, format));

      writeFileSync(file, await renderReport(report, format));
      console.log(`Wrote ${file}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Could not write the samples.");
  process.exitCode = 1;
});
