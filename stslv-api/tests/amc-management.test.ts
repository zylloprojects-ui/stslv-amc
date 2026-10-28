import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { expiryBand } from "../src/modules/amc/management.service";
import { activeContract, contractBody, createClient, createContract, today } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { executeVisit, invoiceBody, postInvoice } from "./invoices-helpers";
import { resetProjectData } from "./projects-helpers";

// GET /api/amc/management/summary and the expiry alerts. Every figure is
// checked against the base tables with SQL written here or against a fixture
// whose expected counts are worked out by hand. Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let now: string;
let clientId: string;
let monthlyId: string;

const summary = (session: Session = admin) => api().get("/api/amc/management/summary").set(session.headers);
const alerts = (session: Session) => api().get("/api/notifications").set(session.headers);

const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> =>
  (await pool.query<T>(sql, params)).rows[0] as T;

async function userWith(code: string, permissions: string[]): Promise<Session> {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1)", [code]);

  for (const permission of permissions) {
    const [module, action] = permission.split(":");

    await pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, $2, $3 FROM roles WHERE code = $1", [code, module, action]);
  }

  return signedIn(`${code.toLowerCase()}@example.com`, [code]);
}

/** An active annual contract ending `daysLeft` days from today. */
const ending = (daysLeft: number, systemDescription: string) =>
  activeContract(admin, clientId, {
    systemDescription,
    maintenanceFrequency: "ANNUALLY",
    defaultVisitAmount: "100.000",
    contractValue: "1000.000",
    validFrom: addDays(now, -300),
    validTo: addDays(now, daysLeft),
  });

const renew = async (id: string) => {
  const response = await api()
    .post(`/api/amc/contracts/${id}/renewals`)
    .set(admin.headers)
    .send(contractBody(clientId, { validFrom: addDays(now, 120), validTo: addDays(now, 480), status: "DRAFT", systemDescription: "RENEWAL" }));

  expect(response.status).toBe(201);
  return response.body.data.id as string;
};

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  now = await today();
});
afterAll(closePool);

describe("expiryBand", () => {
  it("puts each number of days left in exactly one band", () => {
    expect(expiryBand(91)).toBeNull();
    expect(expiryBand(90)).toBe(90);
    expect(expiryBand(61)).toBe(90);
    expect(expiryBand(60)).toBe(60);
    expect(expiryBand(46)).toBe(60);
    expect(expiryBand(45)).toBe(45);
    expect(expiryBand(31)).toBe(45);
    expect(expiryBand(30)).toBe(30);
    expect(expiryBand(16)).toBe(30);
    expect(expiryBand(15)).toBe(15);
    expect(expiryBand(0)).toBe(15);
    expect(expiryBand(-1)).toBeNull();
  });
});

describe("empty database", () => {
  it("returns zeros, empty lists and payment as unavailable", async () => {
    const response = await summary();

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.asOf).toBe(now);
    expect(data.contracts).toMatchObject({ active: 0, activeValue: "0.000", finalCreditTotal: "0.000", expiringSoon: 0, expiringSoonDays: 45 });
    expect(data.schedule).toEqual({
      servicesThisMonth: { planned: 0, completed: 0, open: 0 },
      pendingBilling: { count: 0, amount: "0.000", amountRequired: 0 },
      currentScheduledValue: { amount: "0.000", visits: 0, amountMissing: 0 },
      engine: { activeContracts: 0, withoutSchedule: 0 },
    });
    expect(data.invoices.paid.available).toBe(false);
    expect(data.invoices.unpaid.available).toBe(false);
    expect(data.invoices.paidTotal.available).toBe(false);
    expect(data.invoices.module).toEqual({ issued: 0, cancelled: 0, paymentTracked: false });
    expect(data.expiry.bands.map((band: { days: number; fromDays: number; count: number }) => [band.days, band.fromDays, band.count])).toEqual([
      [90, 61, 0],
      [60, 46, 0],
      [45, 31, 0],
      [30, 16, 0],
      [15, 0, 0],
    ]);
    expect(data.expiry.renewalWarning).toEqual({ days: 45, count: 0, ids: [] });
    expect(data.expiry.critical).toEqual({ days: 15, count: 0, notRenewed: 0 });
    expect(data.expiry.notRenewedExpired).toEqual({ count: 0, expiredStatus: 0, activePastValidity: 0 });
    expect(data.recentContracts).toEqual({ total: 0, items: [] });
  });
});

