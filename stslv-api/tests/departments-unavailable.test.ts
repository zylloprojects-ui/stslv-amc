import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Departments module on a database without migration 0070, as stslv_amc_dev
// is today: every table is reported missing (vi.mock is hoisted above the
// imports). Each department route must answer FEATURE_UNAVAILABLE instead of
// failing, and the Master Data Center must still answer.
vi.mock("../src/shared/schema-features", () => ({ schemaHas: async () => false }));

type Session = Awaited<ReturnType<typeof signedIn>>;
let admin: Session;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("departments without migration 0070", () => {
  it.each([
    ["list", "/api/masters/departments"],
    ["options", "/api/masters/departments/options"],
    ["export", "/api/masters/departments/export?format=xlsx"],
    ["one department", "/api/masters/departments/1"],
    ["history", "/api/masters/departments/1/history"],
  ])("answers 503 FEATURE_UNAVAILABLE for the %s", async (_name, path) => {
    const response = await api().get(path).set(admin.headers);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FEATURE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toMatch(/stack|relation|departments_/i);
  });

  it("refuses to save, without writing anything", async () => {
    expect((await api().post("/api/masters/departments").set(admin.headers).send({ code: "AMC", name: "AMC" })).status).toBe(503);
    expect((await api().patch("/api/masters/departments/1").set(admin.headers).send({ name: "AMC" })).status).toBe(503);
    expect((await api().post("/api/masters/departments/1/status").set(admin.headers).send({ isActive: false })).status).toBe(503);
  });

  it("still answers the Master Data Center summary, marking departments unavailable", async () => {
    const response = await api().get("/api/masters/summary").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.categories).toContainEqual({ key: "departments", available: false, activeCount: null });
  });
});
