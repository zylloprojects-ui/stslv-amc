import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { TRACKING_DISCLAIMER } from "../src/modules/invoices/invoices.export";
import { HEADER_ROW } from "../src/shared/export/excel";
import { EMPTY_MESSAGE, EXPORT_ROW_LIMITS } from "../src/shared/export/report";
import { grant } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import {
  cancelInvoice,
  completeVisit,
  completedProject,
  invoiceBody,
  invoiceFixture,
  newInvoice,
  type Fixture,
  type Session,
} from "./invoices-helpers";
import { newProject, resetProjectData } from "./projects-helpers";

// The Invoice Tracking and Pending Invoices reports. Every invoice here is invented.

let admin: Session;
let invoicing: Session; // INVOICES view/create/edit, AMC_SCHEDULE:VIEW, PROJECTS:VIEW; no EXPORT until granted
let accountant: Session; // INVOICES:VIEW, no EXPORT
let procurement: Session; // given INVOICES:EXPORT without INVOICES:VIEW
let fixture: Fixture;
let partProject: { id: string; jobNumber: string };
let readyProject: { id: string; jobNumber: string };
let cancelled: { id: string; invoiceNumber: string };

const DANGEROUS_NUMBER = "=1+1";
const visitId = (index: number) => fixture.visits[index]?.id as string;

beforeAll(async () => {
  await resetProjectData();
  await grant("PROCUREMENT", [["INVOICES", "EXPORT"]]);
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  fixture = await invoiceFixture(admin);

  // Visits 0-3 are completed at 405.000 each; the others stay scheduled.
  for (const index of [0, 1, 2, 3]) {
    await completeVisit(admin, visitId(index));
  }
  partProject = await completedProject(admin, fixture.clientId, "1000.000");
  readyProject = await completedProject(admin, fixture.otherClientId, "2500.500");
  // Not completed: never waiting for an invoice.
  await newProject(admin, fixture.clientId, { jobValue: "9999.000" });

  // 00077: visit 0 and part of a project on one invoice. Leading zeros must survive.
  await newInvoice(
    admin,
    invoiceBody(fixture.clientId, [{ amcVisitId: visitId(0), amount: "405.000" }, { projectId: partProject.id, amount: "600.000" }], {
      invoiceNumber: "00077",
      invoiceDate: "2026-09-20",
      amountExclVat: "1005.000",
      vatAmount: "50.250",
      sourceReference: "000123",
      notes: "First part",
    })
  );
  // An invoice number that is a formula.
  await newInvoice(admin, invoiceBody(fixture.clientId, [{ amcVisitId: visitId(1), amount: "405.000" }], { invoiceNumber: DANGEROUS_NUMBER, invoiceDate: "2026-08-05", vatAmount: "0.000" }));
  // Cancelled: listed, never counted, and visit 2 is waiting again.
  cancelled = await newInvoice(admin, invoiceBody(fixture.clientId, [{ amcVisitId: visitId(2), amount: "405.000" }], { invoiceNumber: "9001", invoiceDate: "2026-09-25" }));
  await cancelInvoice(admin, cancelled.id, { reason: "Raised twice." });
});
afterAll(closePool);

const get = (path: string, query: Record<string, unknown>, session: Session | null = admin) => {
  const request = api().get(path).query(query).responseType("blob");

  return session ? request.set(session.headers) : request;
};
const exportInvoices = (query: Record<string, unknown>, session: Session | null = admin) => get("/api/invoices/export", query, session);
const exportPending = (query: Record<string, unknown>, session: Session | null = admin) => get("/api/invoices/billable/export", query, session);
const errorOf = (response: { body: Buffer }) => JSON.parse(response.body.toString()).error as { code: string; message: string };

async function workbookOf(response: { body: Buffer }): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);

  return workbook;
}

function rowsOf(sheet: ExcelJS.Worksheet, count: number, columns: number): ExcelJS.CellValue[][] {
  return Array.from({ length: count }, (_, index) => Array.from({ length: columns }, (_cell, column) => sheet.getRow(HEADER_ROW + 1 + index).getCell(column + 1).value));
}

const day = (value: string) => new Date(`${value}T00:00:00Z`);

