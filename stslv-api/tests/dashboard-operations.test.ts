import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { percentOf } from "../src/modules/dashboard/operations.service";
import { activeContract, createClient, createContract, today, visitsOf } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { resetProjectData, type Session } from "./projects-helpers";

// GET /api/dashboard/operations, /calendar and /readiness. Every figure is
// checked against the base tables with SQL written here, not against the
// services the API uses.

let admin: Session;
let now: string;

const operations = (session: Session = admin) => api().get("/api/dashboard/operations").set(session.headers);
const calendar = (month: string, session: Session = admin) => api().get(`/api/dashboard/calendar?month=${month}`).set(session.headers);
const readiness = (session: Session = admin) => api().get("/api/dashboard/readiness").set(session.headers);

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

// The visits the dashboard counts, written independently of the service.
const COUNTED = `v.status NOT IN ('CANCELLED', 'HISTORICAL') AND c.status <> 'CANCELLED'`;

let expiringIn45: string;
let renewedSource: string;

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  now = await today();
});

afterAll(async () => {
  await closePool();
});

describe("percentOf", () => {
  it("rounds half up to one decimal using whole numbers only", () => {
    expect(percentOf(1, 3)).toBe("33.3");
    expect(percentOf(2, 3)).toBe("66.7");
    expect(percentOf(1, 8)).toBe("12.5");
    expect(percentOf(1, 16)).toBe("6.3");
    expect(percentOf(0, 5)).toBe("0.0");
    expect(percentOf(7, 7)).toBe("100.0");
    expect(percentOf(0, 0)).toBeNull();
  });
});

describe("empty database", () => {
  it("returns zeros, empty lists and no percentages", async () => {
    const response = await operations();

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data.asOf).toBe(now);
    expect(typeof data.timeZone).toBe("string");
    expect(data.kpis.contracts).toEqual({
      active: 0,
      activePastValidity: 0,
      activeValue: "0.000",
      finalCreditTotal: "0.000",
      finalCreditRecorded: 0,
      expiringSoon: 0,
      expiringSoonDays: 45,
      expiringSoonWithRenewal: 0,
    });
    expect(data.kpis.services).toEqual({ thisMonth: 0, completedThisMonth: 0, openThisMonth: 0 });
    expect(data.portfolio.total).toBe(0);
    expect(data.portfolio.statuses.map((s: { status: string }) => s.status)).toEqual(["DRAFT", "ACTIVE", "EXPIRED", "CANCELLED"]);
    expect(data.portfolio.statuses.every((s: { count: number; percent: string | null }) => s.count === 0 && s.percent === null)).toBe(true);
    expect(data.expiring).toMatchObject({ days: 90, total: 0, pastValidity: 0, items: [] });
    expect(data.workload.months).toHaveLength(6);
    expect(data.workload.months.every((m: { planned: number }) => m.planned === 0)).toBe(true);
    expect(data.schedule).toMatchObject({ today: [], todayTotal: 0, upcoming: [], upcomingTotal: 0 });
  });
});

