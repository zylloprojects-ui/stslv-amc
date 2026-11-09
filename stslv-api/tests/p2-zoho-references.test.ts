import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zohoReferencesCell } from "../src/modules/amc/master-status.export";
import { HEADER_ROW } from "../src/shared/export/excel";
import { activeContract, createClient, testReference, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { invoiceBody, newInvoice } from "./invoices-helpers";

// Approved 2026-11-09: the Master AMC Status export carries both the Zoho invoice numbers and, in a separate column,
// their Zoho references (Invoice Tracking "Zoho reference"), each reference beside its own invoice. Own data, so the
// invoices added here never reach the other export tests.

let admin: Session;
let viewer: Session;
let clientId: string;
let visitIds: string[];

const file = (query: Record<string, unknown>, session: Session = admin) =>
  api().get("/api/amc/master-status/export").query(query).set(session.headers).responseType("blob");

async function sheetOf(query: Record<string, unknown>) {
  const response = await file(query);
  expect(response.status).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
  return workbook.getWorksheet("Master AMC Status") as ExcelJS.Worksheet;
}
const headerOf = (sheet: ExcelJS.Worksheet) => (sheet.getRow(HEADER_ROW).values as unknown[]).slice(1);
const rowOf = (sheet: ExcelJS.Worksheet, n: number) => (sheet.getRow(HEADER_ROW + n).values as unknown[]).slice(1);

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@p2-zoho-ref.example.com", ["ADMIN"]);
  viewer = await signedIn("viewer@p2-zoho-ref.example.com", ["VIEWER"]);
  clientId = await createClient(admin, "Zoho Reference Hotel");
  const contractId = await activeContract(admin, clientId, {
    amcReference: testReference("P2ZREF"),
    clientId,
    systemDescription: "FIRE",
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    contractValue: "1200.000",
    maintenanceFrequency: "QUARTERLY",
    defaultVisitAmount: "300.000",
    status: "ACTIVE",
  });
  const visits = await visitsOf(contractId);
  visitIds = visits.map((visit) => visit.id);
  const day = await today();

  for (const id of visitIds.slice(0, 2)) {
    await withServiceReport(id);
    expect((await api().patch(`/api/amc/execution/visits/${id}`).set(admin.headers).send({ status: "COMPLETED", completedDate: day })).status).toBe(200);
  }
  // First service: one invoice with a reference. Second service: two invoices, the later without a reference.
  await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visitIds[0]!, amount: "300.000" }], { invoiceNumber: "ZB-10042", sourceReference: "ZREF-0042", amountExclVat: "300.000", vatAmount: "15.000", invoiceDate: day }));
  await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visitIds[1]!, amount: "150.000" }], { invoiceNumber: "ZB-10050", sourceReference: "ZREF-0050", amountExclVat: "150.000", vatAmount: "7.500", invoiceDate: day }));
  await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visitIds[1]!, amount: "150.000" }], { invoiceNumber: "ZB-10051", amountExclVat: "150.000", vatAmount: "7.500", invoiceDate: day }));
});
afterAll(closePool);

describe("Master AMC Status export: Zoho invoice numbers and Zoho references", () => {
  it("exports the references in their own column, each beside its own invoice number", async () => {
    const sheet = await sheetOf({ format: "xlsx", clientId });
    const header = headerOf(sheet);
    const invoiceNo = header.indexOf("Invoice No.");
    const numbers = header.indexOf("Zoho Invoices (Tracking)");
    const references = header.indexOf("Zoho References (Tracking)");
    expect([numbers, references]).toEqual([invoiceNo + 1, invoiceNo + 2]);

    expect(String(rowOf(sheet, 1)[numbers])).toBe("ZB-10042");
    expect(String(rowOf(sheet, 1)[references])).toBe("ZREF-0042");
    expect(String(rowOf(sheet, 2)[numbers])).toBe("ZB-10050, ZB-10051");
    expect(String(rowOf(sheet, 2)[references])).toBe("ZREF-0050, —");
    // A service with no Zoho invoice has neither.
    expect(rowOf(sheet, 3)[numbers] ?? null).toBeNull();
    expect(rowOf(sheet, 3)[references] ?? null).toBeNull();

    const text: string[] = [];
    sheet.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value))));
    expect(text.join(" ")).toMatch(/Zoho References \(Tracking\) are those invoices' Zoho references/);
  });

  it("gives the page the same references, in the order of the numbers", async () => {
    const page = await api().get(`/api/amc/master-status?clientId=${clientId}`).set(admin.headers);
    const items = page.body.data.items as { id: string; invoiceNumbers: string[]; invoiceReferences: (string | null)[] }[];
    expect(items.find((item) => item.id === visitIds[0])).toMatchObject({ invoiceNumbers: ["ZB-10042"], invoiceReferences: ["ZREF-0042"] });
    expect(items.find((item) => item.id === visitIds[1])).toMatchObject({ invoiceNumbers: ["ZB-10050", "ZB-10051"], invoiceReferences: ["ZREF-0050", null] });
    expect(items.find((item) => item.id === visitIds[2])).toMatchObject({ invoiceNumbers: [], invoiceReferences: [] });
  });

  it("hides both Zoho columns with Invoice No., writes the PDF, and keeps the export permission", async () => {
    const header = headerOf(await sheetOf({ format: "xlsx", clientId, hidden: "invoiceNo" }));
    expect(header).not.toContain("Zoho Invoices (Tracking)");
    expect(header).not.toContain("Zoho References (Tracking)");
    const pdf = await file({ format: "pdf", clientId });
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect((await file({ format: "xlsx", clientId }, viewer)).status).toBe(403);
  });

  it("writes the references exactly as recorded, with — only to keep them aligned", () => {
    expect(zohoReferencesCell([])).toBeNull();
    expect(zohoReferencesCell([null, null])).toBeNull();
    expect(zohoReferencesCell(["A-1"])).toBe("A-1");
    expect(zohoReferencesCell([null, "B-2", null])).toBe("—, B-2, —");
  });
});
