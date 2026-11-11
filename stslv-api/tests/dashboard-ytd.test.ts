import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { yearToDateServiceCounts } from "../src/modules/dashboard/operations.service";
import { BUSINESS_TODAY_SQL, businessDateOf } from "../src/shared/business-date";
import { activeContract, createClient, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Dashboard's Current Year (YTD) row (2026-11-11): Services Due, Services Completed and Services Pending, over the
// counted services (the same scope as Current Month and Overall) scheduled from January 1 of Oman's year through
// Oman's today. Visits ahead are not counted.
//
// The fixed-date scenarios use years no other fixture reaches (2030-2032) and pass "today" to the calculation; the API
// checks use the real clock. Like business-date-oman.test.ts, this file's database sessions run in a time zone on a
// DIFFERENT calendar day from Oman, so a period measured on the session's date would fail.

const ZONES = ["Etc/GMT+12", "Pacific/Kiritimati"];
const FAR = "2040-01-15";

let admin: Session;
let omanToday = "";

const operations = (session: Session = admin) => api().get("/api/dashboard/operations").set(session.headers);

/** Sets a visit's date and status once (a completed visit is locked), completing it on its own date. */
const set = (id: string | undefined, date: string, status: string, invoiceNo: string | null = null) =>
  pool.query(
    `UPDATE amc_visits SET scheduled_date = $2::date, status = $3,
            completed_date = CASE WHEN $3 = 'COMPLETED' THEN $2::date END,
            manual_invoice_no = $4, manual_invoice_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
            manual_invoice_by = CASE WHEN $4::text IS NULL THEN NULL ELSE (SELECT min(id) FROM users) END
     WHERE id = $1`,
    [id, date, status, invoiceNo]
  );

/** A monthly contract whose visits are all moved out of the way except those the plan places. */
async function contractWith(client: string, name: string, plan: [string, string, string?][]): Promise<string> {
  const contract = await activeContract(admin, client, {
    systemDescription: name,
    validFrom: addDays(omanToday, -400),
    validTo: addDays(omanToday, 200),
    contractValue: "1200.000",
    maintenanceFrequency: "MONTHLY",
    defaultVisitAmount: "100.000",
  });
  const visits = await visitsOf(contract);
  expect(visits.length).toBeGreaterThan(plan.length);

  for (const [index, visit] of visits.entries()) {
    const [date, status, invoiceNo] = plan[index] ?? [FAR, "SCHEDULED"];
    await set(visit.id, date, status, invoiceNo ?? null);
  }

  return contract;
}

async function userWith(code: string, permissions: string[]): Promise<Session> {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1)", [code]);
  for (const permission of permissions) {
    const [module, action] = permission.split(":");
    await pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, $2, $3 FROM roles WHERE code = $1", [code, module, action]);
  }

  return signedIn(`${code.toLowerCase()}@example.com`, [code]);
}

beforeAll(async () => {
  let zone = "";
  for (const candidate of ZONES) {
    const differs = await pool.query<{ differs: boolean }>(`SELECT (now() AT TIME ZONE $1)::date <> ${BUSINESS_TODAY_SQL} AS differs`, [candidate]);
    if (differs.rows[0]?.differs) {
      zone = candidate;
      break;
    }
  }
  expect(zone).not.toBe("");
  pool.on("connect", (connection) => {
    void connection.query(`SET TIME ZONE '${zone}'`);
  });
  await pool.query(`SET TIME ZONE '${zone}'`);

  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  omanToday = (await pool.query<{ d: string }>(`SELECT ${BUSINESS_TODAY_SQL}::text AS d`)).rows[0]!.d;
  const client = await createClient(admin, "YTD Client");

  // The main scenario, "today" = 2031-06-15.
  await contractWith(client, "YTD MAIN", [
    ["2030-12-31", "COMPLETED"], // previous year: never in 2031
    ["2031-01-01", "COMPLETED"], // January 1: included
    ["2031-03-10", "SCHEDULED"], // overdue
    ["2031-04-10", "POSTPONED"], // overdue
    ["2031-05-10", "IN_PROGRESS"], // pending, not overdue (the schedule's rule)
    ["2031-06-15", "SCHEDULED"], // today: due and pending, not yet overdue
    ["2031-06-16", "SCHEDULED"], // tomorrow: a future visit, not counted
    ["2031-02-10", "CANCELLED"], // cancelled visit: never counted
    ["2031-06-14", "COMPLETED"], // completed yesterday
    ["2032-01-01", "SCHEDULED"], // next year's January 1
  ]);

  // A cancelled contract: its outstanding unpaid work leaves every figure; work carried out and Paid records stay
  // (the shared service scope, P1 fixes 2026-11-09).
  const cancelled = await contractWith(client, "YTD CANCELLED", [
    ["2031-02-01", "SCHEDULED"], // not counted
    ["2031-02-02", "COMPLETED"], // counted, completed
    ["2031-02-03", "SCHEDULED", "INV-YTD-1"], // Paid reference: counted, pending and overdue
  ]);
  await pool.query("UPDATE amc_contracts SET status = 'CANCELLED' WHERE id = $1", [cancelled]);

  // A contract in the Recycle Bin: none of its services is counted.
  const deleted = await contractWith(client, "YTD DELETED", [
    ["2031-03-01", "COMPLETED"],
    ["2031-03-02", "SCHEDULED", "INV-YTD-2"],
    ["2031-06-15", "SCHEDULED"],
  ]);
  await pool.query("UPDATE amc_contracts_all SET deleted_at = now(), deleted_by = (SELECT min(id) FROM users) WHERE id = $1", [deleted]);

  // Around the real Oman today, for the API checks.
  const yearStart = `${omanToday.slice(0, 4)}-01-01`;
  await contractWith(client, "YTD NOW", [
    [addDays(yearStart, -1), "COMPLETED"], // last year's December 31
    [yearStart, "COMPLETED"],
    [addDays(omanToday, -1) < yearStart ? yearStart : addDays(omanToday, -1), "SCHEDULED"],
    [omanToday, "SCHEDULED"],
    [omanToday, "COMPLETED"],
    [addDays(omanToday, 1), "SCHEDULED"], // tomorrow: not counted
    [omanToday, "CANCELLED"],
  ]);
});

