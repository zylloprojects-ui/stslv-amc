import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { buildAccountsExport } from "../src/modules/accounts/accounts.export";
import type { ExportAccountsQuery } from "../src/modules/accounts/accounts.schemas";
import type { AuthContext } from "../src/modules/auth/access";
import { pdfDefinition } from "../src/shared/export/pdf";
import { overallServiceCounts, periodServiceFigures, tillDateServiceCounts, yearToDateServiceCounts } from "../src/modules/dashboard/operations.service";
import { activeContract, createClient, grant, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn, withAuditLogUnlocked } from "./helpers";

// Client UAT review of 2026-11-16 ("Stselv changes .xlsx"): Sales Engineer and Service Engineer (CR-005 to CR-016),
// AMC Value and Service Value on Invoices (CR-013, CR-014), Contract Value / Final Credit headings (CR-019, CR-020),
// Service Sales values (CR-017) and the Dashboard rows Current YTD and Overall Till Date (CR-001 to CR-004).

let admin: Session;
/** The Accounts role (FINANCE_EXECUTIVE) with its seeded grants: Accounts, no AMC Contracts. */
let accounts: Session;
/** The AMC Sales role (MASTER_DATA_EXECUTIVE) given Service Sales View and Export, and no AMC Contracts. */
let amcSales: Session;

async function engineer(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>("INSERT INTO sales_engineers (name, is_active) VALUES ($1, true) RETURNING id", [name]);
  return result.rows[0]?.id as string;
}

/** Saves the Service Engineer of one visit through Service Status, as the page does. */
async function setServiceEngineer(visitId: string, name: string | null) {
  const row = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [visitId]);
  return api()
    .patch(`/api/amc/service-status/${visitId}`)
    .set(admin.headers)
    .send({ salesEngineerName: name, expectedUpdatedAt: (row.rows[0]?.updated_at as Date).toISOString() });
}

async function sheet(path: string, query: Record<string, unknown>, session: Session, name: string) {
  const response = await api().get(path).query({ format: "xlsx", ...query }).set(session.headers).responseType("blob");
  expect(response.status).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
  const ws = workbook.getWorksheet(name) as ExcelJS.Worksheet;
  const header = (ws.getRow(6).values as unknown[]).slice(1) as string[];
  const rows: unknown[][] = [];
  for (let n = 7; n <= ws.rowCount; n += 1) rows.push((ws.getRow(n).values as unknown[]).slice(1));
  return { header, rows, column: (heading: string) => rows.map((row) => row[header.indexOf(heading)] ?? null) };
}