describe("who may export invoice reports", () => {
  it("needs a session, INVOICES:VIEW and INVOICES:EXPORT, for both reports", async () => {
    for (const run of [exportInvoices, exportPending]) {
      expect((await run({ format: "xlsx" }, null)).status).toBe(401);
      // Views invoices, holds no EXPORT.
      expect((await run({ format: "xlsx" }, accountant)).status).toBe(403);
      expect((await run({ format: "pdf" }, invoicing)).status).toBe(403);
      // Holds EXPORT, may not view invoices.
      expect((await run({ format: "pdf" }, procurement)).status).toBe(403);
    }
  });

  it("gives EXPORT on invoices only to Super Admin, Admin and Finance Executive unless it is granted", async () => {
    const granted = await pool.query<{ code: string }>(
      "SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.module = 'INVOICES' AND rp.action = 'EXPORT' AND r.code <> 'PROCUREMENT' ORDER BY r.id"
    );

    expect(granted.rows.map((row) => row.code)).toEqual(["ADMIN", "ADMINISTRATOR", "FINANCE_EXECUTIVE"]);
  });

  it("rejects an unknown format or filter, and cannot be asked for work that is already invoiced", async () => {
    expect((await exportInvoices({ format: "csv" })).status).toBe(400);
    expect((await exportInvoices({ format: "xlsx", dateFrom: "2026-02-30" })).status).toBe(400);
    expect((await exportPending({})).status).toBe(400);
    expect((await exportPending({ format: "xlsx", includeInvoiced: "true", clientId: fixture.clientId })).status).toBe(400);
  });
});

