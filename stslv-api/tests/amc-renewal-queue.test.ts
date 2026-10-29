import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, contractBody, createClient, createContract, renewalEngineer, today, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// The AMC Renewal queue: renewal states derived from contracts and their
// renewals (migration 0072), measured against the database's current date.
// Every record here is invented.

let admin: Session;
let execution: Session;
let procurement: Session;
let todayIso: string;

/** A date `days` after the database's today (negative for before), as YYYY-MM-DD. Calendar arithmetic in UTC, so no time zone can shift it. */
function shift(days: number): string {
  const date = new Date(`${todayIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A one-year contract ending `endsIn` days from today. */
const endingIn = (endsIn: number, overrides: Record<string, unknown> = {}) => ({ validFrom: shift(endsIn - 364), validTo: shift(endsIn), ...overrides });

interface Fixture {
  clientId: string;
  at45: string;
  at46: string;
  endsToday: string;
  pastValidity: string;
  expiredStatus: string;
  cancelledContract: string;
  draftContract: string;
}
let fx: Fixture;

type Item = { id: string; reference: string; renewalState: string; daysLeft: number; contractStatus: string; renewal: { id: string; status: string } | null; remarks: string | null; services: { completed: number; scheduled: number } };

const queue = (query: Record<string, unknown> = {}, session: Session = admin) => api().get("/api/amc/renewals/queue").query({ pageSize: 200, ...query }).set(session.headers);
const stateOf = async (id: string): Promise<string | null> => ((await queue()).body.data.items as Item[]).find((item) => item.id === id)?.renewalState ?? null;
const itemOf = async (id: string): Promise<Item | undefined> => ((await queue()).body.data.items as Item[]).find((item) => item.id === id);

// Every renewal names an active sales engineer.
let engineerId: string;

const renew = (sourceId: string, overrides: Record<string, unknown> = {}, session: Session = admin) =>
  api()
    .post(`/api/amc/contracts/${sourceId}/renewals`)
    .set(session.headers)
    .send(contractBody(fx.clientId, { validFrom: shift(400), validTo: shift(764), status: "DRAFT", salesEngineerId: engineerId, ...overrides }));
const setStatus = (id: string, status: string, session: Session = admin) => api().post(`/api/amc/contracts/${id}/status`).set(session.headers).send({ status });

async function contract(endsIn: number, overrides: Record<string, unknown> = {}): Promise<string> {
  return activeContract(admin, fx.clientId, endingIn(endsIn, overrides));
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  todayIso = await today();
  engineerId = await renewalEngineer();

  const clientId = await createClient(admin, "Renewal Queue Client");
  fx = { clientId } as Fixture;
  fx.at45 = await contract(45, { systemDescription: "FIRE ALARM" });
  fx.at46 = await contract(46, { systemDescription: "CCTV" });
  fx.endsToday = await contract(0, { systemDescription: "ACCESS CONTROL" });
  fx.pastValidity = await contract(-30, { systemDescription: "PUMPS", notes: "Client asked for a revised quote." });
  fx.expiredStatus = await contract(-60, { systemDescription: "GATES" });
  expect((await setStatus(fx.expiredStatus, "EXPIRED")).status).toBe(200);
  fx.cancelledContract = await contract(10, { systemDescription: "INTERCOM" });
  expect((await setStatus(fx.cancelledContract, "CANCELLED")).status).toBe(200);
  const draft = await createContract(admin, fx.clientId, { ...endingIn(10), systemDescription: "LIGHTING", status: "DRAFT" });
  fx.draftContract = draft.body.data.id as string;
});
afterAll(closePool);

describe("GET /api/amc/renewals/queue — eligibility", () => {
  it("lists active contracts ending within 45 days, the 45th day included and the 46th not", async () => {
    expect(await stateOf(fx.at45)).toBe("DUE");
    expect(await stateOf(fx.at46)).toBeNull();
    expect((await itemOf(fx.at45))?.daysLeft).toBe(45);
  });

  it("lists contracts ending today and contracts already past validity, active or expired", async () => {
    expect(await itemOf(fx.endsToday)).toMatchObject({ renewalState: "DUE", daysLeft: 0, contractStatus: "ACTIVE" });
    expect(await itemOf(fx.pastValidity)).toMatchObject({ renewalState: "DUE", daysLeft: -30, contractStatus: "ACTIVE", remarks: "Client asked for a revised quote." });
    expect(await itemOf(fx.expiredStatus)).toMatchObject({ renewalState: "DUE", contractStatus: "EXPIRED" });
  });

  it("leaves out cancelled and draft contracts that have no renewal", async () => {
    expect(await stateOf(fx.cancelledContract)).toBeNull();
    expect(await stateOf(fx.draftContract)).toBeNull();
  });

  it("returns the reference, service progress, window and today's date", async () => {
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ windowDays: 45, today: todayIso });
    const item = (response.body.data.items as Item[]).find((row) => row.id === fx.at45);
    expect(item?.reference).toBe(`AMC-${fx.at45.padStart(4, "0")}`);
    expect(item?.services.scheduled).toBe((await visitsOf(fx.at45)).filter((visit) => visit.status !== "CANCELLED").length);
    expect(item?.services.completed).toBe(0);
  });
});

describe("renewal lifecycle through the queue", () => {
  let renewalId: string;

  it("starting a renewal makes the contract Under Client Approval and leaves the contract unchanged", async () => {
    const before = (await api().get(`/api/amc/contracts/${fx.at45}`).set(admin.headers)).body.data;
    const visitsBefore = await visitsOf(fx.at45);

    const response = await renew(fx.at45);
    expect(response.status).toBe(201);
    renewalId = response.body.data.id as string;

    expect(await itemOf(fx.at45)).toMatchObject({ renewalState: "UNDER_APPROVAL", contractStatus: "ACTIVE", renewal: { id: renewalId, status: "DRAFT" } });
    // The renewal is a new contract with a reference of its own, and has no schedule until approved.
    expect(renewalId).not.toBe(fx.at45);
    expect(await visitsOf(renewalId)).toEqual([]);
    expect((await api().get(`/api/amc/contracts/${fx.at45}`).set(admin.headers)).body.data).toEqual(before);
    expect(await visitsOf(fx.at45)).toEqual(visitsBefore);
  });

  it("a draft renewal is not itself on the queue", async () => {
    expect(await stateOf(renewalId)).toBeNull();
  });

  it("refuses a second renewal while one is open", async () => {
    expect((await renew(fx.at45)).status).toBe(409);
  });

  it("approving (activating the renewal) makes the contract Renewed and generates the renewal's schedule only", async () => {
    const visitsBefore = await visitsOf(fx.at45);
    expect((await setStatus(renewalId, "ACTIVE")).status).toBe(200);

    expect(await itemOf(fx.at45)).toMatchObject({ renewalState: "RENEWED", contractStatus: "ACTIVE", renewal: { id: renewalId, status: "ACTIVE" } });
    expect((await visitsOf(renewalId)).length).toBeGreaterThan(0);
    expect(await visitsOf(fx.at45)).toEqual(visitsBefore);
  });

  it("cancelling a renewal moves the contract to Cancelled, keeps the renewal record and allows renewing again", async () => {
    const source = await contract(20, { systemDescription: "BMS" });
    const first = (await renew(source)).body.data.id as string;
    expect((await setStatus(first, "CANCELLED")).status).toBe(200);

    expect(await itemOf(source)).toMatchObject({ renewalState: "CANCELLED", contractStatus: "ACTIVE", renewal: { id: first, status: "CANCELLED" } });
    expect((await pool.query("SELECT status FROM amc_contracts WHERE id = $1", [first])).rows[0]).toEqual({ status: "CANCELLED" });

    const second = await renew(source);
    expect(second.status).toBe(201);
    expect(await itemOf(source)).toMatchObject({ renewalState: "UNDER_APPROVAL", renewal: { id: second.body.data.id } });

    // The cancelled renewal cannot be reactivated beside the new one: a 409, not a database error.
    const reopen = await setStatus(first, "ACTIVE");
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.message).toBe("The contract this renews already has another renewal. Cancel that renewal first, or keep this one cancelled.");
    expect((await pool.query("SELECT status FROM amc_contracts WHERE id = $1", [first])).rows[0]).toEqual({ status: "CANCELLED" });
  });

  it("a cancelled renewal can still be reactivated when it is the only one", async () => {
    const source = await contract(25, { systemDescription: "SPRINKLERS" });
    const only = (await renew(source)).body.data.id as string;
    expect((await setStatus(only, "CANCELLED")).status).toBe(200);
    expect((await setStatus(only, "ACTIVE")).status).toBe(200);
    expect(await stateOf(source)).toBe("RENEWED");
  });

  it("records the renewal and its approval in the audit trail", async () => {
    const actions = await pool.query<{ action: string; entity_id: string }>(
      "SELECT action, entity_id FROM activity_logs WHERE entity_type = 'amc_contracts' AND entity_id IN ($1, $2) ORDER BY id",
      [fx.at45, renewalId]
    );
    const of = (id: string) => actions.rows.filter((row) => row.entity_id === id).map((row) => row.action);
    expect(of(fx.at45)).toContain("amc_contract.renewal_created");
    expect(of(renewalId)).toEqual(expect.arrayContaining(["amc_contract.renewal_of", "amc_contract.status_changed"]));
  });
});

describe("GET /api/amc/renewals/queue — filters and cards", () => {
  it("counts each state over the search, whatever state filter is applied", async () => {
    const all = (await queue()).body.data;
    const counted = all.kpis.due + all.kpis.underApproval + all.kpis.renewed + all.kpis.cancelled;
    expect(counted).toBe(all.total);

    const due = (await queue({ renewalStatus: "DUE" })).body.data;
    expect(due.kpis).toEqual(all.kpis);
    expect(due.total).toBe(all.kpis.due);
    expect((due.items as Item[]).every((item) => item.renewalState === "DUE")).toBe(true);
  });

  it("searches by AMC reference, client and system", async () => {
    const byReference = (await queue({ search: `AMC-${fx.pastValidity.padStart(4, "0")}` })).body.data.items as Item[];
    expect(byReference.map((item) => item.id)).toEqual([fx.pastValidity]);
    const bySystem = (await queue({ search: "pumps" })).body.data;
    expect(bySystem.items.map((item: Item) => item.id)).toEqual([fx.pastValidity]);
    expect(bySystem.kpis).toEqual({ due: 1, underApproval: 0, renewed: 0, cancelled: 0 });
    expect((await queue({ search: "Renewal Queue Client" })).body.data.total).toBeGreaterThan(1);
    expect((await queue({ search: "no such client" })).body.data.total).toBe(0);
  });

  it("lists due contracts first, earliest expiry first, and pages", async () => {
    const items = (await queue()).body.data.items as Item[];
    const firstOther = items.findIndex((item) => item.renewalState !== "DUE");
    expect(items.slice(firstOther).some((item) => item.renewalState === "DUE")).toBe(false);
    const dueDays = items.filter((item) => item.renewalState === "DUE").map((item) => item.daysLeft);
    expect(dueDays).toEqual([...dueDays].sort((a, b) => a - b));

    const page = (await queue({ pageSize: 2, page: 2 })).body.data;
    expect(page.items).toHaveLength(2);
    expect(page.items[0].id).toBe(items[2]?.id);
  });

  it("refuses an unknown state", async () => {
    expect((await queue({ renewalStatus: "LOST" })).status).toBe(400);
  });
});

describe("permissions", () => {
  it("needs view on AMC contracts to see the queue and the history", async () => {
    expect((await queue({}, execution)).status).toBe(200);
    expect((await queue({}, procurement)).status).toBe(403);
    expect((await api().get("/api/amc/reports/renewals").set(procurement.headers)).status).toBe(403);
  });

  it("starting, approving and cancelling keep the contract permissions", async () => {
    const source = await contract(30, { systemDescription: "UPS" });
    expect((await renew(source, {}, execution)).status).toBe(403);
    const renewal = (await renew(source)).body.data.id as string;
    expect((await setStatus(renewal, "ACTIVE", execution)).status).toBe(403);
    expect((await setStatus(renewal, "CANCELLED", execution)).status).toBe(403);
    expect(await stateOf(source)).toBe("UNDER_APPROVAL");
  });

  it("exports need the export permission", async () => {
    expect((await api().get("/api/amc/renewals/queue/export").query({ format: "xlsx" }).set(execution.headers)).status).toBe(403);
    expect((await api().get("/api/amc/reports/renewals/export").query({ format: "xlsx" }).set(execution.headers)).status).toBe(403);
  });
});

describe("exports", () => {
  const exportFile = (path: string, query: Record<string, unknown>) => api().get(path).query(query).set(admin.headers).responseType("blob");

  it("exports the queue with the applied filter and only the visible columns, and records the export", async () => {
    const response = await exportFile("/api/amc/renewals/queue/export", { format: "xlsx", renewalStatus: "DUE", hidden: "remarks,frequency" });
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/amc-renewal-queue/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Renewal Queue") as ExcelJS.Worksheet;
    const header = (sheet.getRow(6).values as unknown[]).slice(1);
    expect(header).toEqual(["#", "AMC Reference", "Client", "System", "Service", "Contract Expiry Date", "Contract Status", "Contract Amount", "Renewal Status", "Renewal AMC"]);
    const due = (await queue({ renewalStatus: "DUE" })).body.data.total as number;
    const states = Array.from({ length: due }, (_, index) => (sheet.getRow(7 + index).values as unknown[])[9]);
    expect(states.every((state) => state === "Due / Expired")).toBe(true);

    const audit = await pool.query<{ metadata: { rowCount: number; hidden: string[] } }>(
      "SELECT metadata FROM activity_logs WHERE action = 'amc_renewal_queue.exported' ORDER BY id DESC LIMIT 1"
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ rowCount: due, hidden: ["remarks", "frequency"] });
  });

  it("exports the queue as PDF and refuses an unknown format or column", async () => {
    const response = await exportFile("/api/amc/renewals/queue/export", { format: "pdf" });
    expect(response.status).toBe(200);
    expect((response.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect((await exportFile("/api/amc/renewals/queue/export", { format: "csv" })).status).toBe(400);
    expect((await exportFile("/api/amc/renewals/queue/export", { format: "xlsx", hidden: "reference" })).status).toBe(400);
  });

  it("exports the renewal history, cancelled renewals included, newest first", async () => {
    const history = (await api().get("/api/amc/reports/renewals").query({ pageSize: 100 }).set(admin.headers)).body.data;
    const response = await exportFile("/api/amc/reports/renewals/export", { format: "xlsx" });
    expect(response.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet("Renewal History") as ExcelJS.Worksheet;
    expect((sheet.getRow(6).values as unknown[]).slice(1)).toEqual(["#", "Source AMC", "Client / System", "Source Expiry", "Renewed AMC", "New Validity", "Status", "Created"]);
    const first = (sheet.getRow(7).values as unknown[]).slice(1);
    expect(first[4]).toBe(`AMC-${String(history.items[0].renewal.id).padStart(4, "0")}`);
    const statuses = Array.from({ length: history.total as number }, (_, index) => String((sheet.getRow(7 + index).values as unknown[])[7]));
    expect(statuses).toContain("Cancelled (Cancelled)");
    expect(statuses).toContain("Under Client Approval (Draft)");
    expect(statuses).toContain("Renewed (Active)");
    expect(history.items[0].createdOn).toBe(todayIso);

    const pdf = await exportFile("/api/amc/reports/renewals/export", { format: "pdf" });
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });
});
