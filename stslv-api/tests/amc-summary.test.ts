import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { activeContract, createClient, createContract, today, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// The figures handed to the dashboard and reports: GET /api/amc/summary.

let admin: Session;
let accountant: Session;
let execution: Session;
let procurement: Session;
let now: string;
let allVisits: { scheduled_date: string; status: string }[];

const execute = (id: string, body: Record<string, unknown>) =>
  api().patch(`/api/amc/execution/visits/${id}`).set(admin.headers).send(body);
const summary = (session: Session = admin, query: Record<string, unknown> = {}) =>
  api().get("/api/amc/summary").query(query).set(session.headers);

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  now = await today();
  const client = await createClient(admin, "Test Hotel One");

  // W: monthly around today. Visits about 40 and 10 days ago, and 20, 50 and 80 days ahead.
  const w = await activeContract(admin, client, {
    systemDescription: "W",
    validFrom: addDays(now, -40),
    validTo: addDays(now, 100),
    maintenanceFrequency: "MONTHLY",
    defaultVisitAmount: "100.000",
  });
  const [w1, w2, w3, w4, w5] = await visitsOf(w);
  void w2; // left scheduled: overdue
  await execute(w1?.id as string, { status: "COMPLETED", completedDate: now }); // ready for invoice, 100.000
  await execute(w3?.id as string, { status: "IN_PROGRESS" });
  await execute(w4?.id as string, { status: "POSTPONED" });
  await api().patch(`/api/amc/visits/${w5?.id}`).set(admin.headers).send({ visitAmount: "0" });
  await execute(w5?.id as string, { status: "COMPLETED", completedDate: now }); // zero value: no invoice required

  // X: a draft. No visits.
  await createContract(admin, client, { systemDescription: "X" });

  // Y: active, validity ended, no default amount. Its one visit is completed without an amount.
  const y = await activeContract(admin, client, {
    systemDescription: "Y",
    validFrom: "2024-01-01",
    validTo: "2024-12-31",
    maintenanceFrequency: "ANNUALLY",
    defaultVisitAmount: null,
  });
  await execute((await visitsOf(y))[0]?.id as string, { status: "COMPLETED", completedDate: "2024-01-15" });

  // Z: cancelled, with its four scheduled visits left as they were.
  const z = await activeContract(admin, client, { systemDescription: "Z", validFrom: "2025-01-01", validTo: "2025-12-31" });
  await api().post(`/api/amc/contracts/${z}/status`).set(admin.headers).send({ status: "CANCELLED" });

  allVisits = (await pool.query<{ scheduled_date: string; status: string }>("SELECT scheduled_date::text AS scheduled_date, status FROM amc_visits")).rows;
});
afterAll(closePool);

describe("AMC summary", () => {
  it("counts contracts by status from the database", async () => {
    const response = await summary();

    expect(response.status).toBe(200);
    expect(response.body.data.asOf).toBe(now);
    expect(response.body.data.contracts).toEqual({ active: 2, activePastValidity: 1, draft: 1, expired: 0, cancelled: 1 });
  });

  it("counts due, overdue, upcoming and completed visits", async () => {
    const response = await summary();
    const month = now.slice(0, 7);

    expect(response.body.data.visits).toEqual({
      due: 1,
      overdue: 1,
      upcoming: 1,
      upcomingDays: 30,
      dueThisMonth: allVisits.filter((visit) => visit.scheduled_date.startsWith(month) && visit.status !== "CANCELLED").length,
      inProgress: 1,
      postponed: 1,
      completedThisMonth: 2,
      completedTotal: 3,
      historical: 0,
    });
  });

  it("widens the upcoming window on request", async () => {
    const response = await summary(admin, { upcomingDays: 60 });

    expect(response.body.data.visits).toMatchObject({ upcoming: 2, upcomingDays: 60 });
    expect((await summary(admin, { upcomingDays: 0 })).status).toBe(400);
  });

  it("reports what is ready for invoice, with zero-value and missing-amount visits kept apart", async () => {
    const response = await summary();

    expect(response.body.data.invoicing).toEqual({
      readyForInvoice: { count: 1, amount: "100.000" },
      amountRequired: { count: 1 },
      noInvoiceRequired: { count: 1 },
    });
  });

  it("agrees with the lists the figures come from", async () => {
    const due = await api().get("/api/amc/execution/visits").query({ scope: "due" }).set(admin.headers);
    const upcoming = await api().get("/api/amc/execution/visits").query({ scope: "upcoming", days: 30 }).set(admin.headers);
    const ready = await api().get("/api/amc/visits").query({ invoiceEligibility: "READY_FOR_INVOICE" }).set(admin.headers);
    const active = await api().get("/api/amc/contracts").query({ status: "ACTIVE" }).set(admin.headers);
    const data = (await summary()).body.data;

    expect(due.body.data.total).toBe(data.visits.due);
    expect(upcoming.body.data.total).toBe(data.visits.upcoming);
    expect(ready.body.data.total).toBe(data.invoicing.readyForInvoice.count);
    expect(ready.body.data.totals.visitAmount).toBe(data.invoicing.readyForInvoice.amount);
    expect(active.body.data.total).toBe(data.contracts.active);
  });
});

describe("AMC summary permissions", () => {
  it("requires a signed-in user with at least one AMC view permission", async () => {
    expect((await api().get("/api/amc/summary")).status).toBe(401);
    expect((await summary(procurement)).status).toBe(403);
  });

  it("returns every section to a role that may view contracts and the schedule", async () => {
    const data = (await summary(accountant)).body.data;

    expect(data.contracts).not.toBeNull();
    expect(data.visits).not.toBeNull();
    expect(data.invoicing).not.toBeNull();
  });

  it("leaves out the sections a role may not see, amounts included", async () => {
    // An execution-only role: the work list, but no schedule and no contracts.
    await pool.query(
      "DELETE FROM role_permissions WHERE module IN ('AMC_SCHEDULE', 'AMC_CONTRACTS') AND role_id = (SELECT id FROM roles WHERE code = 'EXECUTION')"
    );
    const data = (await summary(execution)).body.data;

    expect(data.contracts).toBeNull();
    expect(data.invoicing).toBeNull();
    expect(data.visits).toMatchObject({ due: 1, overdue: 1 });
  });
});
