import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, contractBody, createClient, grant, renewalEngineer, visitsOf, withRenewalDocument, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { invoiceBody, newInvoice } from "./invoices-helpers";

// Owner approval 2026-11-09: (1) the original AMC contract and all its renewals show the SAME contract number, each
// renewal being its own contract period with a unique version (migration 0111); (2) Service Sales shows the AMC Value
// of each visit's contract period and a filtered total over unique contract periods, to AMC Contracts: View only.
// Every record here is synthetic, in the stslv_test schema.

let admin: Session;
let salesOnly: Session; // Service Sales view and export, nothing from AMC Contracts
let client: string;
let engineer: string;

const renew = (sourceId: string, validFrom: string, validTo: string, overrides: Record<string, unknown> = {}) =>
  api()
    .post(`/api/amc/contracts/${sourceId}/renewals`)
    .set(admin.headers)
    .send(withRenewalDocument(contractBody(client, { validFrom, validTo, status: "DRAFT", salesEngineerId: engineer, contractValue: "2400.000", ...overrides })));
const activate = (id: string) => api().post(`/api/amc/contracts/${id}/status`).set(admin.headers).send({ status: "ACTIVE" });
const getContract = async (id: string) => (await api().get(`/api/amc/contracts/${id}`).set(admin.headers)).body.data;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  await pool.query("INSERT INTO roles (code, name) VALUES ('CV_SALES_ONLY', 'Sales only') ON CONFLICT DO NOTHING");
  await grant("CV_SALES_ONLY", [
    ["SERVICES_SALES", "VIEW"],
    ["SERVICES_SALES", "EXPORT"],
  ]);
  salesOnly = await signedIn("sales-only@example.com", ["CV_SALES_ONLY"]);
  client = await createClient(admin, "Versions Client");
  engineer = await renewalEngineer();
});

afterAll(async () => {
  await closePool();
});

