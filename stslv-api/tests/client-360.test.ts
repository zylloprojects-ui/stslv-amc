import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { clientCode } from "../src/modules/clients/clients.service";
import { HEADER_ROW } from "../src/shared/export/excel";
import { activeContract, contractBody, createClient, grant, type Session } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { cancelInvoice, completeVisit, invoiceBody, newInvoice } from "./invoices-helpers";
import { resetProjectData } from "./projects-helpers";

// Client codes, the client list export and the Client 360 figures. Every client and figure here is invented.

let admin: Session;
let accountant: Session; // CLIENTS, AMC_CONTRACTS, AMC_SCHEDULE and INVOICES: VIEW only
let execution: Session; // no INVOICES
let procurement: Session; // CLIENTS:VIEW only, later given CLIENTS:EXPORT
let clientId: string;
let otherClientId: string;
let pastContract: string;

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);

  clientId = await createClient(admin, "Summary Test Hotel");
  otherClientId = await createClient(admin, "Other Test Mall");

  // Twelve monthly visits through 2025 at 405.000: all in the past.
  pastContract = await activeContract(admin, clientId, {
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    maintenanceFrequency: "MONTHLY",
    contractValue: "4860.000",
    defaultVisitAmount: "405.000",
    finalCredit: "100.000",
  });
  // Four quarterly visits far ahead.
  await activeContract(admin, clientId, { validFrom: "2030-01-01", validTo: "2030-12-31", contractValue: "1620.000" });
  // A draft and a cancelled contract.
  await api().post("/api/amc/contracts").set(admin.headers).send(contractBody(clientId, { contractValue: "500.000" }));
  const cancelled = await api().post("/api/amc/contracts").set(admin.headers).send(contractBody(clientId, { contractValue: "9000.000" }));
  await api().post(`/api/amc/contracts/${cancelled.body.data.id}/status`).set(admin.headers).send({ status: "CANCELLED" });
  // Another client's contract is never counted.
  await activeContract(admin, otherClientId, { contractValue: "7777.000" });

  const visits = await pool.query<{ id: string }>("SELECT id FROM amc_visits WHERE amc_contract_id = $1 ORDER BY period_start", [pastContract]);
  const visitId = (index: number) => visits.rows[index]?.id as string;

  for (const index of [0, 1, 2]) {
    await completeVisit(admin, visitId(index));
  }
  await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visitId(0), amount: "405.000" }], { invoiceDate: "2026-09-01", vatAmount: "20.250" }));
  const voided = await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visitId(1), amount: "405.000" }], { invoiceDate: "2026-09-10" }));
  await cancelInvoice(admin, voided.id);
});
afterAll(closePool);

const summaryOf = (id: string, session: Session = admin) => api().get(`/api/clients/${id}/summary`).set(session.headers);

describe("client code", () => {
  it("is derived from the id, padded to five digits, and never cut", () => {
    expect(clientCode("1")).toBe("CL-00001");
    expect(clientCode("42")).toBe("CL-00042");
    expect(clientCode("123456")).toBe("CL-123456");
  });

  it("is returned with every client and can be searched for", async () => {
    const fetched = (await api().get(`/api/clients/${clientId}`).set(admin.headers)).body.data;
    expect(fetched.code).toBe(clientCode(clientId));

    const byCode = await api().get("/api/clients").query({ search: clientCode(clientId) }).set(admin.headers);
    expect(byCode.body.data.items.map((item: { id: string }) => item.id)).toEqual([clientId]);

    const lower = await api().get("/api/clients").query({ search: clientCode(clientId).toLowerCase() }).set(admin.headers);
    expect(lower.body.data.total).toBe(1);
  });
});

describe("Client 360 figures", () => {
  it("counts contracts and sums their values from the stored contracts of this client only", async () => {
    const summary = (await summaryOf(clientId)).body.data;

    expect(summary.contracts).toEqual({
      total: 4,
      active: 2,
      draft: 1,
      expired: 0,
      cancelled: 1,
      activeValue: "6480.000",
      nonCancelledValue: "6980.000",
      finalCreditTotal: "100.000",
      finalCreditRecorded: 1,
    });
    expect(summary.paymentTracking).toBe(false);
  });

  it("counts visits by state and the visits ready for invoice", async () => {
    const { visits } = (await summaryOf(clientId)).body.data;

    // 12 past monthly visits: 3 completed, 9 overdue. 4 quarterly visits in 2030 are upcoming.
    expect(visits).toEqual({ upcoming: 4, overdue: 9, completed: 3, readyForInvoice: 2, nextVisitDate: expect.stringMatching(/^2030-/) });
  });

  it("sums issued invoices and leaves cancelled ones out", async () => {
    const { invoices } = (await summaryOf(clientId)).body.data;

    expect(invoices).toEqual({ issued: 1, cancelled: 1, issuedExclVat: "405.000", issuedTotal: "425.250", lastInvoiceDate: "2026-09-01" });
  });

  it("lists active contracts whose validity has ended or ends within the renewal window", async () => {
    const { renewals } = (await summaryOf(clientId)).body.data;

    expect(renewals.windowDays).toBe(90);
    expect(renewals.total).toBe(1);
    expect(renewals.items[0]).toMatchObject({ id: pastContract, validTo: "2025-12-31" });
    expect(renewals.items[0].daysLeft).toBeLessThan(0);
  });

  it("gives zeros for a client with no records and 404 for an unknown client", async () => {
    const empty = await createClient(admin, "Empty Test Client");
    const summary = (await summaryOf(empty)).body.data;

    expect(summary.contracts).toMatchObject({ total: 0, activeValue: "0.000" });
    expect(summary.invoices).toMatchObject({ issued: 0, issuedTotal: "0.000", lastInvoiceDate: null });
    expect(summary.visits).toMatchObject({ upcoming: 0, nextVisitDate: null });
    expect((await summaryOf("999999")).status).toBe(404);
  });

  it("leaves out each section the role cannot see", async () => {
    const withoutInvoices = (await summaryOf(clientId, execution)).body.data;
    expect(withoutInvoices.invoices).toBeNull();
    expect(withoutInvoices.contracts).not.toBeNull();

    const clientsOnly = (await summaryOf(clientId, procurement)).body.data;
    expect(clientsOnly).toMatchObject({ contracts: null, renewals: null, visits: null, invoices: null });

    expect((await summaryOf(clientId, accountant)).body.data.invoices).not.toBeNull();
  });
});

