import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { grant } from "./amc-helpers";
import { api, closePool, insertUser, PASSWORD, resetData, signedIn } from "./helpers";

// Login History and the Activity Log (read-only views over activity_logs).
// Every record here is invented test data.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let manager: Session;
let execution: Session;
let staffId: string;

const logins = (query: Record<string, string> = {}, session: Session = admin) =>
  api().get("/api/audit/logins").query(query).set(session.headers);
const activity = (query: Record<string, string> = {}, session: Session = admin) =>
  api().get("/api/audit/activity").query(query).set(session.headers);

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  // A user manager who is not an Admin: may see sign-ins, not the full activity log.
  await grant("ACCOUNTANT", [["USERS", "VIEW"]]);
  manager = await signedIn("manager@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  staffId = await insertUser({ email: "staff@example.com", fullName: "Staff Member", roles: ["EXECUTION"] });

  await api().post("/api/auth/login").send({ email: "staff@example.com", password: PASSWORD });
  await api().post("/api/auth/login").send({ email: "staff@example.com", password: "Wrong-Password-1" });
  await api().post("/api/auth/login").send({ email: "nobody@example.com", password: "Secret-Typed-9" });
  await api().post("/api/clients").set(admin.headers).send({ name: "Audit Test Client", clientType: "COMPANY" });
});
afterAll(closePool);

describe("GET /api/audit/logins", () => {
  it("lists successful and failed sign-ins, newest first, with user, address and outcome", async () => {
    const response = await logins();

    expect(response.status).toBe(200);

    const items = response.body.data.items as Record<string, unknown>[];
    const forStaff = items.filter((item) => (item.user as { id: string } | null)?.id === staffId);

    expect(forStaff.map((item) => item.outcome)).toEqual(["FAILED", "SUCCESS"]);
    expect(forStaff[0]).toMatchObject({ reason: "wrong_password", user: { fullName: "Staff Member", email: "staff@example.com" } });
    expect(forStaff[1]).toMatchObject({ reason: null });
    for (const item of forStaff) {
      expect(item.ip).toEqual(expect.any(String));
      expect(Object.keys(item).sort()).toEqual(["createdAt", "id", "ip", "outcome", "reason", "user"]);
    }

    const unknown = items.find((item) => item.reason === "unknown_account");
    expect(unknown?.user).toBeNull();
    expect(response.body.data.failedTotal).toBe(2);
  });

  it("never returns a password or the email typed for an unknown account", async () => {
    const text = JSON.stringify((await logins()).body);

    expect(text).not.toContain("Wrong-Password-1");
    expect(text).not.toContain("Secret-Typed-9");
    expect(text).not.toContain("nobody@example.com");
    expect(text).not.toContain(PASSWORD);
  });

  it("filters by outcome, user, search and date", async () => {
    const failed = (await logins({ outcome: "FAILED" })).body.data;
    expect(failed.items.every((item: { outcome: string }) => item.outcome === "FAILED")).toBe(true);
    expect(failed.total).toBe(2);

    const staff = (await logins({ userId: staffId })).body.data;
    expect(staff.total).toBe(2);

    const searched = (await logins({ search: "staff member" })).body.data;
    expect(searched.total).toBe(2);

    expect((await logins({ from: "2999-01-01" })).body.data.total).toBe(0);
    expect((await logins({ from: "1999-01-01", to: "2999-12-31" })).body.data.total).toBeGreaterThanOrEqual(5);
    expect((await logins({ from: "31-12-2026" })).status).toBe(400);
  });

  it("pages the results", async () => {
    const first = (await logins({ pageSize: "1" })).body.data;
    const second = (await logins({ pageSize: "1", page: "2" })).body.data;

    expect(first.items).toHaveLength(1);
    expect(first.items[0].id).not.toBe(second.items[0].id);
  });

  it("is open to user managers and refused to other roles", async () => {
    expect((await logins({}, manager)).status).toBe(200);
    expect((await logins({}, execution)).status).toBe(403);
    expect((await api().get("/api/audit/logins")).status).toBe(401);
  });
});

describe("GET /api/audit/activity", () => {
  it("lists every module's entries with the user, and only the readable details", async () => {
    const response = await activity();

    expect(response.status).toBe(200);

    const items = response.body.data.items as Record<string, unknown>[];
    const created = items.find((item) => item.action === "client.created");

    expect(created).toMatchObject({ module: "CLIENTS", entityType: "clients", user: { id: admin.id } });
    expect(Object.keys(created ?? {}).sort()).toEqual(
      ["action", "changes", "createdAt", "description", "entityId", "entityType", "id", "module", "reason", "user"].sort()
    );
    expect(JSON.stringify(items)).not.toContain('"metadata"');
    expect(JSON.stringify(items)).not.toContain("Wrong-Password-1");
  });

  it("filters by module, record and search", async () => {
    const clients = (await activity({ module: "CLIENTS" })).body.data;
    expect(clients.total).toBeGreaterThan(0);
    expect(clients.items.every((item: { module: string }) => item.module === "CLIENTS")).toBe(true);

    const clientId = clients.items[0].entityId as string;
    const record = (await activity({ entityType: "clients", entityId: clientId })).body.data;
    expect(record.items.every((item: { entityId: string }) => item.entityId === clientId)).toBe(true);

    expect((await activity({ search: "Audit Test Client" })).body.data.total).toBeGreaterThan(0);
    expect((await activity({ module: "drop table" })).status).toBe(400);
  });

  it("offers the modules, record types and users that occur in the log", async () => {
    const options = (await api().get("/api/audit/activity/options").set(admin.headers)).body.data;

    expect(options.modules).toEqual(expect.arrayContaining(["AUTH", "CLIENTS"]));
    expect(options.entityTypes).toEqual(expect.arrayContaining(["clients", "users"]));
    expect(options.users).toEqual(expect.arrayContaining([{ id: admin.id, fullName: "admin@example.com", email: "admin@example.com" }]));
  });

  it("is reserved to the Admin role, even for a user manager", async () => {
    expect((await activity({}, manager)).status).toBe(403);
    expect((await api().get("/api/audit/activity/options").set(manager.headers)).status).toBe(403);
    expect((await activity({}, execution)).status).toBe(403);
  });

  it("does not change the stored log", async () => {
    const before = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM activity_logs");
    await activity();
    await logins();
    const after = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM activity_logs");

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
