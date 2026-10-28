import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, visitsOf, type Session, type VisitRecord } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { cancelInvoice, completeVisit, invoiceBody, newInvoice } from "./invoices-helpers";

// The Monthly Calendar's year (/api/amc/visits/year-summary) and the filters it
// added to the shared visit query. Every record here is invented.
//
// Year 2025:
//   FIRE, Year Hotel, monthly, 405.000 a visit, linked to a sales engineer:
//     Jan  completed, covered by two active invoices (two allocations, one visit)
//     Feb  completed, its only invoice cancelled          -> not yet invoiced
//     Mar  completed, no amount                          -> not yet invoiced, amount missing
//     Apr  completed, amount zero                        -> no invoice required
//     May  cancelled
//     Jun  postponed
//     Jul-Dec scheduled
//   CCTV, Year Mall, quarterly, 300.000 a visit, no sales engineer: four scheduled visits.

let admin: Session;
let accountant: Session; // AMC_SCHEDULE:VIEW, no EXPORT
let procurement: Session; // no AMC access
let hotel: string;
let mall: string;
let engineerId: string;
let fire: VisitRecord[];
let cctv: VisitRecord[];

const summary = (query: Record<string, unknown>, session: Session = admin) =>
  api().get("/api/amc/visits/year-summary").query(query).set(session.headers);
const list = (query: Record<string, unknown>) => api().get("/api/amc/visits").query({ pageSize: 200, ...query }).set(admin.headers);
const ids = (response: { body: { data: { items: { id: string }[] } } }) => response.body.data.items.map((item) => item.id).sort();
const visitId = (visits: VisitRecord[], index: number) => (visits[index] as VisitRecord).id;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  hotel = await createClient(admin, "Year Hotel");
  mall = await createClient(admin, "Year Mall");
  engineerId = (await api().post("/api/masters/sales-engineers").set(admin.headers).send({ name: "Calendar Engineer" })).body.data.id;

  const fireId = await activeContract(admin, hotel, {
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    maintenanceFrequency: "MONTHLY",
    contractValue: "4860.000",
    defaultVisitAmount: "405.000",
    salesEngineerId: engineerId,
  });
  const cctvId = await activeContract(admin, mall, {
    systemDescription: "CCTV",
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    contractValue: "1200.000",
    defaultVisitAmount: "300.000",
  });
  fire = await visitsOf(fireId);
  cctv = await visitsOf(cctvId);

  // Mar: no amount; Apr: zero. Set before completion, as the office would.
  await pool.query("UPDATE amc_visits SET visit_amount = NULL WHERE id = $1", [visitId(fire, 2)]);
  await pool.query("UPDATE amc_visits SET visit_amount = 0 WHERE id = $1", [visitId(fire, 3)]);
  for (const index of [0, 1, 2, 3]) {
    await completeVisit(admin, visitId(fire, index));
  }

  // Jan: two active invoices, each covering part of the visit.
  await newInvoice(admin, invoiceBody(hotel, [{ amcVisitId: visitId(fire, 0), amount: "200.000" }], { amountExclVat: "200.000", vatAmount: "0" }));
  await newInvoice(admin, invoiceBody(hotel, [{ amcVisitId: visitId(fire, 0), amount: "205.000" }], { amountExclVat: "205.000", vatAmount: "0" }));
  // Feb: invoiced, then the invoice was cancelled.
  const february = await newInvoice(admin, invoiceBody(hotel, [{ amcVisitId: visitId(fire, 1), amount: "405.000" }]));
  const cancelled = await cancelInvoice(admin, february.id);
  expect(cancelled.status).toBe(200);

  await pool.query("UPDATE amc_visits SET status = 'CANCELLED' WHERE id = $1", [visitId(fire, 4)]);
  await pool.query("UPDATE amc_visits SET status = 'POSTPONED' WHERE id = $1", [visitId(fire, 5)]);
});
afterAll(closePool);

