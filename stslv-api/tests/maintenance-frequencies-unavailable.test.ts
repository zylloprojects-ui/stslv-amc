import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "../src/config/database";
import { createClient, createContract } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Maintenance frequencies on a database without migration 0076 (the 0076
// columns and table are reported missing; vi.mock is hoisted above the
// imports). The frequency module answers that a database update is needed, and
// AMC contracts keep working on the four built-in frequencies, as before 0076.
// Every record is invented.
const FROM_0076 = ["maintenance_frequencies.code_prefix", "maintenance_frequencies.archived_at", "amc_contract_custom_months", "amc_visits.service_code"];

vi.mock("../src/shared/schema-features", () => ({
  schemaHas: async (items: readonly string[]) => !items.some((item) => FROM_0076.includes(item)),
}));

type Session = Awaited<ReturnType<typeof signedIn>>;
let admin: Session;
let clientId: string;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await createClient(admin, "Before 0076 Client");
});
afterAll(closePool);

describe("maintenance frequencies before migration 0076", () => {
  it("answers FEATURE_UNAVAILABLE with a database-update message on every frequency route", async () => {
    for (const path of ["", "/options", "/export?format=xlsx", "/1", "/1/contracts"]) {
      const response = await api().get(`/api/masters/maintenance-frequencies${path}`).set(admin.headers);

      expect(response.status, path).toBe(503);
      expect(response.body.error).toMatchObject({ code: "FEATURE_UNAVAILABLE", message: "This feature needs a database update that has not been applied yet." });
    }
    expect((await api().post("/api/masters/maintenance-frequencies").set(admin.headers).send({})).status).toBe(503);
  });

  it("keeps the Master Data Center summary and the other lists working", async () => {
    const summary = await api().get("/api/masters/summary").set(admin.headers);

    expect(summary.status).toBe(200);
    expect((await api().get("/api/masters/system-types").set(admin.headers)).status).toBe(200);
    expect((await api().get("/api/masters/departments").set(admin.headers)).status).toBe(200);
    expect((await api().get("/api/masters/sales-engineers").set(admin.headers)).status).toBe(200);
  });
});

describe("AMC contracts before migration 0076", () => {
  it("schedule the four built-in frequencies as before, with no service labels", async () => {
    const created = await createContract(admin, clientId, { status: "ACTIVE" });

    expect(created.status).toBe(201);
    expect(created.body.data.customMonths).toEqual([]);
    const visits = await pool.query("SELECT cycle_no, service_code FROM amc_visits WHERE amc_contract_id = $1 ORDER BY period_start", [created.body.data.id]);
    expect(visits.rows).toEqual([
      { cycle_no: null, service_code: null },
      { cycle_no: null, service_code: null },
      { cycle_no: null, service_code: null },
      { cycle_no: null, service_code: null },
    ]);
  });

  it("refuse the frequencies and custom months that need the update", async () => {
    const newCode = await createContract(admin, clientId, { maintenanceFrequency: "BI_MONTHLY" });
    expect(newCode.status).toBe(400);
    expect(newCode.body.error.details[0].field).toBe("maintenanceFrequency");

    const months = await createContract(admin, clientId, { customMonths: [2, 8] });
    expect(months.status).toBe(400);
    expect(months.body.error.details[0].field).toBe("customMonths");
  });
});
