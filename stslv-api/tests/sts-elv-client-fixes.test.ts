import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { HEADER_ROW } from "../src/shared/export/excel";
import { SYSTEM_NAME } from "../src/shared/export/branding";
import { expiryApplyEnabled } from "../src/modules/amc/contract-expiry.service";
import { reportNumberLockEnabled } from "../src/modules/amc/service-status.service";
import {
  activeContract,
  contractBody,
  contractDocument,
  createClient,
  grant,
  logsFor,
  referenceOf,
  renewalEngineer,
  TEST_PDF,
  visitsOf,
  withRenewalDocument,
  withServiceReport,
  type Session,
} from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { cancelInvoice, invoiceBody, newInvoice } from "./invoices-helpers";

// STS-ELV client fixes (2026-11-09). Every record here is synthetic and lives in the stslv_test schema only.
//
// Dataset: three contracts for the validity rules (active, expiring, expired-but-stored-Active) plus a stored Expired
// one and a renewal; and, for the financial checks, one client with a valued contract (completed, Paid, Zoho-invoiced
// and cancelled-invoice services across billing periods) and a contract with no Billing Basis and no Cost per Visit.

let admin: Session;
let execution: Session;
let statusOnly: Session; // SERVICE_STATUS:VIEW and ACCOUNTS/MASTER/REPORTS views, but NOT AMC_CONTRACTS:VIEW
let noRenewal: Session; // AMC_CONTRACTS only
let today: string;

const addDays = async (days: number) => (await pool.query<{ d: string }>("SELECT (current_date + $1::int)::text AS d", [days])).rows[0]!.d;

async function customRole(code: string, permissions: [string, string][]) {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [code]);
  await grant(code, permissions);
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  await customRole("CF_STATUS_ONLY", [
    ["SERVICE_STATUS", "VIEW"],
    ["SERVICE_STATUS", "EXPORT"],
    ["ACCOUNTS", "VIEW"],
    ["MASTER_AMC_STATUS", "VIEW"],
  ]);
  statusOnly = await signedIn("status-only@example.com", ["CF_STATUS_ONLY"]);
  await customRole("CF_CONTRACTS_ONLY", [
    ["AMC_CONTRACTS", "VIEW"],
    ["AMC_CONTRACTS", "CREATE"],
  ]);
  noRenewal = await signedIn("contracts-only@example.com", ["CF_CONTRACTS_ONLY"]);
  today = await addDays(0);
});

afterAll(async () => {
  await closePool();
});

describe("branding and production switches", () => {
  it("uses the confirmed STS-ELV name in exports and the API", async () => {
    expect(SYSTEM_NAME).toBe("STS-ELV AMC");
    expect((await api().get("/api/health")).body.message).toBe("STS-ELV AMC API is running");
  });

  it("keeps both production feature switches off unless explicitly enabled", () => {
    expect(expiryApplyEnabled({})).toBe(false);
    expect(reportNumberLockEnabled({})).toBe(false);
    expect(expiryApplyEnabled({ AMC_CONTRACT_EXPIRY_ENABLED: "" })).toBe(false);
    expect(reportNumberLockEnabled({ SERVICE_REPORT_NO_LOCK_ENABLED: "" })).toBe(false);
  });
});