describe("with contracts, renewals, visits and invoices", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    clientId = await createClient(admin, "Management Client");

    ids.d75 = await ending(75, "D75");
    ids.d50 = await ending(50, "D50");
    ids.d45 = await ending(45, "D45 RENEWED");
    ids.d31 = await ending(31, "D31");
    ids.d16 = await ending(16, "D16");
    ids.d15 = await ending(15, "D15");
    ids.d0 = await ending(0, "D0");
    ids.d91 = await ending(91, "D91");
    ids.past = await ending(-1, "PAST");
    ids.expired = await ending(-20, "EXPIRED");
    ids.expiredRenewed = await ending(-30, "EXPIRED RENEWED");
    ids.expiredCancelledRenewal = await ending(-40, "EXPIRED CANCELLED RENEWAL");
    await pool.query("UPDATE amc_contracts SET status = 'EXPIRED' WHERE id = ANY($1::bigint[])", [[ids.expired, ids.expiredRenewed, ids.expiredCancelledRenewal]]);

    ids.renewal45 = await renew(ids.d45 as string);
    ids.renewalExpired = await renew(ids.expiredRenewed as string);
    ids.cancelledRenewal = await renew(ids.expiredCancelledRenewal as string);
    await pool.query("UPDATE amc_contracts SET status = 'CANCELLED' WHERE id = $1", [ids.cancelledRenewal]);

    // A cancelled contract ending in 10 days and a draft ending in 5: in no expiry figure.
    ids.cancelled = await ending(10, "CANCELLED");
    await pool.query("UPDATE amc_contracts SET status = 'CANCELLED' WHERE id = $1", [ids.cancelled]);
    expect((await createContract(admin, clientId, { systemDescription: "DRAFT", validFrom: addDays(now, -300), validTo: addDays(now, 5) })).status).toBe(201);

    // A monthly contract outside every band, for the schedule and billing figures.
    monthlyId = await activeContract(admin, clientId, {
      systemDescription: "MONTHLY",
      maintenanceFrequency: "MONTHLY",
      defaultVisitAmount: "50.000",
      contractValue: "6000.000",
      validFrom: addDays(now, -100),
      validTo: addDays(now, 200),
    });
    const past = await pool.query<{ id: string }>(
      "SELECT id FROM amc_visits WHERE amc_contract_id = $1 AND scheduled_date < current_date ORDER BY scheduled_date LIMIT 3",
      [monthlyId]
    );
    for (const row of past.rows) {
      expect((await executeVisit(admin, row.id, { status: "COMPLETED", completedDate: now })).status).toBe(200);
    }
    // One completed visit has no amount: it needs one before it can be invoiced.
    await pool.query("UPDATE amc_visits SET visit_amount = NULL WHERE id = $1", [past.rows[2]?.id]);
    // One completed visit is invoiced: it is no longer pending billing.
    const invoiced = await postInvoice(
      admin,
      invoiceBody(clientId, [{ amcVisitId: past.rows[1]?.id as string, amount: "50.000" }], { amountExclVat: "50.000", vatAmount: "2.500" })
    );
    expect(invoiced.status).toBe(201);

    // An active contract whose visits were all cancelled: the engine reports it.
    ids.noSchedule = await ending(200, "NO SCHEDULE");
    await pool.query("UPDATE amc_visits SET status = 'CANCELLED' WHERE amc_contract_id = $1", [ids.noSchedule]);
  });

  it("counts each contract in one band, and its unrenewed contracts separately", async () => {
    const { expiry } = (await summary()).body.data;

    expect(expiry.renewalsInstalled).toBe(true);
    expect(expiry.bands.map((band: { days: number; count: number; notRenewed: number }) => [band.days, band.count, band.notRenewed])).toEqual([
      [90, 1, 1],
      [60, 1, 1],
      [45, 2, 1],
      [30, 1, 1],
      [15, 2, 2],
    ]);
    expect(expiry.bands[2].notRenewedIds).toEqual([ids.d31]);
  });

  it("gives the renewal warning, critical and not-renewed-and-expired figures without double counting renewal chains", async () => {
    const { expiry, contracts } = (await summary()).body.data;

    expect(expiry.renewalWarning.count).toBe(4);
    expect([...expiry.renewalWarning.ids].sort()).toEqual([ids.d31, ids.d16, ids.d15, ids.d0].sort());
    expect(expiry.critical).toEqual({ days: 15, count: 2, notRenewed: 2 });
    // Expired (not renewed), expired with only a cancelled renewal, and Active past validity. The renewed source is left out.
    expect(expiry.notRenewedExpired).toEqual({ count: 3, expiredStatus: 2, activePastValidity: 1 });
    // The 45-day contract KPI counts every active contract once, renewed or not, as on the dashboard.
    expect(contracts.expiringSoon).toBe(5);
    expect(contracts.expiringSoonWithRenewal).toBe(1);
  });

  it("matches the not-renewed-and-expired figure to the base tables", async () => {
    const expected = await one<{ count: number }>(
      `SELECT count(*)::int AS count FROM amc_contracts c
       WHERE (c.status = 'EXPIRED' OR (c.status = 'ACTIVE' AND c.valid_to < current_date))
         AND NOT EXISTS (SELECT 1 FROM amc_contracts r WHERE r.renewed_from_id = c.id AND r.status <> 'CANCELLED')`
    );

    expect((await summary()).body.data.expiry.notRenewedExpired.count).toBe(expected.count);
  });

  it("lists the expiring contracts soonest first with their band, reference and renewal", async () => {
    const { list } = (await summary()).body.data.expiry;
    const d45 = list.items.find((row: { id: string }) => row.id === ids.d45);

    expect(list.days).toBe(90);
    expect(list.pastValidity).toBe(1);
    expect(list.items[0]).toMatchObject({ id: ids.past, daysLeft: -1, band: null });
    expect(d45).toMatchObject({ reference: `AMC-${String(ids.d45).padStart(4, "0")}`, band: 45, daysLeft: 45, renewal: { id: ids.renewal45, status: "DRAFT" } });
  });

  it("returns the contract KPIs of the dashboard", async () => {
    const data = (await summary()).body.data;
    const dashboard = (await api().get("/api/dashboard/operations").set(admin.headers)).body.data;

    expect(data.contracts).toEqual(dashboard.kpis.contracts);
    const expected = await one<{ active: number; value: string }>(
      "SELECT count(*)::int AS active, COALESCE(sum(contract_value), 0)::numeric(16,3)::text AS value FROM amc_contracts WHERE status = 'ACTIVE'"
    );
    expect(data.contracts.active).toBe(expected.active);
    expect(data.contracts.activeValue).toBe(expected.value);
  });

  it("counts schedule figures from the visits, never treating future visits as pending billing", async () => {
    const { schedule } = (await summary()).body.data;
    const month = await one<{ planned: number; amount: string; missing: number }>(
      `SELECT count(*)::int AS planned, COALESCE(sum(v.visit_amount), 0)::numeric(16,3)::text AS amount,
              count(*) FILTER (WHERE v.visit_amount IS NULL)::int AS missing
       FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE v.status NOT IN ('CANCELLED', 'HISTORICAL') AND c.status <> 'CANCELLED'
         AND date_trunc('month', v.scheduled_date) = date_trunc('month', current_date)`
    );

    expect(schedule.servicesThisMonth.planned).toBe(month.planned);
    expect(schedule.currentScheduledValue).toEqual({ amount: month.amount, visits: month.planned, amountMissing: month.missing });
    // Three completed visits: one ready (50.000), one invoiced, one without an amount.
    expect(schedule.pendingBilling).toEqual({ count: 1, amount: "50.000", amountRequired: 1 });
    const active = await one<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts WHERE status = 'ACTIVE'");
    expect(schedule.engine).toEqual({ activeContracts: active.count, withoutSchedule: 1 });
  });

  it("reports invoice counts but never a payment figure", async () => {
    const { invoices } = (await summary()).body.data;

    expect(invoices.module).toEqual({ issued: 1, cancelled: 0, paymentTracked: false });
    for (const figure of [invoices.paid, invoices.unpaid, invoices.paidTotal]) {
      expect(figure).toEqual({ available: false, reason: expect.stringContaining("Payment is not recorded") });
    }
  });

  it("lists the latest contracts, newest first", async () => {
    const { recentContracts } = (await summary()).body.data;
    const expected = await pool.query<{ id: string }>("SELECT id FROM amc_contracts ORDER BY created_at DESC, id DESC LIMIT 6");
    const total = await one<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts");

    expect(recentContracts.total).toBe(total.count);
    expect(recentContracts.items.map((row: { id: string }) => row.id)).toEqual(expected.rows.map((row) => row.id));
    expect(recentContracts.items[0]).toMatchObject({
      reference: `AMC-${String(expected.rows[0]?.id).padStart(4, "0")}`,
      client: { id: clientId, name: "Management Client" },
      contractValue: expect.stringMatching(/^\d+\.\d{3}$/),
    });
  });

  it("changes nothing", async () => {
    const before = await pool.query("SELECT id, status, updated_at FROM amc_contracts ORDER BY id");
    const logs = await one<{ count: number }>("SELECT count(*)::int AS count FROM activity_logs");
    await summary();

    expect((await pool.query("SELECT id, status, updated_at FROM amc_contracts ORDER BY id")).rows).toEqual(before.rows);
    expect((await one<{ count: number }>("SELECT count(*)::int AS count FROM activity_logs")).count).toBe(logs.count);
  });

  it("protects renewal chains from deletion", async () => {
    expect((await api().delete(`/api/amc/contracts/${ids.d45}`).set(admin.headers)).status).toBe(404);
    await expect(pool.query("DELETE FROM amc_contracts WHERE id = $1", [ids.d45])).rejects.toMatchObject({ code: "23503" });
  });

  describe("expiry alerts", () => {
    it("lists the renewal warning, pinned, and one alert per band with unrenewed contracts", async () => {
      const items = (await alerts(admin)).body.data.items as { key: string; count: number; pinned: boolean; link: string; severity: string }[];
      const byKey = Object.fromEntries(items.map((item) => [item.key, item]));

      expect(byKey["contracts.renewal_warning"]).toMatchObject({ count: 4, pinned: true, link: "/amc/management", severity: "warning" });
      expect(byKey["contracts.expiry.ninety"]).toMatchObject({ count: 1, pinned: false, severity: "info" });
      expect(byKey["contracts.expiry.sixty"]).toMatchObject({ count: 1, severity: "info" });
      expect(byKey["contracts.expiry.forty_five"]).toMatchObject({ count: 1, severity: "info" });
      expect(byKey["contracts.expiry.thirty"]).toMatchObject({ count: 1, severity: "warning" });
      expect(byKey["contracts.expiry.fifteen"]).toMatchObject({ count: 2, severity: "warning" });
    });

    it("keeps read state per user, and keeps the renewal warning listed after it is read", async () => {
      expect((await api().post("/api/notifications/contracts.expiry.ninety/read").set(admin.headers)).status).toBe(200);
      expect((await api().post("/api/notifications/contracts.renewal_warning/read").set(admin.headers)).status).toBe(200);

      const mine = (await alerts(admin)).body.data.items as { key: string; isRead: boolean }[];
      expect(mine.find((item) => item.key === "contracts.expiry.ninety")?.isRead).toBe(true);
      expect(mine.find((item) => item.key === "contracts.renewal_warning")?.isRead).toBe(true);
      // Reading other bands never hides the renewal warning; nothing is hidden from another user either.
      const theirs = (await alerts(execution)).body.data.items as { key: string; isRead: boolean }[];
      expect(theirs.find((item) => item.key === "contracts.expiry.ninety")?.isRead).toBe(false);
      expect(theirs.find((item) => item.key === "contracts.renewal_warning")?.isRead).toBe(false);
    });

    it("shows a read warning as unread again when another contract enters it", async () => {
      await ending(10, "NEW D10");

      const warning = ((await alerts(admin)).body.data.items as { key: string; isRead: boolean; count: number }[]).find(
        (item) => item.key === "contracts.renewal_warning"
      );
      expect(warning).toMatchObject({ count: 5, isRead: false });
    });
  });
});

