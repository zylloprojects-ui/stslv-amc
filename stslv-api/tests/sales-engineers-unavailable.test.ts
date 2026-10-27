import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Sales Engineers module on a database without migrations 0070-0075, as
// stslv_amc_dev is today: every table is reported missing (vi.mock is hoisted
// above the imports). Each engineer route must answer FEATURE_UNAVAILABLE
// instead of failing, and the Master Data Center must still answer.
vi.mock("../src/shared/schema-features", () => ({ schemaHas: async () => false }));

type Session = Awaited<ReturnType<typeof signedIn>>;
let admin: Session;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("sales engineers without migration 0070", () => {
  it.each([
    ["list", "/api/masters/sales-engineers"],
    ["options", "/api/masters/sales-engineers/options"],
    ["user options", "/api/masters/sales-engineers/user-options"],
    ["export", "/api/masters/sales-engineers/export?format=xlsx"],
    ["one engineer", "/api/masters/sales-engineers/1"],
    ["Engineer 360", "/api/masters/sales-engineers/1/summary"],
    ["history", "/api/masters/sales-engineers/1/history"],
  ])("answers 503 FEATURE_UNAVAILABLE for the %s", async (_name, path) => {
    const response = await api().get(path).set(admin.headers);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FEATURE_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toMatch(/stack|relation|sales_engineers/i);
  });

  it("refuses to save, without writing anything", async () => {
    expect((await api().post("/api/masters/sales-engineers").set(admin.headers).send({ name: "Not Saved" })).status).toBe(503);
    expect((await api().post("/api/masters/sales-engineers/1/status").set(admin.headers).send({ isActive: false })).status).toBe(503);
  });

  it("still answers the Master Data Center summary, marking engineers unavailable", async () => {
    const response = await api().get("/api/masters/summary").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.categories).toContainEqual({ key: "sales-engineers", available: false, activeCount: null });
  });
});