describe("same visible contract number across renewals (0111)", () => {
  let original: string;
  let second: string;
  let third: string;

  beforeAll(async () => {
    original = await activeContract(admin, client, { amcReference: "STS-AMC-001", systemDescription: "VERSIONED", validFrom: "2026-01-01", validTo: "2026-12-31", contractValue: "1200.000", defaultVisitAmount: "300.000" });
    const v2 = await renew(original, "2027-01-01", "2027-12-31");
    expect(v2.status).toBe(201);
    second = v2.body.data.id;
    expect((await activate(second)).status).toBe(200);
    const v3 = await renew(second, "2028-01-01", "2028-12-31", { contractValue: "3600.000" });
    expect(v3.status).toBe(201);
    third = v3.body.data.id;
  });

  it("gives every period the same number, its own id and the next version", async () => {
    const versions = await Promise.all([original, second, third].map(getContract));

    expect(versions.map((contract) => contract.amcReference)).toEqual(["STS-AMC-001", "STS-AMC-001", "STS-AMC-001"]);
    expect(versions.map((contract) => contract.contractVersion)).toEqual([1, 2, 3]);
    expect(versions.map((contract) => contract.versionRootId)).toEqual([original, original, original]);
    expect(new Set([original, second, third]).size).toBe(3);
    // Each renewal links to the period it renews, inside the chain.
    const links = await pool.query("SELECT id, renewed_from_id FROM amc_contracts_all WHERE version_root_id = $1 ORDER BY contract_version", [original]);
    expect(links.rows).toEqual([
      { id: original, renewed_from_id: null },
      { id: second, renewed_from_id: original },
      { id: third, renewed_from_id: second },
    ]);
  });

  it("keeps the original unchanged: its visits, values and documents", async () => {
    const before = await pool.query("SELECT count(*)::int AS visits, sum(visit_amount)::text AS amount FROM amc_visits WHERE amc_contract_id = $1", [original]);
    expect(before.rows[0]).toEqual({ visits: 4, amount: "1200.000" });
    expect((await getContract(original))).toMatchObject({ contractValue: "1200.000", status: "ACTIVE", contractVersion: 1 });
    const docs = await pool.query("SELECT count(*)::int AS count FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1", [original]);
    expect(docs.rows[0].count).toBe(1);
  });

  it("links services and invoices to the right period, and labels each period on every list", async () => {
    const secondVisits = await visitsOf(second);
    expect(secondVisits.length).toBeGreaterThan(0);
    const visit = secondVisits[0]!.id;
    await withServiceReport(visit);
    const row = (await api().get(`/api/amc/service-status/${visit}`).set(admin.headers)).body.data;
    expect(row).toMatchObject({ reference: "STS-AMC-001 (V2)", contract: { id: second } });
    expect((await api().patch(`/api/amc/service-status/${visit}`).set(admin.headers).send({ status: "COMPLETED", expectedUpdatedAt: row.updatedAt })).status).toBe(200);
    const invoice = await newInvoice(admin, invoiceBody(client, [{ amcVisitId: visit, amount: "600.000" }], { amountExclVat: "600.000", vatAmount: "0.000", invoiceDate: "2027-03-31" }));

    const allocation = await pool.query(
      "SELECT v.amc_contract_id FROM invoice_allocations al JOIN amc_visits v ON v.id = al.amc_visit_id WHERE al.invoice_id = $1",
      [invoice.id]
    );
    expect(allocation.rows).toEqual([{ amc_contract_id: second }]);

    const accounts = (await api().get("/api/accounts").query({ clientId: client, pageSize: 100 }).set(admin.headers)).body.data.items as { id: string; reference: string; contract: { id: string }; invoiceValue: string | null }[];
    expect(accounts.find((item) => item.id === visit)).toMatchObject({ reference: "STS-AMC-001 (V2)", contract: { id: second }, invoiceValue: "600.000" });
    expect(accounts.filter((item) => item.contract.id === original).every((item) => item.reference === "STS-AMC-001")).toBe(true);

    // Searching the number finds every period; each keeps its own id.
    const register = (await api().get("/api/amc/contracts").query({ search: "STS-AMC-001" }).set(admin.headers)).body.data.items as { id: string; contractVersion: number }[];
    expect(register.map((item) => [item.id, item.contractVersion]).sort()).toEqual([[original, 1], [second, 2], [third, 3]].sort());
    const history = (await api().get("/api/amc/reports/renewals").set(admin.headers)).body.data.items as { renewal: { id: string; reference: string }; source: { id: string; reference: string } }[];
    expect(history.find((item) => item.renewal.id === third)).toMatchObject({ renewal: { reference: "STS-AMC-001 (V3)" }, source: { id: second, reference: "STS-AMC-001 (V2)" } });

    // The contracts export labels the versions too.
    const file = await api().get("/api/amc/contracts/export").query({ search: "STS-AMC-001", format: "xlsx" }).responseType("blob").set(admin.headers);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.body as unknown as ExcelJS.Buffer);
    const text = JSON.stringify(book.worksheets[0]?.getSheetValues());
    expect(text).toContain("STS-AMC-001 (V2)");
    expect(text).toContain("STS-AMC-001 (V3)");
  });

  it("never reuses a version: a cancelled renewal keeps its version and the next one moves on", async () => {
    const cancelled = await api().post(`/api/amc/contracts/${third}/status`).set(admin.headers).send({ status: "CANCELLED", reason: "Client changed the scope" });
    expect(cancelled.status).toBe(200);
    const again = await renew(second, "2028-01-01", "2028-12-31");
    expect(again.status).toBe(201);
    expect(again.body.data).toMatchObject({ amcReference: "STS-AMC-001", contractVersion: 4 });
  });

  it("refuses a second open renewal of the same period (existing rule)", async () => {
    const twice = await renew(second, "2028-01-01", "2028-12-31");
    expect(twice.status).toBe(409);
  });

  it("keeps the number for this chain only", async () => {
    const response = await api().post("/api/amc/contracts").set(admin.headers).send({
      ...contractBody(client, { amcReference: "sts-amc-001" }),
      salesEngineerId: engineer,
      systemTypeId: (await pool.query("SELECT id FROM system_types LIMIT 1")).rows[0]?.id,
      finalCredit: "0.000",
      contractDocument: withRenewalDocument({}).contractDocument,
    });
    expect(response.status).toBe(409);
  });

  it("is enforced by the database: unique versions, one number per chain, no cross-chain links", async () => {
    const other = await activeContract(admin, client, { amcReference: "STS-AMC-002", systemDescription: "OTHER", validFrom: "2026-01-01", validTo: "2026-12-31" });
    const insert = (values: { reference: string; root: string; version: number; renewedFrom?: string }) =>
      pool.query(
        `INSERT INTO amc_contracts_all (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, status, created_by, updated_by,
           amc_reference, version_root_id, contract_version, renewed_from_id)
         VALUES ($1, '2030-01-01', '2030-12-31', 'DB', 100, 'QUARTERLY', 'DRAFT', $2, $2, $3, $4, $5, $6)`,
        [client, admin.id, values.reference, values.root, values.version, values.renewedFrom ?? null]
      );

    await expect(insert({ reference: "STS-AMC-001", root: original, version: 2 })).rejects.toMatchObject({ code: "23505", constraint: "amc_contracts_version_uq" });
    await expect(insert({ reference: "STS-AMC-OTHER", root: original, version: 9 })).rejects.toMatchObject({ code: "23514", constraint: "amc_contracts_version_reference_ck" });
    await expect(insert({ reference: "STS-AMC-001", root: second, version: 9 })).rejects.toMatchObject({ code: "23514", constraint: "amc_contracts_version_root_ck" });
    await expect(insert({ reference: "STS-AMC-001", root: original, version: 9, renewedFrom: other })).rejects.toMatchObject({ code: "23514", constraint: "amc_contracts_version_link_ck" });
    // A later version cannot be renamed on its own.
    await expect(pool.query("UPDATE amc_contracts_all SET amc_reference = 'STS-AMC-RENAMED' WHERE id = $1", [second])).rejects.toMatchObject({ code: "23514" });
    // Another original cannot take the chain's number.
    await expect(pool.query("UPDATE amc_contracts_all SET amc_reference = 'STS-AMC-001' WHERE id = $1", [other])).rejects.toMatchObject({ code: "23505" });
  });
});

