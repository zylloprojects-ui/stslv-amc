import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { HEADER_ROW } from "../src/shared/export/excel";
import { activeContract, contractBody, createClient, renewalEngineer, testReference, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { invoiceBody, newInvoice } from "./invoices-helpers";

// P2 (2026-11-09): Zoho invoice numbers on the Master AMC Status export; the Recent Invoices
// export with only the Dashboard's visible columns; the contract's Recycle Bin dependency check.

let admin: Session;
let administrator: Session;
let viewer: Session;
let clientId: string;
let contractId: string;
let zohoNumber: string;

const file = (path: string, query: Record<string, unknown>, session: Session = admin) => api().get(path).query(query).set(session.headers).responseType("blob");
const get = (path: string, session: Session = admin) => api().get(path).set(session.headers);
const contract = (overrides: Record<string, unknown> = {}) => ({ amcReference: testReference("P2EXP"), clientId, systemDescription: "FIRE", validFrom: "2027-01-01", validTo: "2027-12-31", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "300.000", status: "ACTIVE", ...overrides });

async function workbookOf(response: { body: Buffer }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
  return workbook;
}
const headerOf = (sheet: ExcelJS.Worksheet) => (sheet.getRow(HEADER_ROW).values as unknown[]).slice(1);
const cellsOf = (sheet: ExcelJS.Worksheet) => {
  const values: string[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => values.push(String(cell.value))));
  return values;
};

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@p2exp.example.com", ["ADMIN"]);
  administrator = await signedIn("administrator@p2exp.example.com", ["ADMINISTRATOR"]);
  viewer = await signedIn("viewer@p2exp.example.com", ["VIEWER"]);
  clientId = await createClient(admin, "P2 Export Hotel");
  contractId = await activeContract(admin, clientId, contract());
  const [first] = await visitsOf(contractId);
  await withServiceReport(first!.id);
  expect((await api().patch(`/api/amc/execution/visits/${first!.id}`).set(admin.headers).send({ status: "COMPLETED", completedDate: await today() })).status).toBe(200);
  zohoNumber = (await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: first!.id, amount: "300.000" }], { invoiceNumber: "ZB-00042", amountExclVat: "300.000", vatAmount: "15.000", invoiceDate: await today() }))).invoiceNumber;
});
afterAll(closePool);

