import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, createContract } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { completeVisit, type Session } from "./invoices-helpers";
import { resetProjectData } from "./projects-helpers";

// AMC report endpoints: expiring contracts and monthly workload. Read-only.
// Every record here is invented test data.

let admin: Session;
let execution: Session;
let accountant: Session;

/** A date relative to the database's current date, as YYYY-MM-DD. */
async function dayFromToday(days: number): Promise<string> {
  const result = await pool.query<{ day: string }>("SELECT (current_date + $1::int)::text AS day", [days]);

  return (result.rows[0] as { day: string }).day;
}

async function monthFromNow(months: number): Promise<string> {
  const result = await pool.query<{ month: string }>(
    "SELECT to_char(date_trunc('month', current_date) + make_interval(months => $1::int), 'YYYY-MM') AS month",
    [months]
  );

  return (result.rows[0] as { month: string }).month;
}

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  accountant = await signedIn("procurement@example.com", ["PROCUREMENT"]);
});
afterAll(closePool);

describe("GET /api/amc/reports/expiring", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const clientId = await createClient(admin, "Expiry Test Client");
    const contract = async (key: string, validFrom: number, validTo: number, system: string) => {
      ids[key] = await activeContract(admin, clientId, {
        validFrom: await dayFromToday(validFrom),
        validTo: await dayFromToday(validTo),
        maintenanceFrequency: "ANNUALLY",
        systemDescription: system,
      });
    };

    await contract("soon", -300, 10, "SOON");
    await contract("ended", -400, -5, "ENDED");
    await contract("later", -100, 200, "LATER");
    // A draft ending soon is not part of the active portfolio.
    const draft = await createContract(admin, clientId, {
      validFrom: await dayFromToday(-300),
      validTo: await dayFromToday(10),
      systemDescription: "DRAFT",
    });
    ids.draft = draft.body.data.id as string;
  });

  it("lists active contracts ending within the window, soonest first, including those already past validity", async () => {
    const response = await api().get("/api/amc/reports/expiring").query({ days: "90" }).set(admin.headers);

    expect(response.status).toBe(200);

    const data = response.body.data;
    expect(data.items.map((item: { id: string }) => item.id)).toEqual([ids.ended, ids.soon]);
    expect(data.items[0]).toMatchObject({ daysLeft: -5, systemDescription: "ENDED", client: { name: "Expiry Test Client" } });
    expect(data.items[1].daysLeft).toBe(10);
    expect(data.total).toBe(2);
    expect(data.pastValidity).toBe(1);
    expect(data.asOf).toBe(await dayFromToday(0));
  });

  it("widens with the chosen window and never changes a contract's status", async () => {
    const before = await pool.query("SELECT id, status FROM amc_contracts ORDER BY id");
    const wide = (await api().get("/api/amc/reports/expiring").query({ days: "365" }).set(admin.headers)).body.data;
    const after = await pool.query("SELECT id, status FROM amc_contracts ORDER BY id");

    expect(wide.items.map((item: { id: string }) => item.id)).toEqual([ids.ended, ids.soon, ids.later]);
    expect(after.rows).toEqual(before.rows);
  });

  it("validates the window and keeps the contracts permission", async () => {
    expect((await api().get("/api/amc/reports/expiring").query({ days: "-1" }).set(admin.headers)).status).toBe(400);
    expect((await api().get("/api/amc/reports/expiring").query({ days: "999" }).set(admin.headers)).status).toBe(400);
    expect((await api().get("/api/amc/reports/expiring").set(execution.headers)).status).toBe(200);
    expect((await api().get("/api/amc/reports/expiring").set(accountant.headers)).status).toBe(403);
  });
});

describe("GET /api/amc/reports/workload", () => {
  beforeAll(async () => {
    await resetProjectData();
    admin = await signedIn("admin@example.com", ["ADMIN"]);
    execution = await signedIn("execution@example.com", ["EXECUTION"]);
    accountant = await signedIn("procurement@example.com", ["PROCUREMENT"]);

    const clientId = await createClient(admin, "Workload Test Client");
    // One monthly visit per month, from the first day of the current month, for six months.
    const contractId = await activeContract(admin, clientId, {
      validFrom: `${await monthFromNow(0)}-01`,
      validTo: (await pool.query<{ day: string }>("SELECT (date_trunc('month', current_date) + interval '6 months' - interval '1 day')::date::text AS day")).rows[0]?.day,
      maintenanceFrequency: "MONTHLY",
    });
    const first = await pool.query<{ id: string }>("SELECT id FROM amc_visits WHERE amc_contract_id = $1 ORDER BY sequence_no LIMIT 1", [contractId]);
    await completeVisit(admin, first.rows[0]?.id as string).catch(() => undefined);

    // A cancelled contract's visits are not workload.
    const cancelled = await activeContract(admin, clientId, {
      validFrom: `${await monthFromNow(0)}-01`,
      validTo: (await pool.query<{ day: string }>("SELECT (date_trunc('month', current_date) + interval '6 months' - interval '1 day')::date::text AS day")).rows[0]?.day,
      maintenanceFrequency: "MONTHLY",
      systemDescription: "CCTV",
    });
    await api().post(`/api/amc/contracts/${cancelled}/status`).set(admin.headers).send({ status: "CANCELLED" });
  });

  it("counts visits per month from the current month, without cancelled contracts", async () => {
    const response = await api().get("/api/amc/reports/workload").query({ months: "6" }).set(admin.headers);

    expect(response.status).toBe(200);

    const months = response.body.data.months as { month: string; planned: number; completed: number; open: number }[];
    expect(months.map((entry) => entry.month)).toEqual(await Promise.all([0, 1, 2, 3, 4, 5].map(monthFromNow)));
    for (const entry of months) {
      expect(entry.planned).toBe(1);
      expect(entry.completed + entry.open).toBe(1);
    }
  });

  it("covers the requested number of months, within limits", async () => {
    expect((await api().get("/api/amc/reports/workload").query({ months: "3" }).set(admin.headers)).body.data.months).toHaveLength(3);
    expect((await api().get("/api/amc/reports/workload").query({ months: "0" }).set(admin.headers)).status).toBe(400);
    expect((await api().get("/api/amc/reports/workload").query({ months: "25" }).set(admin.headers)).status).toBe(400);
  });

  it("needs the schedule permission", async () => {
    expect((await api().get("/api/amc/reports/workload").set(execution.headers)).status).toBe(200);
    expect((await api().get("/api/amc/reports/workload").set(accountant.headers)).status).toBe(403);
  });
});