describe("AMC Contracts: due and expired visibility", () => {
  let client: string;
  let active: string;
  let expiring: string;
  let pastValidity: string;
  let storedExpired: string;
  const list = (query: Record<string, unknown>) => api().get("/api/amc/contracts").query({ clientId: client, pageSize: 100, ...query }).set(admin.headers);
  const ids = (response: { body: { data: { items: { id: string }[] } } }) => response.body.data.items.map((item) => item.id).sort();

  beforeAll(async () => {
    client = await createClient(admin, "Validity Client");
    active = await activeContract(admin, client, { systemDescription: "ACTIVE", validFrom: await addDays(-30), validTo: await addDays(300) });
    expiring = await activeContract(admin, client, { systemDescription: "EXPIRING", validFrom: await addDays(-300), validTo: await addDays(20) });
    pastValidity = await activeContract(admin, client, { systemDescription: "PAST", validFrom: await addDays(-400), validTo: await addDays(-10) });
    storedExpired = await activeContract(admin, client, { systemDescription: "STORED EXPIRED", validFrom: await addDays(-500), validTo: await addDays(-100) });
    const changed = await api().post(`/api/amc/contracts/${storedExpired}/status`).set(admin.headers).send({ status: "EXPIRED" });
    expect(changed.status).toBe(200);
  });

  it("lists expired contracts by validity, whatever their stored status", async () => {
    expect(ids(await list({ validity: "expired" }))).toEqual([pastValidity, storedExpired].sort());
    // The stored-status filter is unchanged: it still shows only the stored Expired one.
    expect(ids(await list({ status: "EXPIRED" }))).toEqual([storedExpired]);
  });

  it("lists due contracts (active, ending within 45 days) only", async () => {
    expect(ids(await list({ validity: "due" }))).toEqual([expiring]);
    expect(ids(await list({ validity: "all" }))).toEqual([active, expiring, pastValidity, storedExpired].sort());
  });

  it("agrees with the Expired figure and never changes the stored status", async () => {
    const kpis = (await api().get("/api/amc/contracts/kpis").set(admin.headers)).body.data;
    const everyExpired = (await api().get("/api/amc/contracts").query({ validity: "expired", pageSize: 100 }).set(admin.headers)).body.data.total;

    expect(kpis.expired).toBe(everyExpired);
    const stored = await pool.query("SELECT status FROM amc_contracts WHERE id = $1", [pastValidity]);
    expect(stored.rows[0]?.status).toBe("ACTIVE");
  });

  it("keeps a renewed contract visible under Expired", async () => {
    const salesEngineerId = await renewalEngineer();
    const renewal = await api()
      .post(`/api/amc/contracts/${pastValidity}/renewals`)
      .set(admin.headers)
      .send(withRenewalDocument(contractBody(client, { systemDescription: "PAST", validFrom: await addDays(-9), validTo: await addDays(355), status: "DRAFT", salesEngineerId })));

    expect(renewal.status).toBe(201);
    expect(ids(await list({ validity: "expired" }))).toContain(pastValidity);
  });

  it("refuses an unknown validity and filters the export the same way", async () => {
    expect((await list({ validity: "soon" })).status).toBe(400);
    const file = await api().get("/api/amc/contracts/export").query({ clientId: client, validity: "expired", format: "xlsx" }).responseType("blob").set(admin.headers);

    expect(file.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.body as unknown as ExcelJS.Buffer);
    const text = JSON.stringify(book.worksheets[0]?.getSheetValues());
    expect(text).toContain("PAST");
    expect(text).not.toContain('"EXPIRING"');
  });
});

describe("AMC Renewal: updated document required", () => {
  let client: string;
  let source: string;
  let salesEngineerId: string;
  const renew = (body: Record<string, unknown>, session: Session = admin) => api().post(`/api/amc/contracts/${source}/renewals`).set(session.headers).send(body);
  const body = async (overrides: Record<string, unknown> = {}) =>
    contractBody(client, { systemDescription: "RENEWAL DOC", validFrom: await addDays(400), validTo: await addDays(764), status: "DRAFT", salesEngineerId, ...overrides });
  const contractCount = async () => Number((await pool.query("SELECT count(*) FROM amc_contracts_all")).rows[0]!.count);

  beforeAll(async () => {
    client = await createClient(admin, "Renewal Document Client");
    source = await activeContract(admin, client, { systemDescription: "RENEWAL DOC", validFrom: await addDays(35), validTo: await addDays(399) });
    salesEngineerId = await renewalEngineer();
  });

  it("refuses a renewal without its document and creates nothing", async () => {
    const before = await contractCount();
    const refused = await renew(await body());

    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body.error.details)).toContain("contractDocument");
    expect(await contractCount()).toBe(before);
  });

  it("refuses a file that is not a PDF or Word document, and stores nothing", async () => {
    const before = await contractCount();
    const attachments = Number((await pool.query("SELECT count(*) FROM attachments")).rows[0]!.count);
    const refused = await renew({ ...(await body()), contractDocument: contractDocument(Buffer.from("not a pdf"), "renewal.pdf") });

    expect(refused.status).toBe(400);
    expect(await contractCount()).toBe(before);
    expect(Number((await pool.query("SELECT count(*) FROM attachments")).rows[0]!.count)).toBe(attachments);
  });

  it("refuses the renewed contract's own number: each number stays with one contract", async () => {
    const refused = await renew({ ...(await body({ amcReference: await referenceOf(source) })), contractDocument: contractDocument() });

    expect(refused.status).toBe(409);
  });

  it("needs Create on AMC Renewal", async () => {
    expect((await renew(withRenewalDocument(await body()), noRenewal)).status).toBe(403);
  });

  it("saves the renewal with its own document, linked to the unchanged original", async () => {
    const sourceBefore = (await pool.query("SELECT status, valid_to::text, amc_reference, updated_at FROM amc_contracts WHERE id = $1", [source])).rows[0];
    const sourceDocs = (await pool.query("SELECT id FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1", [source])).rows;
    const created = await renew({ ...(await body()), contractDocument: contractDocument(TEST_PDF, "renewal-2027.pdf") });

    expect(created.status).toBe(201);
    const renewalId = created.body.data.id as string;
    const link = await pool.query("SELECT renewed_from_id, status FROM amc_contracts WHERE id = $1", [renewalId]);
    expect(link.rows[0]).toEqual({ renewed_from_id: source, status: "DRAFT" });

    const docs = await pool.query("SELECT title, original_name, category FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1", [renewalId]);
    expect(docs.rows).toEqual([{ title: "Renewal contract document", original_name: "renewal-2027.pdf", category: "SIGNED_CONTRACT" }]);
    // The original keeps exactly its own documents and record.
    expect((await pool.query("SELECT id FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1", [source])).rows).toEqual(sourceDocs);
    expect((await pool.query("SELECT status, valid_to::text, amc_reference, updated_at FROM amc_contracts WHERE id = $1", [source])).rows[0]).toEqual(sourceBefore);
    expect((await logsFor("amc_contracts", source)).map((log) => log.action)).toContain("amc_contract.renewal_created");

    const renewals = (await api().get(`/api/amc/contracts/${source}/renewals`).set(admin.headers)).body.data;
    expect(renewals.renewals.map((item: { id: string }) => item.id)).toEqual([renewalId]);
  });
});

