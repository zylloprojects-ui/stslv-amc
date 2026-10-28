import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { completeVisit, type Session } from "./invoices-helpers";
import { resetProjectData } from "./projects-helpers";

// In-app alerts (migration 0073): figures the application already defines,
// filtered by permission, with a per-user read state. Every record is invented.

let admin: Session;
let execution: Session;
let procurement: Session;

const alerts = (session: Session) => api().get("/api/notifications").set(session.headers);
const keys = async (session: Session) => ((await alerts(session)).body.data.items as { key: string }[]).map((item) => item.key).sort();

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);

  const clientId = await createClient(admin, "Alert Test Client");
  // A contract whose validity has ended (so it is past validity) with past, unfinished visits (overdue).
  const contractId = await activeContract(admin, clientId, {
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    maintenanceFrequency: "QUARTERLY",
    defaultVisitAmount: "405.000",
  });
  const first = await pool.query<{ id: string }>("SELECT id FROM amc_visits WHERE amc_contract_id = $1 ORDER BY sequence_no LIMIT 1", [contractId]);
  await completeVisit(admin, first.rows[0]?.id as string);
});
afterAll(closePool);

describe("GET /api/notifications", () => {
  it("lists the alerts that apply, with a link, a count and an unread state", async () => {
    const response = await alerts(admin);

    expect(response.status).toBe(200);
    const items = response.body.data.items as Record<string, unknown>[];
    expect(items.map((item) => item.key)).toEqual(["visits.overdue", "contracts.past_validity", "invoicing.amc_ready"]);
    expect(items[0]).toMatchObject({ severity: "warning", count: 3, isRead: false, readAt: null, link: "/amc/schedule" });
    expect(items[1]).toMatchObject({ count: 1, link: "/amc/management" });
    expect(items[2]).toMatchObject({ count: 1, link: "/invoices", message: "1 completed visit is waiting for an invoice (visit amounts 405.000)." });
    expect(response.body.data.unreadCount).toBe(3);
  });

  it("matches the figures of the AMC summary, so the two never disagree", async () => {
    const summary = (await api().get("/api/amc/summary").set(admin.headers)).body.data;
    const items = (await alerts(admin)).body.data.items as { key: string; count: number }[];

    expect(items.find((item) => item.key === "visits.overdue")?.count).toBe(summary.visits.overdue);
    expect(items.find((item) => item.key === "contracts.past_validity")?.count).toBe(summary.contracts.activePastValidity);
    expect(items.find((item) => item.key === "invoicing.amc_ready")?.count).toBe(summary.invoicing.readyForInvoice.count);
  });

  it("shows each user only the alerts their permissions allow", async () => {
    expect(await keys(execution)).toEqual(["contracts.past_validity", "invoicing.amc_ready", "visits.overdue"]);
    expect(await keys(procurement)).toEqual([]);
  });
});

describe("read state", () => {
  it("marks one alert read for this user only", async () => {
    const response = await api().post("/api/notifications/visits.overdue/read").set(admin.headers);

    expect(response.status).toBe(200);
    const overdue = (response.body.data.items as { key: string; isRead: boolean; readAt: string | null }[]).find((item) => item.key === "visits.overdue");
    expect(overdue?.isRead).toBe(true);
    expect(overdue?.readAt).toEqual(expect.any(String));
    expect(response.body.data.unreadCount).toBe(2);

    const forExecution = ((await alerts(execution)).body.data.items as { key: string; isRead: boolean }[]).find((item) => item.key === "visits.overdue");
    expect(forExecution?.isRead).toBe(false);
  });

  it("shows a read alert as unread again when its figure changes", async () => {
    const second = await pool.query<{ id: string }>("SELECT id FROM amc_visits WHERE status = 'SCHEDULED' ORDER BY sequence_no LIMIT 1");
    await completeVisit(admin, second.rows[0]?.id as string);

    const overdue = ((await alerts(admin)).body.data.items as { key: string; isRead: boolean; count: number }[]).find((item) => item.key === "visits.overdue");
    expect(overdue).toMatchObject({ count: 2, isRead: false });
  });

  it("marks every alert read at once, and refuses an alert the user does not have", async () => {
    const all = await api().post("/api/notifications/read-all").set(admin.headers);
    expect(all.body.data.unreadCount).toBe(0);

    expect((await api().post("/api/notifications/invoicing.amc_ready/read").set(procurement.headers)).status).toBe(404);
    expect((await api().post("/api/notifications/BAD KEY/read").set(admin.headers)).status).toBe(400);
  });

  it("changes nothing but the read marks", async () => {
    const before = await pool.query("SELECT id, status FROM amc_visits ORDER BY id");
    await api().post("/api/notifications/read-all").set(execution.headers);
    const after = await pool.query("SELECT id, status FROM amc_visits ORDER BY id");

    expect(after.rows).toEqual(before.rows);
  });

  it("needs a signed-in user", async () => {
    expect((await api().get("/api/notifications")).status).toBe(401);
  });
});
