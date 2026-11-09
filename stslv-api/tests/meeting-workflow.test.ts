import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { createClient, newContractBody, referenceOf, testReference, today, visitsOf, withRenewalDocument, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { invoiceBody, newInvoice } from "./invoices-helpers";

// The 24 October 2026 meeting workflow, end to end through the API:
// Master Data -> Contract -> Schedule -> Calendar -> Service Status -> Accounts
// -> Master AMC Status -> Dashboard -> Renewal, with roles and exports.

let admin: Session;
let clientId: string;
let engineerId: string;
let systemTypeId: string;
let contractId: string;

const get = (path: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${path}`).query(query).set(session.headers);
const post = (path: string, body: Record<string, unknown>, session: Session = admin) => api().post(`/api${path}`).set(session.headers).send(body);
const patch = (path: string, body: Record<string, unknown>, session: Session = admin) => api().patch(`/api${path}`).set(session.headers).send(body);

interface FrequencyRow {
  id: string;
  code: string;
  codePrefix: string;
  serviceCount: number | null;
  intervalMonths: number | null;
  isActive: boolean;
}

async function frequencies(): Promise<FrequencyRow[]> {
  return (await get("/masters/maintenance-frequencies", { pageSize: 100 })).body.data.items as FrequencyRow[];
}

async function newContract(overrides: Record<string, unknown>): Promise<string> {
  const response = await post(
    "/amc/contracts",
    await newContractBody(clientId, {
      amcReference: testReference("WORKFLOW"),
      systemDescription: "FIRE",
      validFrom: "2027-01-01",
      validTo: "2027-12-31",
      contractValue: "1200.000",
      maintenanceFrequency: "QUARTERLY",
      defaultVisitAmount: "100.000",
      status: "ACTIVE",
      ...overrides,
    })
  );

  if (response.status !== 201) throw new Error(`Contract refused: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.data.id as string;
}

async function serviceRow(id: string) {
  const response = await get("/amc/service-status", { pageSize: 200, search: await referenceOf(contractId) });

  return (response.body.data.items as { id: string; updatedAt: string; serviceStatus: string; reportNumber: string | null }[]).find((row) => row.id === id);
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("meeting workflow", () => {
  it("1-3. master data: client (no duplicates), sales engineer, system type", async () => {
    clientId = await createClient(admin, "Workflow Hotel LLC");
    expect((await post("/clients", { name: "Workflow Hotel LLC", clientType: "COMPANY" })).status).toBe(409);

    const engineer = await post("/masters/sales-engineers", { code: "SE-6744", name: "Workflow Engineer", employeeNo: "6744" });
    expect(engineer.status).toBe(201);
    engineerId = engineer.body.data.id;

    const system = await post("/masters/system-types", { code: "FIRE", name: "Fire Alarm" });
    expect(system.status).toBe(201);
    systemTypeId = system.body.data.id;
  });

  it("3. maintenance frequencies hold the six agreed rules; the three added ones start inactive", async () => {
    const rows = await frequencies();
    const shape = (code: string) => {
      const row = rows.find((item) => item.code === code);
      return [row?.serviceCount, row?.intervalMonths, row?.codePrefix];
    };

    expect(shape("MONTHLY")).toEqual([12, 1, "M"]);
    expect(shape("QUARTERLY")).toEqual([4, 3, "Q"]);
    expect(shape("HALF_YEARLY")).toEqual([2, 6, "H"]);
    expect(shape("BI_MONTHLY")).toEqual([6, 2, "BM"]);
    expect(shape("EVERY_4_MONTHS")).toEqual([3, 4, "T"]);
    expect(rows.find((item) => item.code === "CUSTOM")?.codePrefix).toBe("C");

    const before = await post("/amc/contracts", await newContractBody(clientId, { amcReference: testReference("WORKFLOW"), systemDescription: "FIRE", validFrom: "2027-01-01", validTo: "2027-12-31", contractValue: "600.000", maintenanceFrequency: "BI_MONTHLY", status: "ACTIVE" }));
    expect(before.status).toBe(400);
    expect(before.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(["maintenanceFrequency"]);

    for (const code of ["BI_MONTHLY", "EVERY_4_MONTHS", "CUSTOM"]) {
      const id = rows.find((item) => item.code === code)?.id as string;
      expect((await post(`/masters/maintenance-frequencies/${id}/status`, { status: "active" })).status).toBe(200);
    }
  });

  it.each([
    ["MONTHLY", 12, "M12", "2027-12-01"],
    ["QUARTERLY", 4, "Q4", "2027-10-01"],
    ["HALF_YEARLY", 2, "H2", "2027-07-01"],
    ["BI_MONTHLY", 6, "BM6", "2027-11-01"],
    ["EVERY_4_MONTHS", 3, "T3", "2027-09-01"],
  ])("5-6. %s generates %i services with the right codes, dates and values", async (maintenanceFrequency, count, lastCode, lastDate) => {
    const id = await newContract({ maintenanceFrequency, systemDescription: `SCHED-${maintenanceFrequency}` });
    const visits = await visitsOf(id);

    expect(visits).toHaveLength(count);
    expect(new Set(visits.map((visit) => visit.period_start)).size).toBe(count);
    expect(visits.every((visit) => visit.visit_amount === "100.000")).toBe(true);
    expect(visits.at(-1)?.scheduled_date).toBe(lastDate);
    expect(((await pool.query<{ service_code: string }>("SELECT service_code FROM amc_visits WHERE id = $1", [visits.at(-1)?.id])).rows[0] as { service_code: string }).service_code).toBe(lastCode);

    // Generating again creates nothing.
    expect((await post(`/amc/contracts/${id}/schedule/generate`, {})).status).toBeLessThan(500);
    expect(await visitsOf(id)).toHaveLength(count);
  });

  it("5. a custom frequency schedules only the chosen months", async () => {
    const id = await newContract({ maintenanceFrequency: "CUSTOM", customMonths: [2, 6, 9], systemDescription: "SCHED-CUSTOM" });

    expect((await visitsOf(id)).map((visit) => visit.scheduled_date)).toEqual(["2027-02-01", "2027-06-01", "2027-09-01"]);
  });

  it("4-6. the workflow contract: engineer, system, schedule; a date change keeps the untouched visits", async () => {
    contractId = await newContract({ salesEngineerId: engineerId, systemDescription: "Fire Alarm", contractValue: "1620.000", defaultVisitAmount: "405.000", finalCredit: "700.000" });
    expect((await api().put(`/api/amc/contracts/${contractId}/masters`).set(admin.headers).send({ salesEngineerId: engineerId, systemTypeId })).status).toBe(200);

    const visits = await visitsOf(contractId);
    expect(visits.map((visit) => visit.scheduled_date)).toEqual(["2027-01-01", "2027-04-01", "2027-07-01", "2027-10-01"]);
    expect(visits.map((visit) => visit.visit_amount)).toEqual(["405.000", "405.000", "405.000", "405.000"]);

    // Longer validity: new visits only, the old ones untouched.
    expect((await patch(`/amc/contracts/${contractId}`, { validTo: "2028-06-30" })).status).toBe(200);
    const longer = await visitsOf(contractId);
    expect(longer).toHaveLength(6);
    expect(longer.slice(0, 4).map((visit) => visit.id)).toEqual(visits.map((visit) => visit.id));
    expect((await patch(`/amc/contracts/${contractId}`, { validTo: "2027-12-31" })).status).toBe(200);
    expect(await visitsOf(contractId)).toHaveLength(4);
  });

  it("7. the calendar shows the scheduled services of the month and year", async () => {
    const month = await get("/amc/visits", { from: "2027-04-01", to: "2027-04-30", search: "Workflow", pageSize: 200 });
    expect(month.status).toBe(200);
    expect((month.body.data.items as { contract?: { id: string }; contractId?: string }[]).some((item) => (item.contract?.id ?? item.contractId) === contractId)).toBe(true);
    expect((await get("/amc/visits/year-summary", { year: 2027 })).status).toBe(200);
  });

  it("8-10. completing a service with a report number shows on Service Status, and stays in sync everywhere", async () => {
    const [first] = await visitsOf(contractId);
    const row = await serviceRow(first!.id);

    expect(row?.serviceStatus).toBe("NOT_COMPLETED");
    await withServiceReport(first!.id);

    // A stale screen cannot overwrite a newer change.
    expect((await patch(`/amc/service-status/${first!.id}`, { status: "COMPLETED", completedDate: await today(), expectedUpdatedAt: "2000-01-01T00:00:00.000Z" })).status).toBe(409);

    const saved = await patch(`/amc/service-status/${first!.id}`, { status: "COMPLETED", completedDate: await today(), reportNumber: "SR-1001", expectedUpdatedAt: row?.updatedAt });
    expect(saved.status).toBe(200);
    expect(await serviceRow(first!.id)).toMatchObject({ serviceStatus: "COMPLETED", reportNumber: "SR-1001" });

    const accounts = (await get("/accounts", { clientId, pageSize: 200 })).body.data.items as { id: string; colour: string; serviceReportNo: string | null }[];
    expect(accounts.find((item) => item.id === first!.id)).toMatchObject({ colour: "BLUE", serviceReportNo: "SR-1001" });

    const master = (await get("/amc/master-status", { clientId, pageSize: 200 })).body.data.items as { id: string; colour: string; serviceStatus: string }[];
    expect(master.find((item) => item.id === first!.id)).toMatchObject({ colour: "YELLOW", serviceStatus: "COMPLETED" });
  });

  it("11-13. the manual Invoice No. reaches Accounts and Master AMC Status as Paid, and the Zoho record stays listed", async () => {
    const [first] = await visitsOf(contractId);
    await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: first!.id, amount: "405.000" }], { amountExclVat: "405.000", vatAmount: "20.250", invoiceDate: await today(), invoiceNumber: "ZOHO-5001" }));

    const updatedAt = (await get(`/amc/visits/${first!.id}`)).body.data.updatedAt;
    expect((await patch(`/amc/visits/${first!.id}/manual-invoice`, { invoiceNo: "MAN-5001", expectedUpdatedAt: updatedAt })).status).toBe(200);

    const accounts = (await get("/accounts", { clientId, invoiceStatus: "RECORDED", pageSize: 200 })).body.data;
    expect(accounts.items).toHaveLength(1);
    expect(accounts.items[0]).toMatchObject({ id: first!.id, colour: "GREEN", manualInvoiceNo: "MAN-5001", invoiceNumbers: ["ZOHO-5001"], paymentStatus: "PAID", visitValue: "405.000" });

    const master = (await get("/amc/master-status", { clientId, invoiceStatus: "RECORDED", quotationStatus: "NOT_RECORDED", pageSize: 200 })).body.data;
    expect(master.items).toHaveLength(1);
    expect(master.items[0]).toMatchObject({ id: first!.id, colour: "BLUE", invoiceNumbers: ["ZOHO-5001"], quotationNo: null });
  });

  it("13. an existing quotation number reaches Master AMC Status", async () => {
    const [first] = await visitsOf(contractId);
    const items = (await get("/services-sales", { clientId, pageSize: 200 })).body.data.items as { id: string; updatedAt: string }[];
    const saved = await patch(`/services-sales/${first!.id}`, { quotationNo: "STS/QU/789", expectedUpdatedAt: items.find((item) => item.id === first!.id)?.updatedAt });

    expect(saved.status).toBe(200);
    const master = (await get("/amc/master-status", { clientId, quotationStatus: "RECORDED", pageSize: 200 })).body.data;
    expect(master.items).toHaveLength(1);
    expect(master.items[0]).toMatchObject({ colour: "GREEN", quotationNo: "STS/QU/789" });
  });

  it("14. the dashboard agrees with the source records", async () => {
    const { kpis } = (await get("/dashboard/operations")).body.data;
    const direct = (await pool.query<{ active: number; value: string; credit: string }>(
      "SELECT count(*)::int AS active, sum(contract_value)::numeric(16,3)::text AS value, COALESCE(sum(final_credit), 0)::numeric(16,3)::text AS credit FROM amc_contracts WHERE status = 'ACTIVE'"
    )).rows[0];
    const accounts = (await get("/accounts", { pageSize: 1 })).body.data.kpis;

    expect(kpis.contracts).toMatchObject({ active: direct?.active, activeValue: direct?.value, finalCreditTotal: direct?.credit });
    expect(kpis.payments).toMatchObject({ paid: accounts.invoiceFilled, unpaid: accounts.rows - accounts.invoiceFilled });
    expect(kpis.payments.paid).toBe(1);
  });

  it("15. renewal: the 45-day boundary, expiry today, expired, renewed and cancelled", async () => {
    const now = await today();
    const at = async (days: number, systemDescription: string) => newContract({ systemDescription, validFrom: addDays(now, days - 300), validTo: addDays(now, days) });
    const at45 = await at(45, "RENEW-45");
    const at46 = await at(46, "RENEW-46");
    const atToday = await at(0, "RENEW-0");
    const expired = await at(-10, "RENEW-EXPIRED");
    const state = async (id: string) => ((await get("/amc/renewals/queue", { pageSize: 200 })).body.data.items as { id: string; renewalState: string; daysLeft: number }[]).find((item) => item.id === id);

    expect(await state(at45)).toMatchObject({ renewalState: "DUE", daysLeft: 45 });
    expect(await state(at46)).toBeUndefined();
    expect(await state(atToday)).toMatchObject({ renewalState: "DUE", daysLeft: 0 });
    expect(await state(expired)).toMatchObject({ renewalState: "DUE", daysLeft: -10 });

    // Draft renewal: under approval; activated: renewed. The source and its visits stay as they were.
    const sourceVisits = await visitsOf(at45);
    const renewal = await post(`/amc/contracts/${at45}/renewals`, withRenewalDocument({ amcReference: testReference("WORKFLOW-RENEWAL"), clientId, systemDescription: "RENEW-45", validFrom: addDays(now, 46), validTo: addDays(now, 410), contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "100.000", salesEngineerId: engineerId, status: "DRAFT" }));
    expect(renewal.status).toBe(201);
    expect(await state(at45)).toMatchObject({ renewalState: "UNDER_APPROVAL" });
    expect((await post(`/amc/contracts/${renewal.body.data.id}/status`, { status: "ACTIVE" })).status).toBe(200);
    expect(await state(at45)).toMatchObject({ renewalState: "RENEWED" });
    expect((await visitsOf(at45)).map((visit) => visit.id)).toEqual(sourceVisits.map((visit) => visit.id));
    expect((await visitsOf(renewal.body.data.id)).length).toBeGreaterThan(0);

    // Cancelled renewal: the queue says so.
    const second = await post(`/amc/contracts/${atToday}/renewals`, withRenewalDocument({ amcReference: testReference("WORKFLOW-RENEWAL"), clientId, systemDescription: "RENEW-0", validFrom: addDays(now, 1), validTo: addDays(now, 365), contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "100.000", salesEngineerId: engineerId, status: "DRAFT" }));
    expect(second.status).toBe(201);
    expect((await post(`/amc/contracts/${second.body.data.id}/status`, { status: "CANCELLED", reason: "Client declined" })).status).toBe(200);
    expect(await state(atToday)).toMatchObject({ renewalState: "CANCELLED" });
  });

  it("cancelling a contract keeps completed work and its invoice, and drops only open work from the lists", async () => {
    const before = (await get("/accounts", { clientId, invoiceStatus: "RECORDED", pageSize: 200 })).body.data.items as { id: string }[];
    expect((await post(`/amc/contracts/${contractId}/status`, { status: "CANCELLED", reason: "Workflow test" })).status).toBe(200);

    const after = (await get("/amc/master-status", { search: await referenceOf(contractId), pageSize: 200 })).body.data.items as { id: string }[];
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    expect((await visitsOf(contractId)).filter((visit) => visit.status === "COMPLETED")).toHaveLength(1);
  });

  it("16. roles: read-only and restricted users are refused by the API itself", async () => {
    const viewer = await signedIn("viewer@example.com", ["VIEWER"]);
    const finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
    const operations = await signedIn("ops@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
    const [, second] = await visitsOf(await newContract({ systemDescription: "ROLES" }));
    const write = { status: "COMPLETED", completedDate: await today(), expectedUpdatedAt: new Date().toISOString() };

    // Viewer writes nothing.
    expect((await post("/clients", { name: "Viewer Client", clientType: "COMPANY" }, viewer)).status).toBe(403);
    expect((await post("/amc/contracts", { clientId }, viewer)).status).toBe(403);
    expect((await patch(`/amc/service-status/${second!.id}`, write, viewer)).status).toBe(403);
    expect((await post("/invoices", {}, viewer)).status).toBe(403);
    expect((await get("/roles", {}, viewer)).status).toBe(403);

    // Finance records invoices but does not complete services or change contracts.
    expect((await patch(`/amc/service-status/${second!.id}`, write, finance)).status).toBe(403);
    expect((await post("/amc/contracts", { clientId }, finance)).status).toBe(403);
    expect((await get("/accounts", {}, finance)).status).toBe(200);

    // Operations cannot record invoices or reach security pages.
    expect((await post("/invoices", {}, operations)).status).toBe(403);
    expect((await get("/audit/activity", {}, operations)).status).toBe(403);
    expect((await get("/users", {}, operations)).status).toBe(403);

    // No sign-in: nothing at all.
    expect((await api().get("/api/accounts")).status).toBe(401);
  });

  it.each([
    ["/amc/contracts/export", "AMC Contracts"],
    ["/amc/visits/export", null],
    ["/amc/service-status/export", "Service Status"],
    ["/accounts/export", "Accounts"],
    ["/amc/master-status/export", "Master AMC Status"],
    ["/services-sales/export", "Service Sales"],
    ["/amc/renewals/queue/export", null],
  ])("17. %s produces Excel and PDF", async (path, sheetName) => {
    const excel = await get(path, { format: "xlsx" }).responseType("blob");
    expect(excel.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel.body as unknown as ExcelJS.Buffer);
    if (sheetName) expect(workbook.getWorksheet(sheetName)).toBeDefined();
    expect(workbook.worksheets[0]?.rowCount).toBeGreaterThan(1);

    const pdf = await get(path, { format: "pdf" }).responseType("blob");
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("18. no duplicate services and no orphaned records", async () => {
    const duplicates = await pool.query("SELECT amc_contract_id, period_start FROM amc_visits WHERE status <> 'CANCELLED' GROUP BY 1, 2 HAVING count(*) > 1");
    const allocations = await pool.query("SELECT a.id FROM invoice_allocations a LEFT JOIN amc_visits v ON v.id = a.amc_visit_id WHERE a.amc_visit_id IS NOT NULL AND v.id IS NULL");
    const sums = await pool.query("SELECT i.id FROM invoices i JOIN invoice_allocations a ON a.invoice_id = i.id GROUP BY i.id, i.amount_excl_vat HAVING sum(a.allocated_amount) <> i.amount_excl_vat");

    expect(duplicates.rows).toEqual([]);
    expect(allocations.rows).toEqual([]);
    expect(sums.rows).toEqual([]);
  });
});
