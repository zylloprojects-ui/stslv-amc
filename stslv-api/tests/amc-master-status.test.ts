import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, today, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { cancelInvoice, invoiceBody, newInvoice } from "./invoices-helpers";

// Master AMC Status: a read-only overview over amc_visits, invoices (0060) and quotation numbers (0078).

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
  invoiceNumbers: string[];
  quotationNo: string | null;
  contract: { id: string };
};

const list = (query: Record<string, unknown> = {}, session: Session = admin) => api().get("/api/amc/master-status").query({ pageSize: 200, ...query }).set(session.headers);
const exportFile = (query: Record<string, unknown>, session: Session = admin) =>
  api().get("/api/amc/master-status/export").query(query).set(session.headers).responseType("blob");

async function complete(visitId: string): Promise<void> {
  const response = await api().patch(`/api/amc/execution/visits/${visitId}`).set(admin.headers).send({ status: "COMPLETED", completedDate: await today() });
  if (response.status !== 200) throw new Error(`Could not complete visit ${visitId}: ${response.status} ${JSON.stringify(response.body)}`);
}

async function quote(visitId: string, quotationNo: string): Promise<void> {
  // Recorded through Services Sales, the only place a quotation number is written.
  const current = await api().get("/api/services-sales").query({ pageSize: 200 }).set(admin.headers);
  const item = (current.body.data.items as { id: string; updatedAt: string }[]).find((row) => row.id === visitId);
  const response = await api().patch(`/api/services-sales/${visitId}`).set(admin.headers).send({ quotationNo, expectedUpdatedAt: item?.updatedAt });
  if (response.status !== 200) throw new Error(`Could not quote visit ${visitId}: ${response.status} ${JSON.stringify(response.body)}`);
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

describe("Master AMC Status", () => {
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
    it("lists one row per scheduled visit, linked to its own contract, never one per contract", async () => {
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
        invoiceNumbers: [],
        quotationNo: null,
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
      expect((await api().patch(`/api/amc/master-status/${first!.id}`).set(admin.headers).send({})).status).toBe(404);
    });
  });

  describe("colour classification", () => {
    it("classifies Red, Yellow, Blue and Green in priority order, and the cards add up to the rows", async () => {
      const [red, yellow, blue, green] = await visitsOf(fx.alphaContract);
      for (const visit of [yellow, blue, green]) await complete(visit!.id);
      const blueInvoice = await invoice(fx.alphaId, [[blue!.id, "405.000"]]);
      const greenInvoice = await invoice(fx.alphaId, [[green!.id, "405.000"]]);
      await quote(green!.id, "QT-100");

      const response = await list({ clientId: fx.alphaId });
      const rows = byId(response.body.data.items);
      expect(rows.get(red!.id)).toMatchObject({ colour: "RED", invoiceNumbers: [], quotationNo: null });
      expect(rows.get(yellow!.id)).toMatchObject({ colour: "YELLOW", serviceStatus: "COMPLETED", invoiceNumbers: [] });
      expect(rows.get(blue!.id)).toMatchObject({ colour: "BLUE", invoiceNumbers: [blueInvoice.invoiceNumber], quotationNo: null });
      expect(rows.get(green!.id)).toMatchObject({ colour: "GREEN", invoiceNumbers: [greenInvoice.invoiceNumber], quotationNo: "QT-100" });
      expect(response.body.data.kpis).toMatchObject({ total: 4, green: 1, blue: 1, yellow: 1, red: 1 });
    });

    it("keeps a completed visit with a quotation but no invoice Yellow: the invoice rule comes first", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await quote(first!.id, "QT-200");

      const row = byId((await list({ clientId: fx.alphaId })).body.data.items).get(first!.id);
      expect(row).toMatchObject({ colour: "YELLOW", quotationNo: "QT-200", invoiceNumbers: [] });
    });

    it("shows Waiting for Renewal unchanged and counts it Red", async () => {
      const response = await list({ clientId: fx.betaId, year: 2025 });
      const items = response.body.data.items as Item[];
      expect(items).toHaveLength(4);
      for (const item of items) expect(item).toMatchObject({ serviceStatus: "WAITING_FOR_RENEWAL", colour: "RED" });
      expect(response.body.data.kpis).toMatchObject({ total: 4, red: 4 });
    });

    it("ignores a cancelled invoice, and lists every active invoice of a visit", async () => {
      const [first, second] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await complete(second!.id);
      const cancelled = await invoice(fx.alphaId, [[first!.id, "405.000"]]);
      expect((await cancelInvoice(admin, cancelled.id)).status).toBe(200);
      const partOne = await invoice(fx.alphaId, [[second!.id, "200.000"]]);
      const partTwo = await invoice(fx.alphaId, [[second!.id, "205.000"]]);

      const rows = byId((await list({ clientId: fx.alphaId })).body.data.items);
      expect(rows.get(first!.id)).toMatchObject({ colour: "YELLOW", invoiceNumbers: [] });
      expect(rows.get(second!.id)?.invoiceNumbers.sort()).toEqual([partOne.invoiceNumber, partTwo.invoiceNumber].sort());
      expect(rows.get(second!.id)?.colour).toBe("BLUE");
    });
  });

  describe("visit value", () => {
    it("totals the visit values of the selected rows exactly, and counts rows without a value", async () => {
      const response = await list({ year: 2027 });
      // Four alpha visits of 405.000 and two beta visits of 400.000.
      expect(response.body.data.kpis).toMatchObject({ total: 6, totalValue: "2420.000", valueMissing: 0 });

      const [first] = await visitsOf(fx.alphaContract);
      await pool.query("UPDATE amc_visits SET visit_amount = NULL WHERE id = $1", [first!.id]);
      await pool.query("UPDATE amc_visits SET visit_amount = 0.001 WHERE amc_contract_id = $1 AND sequence_no = 2", [fx.alphaContract]);

      const after = await list({ year: 2027 });
      expect(byId(after.body.data.items).get(first!.id)?.visitValue).toBeNull();
      expect(after.body.data.kpis).toMatchObject({ totalValue: "1610.001", valueMissing: 1 });
    });
  });

  describe("filters", () => {
    it("applies every filter together, and the cards follow the same filters", async () => {
      const alpha = await visitsOf(fx.alphaContract);
      await complete(alpha[0]!.id);
      await complete(alpha[1]!.id);
      const inv = await invoice(fx.alphaId, [[alpha[1]!.id, "405.000"]], "ZB-7781");
      await quote(alpha[0]!.id, "QT-55");

      // Each filter on its own.
      expect((await list({ clientId: fx.betaId })).body.data.total).toBe(6);
      expect((await list({ salesEngineerId: fx.esha })).body.data.total).toBe(4);
      expect((await list({ year: 2025 })).body.data.total).toBe(4);
      expect((await list({ serviceStatus: "COMPLETED" })).body.data.total).toBe(2);
      expect((await list({ serviceStatus: "WAITING_FOR_RENEWAL" })).body.data.total).toBe(4);
      expect((await list({ colour: "BLUE" })).body.data.items.map((item: Item) => item.id)).toEqual([alpha[1]!.id]);
      expect((await list({ colour: "YELLOW" })).body.data.items.map((item: Item) => item.id)).toEqual([alpha[0]!.id]);

      // Search: invoice number, quotation number, AMC reference and client.
      expect((await list({ search: "zb-77" })).body.data.items.map((item: Item) => item.invoiceNumbers)).toEqual([[inv.invoiceNumber]]);
      expect((await list({ search: "QT-55" })).body.data.items.map((item: Item) => item.id)).toEqual([alpha[0]!.id]);
      expect((await list({ search: `AMC-${fx.alphaContract.padStart(4, "0")}` })).body.data.total).toBe(4);
      expect((await list({ search: "beta" })).body.data.total).toBe(6);

      // Together (AND), with the cards over the same rows.
      const month = Number(alpha[1]!.scheduled_date.slice(5, 7));
      const combined = await list({ clientId: fx.alphaId, salesEngineerId: fx.esha, year: 2027, month, serviceStatus: "COMPLETED", colour: "BLUE", search: "ZB" });
      expect(combined.body.data.items.map((item: Item) => item.id)).toEqual([alpha[1]!.id]);
      expect(combined.body.data.kpis).toEqual({ total: 1, green: 0, blue: 1, yellow: 0, red: 0, totalValue: "405.000", valueMissing: 0 });
      expect((await list({ clientId: fx.betaId, colour: "BLUE" })).body.data.kpis).toMatchObject({ total: 0, totalValue: "0.000" });
    });

    it("rejects unknown filter values", async () => {
      expect((await list({ colour: "PURPLE" })).status).toBe(400);
      expect((await list({ month: 13 })).status).toBe(400);
      expect((await list({ serviceStatus: "DONE" })).status).toBe(400);
    });

    it("pages the rows while the total and cards cover every matching visit", async () => {
      const response = await list({ pageSize: 3, page: 2 });
      expect(response.body.data.items).toHaveLength(3);
      expect(response.body.data.total).toBe(10);
      expect(response.body.data.kpis.total).toBe(10);
    });

    it("offers filter options from the contracts with visits on the page", async () => {
      const response = await api().get("/api/amc/master-status/options").set(admin.headers);
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({
        clients: [
          { id: fx.alphaId, name: "Alpha Towers" },
          { id: fx.betaId, name: "Beta Mall" },
        ],
        salesEngineers: [
          { id: fx.esha, name: "Esha Engineer" },
          { id: fx.omar, name: "Omar Engineer" },
        ],
        years: [2025, 2027],
      });
    });
  });

  describe("permissions", () => {
    it("needs view on the schedule, invoices and services sales; export stays with Admin", async () => {
      expect((await list({}, admin)).status).toBe(200);
      expect((await list({}, invoicing)).status).toBe(200);
      expect((await list({}, accountant)).status).toBe(200);
      // Execution may not view invoices; Procurement has no AMC access.
      expect((await list({}, execution)).status).toBe(403);
      expect((await list({}, procurement)).status).toBe(403);
      expect((await api().get("/api/amc/master-status/options").set(execution.headers)).status).toBe(403);
      expect((await api().get("/api/amc/master-status")).status).toBe(401);

      expect((await exportFile({ format: "xlsx" }, accountant)).status).toBe(403);
      expect((await exportFile({ format: "xlsx" }, invoicing)).status).toBe(403);
      expect((await exportFile({ format: "xlsx" }, execution)).status).toBe(403);
      expect((await exportFile({ format: "xlsx" }, admin)).status).toBe(200);
    });
  });

  describe("export", () => {
    it("exports every matching visit with the colour, invoice and quotation, and only the visible columns", async () => {
      const alpha = await visitsOf(fx.alphaContract);
      await complete(alpha[0]!.id);
      await invoice(fx.alphaId, [[alpha[0]!.id, "405.000"]], "INV-9");
      await quote(alpha[0]!.id, "=QT-1");

      const response = await exportFile({ format: "xlsx", clientId: fx.alphaId, hidden: "system,salesEngineer" });
      expect(response.status).toBe(200);
      expect(response.headers["content-disposition"]).toMatch(/master-amc-status/);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
      const sheet = workbook.getWorksheet("Master AMC Status") as ExcelJS.Worksheet;
      const header = (sheet.getRow(6).values as unknown[]).slice(1);
      expect(header).toEqual(["#", "AMC Reference", "Client", "Frequency", "Service", "Scheduled Month", "Visit Value", "Service Status", "Invoice No.", "Quote No.", "Row Colour"]);
      const rows = [7, 8, 9, 10].map((n) => (sheet.getRow(n).values as unknown[]).slice(1));
      expect(rows.map((row) => row[2])).toEqual(["Alpha Towers", "Alpha Towers", "Alpha Towers", "Alpha Towers"]);
      expect(rows[0]?.[7]).toBe("Completed");
      expect(String(rows[0]?.[8])).toBe("INV-9");
      // A formula-like number is written as text, never run.
      expect(rows[0]?.[9]).not.toBe("=QT-1");
      expect(String(rows[0]?.[9])).toContain("QT-1");
      expect(rows[0]?.[10]).toBe("Green · Invoiced and quoted");
      expect(rows[1]?.[10]).toBe("Red · Not completed");

      const audit = await pool.query<{ metadata: { rowCount: number; hidden: string[] } }>(
        "SELECT metadata FROM activity_logs WHERE action = 'master_amc_status.exported' ORDER BY id DESC LIMIT 1"
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ rowCount: 4, hidden: ["system", "salesEngineer"] });
    });

    it("produces a PDF for the same filters and refuses an unknown format or column", async () => {
      const response = await exportFile({ format: "pdf", colour: "RED" });
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/pdf");
      expect((response.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      expect((await exportFile({ format: "csv" })).status).toBe(400);
      expect((await exportFile({ format: "xlsx", hidden: "reference" })).status).toBe(400);
    });
  });
});