afterAll(async () => {
  await closePool();
});

describe("Current Year (YTD) calculation", () => {
  it("counts January 1 through today, both included, with completed, pending and overdue services", async () => {
    expect(await yearToDateServiceCounts("2031-06-15")).toEqual({
      from: "2031-01-01",
      to: "2031-06-15",
      // Jan 1, Mar 10, Apr 10, May 10, Jun 15, Jun 14 and, on the cancelled contract, the completed and the Paid service.
      due: 8,
      completed: 3,
      pending: 5,
      // Mar 10 (Scheduled), Apr 10 (Postponed) and the Paid service of Feb 3. In Progress and today's are not overdue.
      overdue: 3,
    });
  });

  it("keeps Pending = Due - Completed", async () => {
    for (const today of ["2030-12-31", "2031-01-01", "2031-06-15", "2031-12-31", "2032-01-01"]) {
      const figures = await yearToDateServiceCounts(today);
      expect(figures.pending).toBe(figures.due - figures.completed);
    }
  });

  it("includes a service scheduled on January 1 and nothing from December 31 of the year before", async () => {
    expect(await yearToDateServiceCounts("2031-01-01")).toEqual({ from: "2031-01-01", to: "2031-01-01", due: 1, completed: 1, pending: 0, overdue: 0 });
    // The day before, the period is 2030 and the January 1 service is a future visit.
    expect(await yearToDateServiceCounts("2030-12-31")).toEqual({ from: "2030-01-01", to: "2030-12-31", due: 1, completed: 1, pending: 0, overdue: 0 });
  });

  it("counts a service scheduled today, and not one scheduled tomorrow", async () => {
    const yesterday = await yearToDateServiceCounts("2031-06-14");
    const today = await yearToDateServiceCounts("2031-06-15");
    const tomorrow = await yearToDateServiceCounts("2031-06-16");

    // Jun 15 joins on its own day (pending, not overdue); Jun 16 joins only on Jun 16.
    expect(today.due).toBe(yesterday.due + 1);
    expect(today.pending).toBe(yesterday.pending + 1);
    expect(tomorrow.due).toBe(today.due + 1);
    // On Jun 16, the Jun 15 service has become overdue.
    expect(tomorrow.overdue).toBe(today.overdue + 1);
  });

  it("counts every remaining service of the year by December 31, overdue only when Scheduled or Postponed", async () => {
    expect(await yearToDateServiceCounts("2031-12-31")).toEqual({ from: "2031-01-01", to: "2031-12-31", due: 9, completed: 3, pending: 6, overdue: 5 });
  });

  it("starts again from zero on January 1 of a new year", async () => {
    expect(await yearToDateServiceCounts("2032-01-01")).toEqual({ from: "2032-01-01", to: "2032-01-01", due: 1, completed: 0, pending: 1, overdue: 0 });
  });

  it("never counts cancelled visits, unpaid open work of a cancelled contract, or contracts in the Recycle Bin", async () => {
    const stored = await pool.query<{ cancelled: number; binned: number }>(
      `SELECT count(*) FILTER (WHERE status = 'CANCELLED' AND scheduled_date BETWEEN '2031-01-01' AND '2031-06-15')::int AS cancelled,
              count(*) FILTER (WHERE amc_contract_id IN (SELECT id FROM amc_contracts_all WHERE deleted_at IS NOT NULL)
                               AND scheduled_date BETWEEN '2031-01-01' AND '2031-06-15')::int AS binned
       FROM amc_visits_all`
    );
    // The excluded records exist; the figures above leave them out.
    expect(stored.rows[0]).toEqual({ cancelled: 1, binned: 3 });
    const everything = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM amc_visits_all WHERE scheduled_date BETWEEN '2031-01-01' AND '2031-06-15'");
    expect(everything.rows[0]?.n).toBe(13);
    expect((await yearToDateServiceCounts("2031-06-15")).due).toBe(8);
  });
});