describe("financial consistency across Service Status, Accounts, Master AMC Status and Reports", () => {
  let client: string;
  let valued: string;
  let unvalued: string;
  let visits: string[];
  let zohoA: { id: string };
  let zohoB: { id: string };

  const complete = async (visitId: string) => {
    await withServiceReport(visitId);
    const row = (await api().get(`/api/amc/service-status/${visitId}`).set(admin.headers)).body.data;
    const saved = await api().patch(`/api/amc/service-status/${visitId}`).set(execution.headers).send({ status: "COMPLETED", expectedUpdatedAt: row.updatedAt });
    expect(saved.status).toBe(200);
  };
  const accounts = (query: Record<string, unknown> = {}, session: Session = admin) => api().get("/api/accounts").query({ clientId: client, pageSize: 50, ...query }).set(session.headers);

  beforeAll(async () => {
    client = await createClient(admin, "Finance Consistency Client");
    // Quarterly, four services of 405.000 across four billing periods, the first ones already due.
    valued = await activeContract(admin, client, { systemDescription: "VALUED", validFrom: await addDays(-300), validTo: await addDays(64), contractValue: "1620.000", defaultVisitAmount: "405.000" });
    // No Billing Basis and no Cost per Visit: its services have no amount, and none is invented.
    unvalued = await activeContract(admin, client, { systemDescription: "UNVALUED", validFrom: await addDays(-300), validTo: await addDays(64), contractValue: "999.000", defaultVisitAmount: undefined });
    visits = (await visitsOf(valued)).map((visit) => visit.id);
    expect(visits).toHaveLength(4);

    await complete(visits[0]!);
    await complete(visits[1]!);
    const updatedAt = (await api().get(`/api/amc/visits/${visits[0]}`).set(admin.headers)).body.data.updatedAt;
    expect((await api().patch(`/api/amc/visits/${visits[0]}/manual-invoice`).set(admin.headers).send({ invoiceNo: "CF-INV-1", expectedUpdatedAt: updatedAt })).status).toBe(200);

    zohoA = await newInvoice(admin, invoiceBody(client, [{ amcVisitId: visits[0]!, amount: "100.001" }, { amcVisitId: visits[1]!, amount: "200.002" }], { amountExclVat: "300.003", vatAmount: "0.000", invoiceDate: today }));
    zohoB = await newInvoice(admin, invoiceBody(client, [{ amcVisitId: visits[1]!, amount: "50.000" }], { amountExclVat: "50.000", vatAmount: "0.000", invoiceDate: today }));
    expect((await cancelInvoice(admin, zohoB.id)).status).toBe(200);
  });

  it("Accounts totals cover every filtered row across pages, with decimal precision", async () => {
    const onePage = (await accounts({ pageSize: 1 })).body.data;

    expect(onePage.items).toHaveLength(1);
    expect(onePage.kpis).toMatchObject({ totalValue: "1620.000", paidValue: "405.000", invoiceValue: "300.003", invoiced: 2, valueMissing: 4 });
    expect(onePage.total).toBe(8);
  });

  it("Accounts shows each service's own Zoho invoice value, leaving out the cancelled invoice", async () => {
    const items = (await accounts()).body.data.items as { id: string; invoiceValue: string | null; valueSourceMissing: boolean; visitValue: string | null }[];
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get(visits[0]!)?.invoiceValue).toBe("100.001");
    expect(byId.get(visits[1]!)?.invoiceValue).toBe("200.002");
    expect(byId.get(visits[2]!)?.invoiceValue).toBeNull();
    const unvaluedRows = items.filter((item) => item.visitValue === null);
    expect(unvaluedRows).toHaveLength(4);
    expect(unvaluedRows.every((item) => item.valueSourceMissing)).toBe(true);
  });

  it("Accounts totals follow the filters and are zero for an empty result", async () => {
    expect((await accounts({ invoiceStatus: "RECORDED" })).body.data.kpis).toMatchObject({ totalValue: "405.000", paidValue: "405.000", invoiceValue: "100.001" });
    expect((await accounts({ contractId: unvalued })).body.data.kpis).toMatchObject({ totalValue: "0.000", invoiceValue: "0.000", valueMissing: 4 });
    expect((await accounts({ search: "NO-SUCH-REFERENCE-XYZ" })).body.data.kpis).toMatchObject({ rows: 0, totalValue: "0.000", paidValue: "0.000", invoiceValue: "0.000" });
  });

  it("Master AMC Status reconciles with Accounts and keeps its Zoho columns", async () => {
    const master = (await api().get("/api/amc/master-status").query({ clientId: client, pageSize: 1 }).set(admin.headers)).body.data;
    const acc = (await accounts()).body.data.kpis;

    expect(master.kpis).toMatchObject({ totalValue: acc.totalValue, paidValue: acc.paidValue, invoiceValue: acc.invoiceValue, valueMissing: acc.valueMissing });
    const file = await api().get("/api/amc/master-status/export").query({ clientId: client, format: "xlsx" }).responseType("blob").set(admin.headers);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.body as unknown as ExcelJS.Buffer);
    const headers = (book.worksheets[0]?.getRow(HEADER_ROW).values as unknown[]).filter(Boolean);
    expect(headers).toEqual(expect.arrayContaining(["Zoho Invoices (Tracking)", "Zoho References (Tracking)"]));
  });

  it("the monthly report reconciles with Accounts for the same scope", async () => {
    const report = (await api().get("/api/reports/monthly-maintenance").query({ clientId: client }).set(admin.headers)).body.data;
    const acc = (await accounts()).body.data.kpis;

    expect(report.totals).toMatchObject({ value: acc.totalValue, paid_value: acc.paidValue, zoho_invoice_value: acc.invoiceValue, no_value: String(acc.valueMissing) });
    // Several billing periods: the services fall in more than one month.
    expect(report.rows.length).toBeGreaterThan(1);
  });

  it("Service Status shows the contract's AMC Value only to users who may view contracts", async () => {
    const asAdmin = (await api().get("/api/amc/service-status").query({ clientId: client, pageSize: 50 }).set(admin.headers)).body.data;
    const valuedRow = asAdmin.items.find((item: { id: string }) => item.id === visits[0]);

    expect(asAdmin.amcValueVisible).toBe(true);
    expect(valuedRow.amcValue).toBe("1620.000");

    const restricted = (await api().get("/api/amc/service-status").query({ clientId: client, pageSize: 50 }).set(statusOnly.headers)).body.data;
    expect(restricted.amcValueVisible).toBe(false);
    expect(restricted.items.every((item: { amcValue: string | null }) => item.amcValue === null)).toBe(true);
    expect(JSON.stringify(restricted)).not.toContain("1620.000");

    const file = await api().get("/api/amc/service-status/export").query({ clientId: client, format: "xlsx" }).responseType("blob").set(statusOnly.headers);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.body as unknown as ExcelJS.Buffer);
    expect(JSON.stringify(book.worksheets[0]?.getSheetValues())).not.toContain("AMC Value");
    // Master AMC Status follows the same rule.
    const master = (await api().get("/api/amc/master-status").query({ clientId: client }).set(statusOnly.headers)).body.data;
    expect(master.items.every((item: { amcValue: string | null }) => item.amcValue === null)).toBe(true);
  });
});

