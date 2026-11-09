import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { BUSINESS_TODAY_SQL, businessDateOf, businessDateSql, businessDayStartSql } from "../src/shared/business-date";
import { activeContract, contractBody, createClient, renewalEngineer, visitsOf, withRenewalDocument, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Owner approval 2026-11-09: every date-sensitive business rule is measured in Oman time (Asia/Muscat), whatever the
// time zone of the server or the database session. A contract is valid through its Valid To date in Oman and expired
// from the next Oman day.
//
// To prove the rules do not depend on the session's own date, this file's database sessions run in a time zone that is
// on a DIFFERENT calendar day from Oman right now: UTC-12 (16 h behind Oman) or UTC+14 (10 h ahead). At any instant at
// least one of the two is on another day, so the checks below would fail with the earlier current_date code.

const ZONES = ["Etc/GMT+12", "Pacific/Kiritimati"];
let sessionZone = "";
let today = ""; // Oman
let yesterday = "";
let admin: Session;
let client: string;

const day = async (offset: number) => (await pool.query<{ d: string }>(`SELECT (${BUSINESS_TODAY_SQL} + $1::int)::text AS d`, [offset])).rows[0]!.d;

beforeAll(async () => {
  for (const zone of ZONES) {
    const differs = await pool.query<{ differs: boolean }>(`SELECT (now() AT TIME ZONE $1)::date <> ${BUSINESS_TODAY_SQL} AS differs`, [zone]);
    if (differs.rows[0]?.differs) {
      sessionZone = zone;
      break;
    }
  }
  expect(sessionZone).not.toBe("");
  // Every connection this file's pool opens from now on runs in that zone; close the idle ones first.
  pool.on("connect", (connection) => {
    void connection.query(`SET TIME ZONE '${sessionZone}'`);
  });
  await pool.query(`SET TIME ZONE '${sessionZone}'`);

  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  client = await createClient(admin, "Oman Calendar Client");
  today = await day(0);
  yesterday = await day(-1);
});

afterAll(async () => {
  await closePool();
});

describe("the session really is on another calendar day", () => {
  it("has a session date different from Oman's", async () => {
    const result = await pool.query<{ session: string; zone: string }>("SELECT current_date::text AS session, current_setting('TimeZone') AS zone");
    expect(result.rows[0]?.zone).toBe(sessionZone);
    expect(result.rows[0]?.session).not.toBe(today);
    // Oman's date is also what this process computes for the same instant.
    expect(businessDateOf(new Date())).toBe(today);
  });
});

describe("Oman calendar boundaries (pure conversions)", () => {
  const omanDayOf = async (instant: string) => (await pool.query<{ d: string }>(`SELECT ${businessDateSql("$1::timestamptz")}::text AS d`, [instant])).rows[0]!.d;
  const dayStart = async (date: string) =>
    (await pool.query<{ t: string }>(`SELECT to_char(${businessDayStartSql("$1::date")} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t`, [date])).rows[0]!.t;

  it("changes day at midnight in Oman (20:00 UTC), not at UTC midnight", async () => {
    expect(await omanDayOf("2026-11-09T19:59:59Z")).toBe("2026-11-09");
    expect(await omanDayOf("2026-11-09T20:00:00Z")).toBe("2026-11-10");
    expect(businessDateOf(new Date("2026-11-09T19:59:59Z"))).toBe("2026-11-09");
    expect(businessDateOf(new Date("2026-11-09T20:00:00Z"))).toBe("2026-11-10");
  });

  it("handles month end, year end and the end of February", async () => {
    expect(await omanDayOf("2026-11-30T20:00:00Z")).toBe("2026-12-01");
    expect(await omanDayOf("2026-12-31T19:59:59Z")).toBe("2026-12-31");
    expect(await omanDayOf("2026-12-31T20:00:00Z")).toBe("2027-01-01");
    expect(await omanDayOf("2027-02-28T20:00:00Z")).toBe("2027-03-01");
    expect(await omanDayOf("2028-02-28T20:00:00Z")).toBe("2028-02-29");
    expect(businessDateOf(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });

  it("starts an Oman day at 20:00 UTC the evening before (date filters on stored timestamps)", async () => {
    expect(await dayStart("2026-11-09")).toBe("2026-11-08T20:00:00Z");
    expect(await dayStart("2027-01-01")).toBe("2026-12-31T20:00:00Z");
  });
});

describe("contract validity and expiry by the Oman day", () => {
  let endsToday: string;
  let endedYesterday: string;

  beforeAll(async () => {
    endsToday = await activeContract(admin, client, { systemDescription: "ENDS TODAY", validFrom: await day(-364), validTo: today });
    endedYesterday = await activeContract(admin, client, { systemDescription: "ENDED YESTERDAY", validFrom: await day(-365), validTo: yesterday });
  });

  it("keeps a contract valid through its Valid To day and expired from the next day (contracts, Due/Expired, KPIs)", async () => {
    const list = async (validity: string) =>
      ((await api().get("/api/amc/contracts").query({ clientId: client, validity, pageSize: 100 }).set(admin.headers)).body.data.items as { id: string }[]).map((item) => item.id);

    expect(await list("expired")).toEqual([endedYesterday]);
    expect(await list("due")).toEqual([endsToday]);
    const one = (await api().get(`/api/amc/contracts/${endsToday}`).set(admin.headers)).body.data;
    expect(one.isPastValidity).toBe(false);
    expect((await api().get(`/api/amc/contracts/${endedYesterday}`).set(admin.headers)).body.data.isPastValidity).toBe(true);
    const kpis = (await api().get("/api/amc/contracts/kpis").set(admin.headers)).body.data;
    expect(kpis.expired).toBe(1);
  });

  it("agrees across AMC Renewal, Service Status, AMC Management and the Dashboard", async () => {
    const queue = (await api().get("/api/amc/renewals/queue").query({ pageSize: 100 }).set(admin.headers)).body.data.items as { id: string; daysLeft: number }[];
    expect(queue.find((item) => item.id === endsToday)?.daysLeft).toBe(0);
    expect(queue.find((item) => item.id === endedYesterday)?.daysLeft).toBe(-1);

    const status = (await api().get("/api/amc/service-status").query({ clientId: client, pageSize: 100 }).set(admin.headers)).body.data.items as { contract: { id: string }; serviceStatus: string }[];
    const open = (id: string) => status.filter((item) => item.contract.id === id && item.serviceStatus !== "COMPLETED");
    expect(open(endsToday).every((item) => item.serviceStatus === "NOT_COMPLETED")).toBe(true);
    expect(open(endedYesterday).every((item) => item.serviceStatus === "WAITING_FOR_RENEWAL")).toBe(true);

    const management = (await api().get("/api/amc/management/summary").set(admin.headers)).body.data;
    expect(management.asOf).toBe(today);
    expect(management.expiry.notRenewedExpired.count).toBe(1);

    const dashboard = (await api().get("/api/dashboard/operations").set(admin.headers)).body.data;
    expect(dashboard.asOf).toBe(today);
    expect(dashboard.timeZone).toBe("Asia/Muscat");
  });

  it("lists a renewal's 'Renewed on' as the Oman day it was made", async () => {
    const engineer = await renewalEngineer();
    const renewal = await api()
      .post(`/api/amc/contracts/${endedYesterday}/renewals`)
      .set(admin.headers)
      .send(withRenewalDocument(contractBody(client, { systemDescription: "ENDED YESTERDAY", validFrom: today, validTo: await day(364), status: "DRAFT", salesEngineerId: engineer })));
    expect(renewal.status).toBe(201);
    // Made at 21:30 UTC on 2026-11-09, which is 01:30 on 2026-11-10 in Oman.
    await pool.query("UPDATE amc_contracts_all SET created_at = '2026-11-09T21:30:00Z' WHERE id = $1", [renewal.body.data.id]);

    const history = (await api().get("/api/amc/reports/renewals").set(admin.headers)).body.data.items as { renewal: { id: string }; createdOn: string }[];
    expect(history.find((item) => item.renewal.id === renewal.body.data.id)?.createdOn).toBe("2026-11-10");
    const report = (await api().get("/api/reports/renewal-history").query({ from: "2026-11-10", to: "2026-11-10" }).set(admin.headers)).body.data;
    expect(report.rows.map((row: { created_on: string }) => row.created_on)).toEqual(["2026-11-10"]);
  });
});

describe("services due, overdue and completed by the Oman day", () => {
  it("is not overdue on its own day, overdue from the next, and is completed on Oman's date", async () => {
    const contract = await activeContract(admin, client, { systemDescription: "VISITS", validFrom: await day(-100), validTo: await day(264), maintenanceFrequency: "MONTHLY" });
    const visits = await visitsOf(contract);
    const dueToday = visits[0]!.id;
    const dueYesterday = visits[1]!.id;
    await pool.query("UPDATE amc_visits_all SET scheduled_date = $1 WHERE id = $2", [today, dueToday]);
    await pool.query("UPDATE amc_visits_all SET scheduled_date = $1 WHERE id = $2", [yesterday, dueYesterday]);

    const row = async (id: string) => (await api().get(`/api/amc/service-status/${id}`).set(admin.headers)).body.data;
    expect((await row(dueToday)).isOverdue).toBe(false);
    expect((await row(dueYesterday)).isOverdue).toBe(true);

    await withServiceReport(dueToday);
    const saved = await api().patch(`/api/amc/service-status/${dueToday}`).set(admin.headers).send({ status: "COMPLETED", expectedUpdatedAt: (await row(dueToday)).updatedAt });
    expect(saved.status).toBe(200);
    expect(saved.body.data.completedDate).toBe(today);
  });
});

describe("Dashboard 'paid this month' by the Oman month", () => {
  it("counts an Invoice No. entered at 00:30 on the 1st in Oman, not one entered a minute before the month began", async () => {
    const contract = await activeContract(admin, client, { systemDescription: "PAID", validFrom: await day(-200), validTo: await day(164) });
    const [first, second] = (await visitsOf(contract)).map((visit) => visit.id) as [string, string];
    const monthStart = (await pool.query<{ d: string }>(`SELECT date_trunc('month', ${BUSINESS_TODAY_SQL})::date::text AS d`)).rows[0]!.d;
    // 00:30 Oman on the 1st = 20:30 UTC the day before; 23:59 Oman on the last day of the previous month.
    const inMonth = (await pool.query<{ t: Date }>(`SELECT ${businessDayStartSql("$1::date")} + interval '30 minutes' AS t`, [monthStart])).rows[0]!.t;
    const before = (await pool.query<{ t: Date }>(`SELECT ${businessDayStartSql("$1::date")} - interval '1 minute' AS t`, [monthStart])).rows[0]!.t;

    const before0 = (await api().get("/api/dashboard/operations").set(admin.headers)).body.data.kpis.payments;
    await pool.query("UPDATE amc_visits_all SET status = 'COMPLETED', completed_date = $1, manual_invoice_no = 'OMAN-1', manual_invoice_at = $2, manual_invoice_by = $4 WHERE id = $3", [monthStart, inMonth, first, admin.id]);
    await pool.query("UPDATE amc_visits_all SET status = 'COMPLETED', completed_date = $1, manual_invoice_no = 'OMAN-2', manual_invoice_at = $2, manual_invoice_by = $4 WHERE id = $3", [monthStart, before, second, admin.id]);
    const after = (await api().get("/api/dashboard/operations").set(admin.headers)).body.data.kpis.payments;

    expect(after.paid).toBe(before0.paid + 2);
    expect(after.paidThisMonth).toBe(before0.paidThisMonth + 1);
  });
});
