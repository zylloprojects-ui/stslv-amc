import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, bearer, closePool, insertUser, loginToken, permissionsVersion, resetData, roleId, signedIn } from "./helpers";

// Final integration (2026-11-09): paths that exist only once P0 (server-side sessions, append-only Audit Log),
// P1 (Service Report No. lock and override) and P2 (custom roles managed by Super Admin and Admin) are combined.
//
// The central case: a CUSTOM role given exactly Admin's permissions is still not Admin. Powers reserved to the
// Super Admin and Admin ROLES — ending other people's sessions, overriding a locked Service Report No., managing
// roles — must not follow from permissions alone, or Admin could mint a second "Admin" and escalate through it.

type Grant = { module: string; action: string };

let superAdmin: Session;
let admin: Session;
let twin: Session;
let twinRoleId: string;
let clientId: string;

const grantsOf = async (code: string) =>
  (await pool.query<Grant>("SELECT rp.module, rp.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1 ORDER BY 1, 2", [code])).rows;
const setPermissions = async (session: Session, id: string, permissions: Grant[]) =>
  api().put(`/api/roles/${id}/permissions`).set(session.headers).send({ permissions, expectedVersion: await permissionsVersion(id) });
const sessionIdOf = (token: string) => (jwt.decode(token) as { sid?: string }).sid as string;

beforeAll(async () => {
  await resetData();
  superAdmin = await signedIn("super@integration.example.com", ["ADMIN"]);
  admin = await signedIn("admin@integration.example.com", ["ADMINISTRATOR"]);

  // Super Admin builds the "twin": a custom role with every permission Admin holds (Users & Access included).
  const created = await api().post("/api/roles").set(superAdmin.headers).send({ code: "ADMIN_TWIN", name: "Admin Twin" });
  expect(created.status).toBe(201);
  twinRoleId = created.body.data.id;
  expect((await setPermissions(superAdmin, twinRoleId, await grantsOf("ADMINISTRATOR"))).status).toBe(200);
  expect(await grantsOf("ADMIN_TWIN")).toEqual(await grantsOf("ADMINISTRATOR"));
  twin = await signedIn("twin@integration.example.com", ["ADMIN_TWIN"]);

  clientId = await createClient(superAdmin, "Integration Tower");
});
afterAll(async () => {
  delete process.env.SERVICE_REPORT_NO_LOCK_ENABLED;
  await closePool();
});