describe("with contracts and visits", () => {
  beforeAll(async () => {
    const client = await createClient(admin, "Dashboard Client");
    const annual = { maintenanceFrequency: "ANNUALLY", defaultVisitAmount: "100.000" };

    // Ends exactly 45 days ahead: inside the KPI window.
    expiringIn45 = await activeContract(admin, client, {
      ...annual,
      systemDescription: "EDGE45",
      validFrom: addDays(now, -300),
      validTo: addDays(now, 45),
      contractValue: "1000.125",
      finalCredit: "300.500",
    });
    // Ends 46 days ahead: outside the KPI, inside the 90-day list.
    await activeContract(admin, client, {
      ...annual,
      systemDescription: "EDGE46",
      validFrom: addDays(now, -300),
      validTo: addDays(now, 46),
      contractValue: "2000.000",
      finalCredit: null,
    });
    // Ends today: inside the KPI with zero days left.
    await activeContract(admin, client, {
      ...annual,
      systemDescription: "TODAY",
      validFrom: addDays(now, -300),
      validTo: now,
      contractValue: "0.375",
      finalCredit: "0.001",
    });
    // Validity ended yesterday but still Active: not "expiring", reported as past validity.
    await activeContract(admin, client, {
      ...annual,
      systemDescription: "PAST",
      validFrom: addDays(now, -300),
      validTo: addDays(now, -1),
      contractValue: "10.000",
    });
    // Ends in 200 days: in neither window.
    const monthly = await activeContract(admin, client, {
      systemDescription: "MONTHLY",
      validFrom: addDays(now, -200),
      validTo: addDays(now, 200),
      contractValue: "5000.000",
      maintenanceFrequency: "MONTHLY",
      defaultVisitAmount: "50.000",
    });
    // A draft: in the portfolio, in no KPI.
    expect((await createContract(admin, client, { systemDescription: "DRAFT", contractValue: "999.000" })).status).toBe(201);

    // A cancelled contract with a visit moved to today: never counted.
    const cancelled = await activeContract(admin, client, {
      ...annual,
      systemDescription: "CANCELLED",
      validFrom: addDays(now, -10),
      validTo: addDays(now, 300),
    });
    await pool.query("UPDATE amc_visits SET scheduled_date = current_date WHERE amc_contract_id = $1", [cancelled]);
    await pool.query("UPDATE amc_contracts SET status = 'CANCELLED' WHERE id = $1", [cancelled]);

    // A renewal of the 45-day contract: the KPI still counts the source once and reports the renewal beside it.
    renewedSource = expiringIn45;
    await pool.query(
      `INSERT INTO amc_contracts (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, status, renewed_from_id)
       VALUES ($1, $2, $3, 'EDGE45 RENEWAL', 1000.000, 'ANNUALLY', 'DRAFT', $4)`,
      [client, addDays(now, 46), addDays(now, 410), renewedSource]
    );

    // Month boundaries: move four monthly visits to the first and last day of this month and the days either side.
    const visits = await visitsOf(monthly);
    const bounds = await one<{ first: string; last: string; prev_last: string; next_first: string }>(
      `SELECT date_trunc('month', current_date)::date::text AS first,
              (date_trunc('month', current_date) + interval '1 month - 1 day')::date::text AS last,
              (date_trunc('month', current_date) - interval '1 day')::date::text AS prev_last,
              (date_trunc('month', current_date) + interval '1 month')::date::text AS next_first`
    );
    const move = (index: number, date: string) =>
      pool.query("UPDATE amc_visits SET scheduled_date = $2 WHERE id = $1", [visits[index]?.id, date]);
    await move(0, bounds.prev_last);
    await move(1, bounds.first);
    await move(2, bounds.last);
    await move(3, bounds.next_first);
    // One visit today, completed; one cancelled visit today.
    await pool.query("UPDATE amc_visits SET scheduled_date = current_date, status = 'COMPLETED', completed_date = current_date WHERE id = $1", [
      visits[4]?.id,
    ]);
    await pool.query("UPDATE amc_visits SET scheduled_date = current_date, status = 'CANCELLED' WHERE id = $1", [visits[5]?.id]);
  });

  it("counts active contracts and their total value exactly, without annualising", async () => {
    const expected = await one<{ active: number; value: string; past: number }>(
      `SELECT count(*)::int AS active, sum(contract_value)::numeric(16,3)::text AS value,
              count(*) FILTER (WHERE valid_to < current_date)::int AS past
       FROM amc_contracts WHERE status = 'ACTIVE'`
    );
    const { contracts } = (await operations()).body.data.kpis;

    expect(contracts.active).toBe(expected.active);
    expect(contracts.active).toBe(5);
    // 1000.125 + 2000.000 + 0.375 + 10.000 + 5000.000, to the third decimal.
    expect(contracts.activeValue).toBe("8010.500");
    expect(contracts.activeValue).toBe(expected.value);
    expect(contracts.activePastValidity).toBe(1);
  });

  it("sums final credit as entered on active contracts only, and says how many have one", async () => {
    const { contracts } = (await operations()).body.data.kpis;

    // 300.500 + 0.001; the draft's credit (if any) is not included.
    expect(contracts.finalCreditTotal).toBe("300.501");
    expect(contracts.finalCreditRecorded).toBe(2);
  });

  it("counts contracts expiring within 45 days with both boundaries included, each contract once", async () => {
    const { contracts } = (await operations()).body.data.kpis;

    // EDGE45 and TODAY; not EDGE46, not PAST, not the renewal draft.
    expect(contracts.expiringSoon).toBe(2);
    expect(contracts.expiringSoonWithRenewal).toBe(1);
  });

  it("lists contracts ending within 90 days, past validity first, with days left and renewal", async () => {
    const { expiring } = (await operations()).body.data;

    expect(expiring.total).toBe(4);
    expect(expiring.pastValidity).toBe(1);
    expect(expiring.renewalsInstalled).toBe(true);
    expect(expiring.items.map((row: { systemDescription: string; daysLeft: number }) => [row.systemDescription, row.daysLeft])).toEqual([
      ["PAST", -1],
      ["TODAY", 0],
      ["EDGE45", 45],
      ["EDGE46", 46],
    ]);
    const edge = expiring.items.find((row: { id: string }) => row.id === renewedSource);
    expect(edge.renewal).toMatchObject({ status: "DRAFT" });
    expect(expiring.items.find((row: { systemDescription: string }) => row.systemDescription === "TODAY").renewal).toBeNull();
  });

  it("does not change any contract status", async () => {
    const before = await one<{ statuses: string }>("SELECT string_agg(id || ':' || status, ',' ORDER BY id) AS statuses FROM amc_contracts");

    await operations();

    expect(await one("SELECT string_agg(id || ':' || status, ',' ORDER BY id) AS statuses FROM amc_contracts")).toEqual(before);
  });

  it("breaks the portfolio down by every status with percentages that match the counts", async () => {
    const { portfolio } = (await operations()).body.data;
    const expected = await pool.query<{ status: string; count: number }>("SELECT status, count(*)::int AS count FROM amc_contracts GROUP BY status");

    expect(portfolio.total).toBe(8);
    for (const row of expected.rows) {
      expect(portfolio.statuses.find((s: { status: string }) => s.status === row.status).count).toBe(row.count);
    }
    expect(portfolio.statuses.find((s: { status: string }) => s.status === "EXPIRED")).toEqual({ status: "EXPIRED", count: 0, percent: "0.0" });
    // 5 active of 8.
    expect(portfolio.statuses.find((s: { status: string }) => s.status === "ACTIVE").percent).toBe("62.5");
  });

  it("counts services this month inside the month boundaries only, and matches the workload chart", async () => {
    const expected = await one<{ planned: number; completed: number }>(
      `SELECT count(*)::int AS planned, count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed
       FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE ${COUNTED} AND date_trunc('month', v.scheduled_date) = date_trunc('month', current_date)`
    );
    const data = (await operations()).body.data;

    expect(data.kpis.services.thisMonth).toBe(expected.planned);
    expect(data.kpis.services.completedThisMonth).toBe(expected.completed);
    expect(data.workload.months[0].planned).toBe(data.kpis.services.thisMonth);
    expect(data.workload.months).toHaveLength(6);
  });

  it("returns per-day counts for a month, excluding the neighbouring months, cancelled visits and cancelled contracts", async () => {
    const month = now.slice(0, 7);
    const response = await calendar(month);
    const expected = await pool.query<{ date: string; total: number }>(
      `SELECT v.scheduled_date::text AS date, count(*)::int AS total
       FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE ${COUNTED} AND to_char(v.scheduled_date, 'YYYY-MM') = $1
       GROUP BY 1 ORDER BY 1`,
      [month]
    );

    expect(response.status).toBe(200);
    expect(response.body.data.days.map((d: { date: string; total: number }) => ({ date: d.date, total: d.total }))).toEqual(expected.rows);
    expect(response.body.data.days.every((d: { date: string }) => d.date.startsWith(month))).toBe(true);
    const todayRow = response.body.data.days.find((d: { date: string }) => d.date === now);
    expect(todayRow.completed).toBeGreaterThanOrEqual(1);
  });

  it("rejects a malformed month", async () => {
    expect((await calendar("2026-13")).status).toBe(400);
    expect((await calendar("26-01")).status).toBe(400);
  });

  it("lists today's work without cancelled visits or cancelled contracts", async () => {
    const { schedule } = (await operations()).body.data;
    const expected = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE ${COUNTED} AND v.scheduled_date = current_date`
    );

    expect(schedule.todayTotal).toBe(expected.n);
    expect(schedule.today.length).toBe(Math.min(expected.n, 10));
    expect(schedule.today.every((item: { status: string; scheduledDate: string }) => item.status !== "CANCELLED" && item.scheduledDate === now)).toBe(true);
    expect(schedule.today.some((item: { systemDescription: string }) => item.systemDescription === "CANCELLED")).toBe(false);
    // No amounts in the work lists.
    expect(JSON.stringify(schedule)).not.toContain("visitAmount");
  });

  it("reports payment figures as unavailable instead of inventing them", async () => {
    const { kpis, payments } = (await operations()).body.data;

    expect(kpis.unpaidInvoices).toMatchObject({ available: false });
    expect(kpis.paidThisMonth).toMatchObject({ available: false });
    expect(payments).toMatchObject({ available: false });
    expect(payments.reason).toMatch(/not recorded/);
  });
});

describe("permissions", () => {
  it("refuses a user without DASHBOARD:VIEW", async () => {
    const user = await userWith("NO_DASH", ["AMC_CONTRACTS:VIEW"]);

    expect((await operations(user)).status).toBe(403);
    expect((await calendar(now.slice(0, 7), user)).status).toBe(403);
  });

  it("returns no section to a user who holds only DASHBOARD:VIEW", async () => {
    const user = await userWith("DASH_ONLY", ["DASHBOARD:VIEW"]);
    const data = (await operations(user)).body.data;

    expect(data.kpis).toEqual({ contracts: null, services: null, unpaidInvoices: null, paidThisMonth: null });
    expect(data.portfolio).toBeNull();
    expect(data.expiring).toBeNull();
    expect(data.workload).toBeNull();
    expect(data.schedule).toBeNull();
    expect(data.payments).toBeNull();
    expect((await calendar(now.slice(0, 7), user)).status).toBe(403);
  });

  it("gives schedule viewers counts and today's work, but no contract values", async () => {
    const user = await userWith("SCHED_VIEW", ["DASHBOARD:VIEW", "AMC_SCHEDULE:VIEW"]);
    const data = (await operations(user)).body.data;

    expect(data.kpis.contracts).toBeNull();
    expect(data.portfolio).toBeNull();
    expect(data.expiring).toBeNull();
    expect(data.kpis.services).not.toBeNull();
    expect(data.workload).not.toBeNull();
    expect(data.schedule).not.toBeNull();
    expect(data.payments).toBeNull();
    expect(JSON.stringify(data)).not.toContain("activeValue");
    expect((await calendar(now.slice(0, 7), user)).status).toBe(200);
  });

  it("gives execution viewers visit counts as the AMC summary does", async () => {
    const user = await userWith("EXEC_VIEW", ["DASHBOARD:VIEW", "AMC_EXECUTION:VIEW"]);
    const data = (await operations(user)).body.data;

    expect(data.kpis.services).not.toBeNull();
    expect(data.kpis.contracts).toBeNull();
  });

  it("gives contract viewers contract figures, but no visits or payments", async () => {
    const user = await userWith("CONTRACT_VIEW", ["DASHBOARD:VIEW", "AMC_CONTRACTS:VIEW"]);
    const data = (await operations(user)).body.data;

    expect(data.kpis.contracts.active).toBe(5);
    expect(data.kpis.services).toBeNull();
    expect(data.schedule).toBeNull();
    expect(data.payments).toBeNull();
  });

  it("gives invoice viewers the payment availability only", async () => {
    const user = await userWith("INV_VIEW", ["DASHBOARD:VIEW", "INVOICES:VIEW"]);
    const data = (await operations(user)).body.data;

    expect(data.payments).toMatchObject({ available: false });
    expect(data.kpis.contracts).toBeNull();
  });

  it("keeps production readiness to the built-in Admin role, whatever else a role holds", async () => {
    const user = await userWith("ALMOST_ADMIN", ["DASHBOARD:VIEW", "USERS:VIEW", "SETTINGS:VIEW", "SETTINGS:EDIT"]);

    expect((await readiness(user)).status).toBe(403);
  });
});

describe("production readiness", () => {
  it("reports individual verified checks and no score", async () => {
    const response = await readiness();

    expect(response.status).toBe(200);
    const checks = response.body.data.checks as { id: string; state: string; detail: string }[];
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));

    expect(byId.api?.state).toBe("OK");
    expect(byId.database?.state).toBe("OK");
    // The test schema has every migration applied.
    expect(byId.migrations?.state).toBe("OK");
    expect(byId.backup?.state).toBe("UNAVAILABLE");
    expect(byId.failedSignIns).toBeDefined();
    expect(JSON.stringify(response.body)).not.toMatch(/score/i);
    // No secret or connection detail leaves the API.
    expect(JSON.stringify(response.body)).not.toMatch(/password|JWT|postgres:\/\//i);
  });
});