describe("Service Status: manual Sales Engineer Name", () => {
  let visitId: string;
  let contractId: string;
  const row = async () => (await api().get(`/api/amc/service-status/${visitId}`).set(admin.headers)).body.data;
  const save = async (salesEngineerName: unknown, session: Session = execution) =>
    api().patch(`/api/amc/service-status/${visitId}`).set(session.headers).send({ salesEngineerName, expectedUpdatedAt: (await row()).updatedAt });

  beforeAll(async () => {
    const client = await createClient(admin, "Engineer Name Client");
    contractId = await activeContract(admin, client, { systemDescription: "ENGINEER NAME", validFrom: await addDays(10), validTo: await addDays(374) });
    visitId = (await visitsOf(contractId))[0]!.id;
  });

  it("saves, trims and shows the name after a reload, without touching the contract's Sales Engineer link", async () => {
    const link = (await pool.query("SELECT sales_engineer_id FROM amc_contracts WHERE id = $1", [contractId])).rows[0];
    const saved = await save("  Ahmed Al Balushi  ");

    expect(saved.status).toBe(200);
    expect(saved.body.data.salesEngineerName).toBe("Ahmed Al Balushi");
    expect((await row()).salesEngineerName).toBe("Ahmed Al Balushi");
    expect((await pool.query("SELECT sales_engineer_id FROM amc_contracts WHERE id = $1", [contractId])).rows[0]).toEqual(link);
    expect((await logsFor("amc_visits", visitId)).map((log) => log.action)).toContain("amc_visit.sales_engineer_name_changed");
  });

  it("validates length and control characters, and clears with an empty value", async () => {
    expect((await save("x".repeat(121))).status).toBe(400);
    expect((await save("Line\nbreak")).status).toBe(400);
    expect((await save("")).status).toBe(200);
    expect((await row()).salesEngineerName).toBeNull();
  });

  it("needs Edit on AMC Execution", async () => {
    expect((await save("Someone", statusOnly)).status).toBe(403);
  });
});