describe("Invoice Tracking report", () => {
  it("is a download, labelled as an internal tracking report", async () => {
    const response = await exportInvoices({ format: "xlsx" });
    const sheet = (await workbookOf(response)).getWorksheet("Invoices") as ExcelJS.Worksheet;

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="invoice-tracking_\d{8}-\d{4}\.xlsx"$/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(sheet.getCell("A2").value).toBe("Invoice Tracking Report");
    expect(sheet.getCell("A3").value).toBe("Period: All dates");
    expect(String(sheet.getCell("A4").value)).toMatch(new RegExp(`^${TRACKING_DISCLAIMER.replace(/\./g, "\\.")}   ·   Generated .* Oman time by admin@example\\.com`));
    expect(TRACKING_DISCLAIMER).toBe("Internal tracking report. Not an official tax invoice.");
  });

  it("lists the recorded invoices exactly as the list does, with the list's totals", async () => {
    const listed = (await api().get("/api/invoices").query({ pageSize: 100 }).set(admin.headers)).body.data;
    const sheet = (await workbookOf(await exportInvoices({ format: "xlsx" }))).getWorksheet("Invoices") as ExcelJS.Worksheet;
    const rows = rowsOf(sheet, 3, 12);

    expect(listed.total).toBe(3);
    // Newest first, as on the screen.
    expect(rows[0]).toEqual([
      "9001",
      day("2026-09-25"),
      "Test Hotel",
      "AMC FIRE · visit 3 (01 Mar 2025 to 31 Mar 2025)",
      405,
      20.25,
      425.25,
      "Cancelled",
      null,
      "Raised twice.",
      null,
      "admin@example.com",
    ]);
    expect(rows[1]).toEqual([
      "00077",
      day("2026-09-20"),
      "Test Hotel",
      `AMC FIRE · visit 1 (01 Jan 2025 to 31 Jan 2025) · 405.000\n${partProject.jobNumber} — ${listed.items[1].allocations[1].project.description} · 600.000`,
      1005,
      50.25,
      1055.25,
      "Issued",
      "000123",
      null,
      "First part",
      "admin@example.com",
    ]);
    // Identifiers stay text: leading zeros survive.
    expect(sheet.getRow(HEADER_ROW + 2).getCell(1).numFmt).toBe("@");
    expect(sheet.getRow(HEADER_ROW + 2).getCell(9).value).toBe("000123");
    expect(sheet.getRow(HEADER_ROW + 1).getCell(5).numFmt).toBe("#,##0.000");

    // The cancelled invoice is listed and counted nowhere: 1005 + 405.
    const totals = sheet.getRow(HEADER_ROW + 4);
    expect(listed.totals).toEqual({ amountExclVat: "1410.000", vatAmount: "50.250", totalAmount: "1460.250" });
    expect(totals.getCell(4).value).toBe("Total (3 invoices)");
    expect(totals.getCell(5).value).toMatchObject({ formula: 'SUMIFS(E7:E9,H7:H9,"<>Cancelled")', result: 1410 });
    expect(totals.getCell(6).value).toMatchObject({ formula: 'SUMIFS(F7:F9,H7:H9,"<>Cancelled")', result: 50.25 });
    expect(totals.getCell(7).value).toMatchObject({ formula: 'SUMIFS(G7:G9,H7:H9,"<>Cancelled")', result: 1460.25 });
  });

  it("neutralises an invoice number that is a formula", async () => {
    const sheet = (await workbookOf(await exportInvoices({ format: "xlsx", search: "=1" }))).getWorksheet("Invoices") as ExcelJS.Worksheet;
    const cell = sheet.getRow(HEADER_ROW + 1).getCell(1);

    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe(`'${DANGEROUS_NUMBER}`);
    expect(sheet.getCell("A3").value).toBe("Period: All dates   ·   Search: =1");
  });

  it("gives one line per covered visit or project on a second sheet, adding up to the invoices' total", async () => {
    const sheet = (await workbookOf(await exportInvoices({ format: "xlsx" }))).getWorksheet("Allocations") as ExcelJS.Worksheet;
    const rows = rowsOf(sheet, 4, 10);

    expect(rows.map((row) => [row[0], row[3], row[4], row[5], row[9]])).toEqual([
      ["9001", "Cancelled", "AMC visit", "FIRE", 405],
      ["00077", "Issued", "AMC visit", "FIRE", 405],
      ["00077", "Issued", "Project", partProject.jobNumber, 600],
      [`'${DANGEROUS_NUMBER}`, "Issued", "AMC visit", "FIRE", 405],
    ]);
    expect(rows[1]?.slice(7, 9)).toEqual([day("2025-01-01"), day("2025-01-31")]);
    expect(rows[2]?.slice(7, 9)).toEqual([null, null]);
    expect(sheet.getRow(HEADER_ROW + 5).getCell(10).value).toMatchObject({ formula: 'SUMIFS(J7:J10,D7:D10,"<>Cancelled")', result: 1410 });
  });

  it("respects every filter of the invoice list", async () => {
    const count = async (query: Record<string, string>) => {
      const [listed, exported] = await Promise.all([api().get("/api/invoices").query(query).set(admin.headers), exportInvoices({ format: "xlsx", ...query })]);
      const total = listed.body.data.total as number;
      const sheet = (await workbookOf(exported)).getWorksheet("Invoices") as ExcelJS.Worksheet;
      const last = sheet.getRow(HEADER_ROW + total).getCell(2).value;
      const after = sheet.getRow(HEADER_ROW + total + 1).getCell(1).value;

      expect(total === 0 ? after : last instanceof Date).toBe(total === 0 ? EMPTY_MESSAGE : true);
      // The row after the last invoice is the totals row, never another invoice.
      if (total > 0) {
        expect(sheet.getRow(HEADER_ROW + total + 1).getCell(2).value).toBeNull();
      }

      return total;
    };

    expect(await count({ status: "ISSUED" })).toBe(2);
    expect(await count({ status: "CANCELLED" })).toBe(1);
    expect(await count({ projectId: partProject.id })).toBe(1);
    expect(await count({ amcVisitId: visitId(2) })).toBe(1);
    expect(await count({ clientId: fixture.otherClientId })).toBe(0);
    expect(await count({ dateFrom: "2026-09-01", dateTo: "2026-09-22" })).toBe(1);
    expect(await count({ search: partProject.jobNumber })).toBe(1);

    const sheet = (await workbookOf(await exportInvoices({ format: "xlsx", status: "ISSUED", projectId: partProject.id, dateFrom: "2026-09-01" }))).getWorksheet("Invoices") as ExcelJS.Worksheet;
    expect(sheet.getCell("A3").value).toBe(`Period: From 01 Sep 2026   ·   Project: ${partProject.jobNumber}   ·   Status: Issued`);
  });

  it("is produced as a PDF, also when nothing matches, and refuses a result too large for one", async () => {
    const pdf = await exportInvoices({ format: "pdf" });
    const empty = await exportInvoices({ format: "pdf", dateFrom: "2031-01-01" });
    const limit = EXPORT_ROW_LIMITS.pdf;

    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-disposition"]).toMatch(/^attachment; filename="invoice-tracking_\d{8}-\d{4}\.pdf"$/);
    expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(empty.status).toBe(200);

    EXPORT_ROW_LIMITS.pdf = 2;
    try {
      const refused = await exportInvoices({ format: "pdf" });

      expect(refused.status).toBe(422);
      expect(errorOf(refused).code).toBe("EXPORT_TOO_LARGE");
    } finally {
      EXPORT_ROW_LIMITS.pdf = limit;
    }
  });

  it("changes nothing: no invoice is created or altered by exporting", async () => {
    const snapshot = () => pool.query("SELECT id, status, updated_at FROM invoices ORDER BY id");
    const before = (await snapshot()).rows;

    await exportInvoices({ format: "xlsx" });
    await exportPending({ format: "pdf" });

    expect((await snapshot()).rows).toEqual(before);
  });
});

