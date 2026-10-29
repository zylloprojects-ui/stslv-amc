import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeContract, createClient, today } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Monthly Calendar shows cancelled visits, so its filter lists include the engineers and frequencies of
// cancelled visits. Service Status keeps its own lists, which leave them out. Every record here is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let procurement: Session;

const options = (path: string, session: Session = admin) => api().get(path).set(session.headers);
const names = (items: { name: string }[]) => items.map((item) => item.name);
const codes = (items: { code: string }[]) => items.map((item) => item.code);

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  const year = Number((await today()).slice(0, 4));
  const client = await createClient(admin, "Calendar Options Hotel");
  const engineer = async (name: string) => (await api().post("/api/masters/sales-engineers").set(admin.headers).send({ name })).body.data.id as string;
  const kept = await engineer("Kept Engineer");
  const cancelled = await engineer("Cancelled Engineer");

  await activeContract(admin, client, { validFrom: `${year + 1}-01-01`, validTo: `${year + 1}-12-31`, maintenanceFrequency: "QUARTERLY", salesEngineerId: kept });
  // Every visit of this contract ends up cancelled.
  const gone = await activeContract(admin, client, {
    systemDescription: "CCTV",
    validFrom: `${year + 1}-01-01`,
    validTo: `${year + 1}-12-31`,
    maintenanceFrequency: "MONTHLY",
    salesEngineerId: cancelled,
  });
  const cancel = await api().post(`/api/amc/contracts/${gone}/status`).set(admin.headers).send({ status: "CANCELLED", cancelOpenVisits: true });
  expect(cancel.status).toBe(200);
});
afterAll(closePool);

describe("GET /api/amc/calendar/options", () => {
  it("includes the engineers and frequencies of cancelled visits, which the calendar shows", async () => {
    const response = await options("/api/amc/calendar/options");

    expect(response.status).toBe(200);
    expect(names(response.body.data.salesEngineers)).toEqual(["Cancelled Engineer", "Kept Engineer"]);
    expect(codes(response.body.data.frequencies)).toEqual(expect.arrayContaining(["MONTHLY", "QUARTERLY"]));
  });

  it("leaves the Service Status lists as they were: cancelled visits are not on that page", async () => {
    const response = await options("/api/amc/service-status/options");

    expect(response.status).toBe(200);
    expect(names(response.body.data.salesEngineers)).toEqual(["Kept Engineer"]);
    expect(codes(response.body.data.frequencies)).toEqual(["QUARTERLY"]);
  });

  it("is for roles that may view the calendar or the schedule", async () => {
    expect((await options("/api/amc/calendar/options", procurement)).status).toBe(403);
  });
});