describe("permissions", () => {
  it("leaves out the schedule and invoice sections a contract viewer may not see", async () => {
    const viewer = await userWith("CONTRACT_VIEWER", ["AMC_CONTRACTS:VIEW"]);
    const response = await summary(viewer);

    expect(response.status).toBe(200);
    expect(response.body.data.schedule).toBeNull();
    expect(response.body.data.invoices).toBeNull();
    expect(response.body.data.contracts).not.toBeNull();
    expect(response.body.data.expiry).not.toBeNull();
  });

  it("gives schedule counts without amounts to a user without schedule view", async () => {
    const engineer = await userWith("CONTRACT_ENGINEER", ["AMC_CONTRACTS:VIEW", "AMC_EXECUTION:VIEW"]);
    const { schedule } = (await summary(engineer)).body.data;

    expect(schedule.servicesThisMonth).toEqual(expect.objectContaining({ planned: expect.any(Number) }));
    expect(schedule.pendingBilling).toBeNull();
    expect(schedule.currentScheduledValue).toBeNull();
  });

  it("needs AMC contract view and a signed-in user", async () => {
    const scheduleOnly = await userWith("SCHEDULE_ONLY", ["AMC_SCHEDULE:VIEW", "INVOICES:VIEW"]);

    expect((await summary(scheduleOnly)).status).toBe(403);
    expect((await api().get("/api/amc/management/summary")).status).toBe(401);
  });

  it("gives no expiry alert to a user without contract view", async () => {
    const scheduleOnly = await signedIn("schedule.only.second@example.com", ["SCHEDULE_ONLY"]);
    const items = (await alerts(scheduleOnly)).body.data.items as { key: string }[];

    expect(items.filter((item) => item.key.startsWith("contracts."))).toEqual([]);
  });
});
