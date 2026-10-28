import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, logsFor, today, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Services Sales: migrations 0078 (quotation number, module) and 0079 (grants).

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
  fire: string;
  cctv: string;
  /** Alpha, quarterly 2027, Esha, Fire: four visits. */
  alphaContract: string;
  /** Beta, half-yearly 2027, Omar, CCTV: two visits. */
  betaContract: string;
  /** Beta, quarterly 2025 (past its end date, so Service Status shows "waiting for renewal"). */
  expiredContract: string;
}
let fx: Fixture;

const list = (query: Record<string, unknown> = {}, session: Session = admin) => api().get("/api/services-sales").query({ pageSize: 200, ...query }).set(session.headers);
const save = (id: string, body: Record<string, unknown>, session: Session = admin) => api().patch(`/api/services-sales/${id}`).set(session.headers).send(body);
const exportFile = (query: Record<string, unknown>, session: Session = admin) => api().get("/api/services-sales/export").query(query).set(session.headers).responseType("blob");

async function complete(visitId: string): Promise<void> {
  const response = await api().patch(`/api/amc/execution/visits/${visitId}`).set(admin.headers).send({ status: "COMPLETED", completedDate: await today() });
  if (response.status !== 200) throw new Error(`Could not complete visit ${visitId}: ${response.status} ${JSON.stringify(response.body)}`);
}

async function itemOf(visitId: string) {
  const response = await list();
  const item = (response.body.data.items as { id: string; updatedAt: string }[]).find((row) => row.id === visitId);
  if (!item) throw new Error(`Visit ${visitId} is not on the page.`);
  return item as Record<string, unknown> & { id: string; updatedAt: string };
}

async function quote(visitId: string, quotationNo: string | null, session: Session = admin) {
  const { updatedAt } = await itemOf(visitId);
  return save(visitId, { quotationNo, expectedUpdatedAt: updatedAt }, session);
}

async function insertMaster(table: "sales_engineers" | "system_types", name: string): Promise<string> {
  const result =
    table === "sales_engineers"
      ? await pool.query<{ id: string }>("INSERT INTO sales_engineers (name) VALUES ($1) RETURNING id", [name])
      : await pool.query<{ id: string }>("INSERT INTO system_types (code, name) VALUES ($1, $1) RETURNING id", [name]);
  return result.rows[0]?.id as string;
}

async function link(contractId: string, salesEngineerId: string, systemTypeId: string) {
  await pool.query("UPDATE amc_contracts SET sales_engineer_id = $1, system_type_id = $2 WHERE id = $3", [salesEngineerId, systemTypeId, contractId]);
}