describe("Pending Invoices report", () => {
  it("lists only completed work that no active invoice covers, with the screen's figures", async () => {
    const screen = (await api().get("/api/invoices/billable").set(admin.headers)).body.data;
    const response = await exportPending({ format: "xlsx" });
    const workbook = await workbookOf(response);
    const visits = workbook.getWorksheet("AMC visits") as ExcelJS.Worksheet;
    const projects = workbook.getWorksheet("Projects") as ExcelJS.Worksheet;

    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="pending-invoices_\d{8}-\d{4}\.xlsx"$/);
    expect(visits.getCell("A2").value).toBe("Pending Invoices Report");
    expect(String(visits.getCell("A3").value)).toMatch(/^Period: As at \d{2} \w{3} \d{4}$/);
    expect(String(visits.getCell("A4").value)).toContain(TRACKING_DISCLAIMER);

    // Visit 1 and 2 are invoiced. Visit 3's invoice was cancelled, so it waits again, with visit 4.
    // The scheduled visits are not completed and are never listed.
    expect(screen.amcVisits).toMatchObject({ pendingCount: 2, pendingAmount: "810.000" });
    expect(rowsOf(visits, 2, 7)).toEqual([
      ["Test Hotel", "FIRE", 3, day("2025-03-01"), day("2025-03-31"), day("2025-12-15"), 405],
      ["Test Hotel", "FIRE", 4, day("2025-04-01"), day("2025-04-30"), day("2025-12-15"), 405],
    ]);
    expect(visits.getRow(HEADER_ROW + 3).getCell(6).value).toBe("Total (2 visits)");
    expect(visits.getRow(HEADER_ROW + 3).getCell(7).value).toMatchObject({ formula: "SUM(G7:G8)", result: 810 });
    expect(visits.getRow(HEADER_ROW + 4).getCell(1).value).toBeNull();

    // One project is partly invoiced (400 of 1000 left), one has no invoice. The project that is not completed is absent.
    expect(screen.projects).toMatchObject({ pendingCount: 2, pendingValue: "2900.500" });
    // In the order of the screen: by completion date, then client.
    expect(screen.projects.items.map((project: { jobNumber: string }) => project.jobNumber)).toEqual([readyProject.jobNumber, partProject.jobNumber]);
    expect(rowsOf(projects, 2, 8).map((row) => [row[0], row[1], row[3], row[4], row[5], row[6], row[7]])).toEqual([
      [readyProject.jobNumber, "Other Mall", day("2026-09-10"), 2500.5, 0, 2500.5, "Ready for invoice"],
      [partProject.jobNumber, "Test Hotel", day("2026-09-10"), 1000, 600, 400, "Partly invoiced"],
    ]);
    expect(projects.getRow(HEADER_ROW + 3).getCell(6).value).toBe("Total not yet invoiced (2 projects)");
    expect(projects.getRow(HEADER_ROW + 3).getCell(7).value).toMatchObject({ formula: "SUM(G7:G8)", result: 2900.5 });
    expect(projects.getRow(HEADER_ROW + 3).getCell(5).value).toBeNull();
  });

  it("drops work from the report as soon as an invoice covers it", async () => {
    const invoice = await newInvoice(admin, invoiceBody(fixture.otherClientId, [{ projectId: readyProject.id, amount: "2500.500" }], { amountExclVat: "2500.500", vatAmount: "125.025" }));
    const projects = (await workbookOf(await exportPending({ format: "xlsx" }))).getWorksheet("Projects") as ExcelJS.Worksheet;

    expect(rowsOf(projects, 1, 1)).toEqual([[partProject.jobNumber]]);
    expect(projects.getRow(HEADER_ROW + 2).getCell(7).value).toMatchObject({ result: 400 });

    await cancelInvoice(admin, invoice.id);
    const again = (await workbookOf(await exportPending({ format: "xlsx" }))).getWorksheet("Projects") as ExcelJS.Worksheet;
    expect(rowsOf(again, 2, 1)).toEqual([[readyProject.jobNumber], [partProject.jobNumber]]);
  });

  it("filters by client and names the client from the database", async () => {
    const workbook = await workbookOf(await exportPending({ format: "xlsx", clientId: fixture.otherClientId }));
    const visits = workbook.getWorksheet("AMC visits") as ExcelJS.Worksheet;
    const projects = workbook.getWorksheet("Projects") as ExcelJS.Worksheet;

    expect(String(visits.getCell("A3").value)).toMatch(/   ·   Client: Other Mall$/);
    expect(visits.getRow(HEADER_ROW + 1).getCell(1).value).toBe(EMPTY_MESSAGE);
    expect(rowsOf(projects, 1, 2)).toEqual([[readyProject.jobNumber, "Other Mall"]]);
  });

  it("shows a role only the sections it may see on the screen", async () => {
    await grant("ACCOUNTANT", [["INVOICES", "EXPORT"]]);
    await grant("EXECUTION", [["INVOICES", "VIEW"], ["INVOICES", "EXPORT"]]);
    // Sees invoices, the AMC schedule and projects.
    const both = await workbookOf(await exportPending({ format: "xlsx" }, accountant));
    // Sees projects and the schedule too in the seeded matrix; take PROJECTS away to check the split.
    await pool.query("DELETE FROM role_permissions WHERE module = 'PROJECTS' AND role_id = (SELECT id FROM roles WHERE code = 'EXECUTION')");
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);
    const visitsOnly = await workbookOf(await exportPending({ format: "xlsx" }, execution));

    expect(both.worksheets.map((sheet) => sheet.name)).toEqual(["AMC visits", "Projects"]);
    expect(visitsOnly.worksheets.map((sheet) => sheet.name)).toEqual(["AMC visits"]);

    // Neither section: there is nothing this role may be shown.
    await pool.query("DELETE FROM role_permissions WHERE module = 'AMC_SCHEDULE' AND role_id = (SELECT id FROM roles WHERE code = 'EXECUTION')");
    const refused = await exportPending({ format: "xlsx" }, execution);

    expect(refused.status).toBe(403);
    expect(errorOf(refused).message).toBe("Work waiting for an invoice is listed for roles that may also view the AMC Schedule or Projects.");
  });

  it("is produced as a PDF", async () => {
    const response = await exportPending({ format: "pdf" });

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/^attachment; filename="pending-invoices_\d{8}-\d{4}\.pdf"$/);
    expect(response.body.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("audit", () => {
  it("records each export with who made it, the format, the filters and the row count, and nothing for a refused one", async () => {
    await pool.query("DELETE FROM activity_logs WHERE action LIKE 'invoices.%exported'");
    await exportInvoices({ format: "pdf", status: "ISSUED" });
    await exportPending({ format: "xlsx", clientId: fixture.clientId });
    await exportInvoices({ format: "xlsx" }, invoicing);

    const logs = await pool.query("SELECT user_id, action, module, description, metadata FROM activity_logs WHERE action LIKE 'invoices.%exported' ORDER BY id");

    expect(logs.rows).toEqual([
      {
        user_id: admin.id,
        action: "invoices.exported",
        module: "INVOICES",
        description: "Exported the invoice tracking report as PDF (2 invoices).",
        metadata: { format: "pdf", filters: { status: "ISSUED" }, rowCount: 2 },
      },
      {
        user_id: admin.id,
        action: "invoices.pending_exported",
        module: "INVOICES",
        description: "Exported the pending invoices report as Excel (3 items).",
        metadata: { format: "xlsx", filters: { clientId: fixture.clientId }, rowCount: 3, amcVisits: 2, projects: 1 },
      },
    ]);
  });
});
