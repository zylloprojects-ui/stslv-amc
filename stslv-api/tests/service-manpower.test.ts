import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { HEADER_ROW } from "../src/shared/export/excel";
import { activeContract, createClient, logsFor, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn, withAuditLogUnlocked } from "./helpers";

// Number of Manpower on Service Status (migration 0122, 2026-11-19): typed by hand on one scheduled service, never
// calculated, and changing nothing else. Every record here is invented.

let admin: Session;
let execution: Session; // AMC_SCHEDULE:VIEW, AMC_EXECUTION:VIEW/EDIT
let accountant: Session; // Service Status view only
let procurement: Session; // no AMC access
let contractId: string;
let visitIds: string[];

const list = (session: Session = admin) => api().get("/api/amc/service-status").query({ pageSize: 200 }).set(session.headers);
const one = (id: string, session: Session = admin) => api().get(`/api/amc/service-status/${id}`).set(session.headers);

async function updatedAt(id: string): Promise<string> {
  const row = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [id]);
  return (row.rows[0]?.updated_at as Date).toISOString();
}

/** Saves as the page does: only the changed fields, with the updatedAt the page showed. */
async function save(id: string, body: Record<string, unknown>, session: Session = execution) {
  return api()
    .patch(`/api/amc/service-status/${id}`)
    .set(session.headers)
    .send({ expectedUpdatedAt: await updatedAt(id), ...body });
}

async function stored(id: string) {
  return (
    await pool.query<{ manpower_count: number | null; status: string; completed_date: string | null; visit_amount: string | null; manual_invoice_no: string | null }>(
      "SELECT manpower_count, status, completed_date::text AS completed_date, visit_amount::text AS visit_amount, manual_invoice_no FROM amc_visits WHERE id = $1",
      [id]
    )
  ).rows[0]!;
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("mp-admin@example.com", ["ADMIN"]);
  execution = await signedIn("mp-execution@example.com", ["EXECUTION"]);
  accountant = await signedIn("mp-accountant@example.com", ["ACCOUNTANT"]);
  procurement = await signedIn("mp-procurement@example.com", ["PROCUREMENT"]);
});
afterAll(closePool);

beforeEach(async () => {
  await withAuditLogUnlocked("TRUNCATE activity_logs, amc_visits_all, amc_contracts_all, clients_all RESTART IDENTITY CASCADE");
  const clientId = await createClient(admin, "Manpower Towers");
  contractId = await activeContract(admin, clientId, {
    systemDescription: "FIRE",
    validFrom: "2027-01-01",
    validTo: "2027-12-31",
    maintenanceFrequency: "QUARTERLY",
    contractValue: "1200.000",
    defaultVisitAmount: "300.000",
  });
  visitIds = (await visitsOf(contractId)).map((visit) => visit.id);
});

