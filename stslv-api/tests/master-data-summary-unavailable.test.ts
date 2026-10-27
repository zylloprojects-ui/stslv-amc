import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Master Data Center on a database that has migration 0070 but not 0075:
// the maintenance frequencies table is reported missing (vi.mock is hoisted
// above the imports). The summary must say so instead of reporting zero, and
// the other lists must keep working.
vi.mock("../src/shared/schema-features", () => ({
  schemaHas: async (items: readonly string[]) => !items.includes("maintenance_frequencies"),
}));

type Session = Awaited<ReturnType<typeof signedIn>>;
let admin: Session;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("master data summary before migration 0075", () => {
  it("marks maintenance frequencies as unavailable, with no count", async () => {
    const response = await api().get("/api/masters/summary").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.categories.find((category: { key: string }) => category.key === "maintenance-frequencies")).toEqual({
      key: "maintenance-frequencies",
      available: false,
      activeCount: null,
    });
    expect(response.body.data.categories.find((category: { key: string }) => category.key === "departments")).toMatchObject({ available: true, activeCount: 0 });
  });

  it("answers FEATURE_UNAVAILABLE for the frequency list only", async () => {
    const frequencies = await api().get("/api/masters/maintenance-frequencies").set(admin.headers);

    expect(frequencies.status).toBe(503);
    expect(frequencies.body.error.code).toBe("FEATURE_UNAVAILABLE");
    expect((await api().get("/api/masters/departments").set(admin.headers)).status).toBe(200);
  });
});