describe("GET /api/amc/visits/year-summary", () => {
  it("counts the year's services per month, January to December", async () => {
    const response = await summary({ year: 2025 });

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.year).toBe(2025);
    expect(data.months).toHaveLength(12);
    expect(data.months.map((month: { month: number }) => month.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // 12 FIRE visits, one cancelled, plus 4 CCTV visits.
    expect(data.totals.services).toBe(15);
    expect(data.totals.cancelled).toBe(1);
    // Each month adds up to the year.
    const sum = (key: string) => data.months.reduce((total: number, month: Record<string, number>) => total + (month[key] as number), 0);
    for (const key of ["services", "completed", "cancelled", "invoiced", "notYetInvoiced", "noInvoiceRequired", "notCompleted", "amountMissing"]) {
      expect(sum(key), key).toBe(data.totals[key]);
    }
  });

  it("sums visit amounts without cancelled visits and reports missing amounts", async () => {
    const { totals } = (await summary({ year: 2025 })).body.data;

    // FIRE: 12 visits less May (cancelled), Mar (no amount) and Apr (0.000) = 9 x 405.000; CCTV 4 x 300.000.
    expect(totals.scheduledValue).toBe("4845.000");
    expect(totals.amountMissing).toBe(1);
  });

  it("classifies billing from completion and active invoices, counting a visit once however many invoices cover it", async () => {
    const { months, totals } = (await summary({ year: 2025 })).body.data;
    const [january, february, march, april, may, june] = months;

    expect(january).toMatchObject({ completed: 1, invoiced: 1, invoicedValue: "405.000", notYetInvoiced: 0 });
    // A cancelled invoice does not count.
    expect(february).toMatchObject({ completed: 1, invoiced: 0, notYetInvoiced: 1, notYetInvoicedValue: "405.000" });
    // Completed without an amount is still waiting to be invoiced.
    expect(march).toMatchObject({ completed: 1, notYetInvoiced: 1, amountMissing: 1, notYetInvoicedValue: "0.000" });
    expect(april).toMatchObject({ completed: 1, noInvoiceRequired: 1, notYetInvoiced: 0, invoiced: 0 });
    // Cancelled and not-completed visits are never pending billing.
    expect(may).toMatchObject({ services: 0, cancelled: 1, notYetInvoiced: 0, notCompleted: 0 });
    expect(june).toMatchObject({ postponed: 1, notCompleted: 1, notYetInvoiced: 0 });

    expect(totals).toMatchObject({ completed: 4, invoiced: 1, notYetInvoiced: 2, noInvoiceRequired: 1, notCompleted: 11 });
    expect(totals.completed).toBe(totals.invoiced + totals.notYetInvoiced + totals.noInvoiceRequired);
  });

  it("gives a year without visits twelve empty months", async () => {
    const { months, totals } = (await summary({ year: 2031 })).body.data;

    expect(months).toHaveLength(12);
    expect(totals).toMatchObject({ services: 0, scheduledValue: "0.000", amountMissing: 0 });
    expect(months[6]).toMatchObject({ month: 7, services: 0, scheduledValue: "0.000" });
  });

  it("applies every filter, combined with AND", async () => {
    const byClient = (await summary({ year: 2025, clientId: mall })).body.data.totals;
    expect(byClient).toMatchObject({ services: 4, scheduledValue: "1200.000" });

    const byEngineer = (await summary({ year: 2025, salesEngineerId: engineerId })).body.data.totals;
    expect(byEngineer.services).toBe(11);

    expect((await summary({ year: 2025, frequency: "QUARTERLY" })).body.data.totals.services).toBe(4);
    expect((await summary({ year: 2025, system: "fire" })).body.data.totals.services).toBe(11);
    expect((await summary({ year: 2025, billingStatus: "NOT_YET_INVOICED" })).body.data.totals.services).toBe(2);
    expect((await summary({ year: 2025, status: "SCHEDULED,POSTPONED" })).body.data.totals.services).toBe(11);
    expect((await summary({ year: 2025, search: "Mall" })).body.data.totals.services).toBe(4);

    // Together: the Mall has no sales engineer, so nothing matches both.
    expect((await summary({ year: 2025, clientId: mall, salesEngineerId: engineerId })).body.data.totals.services).toBe(0);
    expect((await summary({ year: 2025, salesEngineerId: engineerId, billingStatus: "INVOICED" })).body.data.totals).toMatchObject({ services: 1, invoiced: 1 });
  });

  it("shows a cancelled visit only under the Cancelled billing status", async () => {
    const { totals } = (await summary({ year: 2025, billingStatus: "CANCELLED" })).body.data;

    expect(totals).toMatchObject({ services: 0, cancelled: 1, notYetInvoiced: 0 });
  });

  it("validates the year and the filters", async () => {
    expect((await summary({})).status).toBe(400);
    expect((await summary({ year: 1999 })).status).toBe(400);
    expect((await summary({ year: "next" })).status).toBe(400);
    expect((await summary({ year: 2025, billingStatus: "PAID" })).status).toBe(400);
    expect((await summary({ year: 2025, frequency: "monthly!" })).status).toBe(400);
  });

  it("is open to AMC Schedule viewers only", async () => {
    expect((await summary({ year: 2025 }, accountant)).status).toBe(200);
    expect((await summary({ year: 2025 }, procurement)).status).toBe(403);
    expect((await api().get("/api/amc/visits/year-summary").query({ year: 2025 })).status).toBe(401);
  });

  it("changes no visit or invoice", async () => {
    const before = await pool.query("SELECT id, status, visit_amount, updated_at FROM amc_visits ORDER BY id");
    const invoicesBefore = await pool.query("SELECT id, status, updated_at FROM invoices ORDER BY id");

    await summary({ year: 2025 });
    await summary({ year: 2026 });

    expect((await pool.query("SELECT id, status, visit_amount, updated_at FROM amc_visits ORDER BY id")).rows).toEqual(before.rows);
    expect((await pool.query("SELECT id, status, updated_at FROM invoices ORDER BY id")).rows).toEqual(invoicesBefore.rows);
  });
});

describe("the new filters on GET /api/amc/visits", () => {
  it("leaves the list unchanged when they are left out", async () => {
    const response = await list({ from: "2025-01-01", to: "2025-12-31" });

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(16);
  });

  it("selects the same visits as the year's figures", async () => {
    expect(ids(await list({ billingStatus: "NOT_YET_INVOICED" }))).toEqual([visitId(fire, 1), visitId(fire, 2)].sort());
    expect(ids(await list({ billingStatus: "INVOICED" }))).toEqual([visitId(fire, 0)]);
    expect(ids(await list({ billingStatus: "NO_INVOICE_REQUIRED" }))).toEqual([visitId(fire, 3)]);
    expect(ids(await list({ billingStatus: "CANCELLED" }))).toEqual([visitId(fire, 4)]);
    expect((await list({ billingStatus: "NOT_COMPLETED" })).body.data.total).toBe(11);
    expect(ids(await list({ frequency: "QUARTERLY" }))).toEqual(cctv.map((visit) => visit.id).sort());
    expect((await list({ salesEngineerId: engineerId })).body.data.total).toBe(12);
  });
});

describe("monthly download through GET /api/amc/visits/export", () => {
  const exportAs = (query: Record<string, unknown>, session: Session = admin) =>
    api().get("/api/amc/visits/export").query(query).responseType("blob").set(session.headers);

  it("exports one month with the calendar's filters, and names them in the report", async () => {
    const response = await exportAs({ format: "xlsx", from: "2025-02-01", to: "2025-02-28", salesEngineerId: engineerId, billingStatus: "NOT_YET_INVOICED", frequency: "MONTHLY" });

    expect(response.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("AMC Schedule") as ExcelJS.Worksheet;
    const text: string[] = [];
    sheet.eachRow((row) => text.push(row.values ? JSON.stringify(row.values) : ""));
    const all = text.join("\n");

    expect(all).toContain("Calendar Engineer");
    expect(all).toContain("Not yet invoiced");
    expect(all).toContain("Year Hotel");
    expect(all).not.toContain("Year Mall");
  });

  it("produces a PDF for a month", async () => {
    const response = await exportAs({ format: "pdf", from: "2025-01-01", to: "2025-01-31" });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
  });

  it("keeps the schedule's export permission", async () => {
    expect((await exportAs({ format: "xlsx", from: "2025-01-01", to: "2025-01-31" }, accountant)).status).toBe(403);
  });
});
