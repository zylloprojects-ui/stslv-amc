import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, logsFor, visitsOf } from "./amc-helpers";
import { api, closePool, insertUser, loginToken, bearer, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// Master Data Center: the active-record counts (GET /api/masters/summary) and
// the maintenance frequency master (migration 0075). Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let procurement: Session;

// Resetting the users cascades to the frequency rows (they name their creator),
// so the four standard rows from migration 0075 are put back before each test,
// with no activity left from an earlier test under a reused id.
async function restoreFrequencies() {
  await pool.query("TRUNCATE maintenance_frequencies RESTART IDENTITY");
  await pool.query("DELETE FROM activity_logs WHERE entity_type = 'maintenance_frequencies'");
  await pool.query(
    `INSERT INTO maintenance_frequencies (code, label, sort_order) VALUES
       ('MONTHLY', 'Monthly', 1), ('QUARTERLY', 'Quarterly', 2), ('HALF_YEARLY', 'Half-yearly', 3), ('ANNUALLY', 'Annually', 4)`
  );
}

const summary = async (session: Session) => api().get("/api/masters/summary").set(session.headers);
const countOf = (body: { data: { categories: { key: string; activeCount: number | null }[] } }, key: string) =>
  body.data.categories.find((category) => category.key === key)?.activeCount;

async function frequency(code: string) {
  const list = await api().get("/api/masters/maintenance-frequencies").set(admin.headers);

  return (list.body.data.items as { id: string; code: string; label: string; isActive: boolean }[]).find((item) => item.code === code) as {
    id: string;
    code: string;
    label: string;
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
    await api().post(`/api/masters/maintenance-frequencies/${(await frequency("ANNUALLY")).id}/status`).set(admin.headers).send({ isActive: false });

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
  it("lists the four fixed frequencies in schedule order, with their interval", async () => {
    const list = await api().get("/api/masters/maintenance-frequencies").set(admin.headers);

    expect(list.status).toBe(200);
    expect(list.body.data.items.map((item: { code: string; label: string; intervalMonths: number; isActive: boolean }) => [item.code, item.label, item.intervalMonths, item.isActive])).toEqual([
      ["MONTHLY", "Monthly", 1, true],
      ["QUARTERLY", "Quarterly", 3, true],
      ["HALF_YEARLY", "Half-yearly", 6, true],
      ["ANNUALLY", "Annually", 12, true],
    ]);
  });

  it("changes only the label, records it, and refuses a duplicate label", async () => {
    const quarterly = await frequency("QUARTERLY");
    const edited = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ label: "Every quarter" });

    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ code: "QUARTERLY", label: "Every quarter" });
    expect((await logsFor("maintenance_frequencies", quarterly.id)).map((log) => log.action)).toEqual(["maintenance_frequency.updated"]);

    const duplicate = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ label: " monthly" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details).toEqual([{ field: "label", message: 'A maintenance frequency labelled "monthly" already exists.' }]);

    const blank = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ label: "  " });
    expect(blank.status).toBe(400);
  });

  it("never changes the code, and has no create or delete", async () => {
    const monthly = await frequency("MONTHLY");

    const recode = await api().patch(`/api/masters/maintenance-frequencies/${monthly.id}`).set(admin.headers).send({ code: "WEEKLY" });
    expect(recode.status).toBe(400);
    expect((await frequency("MONTHLY")).code).toBe("MONTHLY");

    expect((await api().post("/api/masters/maintenance-frequencies").set(admin.headers).send({ code: "WEEKLY", label: "Weekly" })).status).toBe(404);
    expect((await api().delete(`/api/masters/maintenance-frequencies/${monthly.id}`).set(admin.headers)).status).toBe(404);
    expect(Number((await pool.query("SELECT count(*) FROM maintenance_frequencies")).rows[0].count)).toBe(4);
  });

  it("offers only active frequencies for picking, and deactivating one leaves contracts and their visits unchanged", async () => {
    const client = await createClient(admin, "Frequency History Client");
    const contractId = await activeContract(admin, client, { maintenanceFrequency: "QUARTERLY" });
    const visitsBefore = await visitsOf(contractId);
    const quarterly = await frequency("QUARTERLY");

    const off = await api().post(`/api/masters/maintenance-frequencies/${quarterly.id}/status`).set(admin.headers).send({ isActive: false });
    expect(off.body.data).toMatchObject({ isActive: false, contractCount: 1 });

    const relabelled = await api().patch(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(admin.headers).send({ label: "Quarterly (old)" });
    expect(relabelled.status).toBe(200);

    const options = await api().get("/api/masters/maintenance-frequencies/options").set(execution.headers);
    expect(options.body.data.map((item: { code: string }) => item.code)).toEqual(["MONTHLY", "HALF_YEARLY", "ANNUALLY"]);

    // The inactive frequency stays readable for the contracts that use it.
    expect((await api().get(`/api/masters/maintenance-frequencies/${quarterly.id}`).set(execution.headers)).body.data.label).toBe("Quarterly (old)");

    const contract = await pool.query("SELECT maintenance_frequency FROM amc_contracts WHERE id = $1", [contractId]);
    expect(contract.rows[0].maintenance_frequency).toBe("QUARTERLY");
    expect(await visitsOf(contractId)).toEqual(visitsBefore);

    const back = await api().post(`/api/masters/maintenance-frequencies/${quarterly.id}/status`).set(admin.headers).send({ isActive: true });
    expect(back.body.data.isActive).toBe(true);
    expect((await logsFor("maintenance_frequencies", quarterly.id)).map((log) => log.action)).toEqual([
      "maintenance_frequency.deactivated",
      "maintenance_frequency.updated",
      "maintenance_frequency.reactivated",
    ]);
  });

  it("lets contract viewers read but only Settings editors change a frequency", async () => {
    const monthly = await frequency("MONTHLY");

    expect((await api().get("/api/masters/maintenance-frequencies").set(execution.headers)).status).toBe(200);
    expect((await api().patch(`/api/masters/maintenance-frequencies/${monthly.id}`).set(execution.headers).send({ label: "Each month" })).status).toBe(403);
    expect((await api().post(`/api/masters/maintenance-frequencies/${monthly.id}/status`).set(execution.headers).send({ isActive: false })).status).toBe(403);
    expect((await api().get("/api/masters/maintenance-frequencies").set(procurement.headers)).status).toBe(403);
  });
});
