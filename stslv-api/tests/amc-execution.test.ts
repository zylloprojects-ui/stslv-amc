import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { activeContract, createClient, logsFor, today, visitsOf, type Session, type VisitRecord } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

let admin: Session;
let accountant: Session;
let execution: Session;
let invoicing: Session;
let client: string;
let now: string;
let work: string;
let visits: VisitRecord[];

/**
 * A monthly contract placed around today: five visits, two with a date in the
 * past (about 40 and 10 days ago) and three in the future (about 20, 50 and 80
 * days ahead), whatever day the tests run on.
 */
async function contractAroundToday(systemDescription: string): Promise<string> {
  return activeContract(admin, client, {
    systemDescription,
    validFrom: addDays(now, -40),
    validTo: addDays(now, 100),
    maintenanceFrequency: "MONTHLY",
    defaultVisitAmount: "100.000",
  });
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
  client = await createClient(admin, "Test Hotel One");
  now = await today();
  work = await contractAroundToday("WORK");
  visits = await visitsOf(work);
});
afterAll(closePool);

const list = (query: Record<string, unknown>, session: Session = execution) =>
  api().get("/api/amc/execution/visits").query(query).set(session.headers);
const update = (id: string, body: Record<string, unknown>, session: Session = execution) =>
  api().patch(`/api/amc/execution/visits/${id}`).set(session.headers).send(body);