describe("GET /api/dashboard/operations — yearToDate", () => {
  it("measures the period in Oman, whatever the database session's own date", async () => {
    const session = await pool.query<{ session: string }>("SELECT current_date::text AS session");
    expect(session.rows[0]?.session).not.toBe(omanToday);
    expect(businessDateOf(new Date())).toBe(omanToday);

    const { yearToDate, asOf } = (await operations()).body.data;
    expect(yearToDate.to).toBe(omanToday);
    expect(yearToDate.to).toBe(asOf);
    expect(yearToDate.from).toBe(`${omanToday.slice(0, 4)}-01-01`);
    expect(yearToDate).toEqual(await yearToDateServiceCounts(omanToday));
  });

  it("matches the stored services, counted independently with the shared scope", async () => {
    const expected = await pool.query<{ due: number; completed: number; overdue: number }>(
      `SELECT count(*)::int AS due,
              count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE v.status IN ('SCHEDULED', 'POSTPONED') AND v.scheduled_date < $1::date)::int AS overdue
       FROM amc_visits_all v JOIN amc_contracts_all c ON c.id = v.amc_contract_id
       WHERE c.deleted_at IS NULL
         AND v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED')
         AND (v.status = 'COMPLETED' OR v.manual_invoice_no IS NOT NULL OR c.status <> 'CANCELLED')
         AND v.scheduled_date >= make_date(extract(year FROM $1::date)::int, 1, 1) AND v.scheduled_date <= $1::date`,
      [omanToday]
    );
    const row = expected.rows[0]!;
    const { yearToDate } = (await operations()).body.data;

    expect(yearToDate).toMatchObject({ due: row.due, completed: row.completed, pending: row.due - row.completed, overdue: row.overdue });
    // The YTD NOW contract alone gives at least Jan 1 and today's two services.
    expect(yearToDate.due).toBeGreaterThanOrEqual(3);
  });

  it("leaves every existing figure exactly as the shared calculation gives it", async () => {
    const data = (await operations()).body.data;
    const management = (await api().get("/api/amc/management/summary").set(admin.headers)).body.data;

    expect(Object.keys(data.kpis).sort()).toEqual(["contracts", "payments", "services"]);
    expect(Object.keys(data.kpis.services).sort()).toEqual(["completedThisMonth", "openOverall", "openThisMonth", "overall", "thisMonth"]);
    // AMC Management is unchanged: it gets no YTD figures.
    expect(JSON.stringify(management)).not.toContain("yearToDate");
  });

  it("follows the service cards' permission: schedule or execution view", async () => {
    const dashOnly = await userWith("YTD_DASH_ONLY", ["DASHBOARD:VIEW"]);
    const schedule = await userWith("YTD_SCHED", ["DASHBOARD:VIEW", "AMC_SCHEDULE:VIEW"]);
    const execution = await userWith("YTD_EXEC", ["DASHBOARD:VIEW", "AMC_EXECUTION:VIEW"]);
    const invoices = await userWith("YTD_INV", ["DASHBOARD:VIEW", "INVOICES:VIEW"]);
    const contracts = await userWith("YTD_CONTRACTS", ["DASHBOARD:VIEW", "AMC_CONTRACTS:VIEW"]);

    expect((await operations(dashOnly)).body.data.yearToDate).toBeNull();
    expect((await operations(invoices)).body.data.yearToDate).toBeNull();
    expect((await operations(contracts)).body.data.yearToDate).toBeNull();
    expect((await operations(schedule)).body.data.yearToDate).toEqual((await operations()).body.data.yearToDate);
    expect((await operations(execution)).body.data.yearToDate).not.toBeNull();
  });

  it("only reads: no service, contract or invoice changes", async () => {
    const snapshot = async () =>
      (
        await pool.query(
          `SELECT (SELECT string_agg(id || ':' || status || ':' || scheduled_date || ':' || COALESCE(manual_invoice_no, '-'), ',' ORDER BY id) FROM amc_visits_all) AS visits,
                  (SELECT string_agg(id || ':' || status, ',' ORDER BY id) FROM amc_contracts_all) AS contracts`
        )
      ).rows[0];
    const before = await snapshot();
    await operations();
    expect(await snapshot()).toEqual(before);
  });
});
