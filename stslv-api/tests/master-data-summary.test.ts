import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, logsFor, visitsOf } from "./amc-helpers";
import { api, closePool, insertUser, loginToken, bearer, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// Master Data Center: the active-record counts (GET /api/masters/summary) and
// the maintenance frequency master as the Master Data Center uses it
// (migrations 0075 and 0076; the full module is in maintenance-frequencies.test.ts).
// Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let procurement: Session;

// The four standard frequencies are put back as migration 0075 seeds them before
// each test, with no activity left from an earlier test. Contracts refer to the
// codes (migration 0076), so the rows are reset in place rather than truncated;
// the three further 0076 frequencies are removed, as this file counts only the four.
async function restoreFrequencies() {
  await pool.query("DELETE FROM activity_logs WHERE entity_type = 'maintenance_frequencies'");
  await pool.query("DELETE FROM maintenance_frequencies WHERE code NOT IN ('MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY')");
  await pool.query(
    `UPDATE maintenance_frequencies f SET label = v.label, sort_order = v.sort_order, is_active = true, archived_at = NULL
     FROM (VALUES ('MONTHLY', 'Monthly', 1), ('QUARTERLY', 'Quarterly', 2), ('HALF_YEARLY', 'Half-yearly', 3), ('ANNUALLY', 'Annually', 4))
       AS v (code, label, sort_order)
     WHERE f.code = v.code`
  );
}

const summary = async (session: Session) => api().get("/api/masters/summary").set(session.headers);
const countOf = (body: { data: { categories: { key: string; activeCount: number | null }[] } }, key: string) =>
  body.data.categories.find((category) => category.key === key)?.activeCount;

async function frequency(code: string) {
  const list = await api().get("/api/masters/maintenance-frequencies").set(admin.headers);

  return (list.body.data.items as { id: string; code: string; name: string; isActive: boolean }[]).find((item) => item.code === code) as {
    id: string;
    code: string;
    name: string;
    isActive: boolean;
  };
}

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
});
beforeEach(restoreFrequencies);
afterAll(closePool);