describe("Client UAT 2026-11-16", () => {
  beforeAll(async () => {
    await resetData();
    admin = await signedIn("uat-admin@example.com", ["ADMIN"]);
    accounts = await signedIn("uat-accounts@example.com", ["FINANCE_EXECUTIVE"]);
    // The minimum Service Sales access proposed for AMC Sales (View and Edit), plus Export to test the download.
    await grant("MASTER_DATA_EXECUTIVE", [
      ["SERVICES_SALES", "VIEW"],
      ["SERVICES_SALES", "EDIT"],
      ["SERVICES_SALES", "EXPORT"],
    ]);
    amcSales = await signedIn("uat-amc-sales@example.com", ["MASTER_DATA_EXECUTIVE"]);
  });
  afterAll(closePool);

  describe("Sales Engineer (contract) and Service Engineer (visit)", () => {
    let contractId: string;
    let visits: { id: string }[];

    beforeEach(async () => {
      await withAuditLogUnlocked("TRUNCATE activity_logs, amc_visits_all, amc_contracts_all, clients_all, sales_engineers_all RESTART IDENTITY CASCADE");
      const clientId = await createClient(admin, "Engineer Towers");
      const salesEngineerId = await engineer("Sara Sales");
      contractId = await activeContract(admin, clientId, {
        salesEngineerId,
        responsibleEngineer: "Typed Name",
        systemDescription: "FIRE",
        validFrom: "2027-01-01",
        validTo: "2027-12-31",
        maintenanceFrequency: "QUARTERLY",
        contractValue: "1200.000",
        defaultVisitAmount: "300.000",
      });
      visits = await visitsOf(contractId);
    });

    it("keeps the two people apart, per visit, and never copies or invents a Service Engineer", async () => {
      expect((await setServiceEngineer(visits[0]!.id, "Vijay Service")).status).toBe(200);
      expect((await setServiceEngineer(visits[1]!.id, "Ravi Field")).status).toBe(200);

      // Stored against each visit; the contract's Sales Engineer is unchanged and nothing was copied to other visits.
      const stored = await pool.query<{ id: string; sales_engineer_name: string | null }>("SELECT id, sales_engineer_name FROM amc_visits WHERE amc_contract_id = $1 ORDER BY sequence_no", [contractId]);
      expect(stored.rows.map((row) => row.sales_engineer_name)).toEqual(["Vijay Service", "Ravi Field", null, null]);
      const contract = await api().get(`/api/amc/contracts/${contractId}`).set(admin.headers);
      expect(contract.body.data.salesEngineer).toMatchObject({ name: "Sara Sales" });

      const master = (await api().get("/api/amc/master-status").query({ pageSize: 100 }).set(admin.headers)).body.data.items as { id: string; salesEngineer: { name: string } | null; serviceEngineer: string | null }[];
      const accountsRows = (await api().get("/api/accounts").query({ pageSize: 100 }).set(admin.headers)).body.data.items as typeof master;
      const sales = (await api().get("/api/services-sales").query({ pageSize: 100 }).set(admin.headers)).body.data.items as typeof master;
      for (const items of [master, accountsRows, sales]) {
        const byId = new Map(items.map((item) => [item.id, item]));
        expect(byId.get(visits[0]!.id)).toMatchObject({ salesEngineer: { name: "Sara Sales" }, serviceEngineer: "Vijay Service" });
        expect(byId.get(visits[1]!.id)).toMatchObject({ salesEngineer: { name: "Sara Sales" }, serviceEngineer: "Ravi Field" });
        // A visit where nobody entered it has none: no fallback to the Sales Engineer.
        expect(byId.get(visits[2]!.id)).toMatchObject({ salesEngineer: { name: "Sara Sales" }, serviceEngineer: null });
      }
    });

    it("records the change in the Audit Log under the Service Engineer wording", async () => {
      await setServiceEngineer(visits[0]!.id, "Vijay Service");
      const log = await pool.query<{ action: string; description: string; user_id: string; metadata: { changes: Record<string, { from: unknown; to: unknown }> } }>(
        "SELECT action, description, user_id, metadata FROM activity_logs WHERE entity_type = 'amc_visits' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
        [visits[0]!.id]
      );
      expect(log.rows[0]).toMatchObject({ action: "amc_visit.sales_engineer_name_changed", user_id: admin.id });
      expect(log.rows[0]?.description).toMatch(/^Service Engineer of AMC visit 1 .* set to Vijay Service\.$/);
      expect(log.rows[0]?.metadata.changes.salesEngineerName).toEqual({ from: null, to: "Vijay Service" });
    });

    it("exports Sales Engineer and Service Engineer in the order the pages show them", async () => {
      await setServiceEngineer(visits[0]!.id, "Vijay Service");

      const master = await sheet("/api/amc/master-status/export", {}, admin, "Master AMC Status");
      expect(master.header.indexOf("Service Engineer")).toBe(master.header.indexOf("Service Status") + 1);
      expect(master.header).toContain("Sales Engineer");
      expect(master.column("Service Engineer")[0]).toBe("Vijay Service");
      expect(master.column("Sales Engineer")[0]).toBe("Sara Sales");

      const accountsSheet = await sheet("/api/accounts/export", {}, admin, "Accounts");
      const at = (heading: string) => accountsSheet.header.indexOf(heading);
      // Provisional order (Q-04): Service Report No. → Sales Engineer → Service Engineer → AMC Value → Service Value.
      expect([at("Sales Engineer"), at("Service Engineer"), at("AMC Value (ex VAT)"), at("Service Value (ex VAT)")]).toEqual([
        at("Service Report No.") + 1,
        at("Service Report No.") + 2,
        at("Service Report No.") + 3,
        at("Service Report No.") + 4,
      ]);
      expect(accountsSheet.column("Service Engineer")[0]).toBe("Vijay Service");

      const salesSheet = await sheet("/api/services-sales/export", {}, admin, "Service Sales");
      expect(salesSheet.header.indexOf("Service Engineer")).toBe(salesSheet.header.indexOf("Service Report No.") + 1);
      expect(salesSheet.column("Service Engineer")[0]).toBe("Vijay Service");

      const statusSheet = await sheet("/api/amc/service-status/export", { year: 2027 }, admin, "Service Status");
      expect(statusSheet.header).toEqual(expect.arrayContaining(["Sales Engineer", "Service Engineer", "AMC Value (ex VAT)", "Service Value (ex VAT)"]));
      expect(statusSheet.header).not.toContain("Sales Engineer Name");
    });

    it("shows the linked Sales Engineer on the contract register, else the typed name, and sorts by what it shows", async () => {
      const clientId = (await pool.query<{ id: string }>("SELECT id FROM clients LIMIT 1")).rows[0]?.id as string;
      const unlinked = await activeContract(admin, clientId, { responsibleEngineer: "Anwar Typed", systemDescription: "CCTV", validFrom: "2027-01-01", validTo: "2027-12-31" });
      await pool.query("UPDATE amc_contracts_all SET sales_engineer_id = NULL WHERE id = $1", [unlinked]);

      const list = (await api().get("/api/amc/contracts").query({ sort: "engineer", pageSize: 100 }).set(admin.headers)).body.data.items as { id: string; salesEngineer: { name: string } | null; responsibleEngineer: string | null }[];
      // The linked "Sara Sales" wins over the typed "Typed Name"; the unlinked contract keeps its typed name.
      expect(list.map((item) => item.id)).toEqual([unlinked, contractId]);
      expect(list.find((item) => item.id === contractId)).toMatchObject({ salesEngineer: { name: "Sara Sales" }, responsibleEngineer: "Typed Name" });
      expect(list.find((item) => item.id === unlinked)?.salesEngineer).toBeNull();

      const register = await sheet("/api/amc/contracts/export", { sort: "engineer" }, admin, "AMC Contracts");
      expect(register.header).toEqual(expect.arrayContaining(["Sales Engineer", "Contract Value (ex VAT)", "Final Credit (ex VAT)"]));
      expect(register.header).not.toContain("Responsible Engineer");
      expect(register.column("Sales Engineer").slice(0, 2)).toEqual(["Anwar Typed", "Sara Sales"]);
      // Amounts unchanged by the new headings.
      expect(Number(register.column("Contract Value (ex VAT)")[1])).toBe(1200);
    });
  });

  describe("Invoices (Accounts) values and Service Sales restrictions", () => {
    let contractId: string;

    beforeEach(async () => {
      await withAuditLogUnlocked("TRUNCATE activity_logs, amc_visits_all, amc_contracts_all, clients_all RESTART IDENTITY CASCADE");
      const clientId = await createClient(admin, "Value Mall");
      contractId = await activeContract(admin, clientId, {
        systemDescription: "FIRE",
        validFrom: "2027-01-01",
        validTo: "2027-12-31",
        maintenanceFrequency: "QUARTERLY",
        contractValue: "1200.000",
        defaultVisitAmount: "300.000",
      });
    });

    it("gives the contract's Customer PO Value as AMC Value beside each service's own value to every Accounts user, without contract access", async () => {
      // No PO value entered yet: "Not entered" (null), never the annual value in its place.
      const empty = (await api().get("/api/accounts").query({ pageSize: 100 }).set(admin.headers)).body.data;
      expect(empty.amcValueVisible).toBe(true);
      expect(empty.items.map((item: { amcValue: string | null; visitValue: string }) => [item.amcValue, item.visitValue])).toEqual(Array(4).fill([null, "300.000"]));

      const saved = await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ customerPoValue: "1150.5" });
      expect(saved.status).toBe(200);
      expect(saved.body.data.customerPoValue).toBe("1150.500");
      const full = (await api().get("/api/accounts").query({ pageSize: 100 }).set(admin.headers)).body.data;
      expect(full.items.map((item: { amcValue: string; visitValue: string }) => [item.amcValue, item.visitValue])).toEqual(Array(4).fill(["1150.500", "300.000"]));
      // The totals add service values only: the repeated AMC Value is never summed.
      expect(full.kpis.totalValue).toBe("1200.000");

      // Phase 2: the Accounts role (seeded grants, no AMC Contracts) sees the same figure on Accounts and its download...
      const accountsView = await api().get("/api/accounts").query({ pageSize: 100 }).set(accounts.headers);
      expect(accountsView.status).toBe(200);
      expect(accountsView.body.data.amcValueVisible).toBe(true);
      expect(accountsView.body.data.items.every((item: { amcValue: string | null; visitValue: string }) => item.amcValue === "1150.500" && item.visitValue === "300.000")).toBe(true);
      // The contract's AMC Value / Year under the service value follows AMC Contracts: View, as on Master AMC Status.
      expect(full.items.every((item: { annualAmcValue: string | null }) => item.annualAmcValue === "1200.000")).toBe(true);
      expect(accountsView.body.data.items.every((item: { annualAmcValue: unknown }) => item.annualAmcValue === null)).toBe(true);
      expect(JSON.stringify(accountsView.body.data.items)).not.toContain("1200.000");
      const accountsSheet = await sheet("/api/accounts/export", {}, accounts, "Accounts");
      expect(accountsSheet.header).toEqual(expect.arrayContaining(["AMC Value (ex VAT)", "Service Value (ex VAT)"]));
      expect(Number(accountsSheet.column("AMC Value (ex VAT)")[0])).toBe(1150.5);

      // Owner request 2026-11-18: the PDF never carries AMC Value (heading, values or its note), even with no column
      // hidden; Service Value and every other column stay. The Excel export above is unchanged.
      const pdfAuth: AuthContext = {
        user: { id: accounts.id, email: "uat-accounts@example.com", fullName: "Accounts" },
        roles: [],
        permissions: new Set(["ACCOUNTS:VIEW", "ACCOUNTS:EXPORT"]) as AuthContext["permissions"],
        mustChangePassword: false,
      };
      for (const hidden of [[], ["system"]] as ExportAccountsQuery["hidden"][]) {
        const { report } = await buildAccountsExport(pdfAuth, { format: "pdf", hidden } as ExportAccountsQuery);
        const headers = report.tables[0]!.columns.filter((column) => !column.excelOnly).map((column) => column.header);
        expect(headers).not.toContain("AMC Value (ex VAT)");
        expect(headers).toContain("Service Value (ex VAT)");
        expect(headers.indexOf("Service Value (ex VAT)")).toBe(headers.indexOf("Service Engineer") + 1);
        const content = JSON.stringify(pdfDefinition(report).content);
        for (const absent of ["AMC Value", "Customer PO Value", "1,150.500"]) expect(content).not.toContain(absent);
        expect(content).toContain("300.000");
      }
      const xlsx = await buildAccountsExport(pdfAuth, { format: "xlsx", hidden: [] } as unknown as ExportAccountsQuery);
      expect(xlsx.report.tables[0]!.columns.map((column) => column.header)).toContain("AMC Value (ex VAT)");
      expect(JSON.stringify(xlsx.report.tables[0]!.notes)).toContain("Customer PO Value");
      const pdfFile = await api().get("/api/accounts/export").query({ format: "pdf" }).responseType("blob").set(accounts.headers);
      expect(pdfFile.status).toBe(200);
      expect(pdfFile.headers["content-type"]).toBe("application/pdf");
      expect((pdfFile.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");

      // ...and nothing more: no contract, contract list, Service Status, Master Status or Service Sales.
      for (const path of [`/api/amc/contracts/${contractId}`, "/api/amc/contracts", "/api/amc/service-status", "/api/amc/master-status", "/api/services-sales"]) {
        expect((await api().get(path).set(accounts.headers)).status, path).toBe(403);
      }
    });

    it("never sends AMC Value or Service Value to a Service Sales user without AMC Contracts: View, on the page, its totals or the export", async () => {
      const response = await api().get("/api/services-sales").query({ pageSize: 100 }).set(amcSales.headers);
      expect(response.status).toBe(200);
      expect(response.body.data.amcValueVisible).toBe(false);
      expect(response.body.data.amcValueTotal).toBeNull();
      expect(response.body.data.items.every((item: { amcValue: unknown; serviceValue: unknown }) => item.amcValue === null && item.serviceValue === null)).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain("1200.000");
      expect(JSON.stringify(response.body)).not.toContain("300.000");

      const salesSheet = await sheet("/api/services-sales/export", {}, amcSales, "Service Sales");
      expect(salesSheet.header.some((heading) => /Value/.test(heading))).toBe(false);
      // The same user still cannot open contracts or Accounts.
      expect((await api().get(`/api/amc/contracts/${contractId}`).set(amcSales.headers)).status).toBe(403);
      expect((await api().get("/api/accounts").set(amcSales.headers)).status).toBe(403);
    });

    it("lets AMC Sales, with Service Sales View and Edit, record a quotation number and nothing beyond its own modules", async () => {
      const [first] = await visitsOf(contractId);
      await withServiceReport(first!.id);
      await pool.query("UPDATE amc_visits SET status = 'COMPLETED', completed_date = '2027-01-05' WHERE id = $1", [first!.id]);
      const updatedAt = (await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [first!.id])).rows[0]?.updated_at.toISOString();

      const saved = await api().patch(`/api/services-sales/${first!.id}`).set(amcSales.headers).send({ quotationNo: "QT-SALES-1", expectedUpdatedAt: updatedAt });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toMatchObject({ quotationNo: "QT-SALES-1", amcValue: null, serviceValue: null });
      const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'amc_visit.quotation_changed' AND entity_id = $1 AND user_id = $2", [first!.id, amcSales.id]);
      expect(log.rowCount).toBe(1);

      // Service Sales does not open completion, invoices, contracts, finance or administration.
      for (const path of ["/api/amc/service-status", "/api/amc/master-status", "/api/accounts", "/api/invoices", "/api/invoice-acknowledgements", "/api/amc/contracts", "/api/reports", "/api/users", "/api/audit/activity"]) {
        expect((await api().get(path).set(amcSales.headers)).status, path).toBe(403);
      }
    });

    it("shows the Customer PO Value as entered, distinct from the annual value and the term total, single- and multi-year (CR-013)", async () => {
      const clientId = (await pool.query<{ id: string }>("SELECT id FROM clients LIMIT 1")).rows[0]?.id as string;
      // Three years at 1,200.000 a year (term 3,600.000) under a PO of 3,450.000; one year at 1,200.000 under a PO of 1,100.000.
      const threeYear = await activeContract(admin, clientId, {
        systemDescription: "MULTI", validFrom: "2027-01-01", validTo: "2029-12-31", maintenanceFrequency: "QUARTERLY", contractValue: "1200.000", billingBasis: "CONTRACT_VALUE", customerPoValue: "3450.000",
      });
      const oneYear = await activeContract(admin, clientId, {
        systemDescription: "SINGLE", validFrom: "2027-01-01", validTo: "2027-12-31", maintenanceFrequency: "QUARTERLY", contractValue: "1200.000", billingBasis: "CONTRACT_VALUE", customerPoValue: "1100.000",
      });
      const rowsOf = async (id: string) =>
        (await api().get("/api/accounts").query({ contractId: id, pageSize: 100 }).set(admin.headers)).body.data.items as { amcValue: string; annualAmcValue: string; visitValue: string }[];

      const multi = await rowsOf(threeYear);
      expect(multi).toHaveLength(12);
      expect(new Set(multi.map((row) => row.amcValue))).toEqual(new Set(["3450.000"]));
      // The annual value is the AMC Value / Year, never the PO value or the term total.
      expect(new Set(multi.map((row) => row.annualAmcValue))).toEqual(new Set(["1200.000"]));
      // Visit amounts still come from the billing basis only (1,200.000 a year ÷ 4): the PO changes no calculation.
      expect(new Set(multi.map((row) => row.visitValue))).toEqual(new Set(["300.000"]));
      const multiContract = (await api().get(`/api/amc/contracts/${threeYear}`).set(admin.headers)).body.data;
      expect(multiContract).toMatchObject({ contractValue: "1200.000", customerPoValue: "3450.000" });
      expect(multiContract.schedule).toMatchObject({ annualAmount: "1200.000", expectedTermTotal: "3600.000" });

      const single = await rowsOf(oneYear);
      expect(single).toHaveLength(4);
      expect(new Set(single.map((row) => row.amcValue))).toEqual(new Set(["1100.000"]));
      expect(new Set(single.map((row) => row.visitValue))).toEqual(new Set(["300.000"]));
      expect((await api().get(`/api/amc/contracts/${oneYear}`).set(admin.headers)).body.data.schedule).toMatchObject({ annualAmount: "1200.000", expectedTermTotal: "1200.000" });

      // Created with a PO: recorded on the creation entry.
      const created = await pool.query("SELECT metadata, description FROM activity_logs WHERE action = 'amc_contract.created' AND entity_id = $1", [threeYear]);
      expect(created.rows[0]?.metadata).toMatchObject({ customerPoValue: "3450.000" });
      expect(created.rows[0]?.description).toContain("Customer PO Value (ex VAT) 3450.000.");
    });

    it("validates, audits and clears the Customer PO Value, and only a contract editor may change it (CR-013)", async () => {
      for (const bad of ["-1", "12.3456", "abc", "123456789012.000"]) {
        const refused = await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ customerPoValue: bad });
        expect(refused.status, bad).toBe(400);
      }
      expect((await pool.query("SELECT customer_po_value FROM amc_contracts WHERE id = $1", [contractId])).rows[0].customer_po_value).toBeNull();

      const visitsBefore = (await visitsOf(contractId)).map((visit) => [visit.id, visit.visit_amount]);
      expect((await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ customerPoValue: "2500" })).status).toBe(200);
      const changed = await pool.query<{ metadata: { changes: Record<string, { from: unknown; to: unknown }> } }>(
        "SELECT metadata FROM activity_logs WHERE action = 'amc_contract.updated' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
        [contractId]
      );
      expect(changed.rows[0]?.metadata.changes.customerPoValue).toEqual({ from: null, to: "2500.000" });
      // No schedule change, no visit amount change.
      expect((await visitsOf(contractId)).map((visit) => [visit.id, visit.visit_amount])).toEqual(visitsBefore);
      // In the AMC Contracts Excel export, as entered.
      const register = await sheet("/api/amc/contracts/export", {}, admin, "AMC Contracts");
      expect(Number(register.column("Customer PO Value (ex VAT)")[0])).toBe(2500);

      // Empty clears it (back to "Not entered"), also audited.
      expect((await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ customerPoValue: "" })).body.data.customerPoValue).toBeNull();
      const cleared = await pool.query<{ metadata: { changes: Record<string, { from: unknown; to: unknown }> } }>(
        "SELECT metadata FROM activity_logs WHERE action = 'amc_contract.updated' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
        [contractId]
      );
      expect(cleared.rows[0]?.metadata.changes.customerPoValue).toEqual({ from: "2500.000", to: null });

      // Accounts (no AMC Contracts: Edit) cannot set it.
      expect((await api().patch(`/api/amc/contracts/${contractId}`).set(accounts.headers).send({ customerPoValue: "1.000" })).status).toBe(403);
      expect((await pool.query("SELECT customer_po_value FROM amc_contracts WHERE id = $1", [contractId])).rows[0].customer_po_value).toBeNull();
    });

    it("gives AMC Sales no values in the Service Sales PDF either (CR-017)", async () => {
      const pdf = await api().get("/api/services-sales/export").query({ format: "pdf" }).set(amcSales.headers).responseType("blob");
      expect(pdf.status).toBe(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      // The values of this contract (1,200.000 a year, 300.000 a service) appear nowhere in the file's text.
      const text = (pdf.body as Buffer).toString("latin1");
      expect(text).not.toMatch(/1,200\.000|300\.000/);
      // A request for a single visit's report is file-only: no amounts there either.
      const [first] = await visitsOf(contractId);
      expect((await api().get(`/api/services-sales/${first!.id}/report`).set(amcSales.headers)).status).toBe(404);
    });

    it("totals Service Status across every page: services summed, each contract's AMC Value once (CR-028)", async () => {
      // A second contract, so the AMC total is of two contract periods; 4 + 2 services in 2027.
      const clientId = (await pool.query<{ id: string }>("SELECT id FROM clients LIMIT 1")).rows[0]?.id as string;
      await activeContract(admin, clientId, {
        systemDescription: "CCTV", validFrom: "2027-01-01", validTo: "2027-12-31", maintenanceFrequency: "HALF_YEARLY", contractValue: "800.000", defaultVisitAmount: "400.000",
      });
      const page = (await api().get("/api/amc/service-status").query({ year: 2027, pageSize: 1 }).set(admin.headers)).body.data;
      expect(page.items).toHaveLength(1);
      expect(page.totals).toEqual({ services: 6, serviceValue: "2000.000", serviceValueMissing: 0, amcValue: "2000.000", contracts: 2 });
      // Never summed per row: 4 × 1,200 + 2 × 800 would be 6,400.000.
      expect(page.totals.amcValue).not.toBe("6400.000");

      // Filters apply: one contract only.
      const one = (await api().get("/api/amc/service-status").query({ year: 2027, search: "CCTV" }).set(admin.headers)).body.data;
      expect(one.totals).toMatchObject({ services: 2, serviceValue: "800.000", amcValue: "800.000", contracts: 1 });

      // Not computed or sent to a user who may not see the values.
      const operations = await signedIn(`uat-ops-${Date.now()}@example.com`, ["AMC_OPERATIONS_EXECUTIVE"]);
      await pool.query("DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code = 'AMC_OPERATIONS_EXECUTIVE') AND module = 'AMC_CONTRACTS'");
      const hidden = (await api().get("/api/amc/service-status").query({ year: 2027 }).set(operations.headers)).body.data;
      expect(hidden.amcValueVisible).toBe(false);
      expect(hidden.totals).toBeNull();

      // The download: a total row under Service Value, and the once-per-contract AMC total in the notes.
      const book = await sheet("/api/amc/service-status/export", { year: 2027 }, admin, "Service Status");
      const allText = JSON.stringify(book.rows);
      expect(allText).toContain("Total filtered (6 services)");
      expect(allText).toContain("each counted once: 2,000.000 (2 contract periods)");
    });

    it("allows a quotation number only once the service is completed (CR-018, unchanged)", async () => {
      const [first] = await visitsOf(contractId);
      const row = async () => (await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [first!.id])).rows[0]?.updated_at.toISOString();
      const before = await api().patch(`/api/services-sales/${first!.id}`).set(admin.headers).send({ quotationNo: "QT-1", expectedUpdatedAt: await row() });
      expect(before.status).toBe(409);
      await withServiceReport(first!.id);
      await pool.query("UPDATE amc_visits SET status = 'COMPLETED', completed_date = '2027-01-05' WHERE id = $1", [first!.id]);
      const after = await api().patch(`/api/services-sales/${first!.id}`).set(admin.headers).send({ quotationNo: "QT-1", expectedUpdatedAt: await row() });
      expect(after.status).toBe(200);
    });
  });

  describe("Dashboard periods (CR-001 to CR-004)", () => {
    beforeEach(async () => {
      await withAuditLogUnlocked("TRUNCATE activity_logs, amc_visits_all, amc_contracts_all, clients_all RESTART IDENTITY CASCADE");
    });

    async function quarterly(clientId: string, validFrom: string, validTo: string): Promise<string> {
      return activeContract(admin, clientId, { systemDescription: "FIRE", validFrom, validTo, maintenanceFrequency: "QUARTERLY", contractValue: "1200.000", defaultVisitAmount: "300.000" });
    }

    it("follows the client's example: a December quarterly contract viewed in December is 1 till date and 4 overall", async () => {
      const clientId = await createClient(admin, "Example Client");
      await quarterly(clientId, "2026-12-01", "2027-11-30");

      const tillDate = await tillDateServiceCounts("2026-12-15");
      expect(tillDate).toMatchObject({ from: null, to: "2026-12-15", due: 1, completed: 0, pending: 1 });
      expect((await yearToDateServiceCounts("2026-12-15")).due).toBe(1);
      // Overall Contract is unchanged: the whole contract, visits ahead included.
      expect((await overallServiceCounts()).overall).toBe(4);
    });

    it("includes the backlog of earlier years in Till Date, not in YTD, and never the visits ahead", async () => {
      const clientId = await createClient(admin, "Backlog Client");
      const old = await quarterly(clientId, "2025-01-01", "2025-12-31");
      await quarterly(clientId, "2026-12-01", "2027-11-30");
      const [oldFirst, oldSecond] = await visitsOf(old);
      // One old visit completed and Paid, one cancelled (never counted), two still pending from 2025.
      await withServiceReport(oldFirst!.id);
      await pool.query(
        "UPDATE amc_visits SET status = 'COMPLETED', completed_date = '2025-01-10', manual_invoice_no = 'INV-OLD', manual_invoice_at = now(), manual_invoice_by = $2 WHERE id = $1",
        [oldFirst!.id, admin.id]
      );
      await pool.query("UPDATE amc_visits SET status = 'CANCELLED' WHERE id = $1", [oldSecond!.id]);

      // On 2027-03-01: 2025 (3 counted) + 2026-12-01 + 2027-03-01 = 5 till date; YTD is 2027 only (1).
      const till = await periodServiceFigures("tillDate", "2027-03-01");
      expect(till).toMatchObject({ due: 5, completed: 1, pending: 4 });
      // Overdue: Scheduled or Postponed before today (the two 2025 ones and 2026-12-01).
      expect(till.overdue).toBe(3);
      expect(till.invoices.withInvoiceNo + till.invoices.withoutInvoiceNo).toBe(till.due);
      expect(till.invoices).toMatchObject({ withInvoiceNo: 1, withInvoiceNoValue: "300.000", withoutInvoiceNo: 4, withoutInvoiceNoValue: "1200.000" });

      const ytd = await periodServiceFigures("yearToDate", "2027-03-01");
      expect(ytd).toMatchObject({ from: "2027-01-01", to: "2027-03-01", due: 1, completed: 0, pending: 1, overdue: 0 });
      expect(ytd.invoices).toMatchObject({ withInvoiceNo: 0, withoutInvoiceNo: 1 });

      // Year boundary: on 2027-01-01 the new year has nothing yet; Till Date still has the backlog.
      expect((await periodServiceFigures("yearToDate", "2027-01-01")).due).toBe(0);
      expect((await periodServiceFigures("tillDate", "2027-01-01")).due).toBe(4);
      // Overall Contract counts every service, visits ahead included (2025: 3 counted, 2026-27: 4).
      expect((await overallServiceCounts()).overall).toBe(7);
    });

    it("picks out the completed services still without an Invoice No., without changing Invoices Not Generated", async () => {
      const clientId = await createClient(admin, "Awaiting Client");
      const id = await quarterly(clientId, "2026-01-01", "2026-12-31");
      const [first, second, third] = await visitsOf(id);
      // Q1 (Jan) completed and Paid; Q2 (Apr) completed, no Invoice No. (waiting to be invoiced); Q3 (Jul) and Q4 (Oct) not done.
      for (const visit of [first!, second!]) await withServiceReport(visit.id);
      await pool.query("UPDATE amc_visits SET status = 'COMPLETED', completed_date = scheduled_date WHERE id = ANY($1::bigint[])", [[first!.id, second!.id]]);
      await pool.query("UPDATE amc_visits SET manual_invoice_no = 'INV-1', manual_invoice_at = now(), manual_invoice_by = $2 WHERE id = $1", [first!.id, admin.id]);
      expect(third).toBeDefined();

      const till = await periodServiceFigures("tillDate", "2026-11-17");
      // Unchanged meaning: every service up to today without an Invoice No. (Q2, Q3 and Q4).
      expect(till.invoices).toMatchObject({ withInvoiceNo: 1, withoutInvoiceNo: 3, withoutInvoiceNoValue: "900.000" });
      // New: of those, only Q2 is done and waiting for its invoice.
      expect(till.invoices).toMatchObject({ completedWithoutInvoiceNo: 1, completedWithoutInvoiceNoValue: "300.000" });
      expect((await periodServiceFigures("yearToDate", "2026-11-17")).invoices.completedWithoutInvoiceNo).toBe(1);

      const dashboard = await api().get("/api/dashboard/operations").set(admin.headers);
      expect(dashboard.status).toBe(200);
      expect(dashboard.body.data.kpis.payments).toMatchObject({ unpaid: 3, unpaidCompleted: 1, unpaidCompletedValue: "300.000" });
    });

    it("returns the new rows on the Dashboard only to users who may see them", async () => {
      const clientId = await createClient(admin, "Shape Client");
      await quarterly(clientId, "2026-01-01", "2026-12-31");

      const full = (await api().get("/api/dashboard/operations").set(admin.headers)).body.data;
      expect(full.tillDate).toMatchObject({ from: null });
      expect(full.tillDate.due).toBeLessThanOrEqual(full.kpis.services.overall);
      expect(full.yearToDate.due).toBeLessThanOrEqual(full.tillDate.due);
      expect(full.periodInvoices.tillDate.withInvoiceNo + full.periodInvoices.tillDate.withoutInvoiceNo).toBe(full.tillDate.due);
      expect(full.periodInvoices.yearToDate.withInvoiceNo + full.periodInvoices.yearToDate.withoutInvoiceNo).toBe(full.yearToDate.due);

      // The Accounts role sees invoices but not the schedule: the Invoice No. split only.
      const limited = (await api().get("/api/dashboard/operations").set(accounts.headers)).body.data;
      expect(limited.tillDate).toBeNull();
      expect(limited.yearToDate).toBeNull();
      expect(limited.periodInvoices.tillDate.withInvoiceNo + limited.periodInvoices.tillDate.withoutInvoiceNo).toBe(full.tillDate.due);
    });
  });
});
