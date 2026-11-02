import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, resetData, signedIn } from "./helpers";

// The page permission modules of migration 0080: each page answers to its own
// module, and the module it used to share no longer opens it. Every request
// goes through the API, as a direct URL or API call would. The lists are empty;
// only who may read and change them matters here.

type Session = Awaited<ReturnType<typeof signedIn>>;

beforeEach(resetData);
afterAll(closePool);

/** A user whose only role holds exactly these permissions. */
async function userWith(permissions: [string, string][]): Promise<Session> {
  const code = `ONLY_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1)", [code]);
  for (const [module, action] of permissions) {
    await pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, $2, $3 FROM roles WHERE code = $1", [code, module, action]);
  }

  return signedIn(`${code.toLowerCase()}@example.com`, [code]);
}

const status = async (session: Session, method: "get" | "post", path: string, body?: object) =>
  (await (method === "get" ? api().get(path) : api().post(path).send(body ?? {})).set(session.headers)).status;

describe("master data lists", () => {
  const LISTS = [
    ["SALES_ENGINEERS", "/api/masters/sales-engineers"],
    ["SYSTEM_TYPES", "/api/masters/system-types"],
    ["MAINTENANCE_FREQUENCIES", "/api/masters/maintenance-frequencies"],
    ["DEPARTMENTS", "/api/masters/departments"],
  ] as const;

  it("opens each list with its own module's view, and none of the unrelated lists", async () => {
    for (const [module, path] of LISTS) {
      const viewer = await userWith([[module, "VIEW"]]);

      expect(await status(viewer, "get", path), `${module} ${path}`).toBe(200);
      expect(await status(viewer, "get", `${path}/export?format=xlsx`), `${module} export without EXPORT`).toBe(403);
      expect(await status(viewer, "post", path, {}), `${module} create without CREATE`).toBe(403);
    }

    const types = await userWith([["SYSTEM_TYPES", "VIEW"]]);
    expect(await status(types, "get", "/api/masters/departments")).toBe(403);
    expect(await status(types, "get", "/api/masters/sales-engineers")).toBe(403);
  });

  it("lets Sales Engineers read departments and Departments read engineers, as their pages need", async () => {
    expect(await status(await userWith([["SALES_ENGINEERS", "VIEW"]]), "get", "/api/masters/departments")).toBe(200);
    expect(await status(await userWith([["DEPARTMENTS", "VIEW"]]), "get", "/api/masters/sales-engineers")).toBe(200);
  });

  it("exports and changes a list only with that module's permission", async () => {
    const manager = await userWith([["DEPARTMENTS", "VIEW"], ["DEPARTMENTS", "EXPORT"], ["DEPARTMENTS", "CREATE"]]);

    expect(await status(manager, "get", "/api/masters/departments/export?format=xlsx")).toBe(200);
    expect(await status(manager, "post", "/api/masters/departments", { code: "FIRE", name: "Fire Safety" })).toBe(201);
    expect(await status(manager, "post", "/api/masters/system-types", { code: "CCTV", name: "CCTV" })).toBe(403);
  });

  it("no longer opens the master lists with Settings permissions, which keep the Settings page", async () => {
    const settings = await userWith([["SETTINGS", "VIEW"], ["SETTINGS", "CREATE"], ["SETTINGS", "EDIT"], ["SETTINGS", "DELETE"], ["SETTINGS", "EXPORT"]]);

    for (const [, path] of LISTS) {
      expect(await status(settings, "get", path), path).toBe(403);
    }
    expect(await status(settings, "post", "/api/masters/departments", { name: "Fire Safety" })).toBe(403);
    expect(await status(settings, "get", "/api/holidays")).toBe(200);
  });

  it("still lets contract users read the lists to pick from, but not change them", async () => {
    const contracts = await userWith([["AMC_CONTRACTS", "VIEW"]]);

    for (const [, path] of LISTS) {
      expect(await status(contracts, "get", `${path}/options`), path).toBe(200);
    }
    expect(await status(contracts, "post", "/api/masters/departments", { name: "Fire Safety" })).toBe(403);
  });
});

describe("AMC Renewal", () => {
  it("opens the renewal queue and history with AMC_RENEWAL, not with AMC_CONTRACTS", async () => {
    const renewal = await userWith([["AMC_RENEWAL", "VIEW"]]);
    const contracts = await userWith([["AMC_CONTRACTS", "VIEW"], ["AMC_CONTRACTS", "EXPORT"]]);

    expect(await status(renewal, "get", "/api/amc/renewals/queue")).toBe(200);
    expect(await status(renewal, "get", "/api/amc/reports/renewals")).toBe(200);
    expect(await status(renewal, "get", "/api/amc/contracts")).toBe(403);
    expect(await status(renewal, "get", "/api/amc/renewals/queue/export?format=xlsx")).toBe(403);

    expect(await status(contracts, "get", "/api/amc/renewals/queue")).toBe(403);
    expect(await status(contracts, "get", "/api/amc/reports/renewals/export?format=xlsx")).toBe(403);
  });

  it("exports with AMC_RENEWAL:EXPORT", async () => {
    const exporter = await userWith([["AMC_RENEWAL", "VIEW"], ["AMC_RENEWAL", "EXPORT"]]);

    expect(await status(exporter, "get", "/api/amc/renewals/queue/export?format=xlsx")).toBe(200);
    expect(await status(exporter, "get", "/api/amc/reports/renewals/export?format=xlsx")).toBe(200);
  });

  it("renews only with AMC_RENEWAL:CREATE; adding contracts alone is not enough", async () => {
    const creator = await userWith([["AMC_CONTRACTS", "VIEW"], ["AMC_CONTRACTS", "CREATE"]]);

    expect(await status(creator, "post", "/api/amc/contracts/1/renewals", {})).toBe(403);

    const renewer = await userWith([["AMC_RENEWAL", "CREATE"]]);
    // Past the permission check: the empty request is refused as invalid, not forbidden.
    expect(await status(renewer, "post", "/api/amc/contracts/1/renewals", {})).toBe(400);
  });
});

describe("Monthly Calendar and Service Status", () => {
  it("opens the calendar's data with MONTHLY_CALENDAR, but not Service Status", async () => {
    const calendar = await userWith([["MONTHLY_CALENDAR", "VIEW"]]);

    expect(await status(calendar, "get", "/api/amc/visits")).toBe(200);
    expect(await status(calendar, "get", "/api/amc/visits/year-summary?year=2026")).toBe(200);
    expect(await status(calendar, "get", "/api/amc/service-status/options")).toBe(200);
    expect(await status(calendar, "get", "/api/amc/service-status")).toBe(403);
    expect(await status(calendar, "get", "/api/amc/visits/export?format=xlsx")).toBe(403);
  });

  it("downloads a month with MONTHLY_CALENDAR:EXPORT, and needs view and export on the same module", async () => {
    expect(await status(await userWith([["MONTHLY_CALENDAR", "VIEW"], ["MONTHLY_CALENDAR", "EXPORT"]]), "get", "/api/amc/visits/export?format=xlsx")).toBe(200);
    expect(await status(await userWith([["AMC_SCHEDULE", "VIEW"], ["MONTHLY_CALENDAR", "EXPORT"]]), "get", "/api/amc/visits/export?format=xlsx")).toBe(403);
  });

  it("opens Service Status with SERVICE_STATUS only, and exports with its EXPORT", async () => {
    const service = await userWith([["SERVICE_STATUS", "VIEW"]]);

    expect(await status(service, "get", "/api/amc/service-status")).toBe(200);
    expect(await status(service, "get", "/api/amc/service-status/options")).toBe(200);
    expect(await status(service, "get", "/api/amc/visits")).toBe(403);
    expect(await status(service, "get", "/api/amc/service-status/export?format=xlsx")).toBe(403);
    expect(await status(await userWith([["SERVICE_STATUS", "VIEW"], ["SERVICE_STATUS", "EXPORT"]]), "get", "/api/amc/service-status/export?format=xlsx")).toBe(200);
  });

  it("keeps the AMC Schedule on AMC_SCHEDULE, which no longer opens Service Status", async () => {
    const schedule = await userWith([["AMC_SCHEDULE", "VIEW"], ["AMC_SCHEDULE", "EXPORT"]]);

    expect(await status(schedule, "get", "/api/amc/visits")).toBe(200);
    expect(await status(schedule, "get", "/api/amc/visits/export?format=xlsx")).toBe(200);
    expect(await status(schedule, "get", "/api/amc/service-status")).toBe(403);
  });

  it("keeps saving a Service Status row on AMC_EXECUTION:EDIT", async () => {
    const viewer = await userWith([["SERVICE_STATUS", "VIEW"]]);

    expect((await api().patch("/api/amc/service-status/1").set(viewer.headers).send({})).status).toBe(403);
  });
});
