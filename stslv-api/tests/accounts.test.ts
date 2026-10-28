import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, today, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { cancelInvoice, invoiceBody, newInvoice } from "./invoices-helpers";

// Accounts: a read-only billing reconciliation over amc_visits, the service
// report number (0077) and the invoices recorded in Invoice Tracking (0060).

let admin: Session;
let invoicing: Session;
let accountant: Session;
let execution: Session;
let procurement: Session;

interface Fixture {
  alphaId: string;
  betaId: string;
  esha: string;
  omar: string;
  /** Alpha, quarterly 2027, Esha: four visits of 405.000. */
  alphaContract: string;
  /** Beta, half-yearly 2027, Omar: two visits of 400.000. */
  betaContract: string;
  /** Beta, quarterly 2025, past its end date: four visits Service Status shows as waiting for renewal. */
  expiredContract: string;
}
let fx: Fixture;

type Item = {
  id: string;
  reference: string;
  colour: string;
  serviceStatus: string;
  visitValue: string | null;
  serviceReportNo: string | null;
  invoiceNumbers: string[];
  paymentStatus: string;
  contract: { id: string };
};

const list = (query: Record<string, unknown> = {}, session: Session = admin) => api().get("/api/accounts").query({ pageSize: 200, ...query }).set(session.headers);
const exportFile = (query: Record<string, unknown>, session: Session = admin) => api().get("/api/accounts/export").query(query).set(session.headers).responseType("blob");

async function complete(visitId: string): Promise<void> {
  const response = await api().patch(`/api/amc/execution/visits/${visitId}`).set(admin.headers).send({ status: "COMPLETED", completedDate: await today() });
  if (response.status !== 200) throw new Error(`Could not complete visit ${visitId}: ${response.status} ${JSON.stringify(response.body)}`);
}

async function report(visitId: string, reportNumber: string): Promise<void> {
  // Recorded through Service Status, the only place a service report number is written.
  const current = await api().get("/api/amc/service-status").query({ pageSize: 200 }).set(admin.headers);
  const item = (current.body.data.items as { id: string; updatedAt: string }[]).find((row) => row.id === visitId);
  const response = await api().patch(`/api/amc/service-status/${visitId}`).set(admin.headers).send({ reportNumber, expectedUpdatedAt: item?.updatedAt });
  if (response.status !== 200) throw new Error(`Could not save report ${visitId}: ${response.status} ${JSON.stringify(response.body)}`);
}

/** Records an invoice in Invoice Tracking covering the given visits; returns its id and number. */
async function invoice(clientId: string, allocations: [string, string][], invoiceNumber?: string) {
  const amount = allocations.reduce((total, [, value]) => total + Number(value), 0).toFixed(3);
  return newInvoice(
    admin,
    invoiceBody(
      clientId,
      allocations.map(([amcVisitId, value]) => ({ amcVisitId, amount: value })),
      { amountExclVat: amount, vatAmount: "0.000", invoiceDate: await today(), ...(invoiceNumber ? { invoiceNumber } : {}) }
    )
  );
}

async function insertEngineer(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>("INSERT INTO sales_engineers (name) VALUES ($1) RETURNING id", [name]);
  return result.rows[0]?.id as string;
}

const byId = (items: Item[]) => new Map(items.map((item) => [item.id, item]));