describe("a custom role with Admin's permissions is not Admin (P0 x P1 x P2)", () => {
  it("cannot manage roles, though it holds Users & Access Edit", async () => {
    expect((await api().get("/api/roles").set(twin.headers)).body.data.canManageRoles).toBe(false);
    expect((await api().post("/api/roles").set(twin.headers).send({ code: "TWIN_MADE", name: "Twin made" })).status).toBe(403);
    expect((await setPermissions(twin, twinRoleId, [])).status).toBe(403);
    expect(await grantsOf("ADMIN_TWIN")).toEqual(await grantsOf("ADMINISTRATOR"));
  });

  it("cannot list or end other users' sessions", async () => {
    const victim = await signedIn("victim@integration.example.com", ["VIEWER"]);
    expect((await api().get(`/api/users/${victim.id}/sessions`).set(twin.headers)).status).toBe(403);
    expect((await api().post(`/api/users/${victim.id}/sessions/revoke`).set(twin.headers)).status).toBe(403);
    expect((await api().get("/api/security/sessions").set(twin.headers)).status).toBe(403);
    // The victim's session is still valid.
    expect((await api().get("/api/auth/me").set(victim.headers)).status).toBe(200);
  });

  it("cannot override a locked Service Report No.; Admin can, and the override is audited", async () => {
    const now = await today();
    const contract = await activeContract(superAdmin, clientId, { systemDescription: "TWIN-LOCK", validFrom: now, validTo: `${Number(now.slice(0, 4)) + 1}${now.slice(4)}`, maintenanceFrequency: "QUARTERLY" });
    const [visit] = await visitsOf(contract);
    const id = visit!.id;
    await withServiceReport(id);
    expect((await api().patch(`/api/amc/execution/visits/${id}`).set(superAdmin.headers).send({ status: "COMPLETED", completedDate: now })).status).toBe(200);
    const updatedAt = async () => (await api().get(`/api/amc/visits/${id}`).set(superAdmin.headers)).body.data.updatedAt as string;
    expect((await api().patch(`/api/amc/visits/${id}/manual-invoice`).set(superAdmin.headers).send({ invoiceNo: "INT-PAID-1", expectedUpdatedAt: await updatedAt() })).status).toBe(200);

    process.env.SERVICE_REPORT_NO_LOCK_ENABLED = "true";
    const statusUpdatedAt = async () => (await api().get(`/api/amc/service-status/${id}`).set(superAdmin.headers)).body.data.updatedAt as string;
    const save = async (session: Session, reason?: string) =>
      api()
        .patch(`/api/amc/service-status/${id}`)
        .set(session.headers)
        .send({ reportNumber: `SR-${session === admin ? "ADMIN" : "TWIN"}`, ...(reason ? { reportNumberOverrideReason: reason } : {}), expectedUpdatedAt: await statusUpdatedAt() });

    expect((await api().get(`/api/amc/service-status/${id}`).set(twin.headers)).body.data).toMatchObject({ paid: true, reportNumberLocked: true });
    expect((await save(twin, "Twin wants to change it")).status).toBe(403);
    expect((await save(admin, "Admin corrected the number")).status).toBe(200);

    const log = await pool.query<{ id: string; action: string; user_id: string }>(
      "SELECT id::text, action, user_id::text FROM activity_logs WHERE entity_type = 'amc_visits' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
      [id]
    );
    expect(log.rows[0]).toMatchObject({ action: "amc_visit.service_report_no_override", user_id: admin.id });

    // 0109: the override record cannot be altered or removed afterwards.
    await expect(pool.query("UPDATE activity_logs SET description = 'tampered' WHERE id = $1", [log.rows[0]!.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM activity_logs WHERE id = $1", [log.rows[0]!.id])).rejects.toThrow(/append-only/);
  });
});

describe("custom roles meet server-side sessions (P0 x P2)", () => {
  it("Admin assigns its custom role, ends the holder's session, and the holder's token stops working at once", async () => {
    const custom = await api().post("/api/roles").set(admin.headers).send({ code: "SITE_TEAM", name: "Site Team" });
    expect(custom.status).toBe(201);
    expect((await setPermissions(admin, custom.body.data.id, [{ module: "DASHBOARD", action: "VIEW" }])).status).toBe(200);

    const holder = await insertUser({ email: "site@integration.example.com", roles: ["VIEWER"] });
    expect((await api().put(`/api/users/${holder}/roles`).set(admin.headers).send({ roleIds: [custom.body.data.id] })).status).toBe(200);
    const token = await loginToken("site@integration.example.com");
    expect((await api().get("/api/auth/me").set(bearer(token))).body.data.user.permissions).toEqual(["DASHBOARD:VIEW"]);

    const sessions = (await api().get(`/api/users/${holder}/sessions`).set(admin.headers)).body.data as { id: string }[];
    expect(sessions.map((session) => session.id)).toContain(sessionIdOf(token));
    expect((await api().delete(`/api/users/${holder}/sessions/${sessionIdOf(token)}`).set(admin.headers)).status).toBe(200);

    const refused = await api().get("/api/auth/me").set(bearer(token));
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("SESSION_REVOKED");
  });

  it("Admin cannot end a Super Admin's sessions, nor promote anyone through a custom role", async () => {
    expect((await api().post(`/api/users/${superAdmin.id}/sessions/revoke`).set(admin.headers)).status).toBe(403);
    expect((await api().get("/api/auth/me").set(superAdmin.headers)).status).toBe(200);

    // A custom role never carries Users & Access when Admin builds it, so it cannot become a back door.
    const custom = await api().post("/api/roles").set(admin.headers).send({ code: "BACK_DOOR", name: "Back Door" });
    const refused = await setPermissions(admin, custom.body.data.id, [{ module: "USERS", action: "VIEW" }, { module: "USERS", action: "EDIT" }]);
    expect(refused.status).toBe(403);
    expect(await grantsOf("BACK_DOOR")).toEqual([]);
    expect((await api().put(`/api/users/${admin.id}/roles`).set(admin.headers).send({ roleIds: [await roleId("ADMIN")] })).status).toBe(409);
  });

  it("role-management actions are audited and the entries are append-only", async () => {
    const entries = await pool.query<{ id: string }>("SELECT id::text FROM activity_logs WHERE entity_type = 'roles' AND user_id = $1 ORDER BY id", [admin.id]);
    expect(entries.rows.length).toBeGreaterThanOrEqual(3);
    await expect(pool.query("UPDATE activity_logs SET user_id = NULL WHERE id = $1", [entries.rows[0]!.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("TRUNCATE activity_logs")).rejects.toThrow(/append-only/);
  });
});
