import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, grant, logsFor, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

let admin: Session;
let accountant: Session;
let execution: Session;
let invoicing: Session;
let hotelOne: string;
let hotelTwo: string;
let fire: string; // Test Hotel One, FIRE, quarterly 2027, 405.000 per visit
let cctv: string; // Test Hotel Two, CCTV, monthly Jan-Jun 2027, 150.000 per visit

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
  hotelOne = await createClient(admin, "Test Hotel One");
  hotelTwo = await createClient(admin, "Test Hotel Two");
  fire = await activeContract(admin, hotelOne);
  cctv = await activeContract(admin, hotelTwo, {
    systemDescription: "CCTV",
    validTo: "2027-06-30",
    maintenanceFrequency: "MONTHLY",
    contractValue: "900.000",
    defaultVisitAmount: "150.000",
    responsibleEngineer: "Site Engineer",
  });
});
afterAll(closePool);

const list = (query: Record<string, unknown>, session: Session = admin) =>
  api().get("/api/amc/visits").query(query).set(session.headers);
const patch = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().patch(`/api/amc/visits/${id}`).set(session.headers).send(body);
const contract = async (id: string) => (await api().get(`/api/amc/contracts/${id}`).set(admin.headers)).body.data;

describe("schedule list", () => {
  it("returns dated visit rows with their contract, client, amount and derived state", async () => {
    const response = await list({ from: "2027-01-01", to: "2027-01-31" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(response.body.data.items[0]).toMatchObject({
      contract: { id: fire, status: "ACTIVE", systemDescription: "FIRE", maintenanceFrequency: "QUARTERLY" },
      client: { id: hotelOne, name: "Test Hotel One" },
      sequenceNo: 1,
      periodStart: "2027-01-01",
      periodEnd: "2027-03-31",
      originalScheduledDate: "2027-01-01",
      scheduledDate: "2027-01-01",
      isRescheduled: false,
      isOverdue: false,
      assignedTo: "Test Engineer",
      assignedToOverride: null,
      status: "SCHEDULED",
      visitAmount: "405.000",
      amountIsCustom: false,
      completedDate: null,
      completedBy: null,
      invoiceEligibility: "NOT_COMPLETED",
    });
    expect(response.body.data.items[1]).toMatchObject({ client: { name: "Test Hotel Two" }, visitAmount: "150.000", assignedTo: "Site Engineer" });
  });

  it("filters by month through a date range, and totals the amounts of the whole result", async () => {
    const january = await list({ from: "2027-01-01", to: "2027-01-31" });
    const february = await list({ from: "2027-02-01", to: "2027-02-28" });
    const april = await list({ from: "2027-04-01", to: "2027-04-30" });
    const year = await list({ from: "2027-01-01", to: "2027-12-31", pageSize: 3 });

    expect(january.body.data.totals).toEqual({ visitAmount: "555.000", amountMissingCount: 0 });
    expect(february.body.data.items.map((visit: { client: { name: string } }) => visit.client.name)).toEqual(["Test Hotel Two"]);
    expect(april.body.data.total).toBe(2);
    // 4 x 405 + 6 x 150, although only three rows are on the page.
    expect(year.body.data.items).toHaveLength(3);
    expect(year.body.data.total).toBe(10);
    expect(year.body.data.totals.visitAmount).toBe("2520.000");
  });

  it("filters by client, contract, system, status and search", async () => {
    const byClient = await list({ clientId: hotelTwo });
    const byContract = await list({ contractId: fire });
    const bySystem = await list({ system: " cctv " });
    const byStatus = await list({ status: "COMPLETED,CANCELLED" });
    const scheduled = await list({ status: "SCHEDULED" });
    const bySearch = await list({ search: "site eng" });
    const none = await list({ search: "%" });

    expect(byClient.body.data.total).toBe(6);
    expect(byContract.body.data.total).toBe(4);
    expect(bySystem.body.data.total).toBe(6);
    expect(byStatus.body.data.total).toBe(0);
    expect(scheduled.body.data.total).toBe(10);
    expect(bySearch.body.data.total).toBe(6);
    expect(none.body.data.total).toBe(0);
  });

  it("orders the schedule by date", async () => {
    const response = await list({});
    const dates = response.body.data.items.map((visit: { scheduledDate: string }) => visit.scheduledDate);

    expect(dates).toEqual([...dates].sort());
  });

  it("rejects an invalid filter", async () => {
    expect((await list({ from: "2027-02-30" })).status).toBe(400);
    expect((await list({ status: "DONE" })).status).toBe(400);
    expect((await list({ invoiceEligibility: "INVOICED" })).status).toBe(400);
    expect((await list({ pageSize: 1000 })).status).toBe(400);
  });

  it("flags scheduled visits whose date has passed as overdue, without storing it", async () => {
    const past = await activeContract(admin, hotelOne, { validFrom: "2025-01-01", validTo: "2025-12-31", systemDescription: "PAST" });
    const overdue = await list({ overdue: "true" });
    const notOverdue = await list({ overdue: "false", contractId: past });

    expect(overdue.body.data.total).toBe(4);
    expect(overdue.body.data.items.every((visit: { isOverdue: boolean; contract: { id: string } }) => visit.isOverdue && visit.contract.id === past)).toBe(true);
    expect(notOverdue.body.data.total).toBe(0);
    expect((await visitsOf(past)).map((visit) => visit.status)).toEqual(["SCHEDULED", "SCHEDULED", "SCHEDULED", "SCHEDULED"]);
  });

  it("stores every visit as a row: the table has no month columns", async () => {
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('amc_visits', 'amc_contracts')"
    );
    const months = /(^|_)(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|month|q[1-4])(_|$)/;

    expect(columns.rows.map((row) => row.column_name).filter((name) => months.test(name))).toEqual([]);
  });

  it("returns one visit, and 404 for an unknown or malformed id", async () => {
    const id = (await visitsOf(fire))[0]?.id as string;

    expect((await api().get(`/api/amc/visits/${id}`).set(admin.headers)).body.data).toMatchObject({ id, sequenceNo: 1 });
    expect((await api().get("/api/amc/visits/999999").set(admin.headers)).status).toBe(404);
    expect((await api().get("/api/amc/visits/abc").set(admin.headers)).status).toBe(404);
    expect((await patch("999999", { notes: "x" })).status).toBe(404);
  });
});

describe("visit amount", () => {
  it("can be changed on one visit without touching the others or the contract default", async () => {
    const visits = await visitsOf(fire);
    const response = await patch(visits[1]?.id as string, { visitAmount: "33.333" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ visitAmount: "33.333", amountIsCustom: true });

    const after = await visitsOf(fire);
    expect(after.map((visit) => visit.visit_amount)).toEqual(["405.000", "33.333", "405.000", "405.000"]);
    expect(after.map((visit) => visit.amount_is_custom)).toEqual([false, true, false, false]);
    expect((await contract(fire)).defaultVisitAmount).toBe("405.000");

    const logs = await logsFor("amc_visits", visits[1]?.id as string);
    expect(logs).toMatchObject([
      {
        action: "amc_visit.amount_changed",
        user_id: admin.id,
        module: "AMC_SCHEDULE",
        metadata: { changes: { visitAmount: { from: "405.000", to: "33.333" } } },
      },
    ]);
  });

  it("supports uneven amounts within one contract, including zero", async () => {
    // Two charged visits and two that are not: 500 / 0 / 500 / 0 against a contract value of 1000.
    const id = await activeContract(admin, hotelOne, {
      systemDescription: "Automation",
      contractValue: "1000.000",
      finalCredit: "800.000",
      defaultVisitAmount: "500.000",
    });
    const visits = await visitsOf(id);

    await patch(visits[1]?.id as string, { visitAmount: "0" });
    await patch(visits[3]?.id as string, { visitAmount: "0.000" });

    expect((await visitsOf(id)).map((visit) => visit.visit_amount)).toEqual(["500.000", "0.000", "500.000", "0.000"]);
    expect((await contract(id)).schedule).toMatchObject({ scheduledTotal: "1000.000", valueDifference: "0.000", amountMissingCount: 0 });
  });

  it("can be cleared, and the contract then reports a visit without an amount", async () => {
    const visits = await visitsOf(cctv);
    const response = await patch(visits[5]?.id as string, { visitAmount: null });

    expect(response.body.data).toMatchObject({ visitAmount: null, amountIsCustom: true });
    expect((await contract(cctv)).schedule).toMatchObject({ scheduledTotal: "750.000", amountMissingCount: 1 });
  });

  it("rejects an amount that is not valid three-decimal money", async () => {
    const id = (await visitsOf(cctv))[0]?.id as string;

    for (const visitAmount of [150.5, "150.1234", "-1", "abc"]) {
      const response = await patch(id, { visitAmount });

      expect(response.status, String(visitAmount)).toBe(400);
      expect(response.body.error.details[0].field).toBe("visitAmount");
    }
    expect((await visitsOf(cctv))[0]?.visit_amount).toBe("150.000");
  });

  it("does not log or flag the amount when the same value is sent again", async () => {
    const id = (await visitsOf(cctv))[1]?.id as string;

    await patch(id, { visitAmount: "150" });

    expect((await visitsOf(cctv))[1]?.amount_is_custom).toBe(false);
    expect(await logsFor("amc_visits", id)).toEqual([]);
  });

  it("is refused by the database when negative", async () => {
    const id = (await visitsOf(cctv))[0]?.id as string;

    await expect(pool.query("UPDATE amc_visits SET visit_amount = -0.001 WHERE id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("planning changes", () => {
  it("reschedules a visit and keeps the originally generated date", async () => {
    const id = (await visitsOf(cctv))[2]?.id as string;
    const response = await patch(id, { scheduledDate: "2027-03-18", notes: "Client asked for mid-month" });

    expect(response.body.data).toMatchObject({
      scheduledDate: "2027-03-18",
      originalScheduledDate: "2027-03-01",
      isRescheduled: true,
      notes: "Client asked for mid-month",
    });
    // The visit now appears under its new date.
    expect((await list({ contractId: cctv, from: "2027-03-18", to: "2027-03-18" })).body.data.total).toBe(1);
    expect((await logsFor("amc_visits", id))[0]).toMatchObject({
      action: "amc_visit.updated",
      metadata: { changes: { scheduledDate: { from: "2027-03-01", to: "2027-03-18" } } },
    });
  });

  it("assigns a visit to another person, and falls back to the contract engineer when cleared", async () => {
    const id = (await visitsOf(cctv))[3]?.id as string;

    const assigned = await patch(id, { assignedTo: "  Relief Technician " });
    expect(assigned.body.data).toMatchObject({ assignedTo: "Relief Technician", assignedToOverride: "Relief Technician" });

    const cleared = await patch(id, { assignedTo: "" });
    expect(cleared.body.data).toMatchObject({ assignedTo: "Site Engineer", assignedToOverride: null });
  });

  it("rejects an empty update, an impossible date and fields that belong to execution", async () => {
    const id = (await visitsOf(cctv))[4]?.id as string;

    expect((await patch(id, {})).status).toBe(400);
    expect((await patch(id, { scheduledDate: "2027-13-01" })).status).toBe(400);
    expect((await patch(id, { status: "COMPLETED" })).status).toBe(400);
    expect((await patch(id, { completedDate: "2027-05-01" })).status).toBe(400);
  });
});

describe("schedule permissions", () => {
  it("lets the roles with schedule view read the schedule but not change it", async () => {
    const id = (await visitsOf(cctv))[4]?.id as string;

    for (const session of [accountant, execution, invoicing]) {
      expect((await list({}, session)).status).toBe(200);
      expect((await api().get(`/api/amc/visits/${id}`).set(session.headers)).status).toBe(200);

      const response = await patch(id, { visitAmount: "1.000" }, session);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }

    expect((await visitsOf(cctv))[4]?.visit_amount).toBe("150.000");
  });

  it("requires a signed-in user", async () => {
    expect((await api().get("/api/amc/visits")).status).toBe(401);
  });

  it("allows the amount to be edited once a role is granted schedule edit", async () => {
    await grant("ACCOUNTANT", [["AMC_SCHEDULE", "EDIT"]]);
    const id = (await visitsOf(cctv))[4]?.id as string;

    const response = await patch(id, { visitAmount: "175.500" }, accountant);

    expect(response.status).toBe(200);
    expect(response.body.data.visitAmount).toBe("175.500");
  });

  it("offers the execution route no way to change an amount", async () => {
    const id = (await visitsOf(cctv))[0]?.id as string;
    const response = await api().patch(`/api/amc/execution/visits/${id}`).set(admin.headers).send({ visitAmount: "1.000" });

    expect(response.status).toBe(400);
    expect((await visitsOf(cctv))[0]?.visit_amount).toBe("150.000");
  });
});