describe("master data summary", () => {
  it("counts only active records in each of the five categories", async () => {
    const kept = await createClient(admin, "Summary Client Active");
    const archived = await createClient(admin, "Summary Client Archived");
    await api().post(`/api/clients/${archived}/deactivate`).set(admin.headers).send({});

    await api().post("/api/masters/departments").set(admin.headers).send({ code: "SUM1", name: "Summary One" });
    const department = await api().post("/api/masters/departments").set(admin.headers).send({ code: "SUM2", name: "Summary Two" });
    await api().post(`/api/masters/departments/${department.body.data.id}/status`).set(admin.headers).send({ isActive: false });
    await api().post("/api/masters/system-types").set(admin.headers).send({ code: "SUMST", name: "Summary system" });
    await api().post("/api/masters/sales-engineers").set(admin.headers).send({ name: "Summary Engineer" });
    await api().post(`/api/masters/maintenance-frequencies/${(await frequency("ANNUALLY")).id}/status`).set(admin.headers).send({ status: "disabled" });

    const response = await summary(admin);
    const expected = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table} WHERE is_active`)).rows[0].count);

    expect(response.status).toBe(200);
    expect(response.body.data.categories.map((category: { key: string }) => category.key)).toEqual([
      "clients",
      "sales-engineers",
      "system-types",
      "maintenance-frequencies",
      "departments",
    ]);
    expect(response.body.data.categories.every((category: { available: boolean }) => category.available)).toBe(true);
    expect(countOf(response.body, "clients")).toBe(await expected("clients"));
    expect(countOf(response.body, "departments")).toBe(await expected("departments"));
    expect(countOf(response.body, "system-types")).toBe(await expected("system_types"));
    expect(countOf(response.body, "sales-engineers")).toBe(await expected("sales_engineers"));
    expect(countOf(response.body, "maintenance-frequencies")).toBe(3);
    expect(kept).toBeTruthy();
  });

  it("returns only the categories the user may read", async () => {
    // Procurement may view clients but neither Settings nor AMC contracts.
    const limited = await summary(procurement);
    expect(limited.status).toBe(200);
    expect(limited.body.data.categories.map((category: { key: string }) => category.key)).toEqual(["clients"]);

    // Execution may view clients and AMC contracts, so it may read the lists too.
    expect((await summary(execution)).body.data.categories).toHaveLength(5);
  });

  it("refuses a user who may read none of the categories, and an anonymous request", async () => {
    await insertUser({ email: "nobody@example.com", roles: [] });
    const nobody = { headers: bearer(await loginToken("nobody@example.com")) };

    expect((await api().get("/api/masters/summary").set(nobody.headers)).status).toBe(403);
    expect((await api().get("/api/masters/summary")).status).toBe(401);
  });
});

describe("maintenance frequencies", () => {
  it("lists the four standard frequencies in schedule order, with their rule", async () => {
    const list = await api().get("/api/masters/maintenance-frequencies").set(admin.headers);

    expect(list.status).toBe(200);
    expect(
      list.body.data.items.map((item: { code: string; name: string; serviceCount: number; intervalMonths: number; codePrefix: string; isActive: boolean }) => [
        item.code,
        item.name,
        item.serviceCount,
        item.intervalMonths,
        item.codePrefix,
        item.isActive,
      ])
    ).toEqual([
      ["MONTHLY", "Monthly", 12, 1, "M", true],
      ["QUARTERLY", "Quarterly", 4, 3, "Q", true],
      ["HALF_YEARLY", "Half-yearly", 2, 6, "H", true],
      ["ANNUALLY", "Annually", 1, 12, "A", true],
    ]);
  });

  it("changes the name, records it, and refuses a duplicate name", async () => {
    const quarterly = await frequency("QUARTERLY");
    const edited = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ name: "Every quarter" });

    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ code: "QUARTERLY", name: "Every quarter", label: "Every quarter" });
    expect((await logsFor("maintenance_frequencies", quarterly.id)).map((log) => log.action)).toEqual(["maintenance_frequency.updated"]);

    const duplicate = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ name: " monthly" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details).toEqual([{ field: "name", message: 'A maintenance frequency named "monthly" already exists.' }]);

    const blank = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ name: "  " });
    expect(blank.status).toBe(400);
  });

  it("locks the code of a frequency in use, and has no delete", async () => {
    const client = await createClient(admin, "Frequency Lock Client");
    await activeContract(admin, client, { maintenanceFrequency: "MONTHLY" });
    const monthly = await frequency("MONTHLY");

    const recode = await api().patch(`/api/masters/maintenance-frequencies/${monthly.id}`).set(admin.headers).send({ code: "WEEKLY" });
    expect(recode.status).toBe(409);
    expect((await frequency("MONTHLY")).code).toBe("MONTHLY");

    expect((await api().delete(`/api/masters/maintenance-frequencies/${monthly.id}`).set(admin.headers)).status).toBe(405);
    expect(Number((await pool.query("SELECT count(*) FROM maintenance_frequencies")).rows[0].count)).toBe(4);
  });

  it("offers only active frequencies for picking, and disabling one leaves contracts and their visits unchanged", async () => {
    const client = await createClient(admin, "Frequency History Client");
    const contractId = await activeContract(admin, client, { maintenanceFrequency: "QUARTERLY" });
    const visitsBefore = await visitsOf(contractId);
    const quarterly = await frequency("QUARTERLY");

    // Active contracts use it, so disabling needs confirmation.
    expect((await api().post(`/api/masters/maintenance-frequencies/${quarterly.id}/status`).set(admin.headers).send({ status: "disabled" })).status).toBe(409);
    const off = await api().post(`/api/masters/maintenance-frequencies/${quarterly.id}/status`).set(admin.headers).send({ status: "disabled", confirm: true });
    expect(off.body.data).toMatchObject({ isActive: false, status: "disabled", contractCount: 1, activeContractCount: 1 });

    const renamed = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ name: "Quarterly (old)" });
    expect(renamed.status).toBe(200);

    const options = await api().get("/api/masters/maintenance-frequencies/options").set(execution.headers);
    expect(options.body.data.map((item: { code: string }) => item.code)).toEqual(["MONTHLY", "HALF_YEARLY", "ANNUALLY"]);

    // The disabled frequency stays readable for the contracts that use it.
    expect((await api().get(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(execution.headers)).body.data.name).toBe("Quarterly (old)");

    const contract = await pool.query("SELECT maintenance_frequency FROM amc_contracts WHERE id = $1", [contractId]);
    expect(contract.rows[0].maintenance_frequency).toBe("QUARTERLY");
    expect(await visitsOf(contractId)).toEqual(visitsBefore);

    const back = await api().post(`/api/masters/maintenance-frequencies/${quarterly.id}/status`).set(admin.headers).send({ status: "active" });
    expect(back.body.data.isActive).toBe(true);
    expect((await logsFor("maintenance_frequencies", quarterly.id)).map((log) => log.action)).toEqual([
      "maintenance_frequency.disabled",
      "maintenance_frequency.updated",
      "maintenance_frequency.activated",
    ]);
  });

  it("lets contract viewers read but only Settings editors change a frequency", async () => {
    const monthly = await frequency("MONTHLY");

    expect((await api().get("/api/masters/maintenance-frequencies").set(execution.headers)).status).toBe(200);
    expect((await api().patch(`/api/masters/maintenance-frequencies/${monthly.id}`).set(execution.headers).send({ name: "Each month" })).status).toBe(403);
    expect((await api().post(`/api/masters/maintenance-frequencies/${monthly.id}/status`).set(execution.headers).send({ status: "disabled" })).status).toBe(403);
    expect((await api().get("/api/masters/maintenance-frequencies").set(procurement.headers)).status).toBe(403);
  });
});