const stored = async (id: string) =>
  (
    await pool.query(
      `SELECT status, completed_date::text AS completed_date, completed_by, scheduled_date::text AS scheduled_date,
              work_performed, execution_notes, status_reason
       FROM amc_visits WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe("work list", () => {
  it("shows the work that is due, upcoming, open or completed", async () => {
    expect(visits).toHaveLength(5);

    const due = await list({});
    const upcoming = await list({ scope: "upcoming", days: 30 });
    const upcomingLonger = await list({ scope: "upcoming", days: 60 });
    const open = await list({ scope: "open" });
    const completed = await list({ scope: "completed" });
    const all = await list({ scope: "all" });

    expect(due.status).toBe(200);
    expect(due.body.data.items.map((visit: { id: string }) => visit.id)).toEqual([visits[0]?.id, visits[1]?.id]);
    expect(due.body.data.items.every((visit: { isOverdue: boolean }) => visit.isOverdue)).toBe(true);
    expect(upcoming.body.data.items.map((visit: { id: string }) => visit.id)).toEqual([visits[2]?.id]);
    expect(upcomingLonger.body.data.total).toBe(2);
    expect(open.body.data.total).toBe(5);
    expect(completed.body.data.total).toBe(0);
    expect(all.body.data.total).toBe(5);
  });

  it("carries what the execution team needs, and no amounts or invoicing state", async () => {
    const response = await list({});
    const visit = response.body.data.items[0];

    expect(visit).toMatchObject({
      contract: { id: work, status: "ACTIVE", systemDescription: "WORK", maintenanceFrequency: "MONTHLY" },
      client: { id: client, name: "Test Hotel One" },
      status: "SCHEDULED",
      assignedTo: "Test Engineer",
      completedDate: null,
      workPerformed: null,
      executionNotes: null,
    });
    expect(visit).not.toHaveProperty("visitAmount");
    expect(visit).not.toHaveProperty("amountIsCustom");
    expect(visit).not.toHaveProperty("invoiceEligibility");

    const single = await api().get(`/api/amc/execution/visits/${visit.id}`).set(execution.headers);
    expect(single.body.data).not.toHaveProperty("visitAmount");
  });

  it("filters by client and search, and rejects an unknown scope", async () => {
    const other = await createClient(admin, "Test Hotel Two");

    expect((await list({ scope: "open", clientId: other })).body.data.total).toBe(0);
    expect((await list({ scope: "open", search: "test hotel" })).body.data.total).toBe(5);
    expect((await list({ scope: "open", search: "nobody" })).body.data.total).toBe(0);
    expect((await list({ scope: "mine" })).status).toBe(400);
  });
});

describe("execution status", () => {
  it("starts a visit, then completes it with the date, the work done and who completed it", async () => {
    const id = visits[0]?.id as string;

    const started = await update(id, { status: "IN_PROGRESS", executionNotes: "On site" });
    expect(started.status).toBe(200);
    expect(started.body.data).toMatchObject({ status: "IN_PROGRESS", executionNotes: "On site", completedDate: null, isOverdue: false });

    const completed = await update(id, {
      status: "COMPLETED",
      completedDate: addDays(now, -1),
      workPerformed: "Panel tested, two detectors replaced",
    });
    expect(completed.status).toBe(200);
    expect(completed.body.data).toMatchObject({
      status: "COMPLETED",
      completedDate: addDays(now, -1),
      completedBy: { id: execution.id, fullName: "execution@example.com" },
      workPerformed: "Panel tested, two detectors replaced",
      executionNotes: "On site",
    });

    expect(await stored(id)).toMatchObject({ status: "COMPLETED", completed_date: addDays(now, -1), completed_by: execution.id });
    expect((await logsFor("amc_visits", id)).map((log) => [log.action, log.module, log.user_id])).toEqual([
      ["amc_visit.status_changed", "AMC_EXECUTION", execution.id],
      ["amc_visit.completed", "AMC_EXECUTION", execution.id],
    ]);

    // It leaves the due list and appears under completed.
    expect((await list({})).body.data.items.map((visit: { id: string }) => visit.id)).toEqual([visits[1]?.id]);
    expect((await list({ scope: "completed" })).body.data.items.map((visit: { id: string }) => visit.id)).toEqual([id]);
  });

  it("requires a completion date, and refuses one in the future or on a visit that is not completed", async () => {
    const id = visits[1]?.id as string;

    const missing = await update(id, { status: "COMPLETED" });
    const future = await update(id, { status: "COMPLETED", completedDate: addDays(now, 5) });
    const notCompleted = await update(id, { status: "IN_PROGRESS", completedDate: now });
    const impossible = await update(id, { status: "COMPLETED", completedDate: "2026-02-31" });

    for (const response of [missing, future, notCompleted, impossible]) {
      expect(response.status).toBe(400);
      expect(response.body.error.details[0].field).toBe("completedDate");
    }
    expect(await stored(id)).toMatchObject({ status: "SCHEDULED", completed_date: null, completed_by: null });
  });

  it("postpones a visit to a new date with a reason, and keeps the original date", async () => {
    const id = visits[1]?.id as string;
    const newDate = addDays(now, 10);

    const response = await update(id, { status: "POSTPONED", scheduledDate: newDate, statusReason: "Client requested a later date" });

    expect(response.body.data).toMatchObject({
      status: "POSTPONED",
      scheduledDate: newDate,
      originalScheduledDate: visits[1]?.original_scheduled_date,
      isRescheduled: true,
      isOverdue: false,
      statusReason: "Client requested a later date",
    });
    // Postponed work stays on the list of open work, under its new date.
    expect((await list({ scope: "upcoming", days: 15 })).body.data.items.map((visit: { id: string }) => visit.id)).toEqual([id]);

    // The reason belongs to the postponement and is dropped when the visit is put back.
    const back = await update(id, { status: "SCHEDULED" });
    expect(back.body.data).toMatchObject({ status: "SCHEDULED", statusReason: null, scheduledDate: newDate });
  });

  it("cancels a visit with a reason and can restore it", async () => {
    const id = visits[2]?.id as string;

    const cancelled = await update(id, { status: "CANCELLED", statusReason: "Site closed for renovation" });
    expect(cancelled.body.data).toMatchObject({ status: "CANCELLED", statusReason: "Site closed for renovation" });
    expect((await list({ scope: "open" })).body.data.items.map((visit: { id: string }) => visit.id)).not.toContain(id);

    expect((await update(id, { scheduledDate: addDays(now, 3) })).status).toBe(400);

    const restored = await update(id, { status: "SCHEDULED" });
    expect(restored.body.data).toMatchObject({ status: "SCHEDULED", statusReason: null });
  });

  it("lets work notes be corrected on a completed visit without reopening it", async () => {
    const id = visits[0]?.id as string;
    const response = await update(id, { workPerformed: "Panel tested, three detectors replaced", completedDate: addDays(now, -2) });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "COMPLETED",
      workPerformed: "Panel tested, three detectors replaced",
      completedDate: addDays(now, -2),
      completedBy: { id: execution.id },
    });
    expect((await logsFor("amc_visits", id)).at(-1)?.action).toBe("amc_visit.execution_updated");
  });

  it("reopens a completed visit only with approval permission, and clears the completion", async () => {
    const id = visits[0]?.id as string;

    const refused = await update(id, { status: "IN_PROGRESS" });
    expect(refused.status).toBe(403);
    expect(await stored(id)).toMatchObject({ status: "COMPLETED" });

    const reopened = await update(id, { status: "IN_PROGRESS" }, admin);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ status: "IN_PROGRESS", completedDate: null, completedBy: null });
    expect(await stored(id)).toMatchObject({ status: "IN_PROGRESS", completed_date: null, completed_by: null });
  });

  it("writes nothing when an update changes nothing", async () => {
    const id = visits[3]?.id as string;

    const response = await update(id, { status: "SCHEDULED", executionNotes: "" });

    expect(response.status).toBe(200);
    expect(await logsFor("amc_visits", id)).toEqual([]);
  });

  it("rejects an empty update, an unknown status and an unknown visit", async () => {
    const id = visits[3]?.id as string;

    expect((await update(id, {})).status).toBe(400);
    expect((await update(id, { status: "DONE" })).status).toBe(400);
    expect((await update("999999", { status: "IN_PROGRESS" })).status).toBe(404);
  });

  it("keeps the outstanding work of a cancelled contract off the work list", async () => {
    const other = await contractAroundToday("TO CANCEL");
    expect((await list({ scope: "open", search: "TO CANCEL" })).body.data.total).toBe(5);

    await api().post(`/api/amc/contracts/${other}/status`).set(admin.headers).send({ status: "CANCELLED" });

    expect((await list({ scope: "open", search: "TO CANCEL" })).body.data.total).toBe(0);
    expect((await list({ scope: "due", search: "TO CANCEL" })).body.data.total).toBe(0);
    // The visits themselves are untouched and still visible when everything is listed.
    expect((await list({ scope: "all", search: "TO CANCEL" })).body.data.total).toBe(5);
  });
});

describe("execution constraints in the database", () => {
  it("refuses a completed visit without a date, a date on an open visit, and an unknown status", async () => {
    const id = visits[4]?.id as string;

    await expect(pool.query("UPDATE amc_visits SET status = 'COMPLETED' WHERE id = $1", [id])).rejects.toMatchObject({
      code: "23514",
      constraint: "amc_visits_completion_ck",
    });
    await expect(pool.query("UPDATE amc_visits SET completed_date = current_date WHERE id = $1", [id])).rejects.toMatchObject({
      code: "23514",
    });
    await expect(pool.query("UPDATE amc_visits SET status = 'DONE' WHERE id = $1", [id])).rejects.toMatchObject({
      code: "23514",
      constraint: "amc_visits_status_ck",
    });
  });
});

describe("execution permissions", () => {
  it("requires a signed-in user", async () => {
    expect((await api().get("/api/amc/execution/visits")).status).toBe(401);
  });

  it("gives roles without AMC Execution access no work list and no way to update a visit", async () => {
    const id = visits[4]?.id as string;

    for (const session of [accountant, invoicing]) {
      expect((await list({}, session)).status).toBe(403);
      expect((await api().get(`/api/amc/execution/visits/${id}`).set(session.headers)).status).toBe(403);

      const response = await update(id, { status: "COMPLETED", completedDate: now }, session);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }

    expect(await stored(id)).toMatchObject({ status: "SCHEDULED" });
  });

  it("separates viewing from updating", async () => {
    // A role that can see the work list but not change it.
    await pool.query(
      "DELETE FROM role_permissions WHERE module = 'AMC_EXECUTION' AND action = 'EDIT' AND role_id = (SELECT id FROM roles WHERE code = 'EXECUTION')"
    );
    const id = visits[4]?.id as string;

    expect((await list({})).status).toBe(200);
    expect((await update(id, { status: "IN_PROGRESS" })).status).toBe(403);
  });
});
