import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { ownRecordsOnlyEnabled } from "../src/modules/services-sales/services-sales.service";
import { activeContract, createClient, grant, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn, withAuditLogUnlocked } from "./helpers";

// CR-017 (client meeting 2026-11-16, PROVISIONAL): with SERVICE_SALES_OWN_RECORDS_ENABLED=true, a Service Sales user
// without AMC Contracts: View sees only the services of contracts whose Sales Engineer is linked to their user.
let admin: Session;
let ravi: Session;
let sara: Session;
let unlinked: Session;
let raviContract: string;
let saraContract: string;

async function salesEngineer(name: string, userId: string | null): Promise<string> {
  const result = await pool.query<{ id: string }>("INSERT INTO sales_engineers (name, is_active, user_id) VALUES ($1, true, $2) RETURNING id", [name, userId]);
  return result.rows[0]?.id as string;
}

async function contractFor(clientName: string, engineerId: string): Promise<string> {
  const clientId = await createClient(admin, clientName);
  const id = await activeContract(admin, clientId, {
    systemDescription: "FIRE",
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    maintenanceFrequency: "QUARTERLY",
    contractValue: "1200.000",
    defaultVisitAmount: "300.000",
  });
  await pool.query("UPDATE amc_contracts_all SET sales_engineer_id = $2 WHERE id = $1", [id, engineerId]);
  return id;
}

const list = (session: Session) => api().get("/api/services-sales").query({ pageSize: 100 }).set(session.headers);
const clientsOf = (body: { data: { items: { client: { name: string } }[] } }) => [...new Set(body.data.items.map((item) => item.client.name))].sort();

describe("Service Sales: own records only (CR-017)", () => {
  beforeAll(async () => {
    await resetData();
    admin = await signedIn("own-admin@example.com", ["ADMIN"]);
    await grant("MASTER_DATA_EXECUTIVE", [
      ["SERVICES_SALES", "VIEW"],
      ["SERVICES_SALES", "EDIT"],
      ["SERVICES_SALES", "EXPORT"],
    ]);
    ravi = await signedIn("own-ravi@example.com", ["MASTER_DATA_EXECUTIVE"]);
    sara = await signedIn("own-sara@example.com", ["MASTER_DATA_EXECUTIVE"]);
    unlinked = await signedIn("own-unlinked@example.com", ["MASTER_DATA_EXECUTIVE"]);
  });

  beforeEach(async () => {
    await withAuditLogUnlocked("TRUNCATE activity_logs, amc_visits_all, amc_contracts_all, clients_all, sales_engineers_all RESTART IDENTITY CASCADE");
    raviContract = await contractFor("Ravi Client", await salesEngineer("Ravi Sales", ravi.id));
    saraContract = await contractFor("Sara Client", await salesEngineer("Sara Sales", sara.id));
    process.env.SERVICE_SALES_OWN_RECORDS_ENABLED = "true";
  });

  afterEach(() => {
    delete process.env.SERVICE_SALES_OWN_RECORDS_ENABLED;
  });

  afterAll(closePool);

  it("is off unless the switch is exactly true", () => {
    expect(ownRecordsOnlyEnabled({})).toBe(false);
    expect(ownRecordsOnlyEnabled({ SERVICE_SALES_OWN_RECORDS_ENABLED: "yes" })).toBe(false);
    expect(ownRecordsOnlyEnabled({ SERVICE_SALES_OWN_RECORDS_ENABLED: " TRUE " })).toBe(true);
  });

  it("shows a sales user only the services of their own contracts, with matching cards", async () => {
    const response = await list(ravi);

    expect(response.status).toBe(200);
    expect(clientsOf(response.body)).toEqual(["Ravi Client"]);
    expect(response.body.data.total).toBe(4);
    expect(response.body.data.kpis.total).toBe(4);
    expect(response.body.data.ownRecordsOnly).toBe(true);
    expect(clientsOf((await list(sara)).body)).toEqual(["Sara Client"]);
  });

  it("shows nothing to a sales user with no linked Sales Engineer", async () => {
    const response = await list(unlinked);

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([]);
    expect(response.body.data.total).toBe(0);
  });

  it("still shows every service to a user who may view AMC Contracts", async () => {
    const response = await list(admin);

    expect(clientsOf(response.body)).toEqual(["Ravi Client", "Sara Client"]);
    expect(response.body.data.ownRecordsOnly).toBe(false);
  });

  it("changes nothing while the switch is off", async () => {
    delete process.env.SERVICE_SALES_OWN_RECORDS_ENABLED;
    const response = await list(ravi);

    expect(clientsOf(response.body)).toEqual(["Ravi Client", "Sara Client"]);
    expect(response.body.data.ownRecordsOnly).toBe(false);
  });

  it("limits the export to the same rows", async () => {
    const response = await api().get("/api/services-sales/export").query({ format: "xlsx" }).set(ravi.headers).responseType("blob");
    expect(response.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const text = JSON.stringify(workbook.worksheets.map((sheet) => sheet.getSheetValues()));

    expect(text).toContain("Ravi Client");
    expect(text).not.toContain("Sara Client");
  });

  it("refuses another engineer's service report and quotation as not found, and allows their own", async () => {
    const [saraFirst] = await visitsOf(saraContract);
    const [raviFirst] = await visitsOf(raviContract);
    for (const visit of [saraFirst!, raviFirst!]) {
      await withServiceReport(visit.id);
      await pool.query("UPDATE amc_visits SET status = 'COMPLETED', completed_date = '2027-01-05' WHERE id = $1", [visit.id]);
    }
    const updatedAt = async (id: string) => (await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [id])).rows[0]?.updated_at.toISOString();

    expect((await api().get(`/api/services-sales/${saraFirst!.id}/report`).set(ravi.headers)).status).toBe(404);
    const refused = await api().patch(`/api/services-sales/${saraFirst!.id}`).set(ravi.headers).send({ quotationNo: "QT-X", expectedUpdatedAt: await updatedAt(saraFirst!.id) });
    expect(refused.status).toBe(404);
    expect((await pool.query("SELECT quotation_no FROM amc_visits WHERE id = $1", [saraFirst!.id])).rows[0]?.quotation_no).toBeNull();

    const own = await api().patch(`/api/services-sales/${raviFirst!.id}`).set(ravi.headers).send({ quotationNo: "QT-R1", expectedUpdatedAt: await updatedAt(raviFirst!.id) });
    expect(own.status).toBe(200);
    expect(own.body.data.quotationNo).toBe("QT-R1");
  });
});