const download = (path: string, query: Record<string, unknown>, session: Session = admin) =>
  api().get(path).query(query).responseType("blob").set(session.headers);

async function sheetOf(response: { body: Buffer }, name: string): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);

  return workbook.getWorksheet(name) as ExcelJS.Worksheet;
}

describe("client list export", () => {
  it("needs CLIENTS:EXPORT on top of CLIENTS:VIEW", async () => {
    expect((await download("/api/clients/export", { format: "xlsx" }, accountant)).status).toBe(403);
    expect((await download("/api/clients/export", { format: "xlsx" }, procurement)).status).toBe(403);

    await grant("PROCUREMENT", [["CLIENTS", "EXPORT"]]);
    expect((await download("/api/clients/export", { format: "xlsx" }, procurement)).status).toBe(200);
  });

  it("applies the list's filters and writes codes, statuses and the type", async () => {
    await api().post(`/api/clients/${otherClientId}/deactivate`).set(admin.headers);

    const active = await sheetOf(await download("/api/clients/export", { format: "xlsx", status: "active", search: "Summary" }), "Clients");
    expect(active.getRow(HEADER_ROW).getCell(1).value).toBe("Client code");
    expect(active.getRow(HEADER_ROW + 1).getCell(1).value).toBe(clientCode(clientId));
    expect(active.getRow(HEADER_ROW + 1).getCell(2).value).toBe("Summary Test Hotel");
    expect(active.getRow(HEADER_ROW + 1).getCell(3).value).toBe("Company");
    expect(active.getRow(HEADER_ROW + 2).getCell(1).value).not.toBe(clientCode(otherClientId));

    const disabled = await sheetOf(await download("/api/clients/export", { format: "xlsx", status: "inactive" }), "Clients");
    expect(disabled.getRow(HEADER_ROW + 1).getCell(2).value).toBe("Other Test Mall");
    expect(disabled.getRow(HEADER_ROW + 1).getCell(8).value).toBe("Disabled");
  });

  it("says once that nothing matched, without a count of zero", async () => {
    const sheet = await sheetOf(await download("/api/clients/export", { format: "xlsx", status: "all", search: "No Such Client" }), "Clients");
    const texts = Array.from({ length: 6 }, (_, index) => sheet.getRow(HEADER_ROW + 1 + index).getCell(1).value);

    expect(texts).toContain("No records match the selected filters.");
    expect(texts).not.toContain("0 clients.");
  });

  it("is produced as a PDF and records the export", async () => {
    const pdf = await download("/api/clients/export", { format: "pdf", status: "all" });

    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await download("/api/clients/export", { format: "csv" })).status).toBe(400);

    const logged = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'clients.exported' AND user_id = $1", [admin.id]);
    expect(logged.rowCount).toBeGreaterThan(0);
  });
});

describe("client contracts export", () => {
  it("needs AMC_CONTRACTS:EXPORT and lists only this client's contracts with a total excluding cancelled", async () => {
    expect((await download(`/api/clients/${clientId}/contracts/export`, { format: "xlsx" }, accountant)).status).toBe(403);

    const response = await download(`/api/clients/${clientId}/contracts/export`, { format: "xlsx" });
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain(`client-contracts-${clientCode(clientId).toLowerCase()}`);

    const sheet = await sheetOf(response, "AMC Contracts");
    const values = Array.from({ length: 4 }, (_, index) => sheet.getRow(HEADER_ROW + 1 + index).getCell(6).value);
    expect(values).toHaveLength(4);
    expect(sheet.getRow(HEADER_ROW + 5).getCell(6).value).toMatchObject({ result: 6980 });

    expect((await download("/api/clients/999999/contracts/export", { format: "pdf" })).status).toBe(404);
  });
});
