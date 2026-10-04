import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, resetData, signedIn } from "./helpers";

let admin: Awaited<ReturnType<typeof signedIn>>;

const NATIONAL_DAY = { date: "2026-11-18", name: "National Day", isReligious: false, countries: ["OMAN"], divisions: "All divisions" };

beforeAll(async () => {
  await resetData();
  await pool.query("DELETE FROM app_settings WHERE key = 'organization.holidays'");
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("holiday calendar", () => {
  it("starts empty and lists the countries that can be chosen", async () => {
    const response = await api().get("/api/holidays").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.holidays).toEqual([]);
    expect(response.body.data.countries).toEqual(["OMAN", "QATAR", "BAHRAIN", "KSA", "UAE", "KUWAIT"]);
  });

  it("adds a holiday, keeps the list in date order and logs it", async () => {
    const eid = await api().post("/api/holidays").set(admin.headers).send({ date: "2027-03-10", name: "Eid al-Fitr", isReligious: true, countries: ["OMAN", "UAE", "QATAR"] });
    const national = await api().post("/api/holidays").set(admin.headers).send(NATIONAL_DAY);

    expect(eid.status).toBe(201);
    expect(eid.body.data).toMatchObject({ date: "2027-03-10", name: "Eid al-Fitr", isReligious: true, countries: ["OMAN", "UAE", "QATAR"], divisions: null });
    expect(national.status).toBe(201);

    const list = (await api().get("/api/holidays").set(admin.headers)).body.data.holidays;

    expect(list.map((holiday: { name: string }) => holiday.name)).toEqual(["National Day", "Eid al-Fitr"]);
    const log = await pool.query("SELECT user_id FROM activity_logs WHERE action = 'holiday.created'");
    expect(log.rowCount).toBe(2);
  });

  it("rejects bad input and the same holiday twice on one date", async () => {
    const post = (body: object) => api().post("/api/holidays").set(admin.headers).send(body);

    expect((await post({ ...NATIONAL_DAY })).status).toBe(409);
    expect((await post({ ...NATIONAL_DAY, name: "A", date: "2026-02-30" })).status).toBe(400);
    expect((await post({ ...NATIONAL_DAY, name: "A", date: "18-11-2026" })).status).toBe(400);
    expect((await post({ ...NATIONAL_DAY, name: "  " })).status).toBe(400);
    expect((await post({ ...NATIONAL_DAY, name: "B", countries: [] })).status).toBe(400);
    expect((await post({ ...NATIONAL_DAY, name: "C", countries: ["MARS"] })).status).toBe(400);
    expect((await post({ ...NATIONAL_DAY, name: "D", extra: true })).status).toBe(400);
  });

  it("edits a holiday, and refuses an unknown one", async () => {
    const list = (await api().get("/api/holidays").set(admin.headers)).body.data.holidays;
    const id = list.find((holiday: { name: string }) => holiday.name === "National Day").id;

    const response = await api().put(`/api/holidays/${id}`).set(admin.headers).send({ ...NATIONAL_DAY, date: "2026-11-19", countries: ["OMAN", "KSA"], divisions: "" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id, date: "2026-11-19", countries: ["OMAN", "KSA"], divisions: null });
    expect((await api().put("/api/holidays/00000000-0000-4000-8000-000000000000").set(admin.headers).send(NATIONAL_DAY)).status).toBe(404);
    expect((await api().put("/api/holidays/not-an-id").set(admin.headers).send(NATIONAL_DAY)).status).toBe(400);
  });

  it("deletes a holiday and logs it", async () => {
    const list = (await api().get("/api/holidays").set(admin.headers)).body.data.holidays;
    const id = list.find((holiday: { name: string }) => holiday.name === "Eid al-Fitr").id;

    expect((await api().delete(`/api/holidays/${id}`).set(admin.headers)).status).toBe(200);
    expect((await api().delete(`/api/holidays/${id}`).set(admin.headers)).status).toBe(404);
    expect((await api().get("/api/holidays").set(admin.headers)).body.data.holidays).toHaveLength(1);
    expect((await pool.query("SELECT 1 FROM activity_logs WHERE action = 'holiday.deleted'")).rowCount).toBe(1);
  });

  it("is limited to people who hold the matching Settings permission", async () => {
    const accountant = await signedIn("acc@example.com", ["ACCOUNTANT"]);

    expect((await api().get("/api/holidays").set(accountant.headers)).status).toBe(403);
    expect((await api().post("/api/holidays").set(accountant.headers).send(NATIONAL_DAY)).status).toBe(403);
    expect((await api().get("/api/holidays")).status).toBe(401);
  });
});