describe("Service Sales: AMC Value and filtered total", () => {
  let salesClient: string;
  let alpha: string; // 4 visits, 1200.000
  let beta: string; // 4 visits, 2000.500
  let alphaRenewal: string; // own period, 1500.250

  const list = (query: Record<string, unknown>, session: Session = admin) =>
    api().get("/api/services-sales").query({ clientId: salesClient, pageSize: 100, ...query }).set(session.headers);

  beforeAll(async () => {
    salesClient = await createClient(admin, "Sales Value Client");
    alpha = await activeContract(admin, salesClient, { amcReference: "SV-ALPHA", systemDescription: "SV ALPHA", validFrom: "2026-01-01", validTo: "2026-12-31", contractValue: "1200.000", defaultVisitAmount: "300.000" });
    beta = await activeContract(admin, salesClient, { amcReference: "SV-BETA", systemDescription: "SV BETA", validFrom: "2026-01-01", validTo: "2026-12-31", contractValue: "2000.500", defaultVisitAmount: "500.125" });
    const renewal = await api()
      .post(`/api/amc/contracts/${alpha}/renewals`)
      .set(admin.headers)
      .send(withRenewalDocument(contractBody(salesClient, { systemDescription: "SV ALPHA", validFrom: "2027-01-01", validTo: "2027-12-31", status: "DRAFT", salesEngineerId: engineer, contractValue: "1500.250", defaultVisitAmount: "375.063" })));
    expect(renewal.status).toBe(201);
    alphaRenewal = renewal.body.data.id;
    expect((await activate(alphaRenewal)).status).toBe(200);
  });

  it("shows each visit's own contract period value", async () => {
    const data = (await list({})).body.data;
    const byContract = new Map<string, string>();
    for (const item of data.items as { contract: { id: string }; amcValue: string; reference: string }[]) byContract.set(item.contract.id, item.amcValue);

    expect(data.amcValueVisible).toBe(true);
    expect(byContract.get(alpha)).toBe("1200.000");
    expect(byContract.get(beta)).toBe("2000.500");
    expect(byContract.get(alphaRenewal)).toBe("1500.250");
  });

  it("totals unique contract periods across every page, not visits", async () => {
    const page = (await list({ pageSize: 1 })).body.data;

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(12);
    // 3 periods, each counted once although each has 4 visits; the renewal is its own period.
    expect(page.amcValueTotal).toEqual({ total: "4700.750", contracts: 3 });
  });

  it("follows the filters, and is zero for an empty result", async () => {
    expect((await list({ year: 2027 })).body.data.amcValueTotal).toEqual({ total: "1500.250", contracts: 1 });
    expect((await list({ search: "SV-BETA" })).body.data.amcValueTotal).toEqual({ total: "2000.500", contracts: 1 });
    expect((await list({ search: "NO-SUCH-CONTRACT" })).body.data.amcValueTotal).toEqual({ total: "0.000", contracts: 0 });
  });

  it("never sends AMC Value or its total to a user without AMC Contracts: View, in the list or the export", async () => {
    const data = (await list({}, salesOnly)).body.data;

    expect(data.amcValueVisible).toBe(false);
    expect(data.amcValueTotal).toBeNull();
    expect(data.items.every((item: { amcValue: string | null }) => item.amcValue === null)).toBe(true);
    expect(JSON.stringify(data)).not.toContain("1200.000");

    const file = await api().get("/api/services-sales/export").query({ clientId: salesClient, format: "xlsx" }).responseType("blob").set(salesOnly.headers);
    expect(file.status).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.body as unknown as ExcelJS.Buffer);
    const text = JSON.stringify(book.worksheets[0]?.getSheetValues());
    expect(text).not.toContain("AMC Value");
    expect(text).not.toContain("4,700.750");
  });

  it("exports the AMC Value column and the unique-contract total to a permitted user", async () => {
    const file = await api().get("/api/services-sales/export").query({ clientId: salesClient, format: "xlsx" }).responseType("blob").set(admin.headers);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.body as unknown as ExcelJS.Buffer);
    const text = JSON.stringify(book.worksheets[0]?.getSheetValues());
    expect(text).toContain("AMC Value / Year (OMR)");
    expect(text).toContain("Total AMC Value of matching contracts: 4,700.750 OMR excluding VAT, over 3 unique contract periods");

    const hidden = await api().get("/api/services-sales/export").query({ clientId: salesClient, format: "xlsx", hidden: "amcValue" }).responseType("blob").set(admin.headers);
    const hiddenBook = new ExcelJS.Workbook();
    await hiddenBook.xlsx.load(hidden.body as unknown as ExcelJS.Buffer);
    expect(JSON.stringify(hiddenBook.worksheets[0]?.getSheetValues())).not.toContain("AMC Value");
  });
});