describe("Accounts", () => {
  beforeAll(async () => {
    await resetData();
    admin = await signedIn("admin@example.com", ["ADMIN"]);
    invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
    accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
    execution = await signedIn("execution@example.com", ["EXECUTION"]);
    procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  });
  afterAll(closePool);

  beforeEach(async () => {
    await pool.query("TRUNCATE activity_logs, invoice_allocations, invoices, amc_visits, amc_contracts, clients, sales_engineers RESTART IDENTITY CASCADE");
    const alphaId = await createClient(admin, "Alpha Towers");
    const betaId = await createClient(admin, "Beta Mall");
    const esha = await insertEngineer("Esha Engineer");
    const omar = await insertEngineer("Omar Engineer");
    const alphaContract = await activeContract(admin, alphaId, { systemDescription: "FIRE", maintenanceFrequency: "QUARTERLY" });
    const betaContract = await activeContract(admin, betaId, { systemDescription: "CCTV", maintenanceFrequency: "HALF_YEARLY", contractValue: "800.000", defaultVisitAmount: "400.000" });
    const expiredContract = await activeContract(admin, betaId, { systemDescription: "PUMPS", validFrom: "2025-01-01", validTo: "2025-12-31" });
    await pool.query("UPDATE amc_contracts SET sales_engineer_id = $1 WHERE id = $2", [esha, alphaContract]);
    await pool.query("UPDATE amc_contracts SET sales_engineer_id = $1 WHERE id IN ($2, $3)", [omar, betaContract, expiredContract]);
    fx = { alphaId, betaId, esha, omar, alphaContract, betaContract, expiredContract };
  });

  describe("rows", () => {
    it("lists one row per scheduled visit with the reconciliation fields, never one per contract", async () => {
      const response = await list();
      expect(response.status).toBe(200);
      const items = response.body.data.items as Item[];
      expect(items).toHaveLength(10);
      expect(new Set(items.map((item) => item.id)).size).toBe(10);

      const alpha = await visitsOf(fx.alphaContract);
      const alphaRows = items.filter((item) => item.contract.id === fx.alphaContract);
      expect(alphaRows.map((item) => item.id).sort()).toEqual(alpha.map((visit) => visit.id).sort());
      expect(alphaRows[0]).toMatchObject({
        reference: `AMC-${fx.alphaContract.padStart(4, "0")}`,
        client: { id: fx.alphaId, name: "Alpha Towers" },
        system: { description: "FIRE" },
        frequency: { code: "QUARTERLY", label: "Quarterly" },
        service: { sequenceNo: 1, cycleNo: 1, serviceCode: "Q1" },
        visitValue: "405.000",
        serviceStatus: "NOT_COMPLETED",
        serviceReportNo: null,
        invoiceNumbers: [],
        paymentStatus: "NOT_AVAILABLE",
        salesEngineer: { id: fx.esha, name: "Esha Engineer" },
        colour: "RED",
      });
    });

    it("leaves cancelled and historical visits out", async () => {
      const [first, second] = await visitsOf(fx.alphaContract);
      await api().patch(`/api/amc/execution/visits/${first!.id}`).set(admin.headers).send({ status: "CANCELLED", statusReason: "Client request" });
      await pool.query("UPDATE amc_visits SET status = 'HISTORICAL' WHERE id = $1", [second!.id]);

      const ids = ((await list({ clientId: fx.alphaId })).body.data.items as Item[]).map((item) => item.id);
      expect(ids).toHaveLength(2);
      expect(ids).not.toContain(first!.id);
      expect(ids).not.toContain(second!.id);
    });

    it("has no write route", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      expect((await api().patch(`/api/accounts/${first!.id}`).set(admin.headers).send({ invoiceNumber: "X" })).status).toBe(404);
      expect((await api().post("/api/accounts").set(admin.headers).send({})).status).toBe(404);
    });
  });

  describe("colour classification", () => {
    it("classifies Red, Blue and Green, and the cards add up to the rows", async () => {
      const [red, blue, green, other] = await visitsOf(fx.alphaContract);
      for (const visit of [blue, green, other]) await complete(visit!.id);
      const greenInvoice = await invoice(fx.alphaId, [[green!.id, "405.000"]]);

      const response = await list({ clientId: fx.alphaId });
      const rows = byId(response.body.data.items);
      expect(rows.get(red!.id)).toMatchObject({ colour: "RED", invoiceNumbers: [] });
      expect(rows.get(blue!.id)).toMatchObject({ colour: "BLUE", serviceStatus: "COMPLETED", invoiceNumbers: [] });
      expect(rows.get(green!.id)).toMatchObject({ colour: "GREEN", invoiceNumbers: [greenInvoice.invoiceNumber] });
      expect(response.body.data.kpis).toMatchObject({ rows: 4, completed: 3, notCompleted: 1, invoiceFilled: 1, red: 1, blue: 2, green: 1 });
    });

    it("never treats a quotation number as an invoice: Accounts ignores it", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await pool.query("UPDATE amc_visits SET quotation_no = 'QT-1' WHERE id = $1", [first!.id]);

      expect(byId((await list({ clientId: fx.alphaId })).body.data.items).get(first!.id)).toMatchObject({ colour: "BLUE", invoiceNumbers: [] });
    });

    it("counts Waiting for Renewal as not completed and Red", async () => {
      const response = await list({ clientId: fx.betaId, year: 2025 });
      const items = response.body.data.items as Item[];
      expect(items).toHaveLength(4);
      for (const item of items) expect(item).toMatchObject({ serviceStatus: "WAITING_FOR_RENEWAL", colour: "RED" });
      expect(response.body.data.kpis).toMatchObject({ rows: 4, completed: 0, notCompleted: 4, red: 4 });
    });

    it("ignores a cancelled invoice, and lists every active invoice of a visit", async () => {
      const [first, second] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await complete(second!.id);
      const cancelled = await invoice(fx.alphaId, [[first!.id, "405.000"]]);
      expect((await cancelInvoice(admin, cancelled.id)).status).toBe(200);
      const partOne = await invoice(fx.alphaId, [[second!.id, "200.000"]]);
      const partTwo = await invoice(fx.alphaId, [[second!.id, "205.000"]]);

      const response = await list({ clientId: fx.alphaId });
      const rows = byId(response.body.data.items);
      expect(rows.get(first!.id)).toMatchObject({ colour: "BLUE", invoiceNumbers: [] });
      expect(rows.get(second!.id)?.invoiceNumbers.sort()).toEqual([partOne.invoiceNumber, partTwo.invoiceNumber].sort());
      expect(rows.get(second!.id)?.colour).toBe("GREEN");
      // Two invoices on one visit still make one row with an invoice number.
      expect(response.body.data.kpis).toMatchObject({ rows: 4, invoiceFilled: 1 });
    });
  });

  describe("payment status", () => {
    it("never reports a visit as paid, even with an invoice recorded", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await invoice(fx.alphaId, [[first!.id, "405.000"]]);

      const items = (await list()).body.data.items as Item[];
      expect(new Set(items.map((item) => item.paymentStatus))).toEqual(new Set(["NOT_AVAILABLE"]));
    });

    it("refuses a paid / unpaid filter: payment is not recorded", async () => {
      // Unknown query keys are ignored by the schema, so the closest real question is the invoice filter's values.
      expect((await list({ invoiceStatus: "PAID" })).status).toBe(400);
    });
  });

  describe("service report number", () => {
    it("shows the number entered on Service Status, and finds it by search", async () => {
      const [first, second] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await report(first!.id, "SR-2027/014");

      const rows = byId((await list({ clientId: fx.alphaId })).body.data.items);
      expect(rows.get(first!.id)?.serviceReportNo).toBe("SR-2027/014");
      expect(rows.get(second!.id)?.serviceReportNo).toBeNull();

      const found = (await list({ search: "2027/014" })).body.data.items as Item[];
      expect(found.map((item) => item.id)).toEqual([first!.id]);
    });
  });

  describe("visit value", () => {
    it("totals the visit values of the selected rows exactly, and counts rows without a value", async () => {
      const response = await list({ year: 2027 });
      // Four alpha visits of 405.000 and two beta visits of 400.000.
      expect(response.body.data.kpis).toMatchObject({ rows: 6, totalValue: "2420.000", valueMissing: 0 });

      const [first] = await visitsOf(fx.alphaContract);
      await pool.query("UPDATE amc_visits SET visit_amount = 0.001 WHERE id = $1", [first!.id]);
      const [second] = await visitsOf(fx.betaContract);
      await pool.query("UPDATE amc_visits SET visit_amount = NULL WHERE id = $1", [second!.id]);
      // 3 × 405.000 + 0.001 + 400.000, in exact decimals.
      expect((await list({ year: 2027 })).body.data.kpis).toMatchObject({ rows: 6, totalValue: "1615.001", valueMissing: 1 });
    });
  });

  describe("filters", () => {
    it("applies every filter together, and the cards follow the same filters", async () => {
      const alpha = await visitsOf(fx.alphaContract);
      await complete(alpha[0]!.id);
      await complete(alpha[1]!.id);
      const recorded = await invoice(fx.alphaId, [[alpha[0]!.id, "405.000"]], "INV-ALPHA-1");

      expect(((await list({ salesEngineerId: fx.omar })).body.data.items as Item[]).every((item) => item.contract.id !== fx.alphaContract)).toBe(true);
      expect((await list({ serviceStatus: "COMPLETED" })).body.data.kpis).toMatchObject({ rows: 2, completed: 2, notCompleted: 0 });
      expect((await list({ serviceStatus: "NOT_COMPLETED" })).body.data.kpis).toMatchObject({ rows: 8, completed: 0, notCompleted: 8 });
      expect(((await list({ invoiceStatus: "RECORDED" })).body.data.items as Item[]).map((item) => item.id)).toEqual([alpha[0]!.id]);
      expect((await list({ invoiceStatus: "NOT_RECORDED" })).body.data.kpis.rows).toBe(9);
      expect(((await list({ search: "inv-alpha" })).body.data.items as Item[]).map((item) => item.invoiceNumbers)).toEqual([[recorded.invoiceNumber]]);
      expect((await list({ search: `AMC-${fx.alphaContract.padStart(4, "0")}` })).body.data.kpis.rows).toBe(4);
      expect((await list({ search: "beta mall" })).body.data.kpis.rows).toBe(6);

      const combined = await list({ clientId: fx.alphaId, salesEngineerId: fx.esha, year: 2027, serviceStatus: "COMPLETED", invoiceStatus: "NOT_RECORDED" });
      expect((combined.body.data.items as Item[]).map((item) => item.id)).toEqual([alpha[1]!.id]);
      expect(combined.body.data.kpis).toMatchObject({ rows: 1, completed: 1, invoiceFilled: 0, totalValue: "405.000" });

      const month = Number(alpha[0]!.scheduled_date.slice(5, 7));
      const byMonth = (await list({ month })).body.data.items as Item[];
      expect(byMonth.some((item) => item.id === alpha[0]!.id)).toBe(true);
    });

    it("rejects unknown filter values", async () => {
      expect((await list({ serviceStatus: "WAITING_FOR_RENEWAL" })).status).toBe(400);
      expect((await list({ month: 13 })).status).toBe(400);
      expect((await list({ clientId: "abc" })).status).toBe(400);
    });

    it("pages the rows while the total and cards cover every matching visit", async () => {
      const response = await list({ pageSize: 3, page: 2 });
      expect(response.body.data.items).toHaveLength(3);
      expect(response.body.data).toMatchObject({ total: 10, page: 2, pageSize: 3 });
      expect(response.body.data.kpis.rows).toBe(10);
    });

    it("returns an empty list with zero cards when nothing matches", async () => {
      const response = await list({ search: "no such client" });
      expect(response.body.data).toMatchObject({ items: [], total: 0, kpis: { rows: 0, completed: 0, notCompleted: 0, invoiceFilled: 0, totalValue: "0.000", valueMissing: 0 } });
    });

    it("offers filter options from the contracts with visits on the page", async () => {
      const response = await api().get("/api/accounts/options").set(admin.headers);
      expect(response.status).toBe(200);
      expect(response.body.data.clients.map((client: { name: string }) => client.name)).toEqual(["Alpha Towers", "Beta Mall"]);
      expect(response.body.data.salesEngineers.map((engineer: { name: string }) => engineer.name)).toEqual(["Esha Engineer", "Omar Engineer"]);
      expect(response.body.data.years).toEqual([2025, 2027]);
    });
  });

  describe("permissions", () => {
    it("needs view on the schedule and invoices; export needs INVOICES:EXPORT", async () => {
      expect((await list({}, admin)).status).toBe(200);
      expect((await list({}, invoicing)).status).toBe(200);
      expect((await list({}, accountant)).status).toBe(200);
      // Execution may not view invoices; Procurement has no AMC access.
      expect((await list({}, execution)).status).toBe(403);
      expect((await list({}, procurement)).status).toBe(403);
      expect((await api().get("/api/accounts/options").set(execution.headers)).status).toBe(403);
      expect((await api().get("/api/accounts")).status).toBe(401);

      expect((await exportFile({ format: "xlsx" }, accountant)).status).toBe(403);
      expect((await exportFile({ format: "xlsx" }, invoicing)).status).toBe(403);
      expect((await exportFile({ format: "xlsx" }, admin)).status).toBe(200);
    });
  });

  describe("export", () => {
    it("exports every matching visit with the colour, report and invoice numbers, and only the visible columns", async () => {
      const alpha = await visitsOf(fx.alphaContract);
      await complete(alpha[0]!.id);
      await report(alpha[0]!.id, "=SR-1");
      await invoice(fx.alphaId, [[alpha[0]!.id, "405.000"]], "INV-9");

      const response = await exportFile({ format: "xlsx", clientId: fx.alphaId, hidden: "system,salesEngineer" });
      expect(response.status).toBe(200);
      expect(response.headers["content-disposition"]).toMatch(/accounts/);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
      const sheet = workbook.getWorksheet("Accounts") as ExcelJS.Worksheet;
      const header = (sheet.getRow(6).values as unknown[]).slice(1);
      expect(header).toEqual([
        "#",
        "AMC Reference",
        "Client",
        "Frequency",
        "Service",
        "Scheduled Month",
        "Visit Value",
        "Service Status",
        "Service Report No.",
        "Invoice No.",
        "Paid / Unpaid",
        "Row Colour",
      ]);
      const rows = [7, 8, 9, 10].map((n) => (sheet.getRow(n).values as unknown[]).slice(1));
      expect(rows.map((row) => row[2])).toEqual(["Alpha Towers", "Alpha Towers", "Alpha Towers", "Alpha Towers"]);
      expect(rows[0]?.[7]).toBe("Completed");
      // A formula-like number is written as text, never run.
      expect(rows[0]?.[8]).not.toBe("=SR-1");
      expect(String(rows[0]?.[8])).toContain("SR-1");
      expect(String(rows[0]?.[9])).toBe("INV-9");
      expect(rows[0]?.[10]).toBe("Not available");
      expect(rows[0]?.[11]).toBe("Green · Completed, invoice number recorded");
      expect(rows[1]?.[11]).toBe("Red · Service not completed");

      const audit = await pool.query<{ metadata: { rowCount: number; hidden: string[] } }>("SELECT metadata FROM activity_logs WHERE action = 'accounts.exported' ORDER BY id DESC LIMIT 1");
      expect(audit.rows[0]?.metadata).toMatchObject({ rowCount: 4, hidden: ["system", "salesEngineer"] });
    });

    it("produces a PDF for the same filters and refuses an unknown format or column", async () => {
      const pdf = await exportFile({ format: "pdf", clientId: fx.betaId });
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toMatch(/pdf/);
      expect((await exportFile({ format: "csv" })).status).toBe(400);
      expect((await exportFile({ format: "xlsx", hidden: "quotationNo" })).status).toBe(400);
    });
  });
});
