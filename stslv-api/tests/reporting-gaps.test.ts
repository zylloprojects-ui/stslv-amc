import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import type { AuthContext } from "../src/modules/auth/access";
import { buildServiceStatusExport } from "../src/modules/amc/service-status.export";
import { serviceStatusHiddenSchema } from "../src/modules/amc/service-status.schemas";
import { addDays } from "../src/modules/amc/amc.schedule";
import { activeContract, contractBody, createClient, renewalEngineer, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Service Sales' Service Report No. and Quote filter, Accounts' contract filter, hidden columns in exports,
// the new reports, the Reports filters and KPI strip, and the totals against their source modules.

let admin: Session;
let noReports: Session;
let clientId: string;
let otherClientId: string;
let quarterly: string;
let other: string;
let dueSoon: string;
let renewalId: string;
let thisYear: number;

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${url}`).query(query).set(session.headers);

async function sheetOf(url: string, query: Record<string, unknown>) {
  const response = await get(url, { format: "xlsx", ...query }).responseType("blob");
  expect(response.status).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
  const rows: string[][] = [];
  workbook.worksheets[0]?.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ""))));

  return { rows, header: rows.find((row) => row.includes("AMC Reference")) ?? [], text: rows.flat().join(" | ") };
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  noReports = await signedIn("noreports@example.com", ["FINANCE_EXECUTIVE"]);
  clientId = await createClient(admin, "Gaps Hotel");
  otherClientId = await createClient(admin, "Gaps Mall");
  const now = await today();
  thisYear = Number(now.slice(0, 4));
  quarterly = await activeContract(admin, clientId, contractBody(clientId, { systemDescription: "FIRE", validFrom: `${thisYear}-01-01`, validTo: `${thisYear}-12-31`, contractValue: "1200.125", defaultVisitAmount: "300.031" }));
  other = await activeContract(admin, otherClientId, contractBody(otherClientId, { systemDescription: "CCTV", validFrom: `${thisYear + 1}-01-01`, validTo: `${thisYear + 1}-12-31`, contractValue: "400.000", defaultVisitAmount: "100.000" }));
  dueSoon = await activeContract(admin, clientId, contractBody(clientId, { systemDescription: "DUE", validFrom: addDays(now, -300), validTo: addDays(now, 60), contractValue: "90.500", defaultVisitAmount: "10.000" }));

  const engineer = await renewalEngineer();
  const renewal = await api()
    .post(`/api/amc/contracts/${dueSoon}/renewals`)
    .set(admin.headers)
    .send(contractBody(clientId, { systemDescription: "DUE", validFrom: addDays(now, 61), validTo: addDays(now, 400), status: "DRAFT", contractValue: "95.250", salesEngineerId: engineer }));
  expect(renewal.status).toBe(201);
  renewalId = renewal.body.data.id;

  const [first, second, third] = await visitsOf(quarterly);
  await withServiceReport(first!.id);
  await api().patch(`/api/amc/execution/visits/${first!.id}`).set(admin.headers).send({ status: "COMPLETED", completedDate: now });
  await pool.query("UPDATE amc_visits SET service_report_no = 'SR-GAP-1', quotation_no = 'QT-1' WHERE id = $1", [first!.id]);
  // A number on a visit that is not completed: Submitted, though not "Quoted".
  await pool.query("UPDATE amc_visits SET quotation_no = 'QT-2' WHERE id = $1", [second!.id]);
  await pool.query("UPDATE amc_visits SET manual_invoice_no = 'MAN-1', manual_invoice_at = now(), manual_invoice_by = (SELECT min(id) FROM users) WHERE id = $1", [third!.id]);
});
afterAll(closePool);

describe("Service Sales", () => {
  it("shows and searches the Service Report No.", async () => {
    const { data } = (await get("/services-sales", { search: "SR-GAP-1" })).body;
    expect(data.total).toBe(1);
    expect(data.items[0].serviceReportNo).toBe("SR-GAP-1");
  });

  it("filters Quote Submitted / Not Submitted by quotation_no, and the cards follow", async () => {
    const all = (await get("/services-sales", { clientId })).body.data;
    const submitted = (await get("/services-sales", { clientId, quoteSubmission: "SUBMITTED" })).body.data;
    const notSubmitted = (await get("/services-sales", { clientId, quoteSubmission: "NOT_SUBMITTED" })).body.data;

    expect(submitted.items.map((item: { quotationNo: string }) => item.quotationNo).sort()).toEqual(["QT-1", "QT-2"]);
    expect(submitted.kpis).toMatchObject({ total: 2, quoted: 1, notCompleted: 1 });
    expect(notSubmitted.items.every((item: { quotationNo: string | null }) => item.quotationNo === null)).toBe(true);
    expect(submitted.total + notSubmitted.total).toBe(all.total);
    expect((await get("/services-sales", { quoteSubmission: "MAYBE" })).status).toBe(400);
  });

  it("exports the column before Quote No., names the filter, and leaves out hidden columns", async () => {
    const full = await sheetOf("/services-sales/export", { quoteSubmission: "SUBMITTED" });
    const status = full.header.indexOf("Service status");
    expect(full.header.indexOf("Service Report No.")).toBeGreaterThan(status);
    expect(full.header.indexOf("Quote No.")).toBe(full.header.indexOf("Service Report No.") + 1);
    expect(full.text).toContain("Quote Submitted");
    expect(full.text).toContain("SR-GAP-1");

    const hidden = await sheetOf("/services-sales/export", { hidden: "system,serviceReportNo,serviceStatus" });
    expect(hidden.header).not.toContain("System");
    expect(hidden.header).not.toContain("Service Report No.");
    expect(hidden.header).not.toContain("Service status");
    expect(hidden.header).not.toContain("Completed date");
    expect(hidden.header).toContain("AMC Reference");
    expect(hidden.header).toContain("Sales status");

    expect((await get("/services-sales/export", { format: "xlsx", hidden: "password" })).status).toBe(400);
  });

  it("refuses without permission", async () => {
    expect((await api().get("/api/services-sales")).status).toBe(401);
    const viewOnly = await signedIn("salesview@example.com", ["VIEWER"]);
    expect((await get("/services-sales/export", { format: "xlsx" }, viewOnly)).status).toBe(403);
  });
});

describe("Accounts contract filter", () => {
  it("offers the contracts with visits, and limits rows, cards and export to one", async () => {
    const options = (await get("/accounts/options")).body.data;
    expect(options.contracts).toContainEqual({ id: quarterly, reference: `AMC-${quarterly.padStart(4, "0")}`, client: "Gaps Hotel", system: "FIRE" });
    expect(options.contracts.some((contract: { id: string }) => contract.id === renewalId)).toBe(false);
    expect(options.clients.length).toBeGreaterThan(0);

    const visits = await visitsOf(quarterly);
    const { data } = (await get("/accounts", { contractId: quarterly })).body;
    expect(data.total).toBe(visits.length);
    expect(data.items.every((item: { contract: { id: string } }) => item.contract.id === quarterly)).toBe(true);
    const direct = await pool.query<{ total: string }>("SELECT sum(visit_amount)::numeric(16,3)::text AS total FROM amc_visits WHERE amc_contract_id = $1", [quarterly]);
    expect(data.kpis.totalValue).toBe(direct.rows[0]?.total);

    const sheet = await sheetOf("/accounts/export", { contractId: quarterly });
    expect(sheet.text).toContain("AMC Contract");
    expect(sheet.text).toContain(`AMC-${quarterly.padStart(4, "0")}`);
    expect(sheet.text).not.toContain("Gaps Mall");
    expect((await get("/accounts", { contractId: "abc" })).status).toBe(400);
  });
});

describe("Exports honour hidden columns", () => {
  it("Master AMC Status heads the value Value (Ex VAT)", async () => {
    expect((await sheetOf("/amc/master-status/export", {})).header).toContain("Value (Ex VAT)");
  });

  it("Service Status leaves out what the page hides, keeping the reference", async () => {
    const auth = { user: { id: "1", fullName: "Test" } } as unknown as AuthContext;
    const { report } = await buildServiceStatusExport(auth, { format: "xlsx", hidden: ["client", "due", "status", "report"] });
    const keys = report.tables[0]?.columns.map((column) => column.key);
    expect(keys).toEqual(["number", "reference", "system", "frequency", "service", "salesEngineer"]);
    // The month headings still group the rows.
    expect(report.tables[0]?.groupBy).toBeDefined();
    expect(String(report.tables[0]?.rows[0]?.scheduledMonth)).not.toBe("undefined");

    const { report: full } = await buildServiceStatusExport(auth, { format: "xlsx", hidden: [] });
    expect(full.tables[0]?.columns.map((column) => column.key)).toContain("dueDate");

    expect(serviceStatusHiddenSchema.safeParse("client,due").success).toBe(true);
    expect(serviceStatusHiddenSchema.safeParse("password").success).toBe(false);
  });
});

describe("Reports filters", () => {
  it("lists twelve reports, with each report's own statuses and options", async () => {
    const list = (await get("/reports")).body.data as { id: string; title: string; filters: string[]; statuses: { value: string; label: string }[] }[];
    expect(list).toHaveLength(12);
    expect(list.find((report) => report.id === "scheduled-services")).toMatchObject({ title: "Billing Schedule" });
    expect(list.find((report) => report.id === "scheduled-services")?.filters).toEqual(expect.arrayContaining(["system", "status", "payment"]));
    expect(list.find((report) => report.id === "contract-summary")?.statuses).toContainEqual({ value: "ACTIVE", label: "Active" });
    expect(list.find((report) => report.id === "monthly-maintenance")?.statuses).toContainEqual({ value: "IN_PROGRESS", label: "In Progress" });

    const options = (await get("/reports/options")).body.data;
    expect(options.systems).toEqual(expect.arrayContaining(["FIRE", "CCTV"]));
    expect(options.clients.map((client: { name: string }) => client.name)).toContain("Gaps Mall");
  });

  it("filters contract reports by system and contract status, and visit reports by visit status", async () => {
    const fire = (await get("/reports/contract-summary", { system: "FIRE" })).body.data;
    expect(fire.total).toBe(1);
    expect(fire.rows[0].system).toBe("FIRE");
    expect((await get("/reports/contract-summary", { status: "DRAFT" })).body.data.total).toBe(1);

    const completed = (await get("/reports/client-summary", { status: "COMPLETED" })).body.data;
    expect(completed.totals.services).toBe("1");
    const scheduled = (await get("/reports/scheduled-services", { status: "COMPLETED", system: "FIRE" })).body.data;
    expect(scheduled.total).toBe(1);
    expect(scheduled.rows[0].status).toBe("Completed");
  });

  it("refuses a status or payment filter the report does not have", async () => {
    expect((await get("/reports/scheduled-services", { status: "ACTIVE" })).status).toBe(400);
    expect((await get("/reports/contract-summary", { status: "IN_PROGRESS" })).status).toBe(400);
    expect((await get("/reports/expiry-renewal", { status: "ACTIVE" })).status).toBe(400);
    expect((await get("/reports/contract-summary", { payment: "PAID" })).status).toBe(400);
    expect((await get("/reports/contract-summary", { status: "NONSENSE" })).status).toBe(400);
    expect((await get("/reports/contract-summary/export", { format: "xlsx", status: "IN_PROGRESS" })).status).toBe(400);
  });

  it("Billing Schedule filters Paid and Unpaid, as Accounts does", async () => {
    const paid = (await get("/reports/scheduled-services", { payment: "PAID" })).body.data;
    const unpaid = (await get("/reports/scheduled-services", { payment: "UNPAID" })).body.data;
    const accounts = (await get("/accounts", { pageSize: 1, invoiceStatus: "RECORDED" })).body.data.kpis;
    const accountsUnpaid = (await get("/accounts", { pageSize: 1, invoiceStatus: "NOT_RECORDED" })).body.data.kpis;

    expect(paid.total).toBe(accounts.rows);
    expect(paid.totals.value).toBe(accounts.totalValue);
    expect(paid.totals.value).toBe("300.031");
    expect(unpaid.total).toBe(accountsUnpaid.rows);
    expect(unpaid.totals.value).toBe(accountsUnpaid.totalValue);

    const sheet = await sheetOf("/reports/scheduled-services/export", { payment: "PAID", system: "FIRE", status: "SCHEDULED" });
    expect(sheet.text).toContain("Billing Schedule");
    expect(sheet.text).toContain("Paid / Unpaid");
    expect(sheet.text).toContain("Scheduled");
  });
});

describe("AMC Contract Summary figures", () => {
  it("are exact, from PostgreSQL, and match their sources", async () => {
    const { data } = await (await get("/reports/contract-summary")).body;
    const figure = (id: string) => (data.kpis as { id: string; value: string }[]).find((kpi) => kpi.id === id)?.value;
    const direct = await pool.query<{ n: string; value: string }>("SELECT count(*)::text AS n, sum(contract_value)::numeric(16,3)::text AS value FROM amc_contracts");
    const accounts = (await get("/accounts", { pageSize: 1, year: thisYear })).body.data.kpis;
    const unpaid = (await get("/accounts", { pageSize: 1, invoiceStatus: "NOT_RECORDED" })).body.data.kpis;

    expect(figure("contracts")).toBe(direct.rows[0]?.n);
    expect(figure("value")).toBe(direct.rows[0]?.value);
    expect(figure("scheduled")).toBe(accounts.totalValue);
    expect(figure("unpaid")).toBe(unpaid.totalValue);
    for (const id of ["value", "scheduled", "unpaid"]) expect(figure(id)).toMatch(/^\d+\.\d{3}$/);

    // Follow the filters.
    const one = (await get("/reports/contract-summary", { clientId: otherClientId })).body.data;
    expect((one.kpis as { id: string; value: string }[]).find((kpi) => kpi.id === "value")?.value).toBe("400.000");

    const sheet = await sheetOf("/reports/contract-summary/export", {});
    expect(sheet.text).toContain("Contracts in Scope");
    expect(sheet.header).toContain("Scheduled (Current Year)");

    expect((await get("/reports/renewal")).body.data.kpis).toEqual([]);
  });
});

describe("Expiry & Renewal Due", () => {
  it("lists what the Dashboard's Expiring Contracts lists, with days left and renewal state", async () => {
    const { data } = (await get("/reports/expiry-renewal")).body;
    const dashboard = (await get("/dashboard/operations")).body.data.expiring;

    expect(data.total).toBe(dashboard.total);
    const row = (data.rows as Record<string, unknown>[]).find((item) => item.reference === `AMC-${dueSoon.padStart(4, "0")}`);
    expect(row).toMatchObject({ days_left: 60, renewal_state: "Under Client Approval", renewal_reference: `AMC-${renewalId.padStart(4, "0")}`, contract_value: "90.500" });
    expect(data.totals.days_left).toBeUndefined();
    expect(data.totals.contract_value).toMatch(/^\d+\.\d{3}$/);

    const past = await activeContract(admin, clientId, contractBody(clientId, { systemDescription: "PAST", validFrom: addDays(await today(), -400), validTo: addDays(await today(), -5) }));
    const far = await activeContract(admin, clientId, contractBody(clientId, { systemDescription: "NOTYET", validFrom: addDays(await today(), -100), validTo: addDays(await today(), 80) }));
    const after = (await get("/reports/expiry-renewal")).body.data.rows as Record<string, unknown>[];
    expect(after.find((item) => item.reference === `AMC-${past.padStart(4, "0")}`)).toMatchObject({ days_left: -5, renewal_state: "Due / Expired" });
    expect(after.find((item) => item.reference === `AMC-${far.padStart(4, "0")}`)).toMatchObject({ days_left: 80, renewal_state: "Not Yet Due" });
  });
});

describe("Renewal History", () => {
  it("has the rows of the AMC Renewal history, and totals exact to three decimals", async () => {
    const source = (await get("/amc/reports/renewals")).body.data;
    const { data } = (await get("/reports/renewal-history")).body;

    expect(data.total).toBe(source.total);
    expect(data.rows[0]).toMatchObject({ reference: `AMC-${renewalId.padStart(4, "0")}`, renewed_from: `AMC-${dueSoon.padStart(4, "0")}`, status: "Draft", contract_value: "95.250", source_value: "90.500" });
    expect(data.totals).toMatchObject({ contract_value: "95.250", source_value: "90.500" });
    expect((await get("/reports/renewal-history", { status: "ACTIVE" })).body.data.total).toBe(0);
    expect((await get("/reports/renewal-history", { system: "FIRE" })).body.data.total).toBe(0);
  });
});

describe("Reports permissions", () => {
  it.each(["/reports/options", "/reports/expiry-renewal", "/reports/renewal-history", "/reports/scheduled-services/export?format=xlsx"])("%s needs its permission", async (url) => {
    expect((await api().get(`/api${url}`)).status).toBe(401);
    expect((await api().get(`/api${url}`).set(noReports.headers)).status).toBe(403);
  });
});
