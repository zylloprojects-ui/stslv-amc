import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Clients module on a database without migration 0074: the type and VAT
// columns are reported missing (vi.mock is hoisted above the imports), so the module must keep working exactly as
// before and refuse only a value it cannot store.
vi.mock("../src/shared/schema-features", () => ({ schemaHas: async () => false }));


type Session = Awaited<ReturnType<typeof signedIn>>;
let admin: Session;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("clients without migration 0074", () => {
  it("still lists, creates and edits clients, with no type or VAT number", async () => {
    const created = await api().post("/api/clients").set(admin.headers).send({ name: "Older Database Client", phone: "111" });

    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: "Older Database Client", clientType: null, vatNumber: null });

    const edited = await api().patch(`/api/clients/${created.body.data.id}`).set(admin.headers).send({ phone: "222", clientType: null });
    expect(edited.status).toBe(200);
    expect(edited.body.data.phone).toBe("222");

    const list = await api().get("/api/clients").query({ search: "Older", clientType: "COMPANY", sort: "createdAt" }).set(admin.headers);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
  });

  it("says the database update is needed when a type or VAT number is given", async () => {
    const refused = await api().post("/api/clients").set(admin.headers).send({ name: "Needs Update", vatNumber: "VAT-1" });

    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe("FEATURE_UNAVAILABLE");
    expect((await api().get("/api/clients/features").set(admin.headers)).body.data).toEqual({ clientDetails: false });
  });

  it("answers 503 for features of the other pending migrations", async () => {
    expect((await api().get("/api/masters/sales-engineers").set(admin.headers)).status).toBe(503);
    expect((await api().get("/api/amc/contracts").query({ salesEngineerId: "1" }).set(admin.headers)).status).toBe(503);
  });
});