describe("Services Sales", () => {
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
    // Visit ids restart, so the audit entries of earlier tests go too.
    await pool.query("TRUNCATE activity_logs, amc_visits, amc_contracts, clients, sales_engineers, system_types RESTART IDENTITY CASCADE");
    const alphaId = await createClient(admin, "Alpha Towers");
    const betaId = await createClient(admin, "Beta Mall");
    const esha = await insertMaster("sales_engineers", "Esha Engineer");
    const omar = await insertMaster("sales_engineers", "Omar Engineer");
    const fire = await insertMaster("system_types", "Fire Alarm");
    const cctv = await insertMaster("system_types", "CCTV");
    const alphaContract = await activeContract(admin, alphaId, { systemDescription: "FIRE", maintenanceFrequency: "QUARTERLY" });
    const betaContract = await activeContract(admin, betaId, { systemDescription: "CCTV", maintenanceFrequency: "HALF_YEARLY", contractValue: "800.000", defaultVisitAmount: "400.000" });
    const expiredContract = await activeContract(admin, betaId, { systemDescription: "PUMPS", validFrom: "2025-01-01", validTo: "2025-12-31" });
    await link(alphaContract, esha, fire);
    await link(betaContract, omar, cctv);
    await link(expiredContract, omar, fire);
    fx = { alphaId, betaId, esha, omar, fire, cctv, alphaContract, betaContract, expiredContract };
  });

  describe("rows and cards", () => {
    it("lists one row per scheduled visit with reference, service code, frequency and sales engineer", async () => {
      const response = await list({ clientId: fx.alphaId });
      expect(response.status).toBe(200);
      const items = response.body.data.items;
      expect(items).toHaveLength(4);
      expect(new Set(items.map((item: { id: string }) => item.id)).size).toBe(4);
      expect(items[0]).toMatchObject({
        reference: `AMC-${fx.alphaContract.padStart(4, "0")}`,
        client: { id: fx.alphaId, name: "Alpha Towers" },
        system: { description: "FIRE", typeName: "Fire Alarm" },
        frequency: { code: "QUARTERLY", label: "Quarterly" },
        service: { sequenceNo: 1, cycleNo: 1, serviceCode: "Q1" },
        serviceStatus: "NOT_COMPLETED",
        salesStatus: "NOT_COMPLETED",
        salesEngineer: { id: fx.esha, name: "Esha Engineer" },
        quotationNo: null,
        quotationBeforeCompletion: false,
      });
    });

    it("classifies Not Completed, Completed / Quote Pending and Quoted, and the cards add up to the rows", async () => {
      const [first, second, third] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await complete(second!.id);
      expect((await quote(second!.id, "QT-100")).status).toBe(200);

      const response = await list({ clientId: fx.alphaId });
      const byId = new Map(response.body.data.items.map((item: { id: string; salesStatus: string }) => [item.id, item.salesStatus]));
      expect(byId.get(first!.id)).toBe("QUOTE_PENDING");
      expect(byId.get(second!.id)).toBe("QUOTED");
      expect(byId.get(third!.id)).toBe("NOT_COMPLETED");
      expect(response.body.data.kpis).toEqual({ total: 4, notCompleted: 2, quotePending: 1, quoted: 1, quotationBeforeCompletion: 0 });
      expect(response.body.data.total).toBe(4);
    });

    it("leaves cancelled and historical visits out and changes neither", async () => {
      const [first, second] = await visitsOf(fx.alphaContract);
      await api().patch(`/api/amc/execution/visits/${first!.id}`).set(admin.headers).send({ status: "CANCELLED", statusReason: "Client request" });
      await pool.query("UPDATE amc_visits SET status = 'HISTORICAL' WHERE id = $1", [second!.id]);

      const response = await list({ clientId: fx.alphaId });
      expect(response.body.data.kpis.total).toBe(2);
      expect(response.body.data.items.map((item: { id: string }) => item.id)).not.toContain(first!.id);
      for (const id of [first!.id, second!.id]) {
        expect((await save(id, { quotationNo: "QT-X", expectedUpdatedAt: new Date().toISOString() })).status).toBe(409);
      }

      const stored = await pool.query<{ status: string }>("SELECT status FROM amc_visits WHERE id = ANY($1::bigint[]) ORDER BY id", [[first!.id, second!.id]]);
      expect(stored.rows.map((row) => row.status)).toEqual(["CANCELLED", "HISTORICAL"]);
    });

    it("counts a visit Service Status shows as waiting for renewal as Not Completed", async () => {
      const response = await list({ clientId: fx.betaId, systemTypeId: fx.fire });
      expect(response.body.data.kpis).toMatchObject({ total: 4, notCompleted: 4, quotePending: 0, quoted: 0 });
    });
  });

  describe("integration with Service Status", () => {
    it("reflects a completion saved on Service Status, over the same visit record", async () => {
      const [first] = await visitsOf(fx.betaContract);
      const status = await api().get("/api/amc/service-status").query({ clientId: fx.betaId, pageSize: 200 }).set(admin.headers);
      expect(status.status).toBe(200);
      const row = status.body.data.items.find((item: { id: string }) => item.id === first!.id);

      const saved = await api()
        .patch(`/api/amc/service-status/${first!.id}`)
        .set(admin.headers)
        .send({ status: "COMPLETED", completedDate: await today(), expectedUpdatedAt: row.updatedAt });
      expect(saved.status).toBe(200);

      const after = await itemOf(first!.id);
      expect(after).toMatchObject({ serviceStatus: "COMPLETED", salesStatus: "QUOTE_PENDING" });
      // Both pages count the same visits for the same filters.
      const sales = await list({ clientId: fx.betaId });
      const service = await api().get("/api/amc/service-status").query({ clientId: fx.betaId, pageSize: 200 }).set(admin.headers);
      expect(sales.body.data.kpis.total).toBe(service.body.data.kpis.total);
    });

    it("keeps a quotation number when the visit is reopened, counts it Not Completed and reports it", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await quote(first!.id, "QT-KEEP");
      const reopened = await api().patch(`/api/amc/execution/visits/${first!.id}`).set(admin.headers).send({ status: "SCHEDULED" });
      expect(reopened.status).toBe(200);

      expect(await itemOf(first!.id)).toMatchObject({ quotationNo: "QT-KEEP", salesStatus: "NOT_COMPLETED", quotationBeforeCompletion: true });
      expect((await list({ clientId: fx.alphaId })).body.data.kpis).toMatchObject({ notCompleted: 4, quoted: 0, quotationBeforeCompletion: 1 });
      // It may be cleared on purpose, never automatically.
      expect((await quote(first!.id, null)).status).toBe(200);
      expect(await itemOf(first!.id)).toMatchObject({ quotationNo: null, quotationBeforeCompletion: false });
    });
  });

  describe("saving a quotation number", () => {
    it("saves against one visit only, persists, and changes nothing else", async () => {
      const visits = await visitsOf(fx.alphaContract);
      await complete(visits[0]!.id);
      await complete(visits[1]!.id);
      const snapshot = async () =>
        (await pool.query<{ id: string; row: string }>(
          "SELECT id, (to_jsonb(v) - 'quotation_no' - 'quotation_updated_at' - 'quotation_updated_by' - 'updated_at' - 'updated_by')::text AS row FROM amc_visits v ORDER BY id"
        )).rows;
      const before = await snapshot();
      const contractsBefore = await pool.query("SELECT to_jsonb(c)::text AS row FROM amc_contracts c ORDER BY id");

      const response = await quote(visits[0]!.id, "  QT-2027/001  ", invoicing);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ quotationNo: "QT-2027/001", salesStatus: "QUOTED", quotationUpdatedBy: "invoicing@example.com" });

      expect(await snapshot()).toEqual(before);
      expect((await pool.query("SELECT to_jsonb(c)::text AS row FROM amc_contracts c ORDER BY id")).rows).toEqual(contractsBefore.rows);
      const stored = await pool.query<{ id: string; quotation_no: string | null; quotation_updated_by: string | null }>(
        "SELECT id, quotation_no, quotation_updated_by FROM amc_visits ORDER BY id"
      );
      expect(stored.rows.filter((row) => row.quotation_no !== null)).toEqual([{ id: visits[0]!.id, quotation_no: "QT-2027/001", quotation_updated_by: invoicing.id }]);
      expect((await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0]?.n).toBe(0);
      expect(await itemOf(visits[0]!.id)).toMatchObject({ quotationNo: "QT-2027/001" });
      expect(await itemOf(visits[1]!.id)).toMatchObject({ quotationNo: null, salesStatus: "QUOTE_PENDING" });
    });

    it("records every change in the audit log, and an unchanged save writes nothing", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await quote(first!.id, "QT-1");
      await quote(first!.id, "QT-2");
      await quote(first!.id, "QT-2");
      await quote(first!.id, null);

      const logs = (await logsFor("amc_visits", first!.id)).filter((log) => log.action === "amc_visit.quotation_changed");
      expect(logs.map((log) => log.metadata?.changes)).toEqual([
        { quotationNo: { from: null, to: "QT-1" } },
        { quotationNo: { from: "QT-1", to: "QT-2" } },
        { quotationNo: { from: "QT-2", to: null } },
      ]);
      expect(logs.every((log) => log.module === "SERVICES_SALES" && log.user_id === admin.id)).toBe(true);
    });

    it("refuses a new number before completion, and stores nothing", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      const response = await quote(first!.id, "QT-EARLY");
      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/completed/);
      expect((await pool.query("SELECT quotation_no FROM amc_visits WHERE id = $1", [first!.id])).rows[0]).toEqual({ quotation_no: null });
    });

    it("rejects N/A, overlong or multi-line numbers and unknown fields", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      const { updatedAt } = await itemOf(first!.id);
      for (const quotationNo of ["N/A", "n/a", "NA", "Q".repeat(51), "QT\n1"]) {
        expect((await save(first!.id, { quotationNo, expectedUpdatedAt: updatedAt })).status).toBe(400);
      }
      expect((await save(first!.id, { quotationNo: "QT-1", expectedUpdatedAt: updatedAt, status: "COMPLETED" })).status).toBe(400);
      expect((await save(first!.id, { quotationNo: "QT-1" })).status).toBe(400);
      expect((await save("999999", { quotationNo: "QT-1", expectedUpdatedAt: updatedAt })).status).toBe(404);
    });

    it("refuses a save over a newer change", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      const { updatedAt } = await itemOf(first!.id);
      expect((await save(first!.id, { quotationNo: "QT-A", expectedUpdatedAt: updatedAt })).status).toBe(200);
      const stale = await save(first!.id, { quotationNo: "QT-B", expectedUpdatedAt: updatedAt });
      expect(stale.status).toBe(409);
      expect((await itemOf(first!.id)).quotationNo).toBe("QT-A");
    });
  });

  describe("permissions", () => {
    it("lets Admin and Invoicing edit, Accountant and Execution only view, and Procurement nothing", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);

      expect((await api().get("/api/services-sales")).status).toBe(401);
      for (const session of [admin, invoicing, accountant, execution]) expect((await list({}, session)).status).toBe(200);
      expect((await list({}, procurement)).status).toBe(403);
      expect((await api().get("/api/services-sales/options").set(procurement.headers)).status).toBe(403);

      expect((await quote(first!.id, "QT-ACC", accountant)).status).toBe(403);
      expect((await quote(first!.id, "QT-EXE", execution)).status).toBe(403);
      expect((await pool.query("SELECT quotation_no FROM amc_visits WHERE id = $1", [first!.id])).rows[0]).toEqual({ quotation_no: null });
      expect((await quote(first!.id, "QT-INV", invoicing)).status).toBe(200);

      // EXPORT is Admin's only, as on every other module, until an Admin grants it.
      expect((await exportFile({ format: "xlsx" }, accountant)).status).toBe(403);
      expect((await exportFile({ format: "xlsx" }, invoicing)).status).toBe(403);
      expect((await exportFile({ format: "xlsx" }, admin)).status).toBe(200);
    });
  });

  describe("search and filters", () => {
    const ids = (response: { body: { data: { items: { id: string }[] } } }) => response.body.data.items.map((item) => item.id).sort();

    it("applies every filter together, and the cards follow the same filters", async () => {
      const alpha = await visitsOf(fx.alphaContract);
      const beta = await visitsOf(fx.betaContract);
      await complete(alpha[0]!.id);
      await quote(alpha[0]!.id, "QT-777");

      expect(ids(await list({ search: "QT-777" }))).toEqual([alpha[0]!.id]);
      expect(ids(await list({ search: `AMC-${fx.alphaContract.padStart(4, "0")}` }))).toEqual(alpha.map((v) => v.id).sort());
      expect(ids(await list({ search: "beta" }))).toHaveLength(beta.length + 4);
      expect(ids(await list({ search: "cctv" }))).toEqual(beta.map((v) => v.id).sort());
      expect(ids(await list({ salesEngineerId: fx.esha }))).toEqual(alpha.map((v) => v.id).sort());
      expect(ids(await list({ systemTypeId: fx.cctv }))).toEqual(beta.map((v) => v.id).sort());
      expect(ids(await list({ frequency: "HALF_YEARLY" }))).toEqual(beta.map((v) => v.id).sort());
      expect(ids(await list({ serviceStatus: "COMPLETED" }))).toEqual([alpha[0]!.id]);

      const month = Number(alpha[0]!.scheduled_date.slice(5, 7));
      const year = Number(alpha[0]!.scheduled_date.slice(0, 4));
      const combined = await list({ clientId: fx.alphaId, salesEngineerId: fx.esha, systemTypeId: fx.fire, frequency: "QUARTERLY", month, year, serviceStatus: "COMPLETED", search: "alpha" });
      expect(ids(combined)).toEqual([alpha[0]!.id]);
      expect(combined.body.data.kpis).toEqual({ total: 1, notCompleted: 0, quotePending: 0, quoted: 1, quotationBeforeCompletion: 0 });
      expect(ids(await list({ month, year: year + 5 }))).toEqual([]);
      expect((await list({ month: 13 })).status).toBe(400);
    });

    it("pages the rows while the total and cards cover every matching visit", async () => {
      const response = await list({ pageSize: 2, page: 2 });
      expect(response.body.data.items).toHaveLength(2);
      expect(response.body.data).toMatchObject({ total: 10, page: 2, pageSize: 2 });
      expect(response.body.data.kpis.total).toBe(10);
    });

    it("offers filter options from the contracts with visits on the page", async () => {
      const response = await api().get("/api/services-sales/options").set(admin.headers);
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        clients: [{ name: "Alpha Towers" }, { name: "Beta Mall" }],
        salesEngineers: [{ name: "Esha Engineer" }, { name: "Omar Engineer" }],
        systemTypes: [{ name: "CCTV" }, { name: "Fire Alarm" }],
        frequencies: [{ code: "QUARTERLY", label: "Quarterly" }, { code: "HALF_YEARLY", label: "Half-yearly" }],
        years: [2025, 2027],
      });
    });
  });

  describe("exports", () => {
    it("exports every matching visit across pages, with quotation numbers and statuses", async () => {
      const alpha = await visitsOf(fx.alphaContract);
      await complete(alpha[0]!.id);
      await quote(alpha[0]!.id, "=QT-1");

      const response = await exportFile({ format: "xlsx", clientId: fx.alphaId });
      expect(response.status).toBe(200);
      expect(response.headers["content-disposition"]).toMatch(/services-sales/);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
      const sheet = workbook.getWorksheet("Services Sales") as ExcelJS.Worksheet;
      const header = (sheet.getRow(6).values as unknown[]).slice(1);
      expect(header).toEqual(["#", "AMC Reference", "Client", "System", "Frequency", "Service", "Due date", "Service status", "Completed date", "Quote No.", "Sales status", "Sales Engineer"]);
      const rows = [7, 8, 9, 10].map((n) => (sheet.getRow(n).values as unknown[]).slice(1));
      expect(rows.map((row) => row[2])).toEqual(["Alpha Towers", "Alpha Towers", "Alpha Towers", "Alpha Towers"]);
      // A formula-like number is written as text, never run.
      expect(rows[0]?.[9]).not.toBe("=QT-1");
      expect(String(rows[0]?.[9])).toContain("QT-1");
      expect(rows[0]?.[7]).toBe("Completed");
      expect(rows[0]?.[10]).toBe("Quoted");
      expect(rows[1]?.[7]).toBe("Not Completed");
      expect(sheet.getRow(11).getCell(3).value).not.toBe("Alpha Towers");

      const audit = await pool.query<{ metadata: { rowCount: number } }>("SELECT metadata FROM activity_logs WHERE action = 'services_sales.exported' ORDER BY id DESC LIMIT 1");
      expect(audit.rows[0]?.metadata.rowCount).toBe(4);
    });

    it("produces a PDF for the same filters and refuses an unknown format", async () => {
      const response = await exportFile({ format: "pdf", serviceStatus: "NOT_COMPLETED" });
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("application/pdf");
      expect((response.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
      expect((await exportFile({ format: "csv" })).status).toBe(400);
    });
  });

  describe("the other AMC screens", () => {
    it("keep working with quotation numbers recorded", async () => {
      const [first] = await visitsOf(fx.alphaContract);
      await complete(first!.id);
      await quote(first!.id, "QT-1");

      expect((await api().get("/api/amc/visits").set(admin.headers)).status).toBe(200);
      expect((await api().get(`/api/amc/visits/${first!.id}`).set(admin.headers)).body.data).toMatchObject({ status: "COMPLETED" });
      expect((await api().get("/api/amc/contracts").set(admin.headers)).status).toBe(200);
      expect((await api().get(`/api/amc/contracts/${fx.alphaContract}`).set(admin.headers)).status).toBe(200);
      expect((await api().get("/api/amc/execution/visits").set(admin.headers)).status).toBe(200);
    });
  });
});
