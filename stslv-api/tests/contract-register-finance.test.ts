import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../src/config/database";
import { env } from "../src/config/env";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { HEADER_ROW } from "../src/shared/export/excel";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, contractBody, createClient, createContract, renewalEngineer, today, visitsOf } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// The contract register's totals and columns, contract cancel reasons, renewal notes,
// schedule exports with Paid / Unpaid, and document integrity. All records are invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("test document body\n%%EOF\n")]);

let admin: Session;
let execution: Session;
let folder: string;
let clientId: string;
let otherClientId: string;
let first: string;
let second: string;

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api/amc${url}`).query(query).set(session.headers);
const post = (url: string, body: object, session: Session = admin) => api().post(`/api/amc${url}`).set(session.headers).send(body);
const blob = (url: string, query: Record<string, unknown>, session: Session = admin) => api().get(`/api/amc${url}`).query(query).responseType("blob").set(session.headers);

async function sheetOf(response: { body: Buffer }, name: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);

  return workbook.getWorksheet(name) as ExcelJS.Worksheet;
}

function headers(sheet: ExcelJS.Worksheet): string[] {
  const row = sheet.getRow(HEADER_ROW);

  return Array.from({ length: row.cellCount }, (_cell, index) => String(row.getCell(index + 1).value));
}

function allText(sheet: ExcelJS.Worksheet): string {
  const parts: string[] = [];

  sheet.eachRow((row) => row.eachCell((cell) => parts.push(String(cell.text))));

  return parts.join("\n");
}

const setInvoice = async (visitId: string, invoiceNo: string | null) => {
  const visit = (await get(`/visits/${visitId}`)).body.data;

  return api().patch(`/api/amc/visits/${visitId}/manual-invoice`).set(admin.headers).send({ invoiceNo, expectedUpdatedAt: visit.updatedAt });
};

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "stslv-register-test-"));
  setStorageForTests(new LocalDiskStorage(folder));
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  clientId = await createClient(admin, "Register Hotel");
  otherClientId = await createClient(admin, "Register Tower");
  first = await activeContract(admin, clientId, { systemDescription: "FIRE", contractValue: "1234567.891", finalCredit: "0.001", validFrom: "2027-01-01", validTo: "2027-12-31" });
  second = await activeContract(admin, clientId, { systemDescription: "CCTV", contractValue: "0.109", finalCredit: "0.002", maintenanceFrequency: "HALF_YEARLY", validFrom: "2027-01-01", validTo: "2027-12-31" });
  await activeContract(admin, otherClientId, { systemDescription: "LIFT", contractValue: "100.000", validFrom: "2027-01-01", validTo: "2027-12-31" });
});

afterAll(async () => {
  setStorageForTests(null);
  await rm(folder, { recursive: true, force: true });
  await closePool();
});

describe("the Filtered Total of the contract register", () => {
  it("sums Value and Credit over every contract the filters select, exactly, whatever the page", async () => {
    const filtered = await get("/contracts", { clientId, pageSize: 1 });

    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.total).toBe(2);
    expect(filtered.body.data.totals).toEqual({ contractValue: "1234568.000", finalCredit: "0.003" });

    const all = await get("/contracts", { pageSize: 1, page: 2 });
    expect(all.body.data.totals).toEqual({ contractValue: "1234668.000", finalCredit: "0.003" });
  });

  it("is zero, with three decimals, when nothing matches", async () => {
    const none = await get("/contracts", { search: "no such contract" });

    expect(none.body.data.totals).toEqual({ contractValue: "0.000", finalCredit: "0.000" });
  });

  it("is in the export, with the same figures", async () => {
    const response = await blob("/contracts/export", { format: "xlsx", clientId });
    const sheet = await sheetOf(response, "AMC Contracts");
    const heads = headers(sheet);
    const totalRow = sheet.getRow(HEADER_ROW + 3);

    expect(totalRow.getCell(heads.indexOf("AMC Value / Year") + 1).value).toMatchObject({ result: 1234568 });
    expect(totalRow.getCell(heads.indexOf("Final Credit") + 1).value).toMatchObject({ result: 0.003 });
    expect(allText(sheet)).toContain("Filtered Total (2 contracts)");
  });

  it("leaves hidden columns out of the export, and their totals with them", async () => {
    const response = await blob("/contracts/export", { format: "xlsx", clientId, hidden: "system,validity,finalCredit,visits" });
    const heads = headers(await sheetOf(response, "AMC Contracts"));

    expect(heads).toContain("AMC Reference");
    expect(heads).toContain("AMC Value / Year");
    for (const gone of ["System", "Valid From", "Valid To", "Final Credit", "Visits", "Completed"]) expect(heads).not.toContain(gone);
    expect(allText(await sheetOf(response, "AMC Contracts"))).toContain("Filtered Total");

    const neither = await blob("/contracts/export", { format: "xlsx", clientId, hidden: "contractValue,finalCredit" });
    expect(allText(await sheetOf(neither, "AMC Contracts"))).not.toContain("Filtered Total");
  });

  it("refuses an unknown column", async () => {
    expect((await get("/contracts/export", { format: "xlsx", hidden: "secret" })).status).toBe(400);
  });
});

describe("Contract 360 figures", () => {
  it("names who created and last updated the contract, and gives the first service and interval", async () => {
    const contract = (await get(`/contracts/${second}`)).body.data;

    expect(contract.createdBy).toEqual({ id: admin.id, fullName: expect.any(String) });
    expect(contract.updatedBy).toEqual({ id: admin.id, fullName: expect.any(String) });
    expect(contract.schedule).toMatchObject({ firstServiceDate: "2027-01-01", intervalMonths: 6, servicesPerCycle: 2 });
  });

  it("filters the visit export by contract", async () => {
    const response = await blob("/visits/export", { format: "xlsx", contractId: second });
    const sheet = await sheetOf(response, "AMC Schedule");

    expect(allText(sheet)).toContain("CCTV");
    expect(allText(sheet)).not.toContain("LIFT");
  });
});

describe("cancelling a contract", () => {
  it("needs a reason, changes nothing without one, and keeps the reason in the history", async () => {
    const id = await activeContract(admin, otherClientId, { systemDescription: "PUMP" });
    const before = await visitsOf(id);

    for (const body of [{ status: "CANCELLED" }, { status: "CANCELLED", reason: "   " }, { status: "CANCELLED", reason: null, cancelOpenVisits: true }]) {
      const refused = await post(`/contracts/${id}/status`, body);

      expect(refused.status).toBe(400);
      expect(refused.body.error.details[0]).toMatchObject({ field: "reason" });
    }
    expect((await get(`/contracts/${id}`)).body.data.status).toBe("ACTIVE");
    expect(await visitsOf(id)).toEqual(before);

    expect((await post(`/contracts/${id}/status`, { status: "CANCELLED", reason: "Client closed the site" })).status).toBe(200);
    const history = (await get(`/contracts/${id}/history`)).body.data.items;
    expect(history[0]).toMatchObject({ action: "amc_contract.status_changed", reason: "Client closed the site" });
  });

  it("does not need a reason for other statuses, and checks the permission first", async () => {
    const id = await activeContract(admin, otherClientId, { systemDescription: "GATE" });

    expect((await post(`/contracts/${id}/status`, { status: "CANCELLED" }, execution)).status).toBe(403);
    expect((await post(`/contracts/${id}/status`, { status: "EXPIRED" })).status).toBe(200);
  });
});

describe("renewal notes", () => {
  it("are kept in the activity log of the new contract and shown in its history", async () => {
    const source = await activeContract(admin, otherClientId, { systemDescription: "RENEW ME" });
    const salesEngineerId = await renewalEngineer();
    const response = await post(
      `/contracts/${source}/renewals`,
      contractBody(otherClientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", systemDescription: "RENEW ME", salesEngineerId, renewalNotes: "Client asked for two more sites" })
    );

    expect(response.status).toBe(201);
    const id = response.body.data.id as string;
    const log = await pool.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM activity_logs WHERE action = 'amc_contract.renewal_of' AND entity_id = $1", [id]);
    expect(log.rows[0]?.metadata).toMatchObject({ renewalNotes: "Client asked for two more sites", renewedFromId: source });

    const history = (await get(`/contracts/${id}/history`)).body.data.items;
    expect(history.find((entry: { action: string }) => entry.action === "amc_contract.renewal_of").description).toContain("Renewal notes: Client asked for two more sites");
  });

  it("are optional on a renewal and refused on an ordinary contract", async () => {
    const source = await activeContract(admin, otherClientId, { systemDescription: "RENEW PLAIN" });
    const salesEngineerId = await renewalEngineer();
    const plain = await post(`/contracts/${source}/renewals`, contractBody(otherClientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId }));

    expect(plain.status).toBe(201);
    const log = await pool.query<{ metadata: Record<string, unknown>; description: string }>("SELECT metadata, description FROM activity_logs WHERE action = 'amc_contract.renewal_of' AND entity_id = $1", [plain.body.data.id]);
    expect(log.rows[0]?.metadata).not.toHaveProperty("renewalNotes");
    expect(log.rows[0]?.description).not.toContain("Renewal notes");

    expect((await createContract(admin, otherClientId, { renewalNotes: "Not a renewal" })).status).toBe(400);
  });
});

describe("the contract form's client list", () => {
  it("gives the CL- code", async () => {
    const options = (await get("/contracts/client-options")).body.data as { id: string; code: string; name: string }[];

    expect(options.find((option) => option.id === clientId)).toEqual({ id: clientId, code: `CL-${clientId.padStart(5, "0")}`, name: "Register Hotel" });
  });
});

describe("schedule exports", () => {
  let paidVisit: string;

  beforeAll(async () => {
    paidVisit = (await visitsOf(second))[0]!.id;
    // A manual Invoice No. needs a completed service (2026-11-04).
    expect((await api().patch(`/api/amc/execution/visits/${paidVisit}`).set(admin.headers).send({ status: "COMPLETED", completedDate: await today() })).status).toBe(200);
    expect((await setInvoice(paidVisit, "MAN-777")).status).toBe(200);
  });

  it("list Invoice No. and Paid / Unpaid under Value (Ex VAT), with the reference-status note", async () => {
    const sheet = await sheetOf(await blob("/visits/export", { format: "xlsx", contractId: second }), "AMC Schedule");
    const heads = headers(sheet);

    expect(heads).toEqual(expect.arrayContaining(["Value (Ex VAT)", "Invoice No.", "Paid / Unpaid", "Invoicing (Zoho)"]));
    expect(heads).not.toContain("Amount");
    const row = sheet.getRow(HEADER_ROW + 1);
    expect(row.getCell(heads.indexOf("Invoice No.") + 1).value).toBe("MAN-777");
    expect(row.getCell(heads.indexOf("Paid / Unpaid") + 1).value).toBe("Paid");
    expect(sheet.getRow(HEADER_ROW + 2).getCell(heads.indexOf("Paid / Unpaid") + 1).value).toBe("Unpaid");
    expect(allText(sheet)).toContain("does not verify that money was received");
  });

  it("export only the chosen Paid or Unpaid services", async () => {
    const paid = await sheetOf(await blob("/visits/export", { format: "xlsx", contractId: second, paymentStatus: "PAID" }), "AMC Schedule");

    expect(allText(paid)).toContain("MAN-777");
    expect(allText(paid)).toContain("Total value (1 visit)");
    expect((await get("/visits", { contractId: second, paymentStatus: "UNPAID" })).body.data.total).toBe(1);
  });

  it("show the manual Invoice No. and the Paid mark in the consolidated export, apart from Zoho numbers", async () => {
    const sheet = await sheetOf(await blob("/visits/monthly-consolidated/export", { format: "xlsx", month: "2027-01", clientId }), "Monthly Schedule");
    const heads = headers(sheet);
    const text = allText(sheet);

    expect(heads).toEqual(expect.arrayContaining(["Invoice No.", "Paid / Unpaid", "Zoho Invoice", "Value (Ex VAT)"]));
    expect(heads).not.toContain("Visit Value");
    expect(text).toContain("MAN-777");
    expect(text).toContain("1 Paid, 0 Unpaid");
    expect(text).toContain("Client: Register Hotel");
    expect(text).toContain("does not verify that money was received");

    const list = (await get("/visits/monthly-consolidated", { month: "2027-01", clientId })).body.data;
    const row = list.items.find((item: { id: string }) => item.id === second);
    expect(row.services[0].manualInvoiceNo).toBe("MAN-777");
  });
});

describe("contract documents", () => {
  const upload = (session: Session, file: Buffer, name: string, title = "Signed") =>
    api()
      .post("/api/attachments")
      .query({ entityType: "amc_contracts", entityId: first, category: "SIGNED_CONTRACT", title })
      .set(session.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", encodeURIComponent(name))
      .send(file);
  const versions = (session: Session = admin) => api().get("/api/attachments/versions").query({ entityType: "amc_contracts", entityId: first }).set(session.headers);

  it("lists every version with its integrity and states the limits", async () => {
    const created = await upload(admin, PDF, "signed.pdf");
    expect(created.status).toBe(201);
    const replaced = await api()
      .post(`/api/attachments/${created.body.data.id}/versions`)
      .set(admin.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", "signed-2.pdf")
      .send(Buffer.concat([PDF, Buffer.from("v2")]));
    expect(replaced.status).toBe(201);

    const response = await versions();
    expect(response.status).toBe(200);
    // AMC contracts may also hold Word files (migration 0103).
    expect(response.body.data.limits).toEqual({ maxMb: env.attachmentMaxMb, allowedTypes: ["PDF", "PNG", "JPEG", "Word (.doc)", "Word (.docx)"] });
    // Newest first: both versions of this document, then the contract document the contract was added with.
    expect(response.body.data.items.map((item: { version: number; isCurrent: boolean; integrity: string; title: string }) => [item.title, item.version, item.isCurrent, item.integrity])).toEqual([
      ["Signed", 2, true, "VERIFIED"],
      ["Signed", 1, false, "VERIFIED"],
      ["Contract document", 1, true, "VERIFIED"],
    ]);

    const current = await api().get("/api/attachments").query({ entityType: "amc_contracts", entityId: first }).set(admin.headers);
    expect(current.body.data).toHaveLength(2);
    expect(current.body.data[0]).toMatchObject({ title: "Signed", integrity: "VERIFIED", versionCount: 2 });
  });

  it("reports a changed or missing stored file instead of calling it verified", async () => {
    const stored = await readdir(folder);
    const rows = await pool.query<{ storage_key: string; version: number }>("SELECT storage_key, version FROM attachments WHERE entity_id = $1 AND title = 'Signed' ORDER BY version", [first]);
    expect(stored).toEqual(expect.arrayContaining(rows.rows.map((row) => row.storage_key)));

    await writeFile(path.join(folder, rows.rows[1]!.storage_key), "tampered");
    await rm(path.join(folder, rows.rows[0]!.storage_key));

    const response = await versions();
    expect(response.body.data.items.map((item: { integrity: string }) => item.integrity)).toEqual(["FAILED", "MISSING", "VERIFIED"]);
  });

  it("needs the same permission as the list, and an existing record", async () => {
    const stranger = await signedIn("stranger@example.com", []);

    expect((await versions(stranger)).status).toBe(403);
    expect((await api().get("/api/attachments/versions").query({ entityType: "amc_contracts", entityId: first })).status).toBe(401);
    expect((await api().get("/api/attachments/versions").query({ entityType: "amc_contracts", entityId: "99999999" }).set(admin.headers)).status).toBe(404);
  });
});

describe("the attachment size limit", () => {
  it("defaults to 12 MB in the code and the example settings", () => {
    expect(readFileSync(path.join(__dirname, "../src/config/env.ts"), "utf8")).toContain('readWholeNumber("ATTACHMENT_MAX_MB", 12, 1, 50)');
    expect(readFileSync(path.join(__dirname, "../.env.example"), "utf8")).toContain("ATTACHMENT_MAX_MB=12");
  });
});