describe("Number of Manpower on Service Status", () => {
  it("is blank on existing services and is offered by the API", async () => {
    const response = await list();

    expect(response.status).toBe(200);
    expect(response.body.data.manpowerCountAvailable).toBe(true);
    const items = response.body.data.items as { id: string; manpowerCount: number | null }[];
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.manpowerCount === null)).toBe(true);
    expect((await pool.query("SELECT count(*)::int AS n FROM amc_visits WHERE manpower_count IS NOT NULL")).rows[0].n).toBe(0);
  });

  it("saves the number against exactly that service and shows it when reopened", async () => {
    const response = await save(visitIds[1]!, { manpowerCount: 3 });

    expect(response.status).toBe(200);
    expect(response.body.data.manpowerCount).toBe(3);
    expect((await stored(visitIds[1]!)).manpower_count).toBe(3);
    // No other service of the contract was touched.
    for (const id of [visitIds[0]!, visitIds[2]!, visitIds[3]!]) expect((await stored(id)).manpower_count).toBeNull();

    // Reopened: the list and the View dialog's own read both show it.
    const listed = (await list()).body.data.items as { id: string; manpowerCount: number | null }[];
    expect(listed.find((item) => item.id === visitIds[1])?.manpowerCount).toBe(3);
    expect((await one(visitIds[1]!)).body.data.manpowerCount).toBe(3);
  });

  it("can be edited later, set to zero and cleared", async () => {
    expect((await save(visitIds[0]!, { manpowerCount: 2 })).status).toBe(200);
    expect((await save(visitIds[0]!, { manpowerCount: 5 })).body.data.manpowerCount).toBe(5);
    expect((await save(visitIds[0]!, { manpowerCount: 0 })).body.data.manpowerCount).toBe(0);
    expect((await stored(visitIds[0]!)).manpower_count).toBe(0);
    expect((await save(visitIds[0]!, { manpowerCount: null })).body.data.manpowerCount).toBeNull();
    expect((await stored(visitIds[0]!)).manpower_count).toBeNull();
  });

  it("accepts non-negative whole numbers only", async () => {
    for (const manpowerCount of [-1, 1.5, "3", "", "abc", true, 10000, 1e9]) {
      const response = await save(visitIds[0]!, { manpowerCount });

      expect(response.status, `value ${JSON.stringify(manpowerCount)}`).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await stored(visitIds[0]!)).manpower_count).toBeNull();
    // The upper input limit itself is accepted.
    expect((await save(visitIds[0]!, { manpowerCount: 9999 })).status).toBe(200);
  });

  it("is also refused by the database when negative", async () => {
    await expect(pool.query("UPDATE amc_visits SET manpower_count = -1 WHERE id = $1", [visitIds[0]])).rejects.toThrow(/amc_visits_manpower_count_ck/);
  });

  it("writes one Audit Log entry per change and none when unchanged", async () => {
    await save(visitIds[0]!, { manpowerCount: 4 });
    await save(visitIds[0]!, { manpowerCount: 4 });
    await save(visitIds[0]!, { manpowerCount: 6 });

    const logs = (await logsFor("amc_visits", visitIds[0]!)).filter((log: { action: string }) => log.action === "amc_visit.manpower_count_changed");
    expect(logs).toHaveLength(2);
    const latest = (
      await pool.query<{ user_id: string; module: string; description: string; metadata: { changes: Record<string, unknown> } }>(
        "SELECT user_id, module, description, metadata FROM activity_logs WHERE action = 'amc_visit.manpower_count_changed' ORDER BY id DESC LIMIT 1"
      )
    ).rows[0]!;
    expect(latest).toMatchObject({ user_id: execution.id, module: "AMC_EXECUTION" });
    expect(latest.description).toMatch(/^Number of Manpower of AMC visit 1 .* set to 6\.$/);
    expect(latest.metadata.changes.manpowerCount).toEqual({ from: 4, to: 6 });
  });

  it("changes nothing else: status, completion, service value, Invoice No. or the contract", async () => {
    const contractBefore = (await api().get(`/api/amc/contracts/${contractId}`).set(admin.headers)).body.data;
    const before = await stored(visitIds[0]!);

    await save(visitIds[0]!, { manpowerCount: 7 });

    const after = await stored(visitIds[0]!);
    expect(after).toEqual({ ...before, manpower_count: 7 });
    const contractAfter = (await api().get(`/api/amc/contracts/${contractId}`).set(admin.headers)).body.data;
    expect({ ...contractAfter, updatedAt: undefined }).toEqual({ ...contractBefore, updatedAt: undefined });
    expect(contractAfter.updatedAt).toBe(contractBefore.updatedAt);
  });

  it("can be entered on a completed (locked) and on a Paid service without changing either state", async () => {
    await withServiceReport(visitIds[0]!);
    expect((await save(visitIds[0]!, { status: "COMPLETED" })).status).toBe(200);
    const completed = await stored(visitIds[0]!);

    const response = await save(visitIds[0]!, { manpowerCount: 2 });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ manpowerCount: 2, serviceStatus: "COMPLETED", locked: true });
    expect(await stored(visitIds[0]!)).toEqual({ ...completed, manpower_count: 2 });

    // Paid through the real manual Invoice No. endpoint (a completed service).
    const invoice = await api()
      .patch(`/api/amc/visits/${visitIds[0]}/manual-invoice`)
      .set(admin.headers)
      .send({ invoiceNo: "INV-MP-1", expectedUpdatedAt: (await api().get(`/api/amc/visits/${visitIds[0]}`).set(admin.headers)).body.data.updatedAt });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(200);
    const paidBefore = await stored(visitIds[0]!);
    const paid = await save(visitIds[0]!, { manpowerCount: 1 });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ manpowerCount: 1, paid: true, serviceStatus: "COMPLETED" });
    expect(await stored(visitIds[0]!)).toEqual({ ...paidBefore, manpower_count: 1 });
    expect(paidBefore.manual_invoice_no).toBe("INV-MP-1");
  });

  it("saves together with the other fields of the row", async () => {
    const response = await save(visitIds[2]!, { salesEngineerName: "Field Person", reportNumber: "SR-9", manpowerCount: 3 });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ salesEngineerName: "Field Person", reportNumber: "SR-9", manpowerCount: 3 });
  });

  it("never overwrites another typed field when saved alone, and is kept when another field is saved", async () => {
    await save(visitIds[2]!, { salesEngineerName: "Field Person", reportNumber: "SR-9" });
    expect((await save(visitIds[2]!, { manpowerCount: 2 })).body.data).toMatchObject({ salesEngineerName: "Field Person", reportNumber: "SR-9", manpowerCount: 2 });
    expect((await save(visitIds[2]!, { salesEngineerName: "Other Person" })).body.data).toMatchObject({ salesEngineerName: "Other Person", manpowerCount: 2 });
    // Every other column of the visit is unchanged by a Manpower-only save.
    const before = (await pool.query("SELECT * FROM amc_visits WHERE id = $1", [visitIds[2]])).rows[0] as Record<string, unknown>;
    await save(visitIds[2]!, { manpowerCount: 5 });
    const after = (await pool.query("SELECT * FROM amc_visits WHERE id = $1", [visitIds[2]])).rows[0] as Record<string, unknown>;
    expect({ ...after, updated_at: null }).toEqual({ ...before, manpower_count: 5, updated_at: null });
  });

  it("coexists with the Number of Working Days (0121): each saves its own column and never overwrites the other", async () => {
    const both = await save(visitIds[1]!, { workingDays: 3, manpowerCount: 4 });
    expect(both.status).toBe(200);
    expect(both.body.data).toMatchObject({ workingDays: 3, manpowerCount: 4 });

    // Manpower alone keeps the working days; working days alone keeps the manpower.
    expect((await save(visitIds[1]!, { manpowerCount: 6 })).body.data).toMatchObject({ workingDays: 3, manpowerCount: 6 });
    expect((await save(visitIds[1]!, { workingDays: 2 })).body.data).toMatchObject({ workingDays: 2, manpowerCount: 6 });
    // Clearing one leaves the other.
    expect((await save(visitIds[1]!, { manpowerCount: null })).body.data).toMatchObject({ workingDays: 2, manpowerCount: null });
    expect((await save(visitIds[1]!, { manpowerCount: 1, workingDays: null })).body.data).toMatchObject({ workingDays: null, manpowerCount: 1 });

    const row = (await pool.query("SELECT working_days, manpower_count FROM amc_visits WHERE id = $1", [visitIds[1]])).rows[0];
    expect(row).toEqual({ working_days: null, manpower_count: 1 });
    // A refused value of one field saves neither (the whole request is validated first).
    expect((await save(visitIds[1]!, { workingDays: 5, manpowerCount: -1 })).status).toBe(400);
    expect((await pool.query("SELECT working_days, manpower_count FROM amc_visits WHERE id = $1", [visitIds[1]])).rows[0]).toEqual(row);

    // Each change has its own Audit Log action.
    const actions = (await logsFor("amc_visits", visitIds[1]!)).map((log: { action: string }) => log.action);
    expect(actions.filter((action: string) => action === "amc_visit.manpower_count_changed")).toHaveLength(4);
    expect(actions.filter((action: string) => action === "amc_visit.working_days_changed")).toHaveLength(3);
    // Both appear in the list.
    const listed = ((await list()).body.data.items as { id: string; workingDays: number | null; manpowerCount: number | null }[]).find((item) => item.id === visitIds[1]);
    expect(listed).toMatchObject({ workingDays: null, manpowerCount: 1 });
  });

  it("is refused over a newer change (optimistic concurrency)", async () => {
    const stale = await updatedAt(visitIds[0]!);
    await save(visitIds[0]!, { manpowerCount: 1 });

    const response = await api().patch(`/api/amc/service-status/${visitIds[0]}`).set(execution.headers).send({ manpowerCount: 9, expectedUpdatedAt: stale });
    expect(response.status).toBe(409);
    expect((await stored(visitIds[0]!)).manpower_count).toBe(1);
  });

  it("follows the existing permissions: saving needs AMC Execution: Edit", async () => {
    // Viewing only (Service Status: View, no AMC Execution: Edit): sees the value, cannot save.
    await save(visitIds[0]!, { manpowerCount: 2 });
    const seen = (await list(accountant)).body.data.items as { id: string; manpowerCount: number | null }[];
    expect(seen.find((item) => item.id === visitIds[0])?.manpowerCount).toBe(2);
    expect((await save(visitIds[0]!, { manpowerCount: 8 }, accountant)).status).toBe(403);
    // No AMC access at all.
    expect((await save(visitIds[0]!, { manpowerCount: 8 }, procurement)).status).toBe(403);
    expect((await list(procurement)).status).toBe(403);
    // Unsigned.
    const unsigned = await api().patch(`/api/amc/service-status/${visitIds[0]}`).send({ manpowerCount: 8, expectedUpdatedAt: await updatedAt(visitIds[0]!) });
    expect(unsigned.status).toBe(401);
    expect((await stored(visitIds[0]!)).manpower_count).toBe(2);
  });

  it("is in the export as its own hideable column, blank when not entered", async () => {
    await save(visitIds[0]!, { manpowerCount: 4 });

    const read = async (hidden?: string) => {
      const response = await api()
        .get("/api/amc/service-status/export")
        .query({ format: "xlsx", ...(hidden ? { hidden } : {}) })
        .responseType("blob")
        .set(admin.headers);
      expect(response.status).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
      const sheet = workbook.getWorksheet("Service Status") as ExcelJS.Worksheet;
      const header = (sheet.getRow(HEADER_ROW).values as unknown[]).slice(1) as string[];
      return { header, sheet };
    };

    const { header, sheet } = await read();
    const column = header.indexOf("Number of Manpower");
    // Owner's order (2026-11-19): Service Engineer, Number of Working Days, Number of Manpower.
    expect(header.indexOf("Number of Working Days")).toBe(header.indexOf("Service Engineer") + 1);
    expect(column).toBe(header.indexOf("Number of Working Days") + 1);
    const values: unknown[] = [];
    sheet.eachRow((row, n) => {
      if (n > HEADER_ROW && typeof row.getCell(1).value === "number") values.push(row.getCell(column + 1).value ?? null);
    });
    expect(values).toEqual([4, null, null, null]);

    expect((await read("manpowerCount")).header).not.toContain("Number of Manpower");
  });
});