describe("Master AMC Status export: Zoho invoice numbers", () => {
  it("lists the Zoho invoice numbers of each service beside Invoice No.", async () => {
    const response = await file("/api/amc/master-status/export", { format: "xlsx", clientId });
    expect(response.status).toBe(200);
    const sheet = (await workbookOf(response)).getWorksheet("Master AMC Status") as ExcelJS.Worksheet;
    const header = headerOf(sheet);
    const zoho = header.indexOf("Zoho Invoices (Tracking)");
    expect(zoho).toBe(header.indexOf("Invoice No.") + 1);
    const firstRow = (sheet.getRow(HEADER_ROW + 1).values as unknown[]).slice(1);
    expect(String(firstRow[zoho])).toBe(zohoNumber);
    expect(cellsOf(sheet).join(" ")).toMatch(/do not decide Paid or Unpaid/);
  });


  it("hides the Zoho columns together with Invoice No., and still writes the PDF", async () => {
    const hidden = await file("/api/amc/master-status/export", { format: "xlsx", clientId, hidden: "invoiceNo" });
    const header = headerOf((await workbookOf(hidden)).getWorksheet("Master AMC Status") as ExcelJS.Worksheet);
    expect(header).not.toContain("Invoice No.");
    expect(header).not.toContain("Zoho Invoices (Tracking)");
    expect(header).not.toContain("Zoho References (Tracking)");
    const pdf = await file("/api/amc/master-status/export", { format: "pdf", clientId });
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("Recent Invoices export: visible columns only", () => {
  it("writes exactly the visible columns, in the table's order, and records them in the audit log", async () => {
    const response = await file("/api/invoices/export", { format: "xlsx", columns: "total,number,status" });
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/recent-invoices/);
    const workbook = await workbookOf(response);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Recent Invoices"]);
    const sheet = workbook.worksheets[0]!;
    expect(headerOf(sheet)).toEqual(["Invoice no.", "Total", "Status"]);
    const row = (sheet.getRow(HEADER_ROW + 1).values as unknown[]).slice(1);
    expect(String(row[0])).toBe("ZB-00042");
    expect(Number(row[1])).toBeCloseTo(315, 3);
    expect(cellsOf(sheet).join(" ")).not.toMatch(/P2 Export Hotel/);

    const audit = await pool.query<{ metadata: { columns: string[]; rowCount: number } }>("SELECT metadata FROM activity_logs WHERE action = 'invoices.exported' ORDER BY id DESC LIMIT 1");
    expect(audit.rows[0]?.metadata).toMatchObject({ columns: ["number", "total", "status"], rowCount: 1 });
  });

  it("writes a PDF, works without Status or Total, and refuses unknown or empty column lists", async () => {
    const pdf = await file("/api/invoices/export", { format: "pdf", columns: "number,client,date,total,status" });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    const narrow = await file("/api/invoices/export", { format: "xlsx", columns: "client" });
    expect(narrow.status).toBe(200);
    expect(headerOf((await workbookOf(narrow)).worksheets[0]!)).toEqual(["Client"]);
    expect((await file("/api/invoices/export", { format: "xlsx", columns: "number,covers" })).status).toBe(400);
    expect((await file("/api/invoices/export", { format: "xlsx", columns: "" })).status).toBe(400);
  });

  it("leaves the full Invoice Tracking Report unchanged when no columns are given", async () => {
    const workbook = await workbookOf(await file("/api/invoices/export", { format: "xlsx" }));
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Invoices", "Allocations"]);
    expect(headerOf(workbook.worksheets[0]!)).toContain("Covers");
  });

  it("keeps the export permission: View alone is refused", async () => {
    expect((await file("/api/invoices/export", { format: "xlsx", columns: "number" }, viewer)).status).toBe(403);
  });
});

describe("Contract Recycle Bin dependency check", () => {
  it("shows what is kept, and that nothing blocks a contract without a renewal", async () => {
    const usage = await get(`/api/amc/contracts/${contractId}/usage`);
    expect(usage.status).toBe(200);
    expect(usage.body.data).toMatchObject({ services: { total: 4, completed: 1, open: 3, cancelled: 0, historical: 0 }, paidServices: 0, invoices: 1, renewal: null, renewedFrom: null, blockedReason: null });
  });

  it("names the renewal that blocks the move, exactly as the move itself refuses it", async () => {
    const source = await activeContract(admin, clientId, contract({ systemDescription: "RENEWED", validFrom: addDays(await today(), -300), validTo: addDays(await today(), 20) }));
    const renewal = await api()
      .post(`/api/amc/contracts/${source}/renewals`)
      .set(admin.headers)
      .send(contractBody(clientId, { validFrom: addDays(await today(), 21), validTo: addDays(await today(), 380), status: "DRAFT", salesEngineerId: await renewalEngineer() }));
    expect(renewal.status).toBe(201);

    const usage = (await get(`/api/amc/contracts/${source}/usage`)).body.data;
    expect(usage.renewal).toMatchObject({ id: renewal.body.data.id });
    expect(usage.blockedReason).toMatch(/was renewed as/);
    const refused = await api().delete(`/api/amc/contracts/${source}`).set(admin.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain(usage.renewal.reference);

    // The renewal knows its source, and moving the renewal is not blocked.
    const renewalUsage = (await get(`/api/amc/contracts/${renewal.body.data.id}/usage`)).body.data;
    expect(renewalUsage).toMatchObject({ renewedFrom: { id: source }, blockedReason: null });
  });

  it("is Super Admin only, like the move, and changes nothing", async () => {
    expect((await get(`/api/amc/contracts/${contractId}/usage`, administrator)).status).toBe(403);
    expect((await get(`/api/amc/contracts/${contractId}/usage`, viewer)).status).toBe(403);
    expect((await api().get(`/api/amc/contracts/${contractId}/usage`)).status).toBe(401);
    expect((await get("/api/amc/contracts/99999999/usage")).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM amc_contracts WHERE id = $1", [contractId])).rowCount).toBe(1);
  });
});