describe("Accounts: View Service Report", () => {
  let visitId: string;
  let emptyVisit: string;
  let outsider: Session;

  beforeAll(async () => {
    outsider = await signedIn("outsider@example.com", ["PROCUREMENT"]);
    const client = await createClient(admin, "Report Viewer Client");
    const contract = await activeContract(admin, client, { systemDescription: "VIEWER", validFrom: await addDays(-100), validTo: await addDays(264) });
    [visitId, emptyVisit] = (await visitsOf(contract)).map((visit) => visit.id) as [string, string];
    const uploaded = await api()
      .post(`/api/amc/service-status/${visitId}/report`)
      .set(execution.headers)
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", encodeURIComponent("visit-report.pdf"))
      .send(TEST_PDF);
    expect(uploaded.status).toBe(201);
  });

  const fetchReport = (id: string, session?: Session) => {
    const request = api().get(`/api/accounts/${id}/report`);
    return (session ? request.set(session.headers) : request).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
  };

  it("lists the report on the Accounts row and serves the file to Accounts viewers", async () => {
    const items = (await api().get("/api/accounts").query({ pageSize: 200 }).set(statusOnly.headers)).body.data.items as { id: string; serviceReport: { originalName: string } | null }[];
    expect(items.find((item) => item.id === visitId)?.serviceReport?.originalName).toBe("visit-report.pdf");
    expect(items.find((item) => item.id === emptyVisit)?.serviceReport).toBeNull();

    const file = await fetchReport(visitId, statusOnly);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toContain("application/pdf");
    expect(file.headers["cache-control"]).toBe("no-store");
    expect(Buffer.compare(file.body as Buffer, TEST_PDF)).toBe(0);
  });

  it("refuses anyone without Accounts View, and a request without sign-in", async () => {
    expect((await fetchReport(visitId, outsider)).status).toBe(403);
    expect((await fetchReport(visitId)).status).toBe(401);
  });

  it("says clearly when no report exists", async () => {
    expect((await fetchReport(emptyVisit, statusOnly)).status).toBe(404);
    expect((await fetchReport("999999999", statusOnly)).status).toBe(404);
  });
});
