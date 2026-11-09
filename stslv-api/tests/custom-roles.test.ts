import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, bearer, closePool, insertUser, loginToken, permissionsVersion, resetData, signedIn } from "./helpers";

// Custom roles (P2, 2026-11-09): Super Admin adds a role, gives it permissions, assigns it; the
// holder signs in with exactly those permissions. Built-in roles stay protected, and nobody gives
// away more than they hold. Admin's own role management: tests/admin-custom-roles.test.ts.

type Session = { id: string; headers: { Authorization: string } };
let superAdmin: Session;
let admin: Session;
let finance: Session;
let customId: string;

const createRole = (session: Session, body: Record<string, unknown>) => api().post("/api/roles").set(session.headers).send(body);
const setPermissions = async (session: Session, id: string, permissions: { module: string; action: string }[]) =>
  api().put(`/api/roles/${id}/permissions`).set(session.headers).send({ permissions, expectedVersion: await permissionsVersion(id) });
const me = (headers: { Authorization: string }) => api().get("/api/auth/me").set(headers);

beforeAll(async () => {
  await resetData();
  superAdmin = await signedIn("super@custom.example.com", ["ADMIN"]);
  admin = await signedIn("admin@custom.example.com", ["ADMINISTRATOR"]);
  finance = await signedIn("finance@custom.example.com", ["FINANCE_EXECUTIVE"]);
});
afterAll(closePool);

describe("custom roles", () => {
  it("Super Admin adds a role (an executive role may not); it starts with no permissions and is logged", async () => {
    expect((await createRole(finance, { code: "SITE_SUPERVISOR", name: "Site Supervisor" })).status).toBe(403);

    const created = await createRole(superAdmin, { code: "site_supervisor", name: "Site Supervisor", description: "Checks completed services" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: "SITE_SUPERVISOR", builtIn: false, isActive: true, permissions: [], scope: null, userCount: 0 });
    customId = created.body.data.id;

    const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'role.created' AND entity_id = $1", [customId]);
    expect(log.rowCount).toBe(1);
  });

  it("refuses a built-in code, a duplicate code or name, and an invalid code", async () => {
    for (const code of ["ADMIN", "ADMINISTRATOR", "VIEWER", "ACCOUNTANT"]) {
      expect((await createRole(superAdmin, { code, name: `Copy of ${code}` })).status).toBe(409);
    }
    expect((await createRole(superAdmin, { code: "SITE_SUPERVISOR", name: "Another" })).status).toBe(409);
    expect((await createRole(superAdmin, { code: "OTHER_CODE", name: "site supervisor" })).status).toBe(409);
    expect((await createRole(superAdmin, { code: "1BAD", name: "Bad" })).status).toBe(400);
  });

  it("Super Admin sets its permissions (an executive role may not), within the catalog and its dependencies", async () => {
    const wanted = [
      { module: "DASHBOARD", action: "VIEW" },
      { module: "AMC_SCHEDULE", action: "VIEW" },
      { module: "SERVICE_STATUS", action: "VIEW" },
    ];
    expect((await setPermissions(finance, customId, wanted)).status).toBe(403);
    // Export without View is refused, and so is a permission the application does not check.
    expect((await setPermissions(superAdmin, customId, [{ module: "SERVICE_STATUS", action: "EXPORT" }])).status).toBe(400);
    expect((await setPermissions(superAdmin, customId, [{ module: "PROJECTS", action: "DELETE" }])).status).toBe(400);

    const saved = await setPermissions(superAdmin, customId, wanted);
    expect(saved.status).toBe(200);
    expect(saved.body.data.permissions).toHaveLength(3);
  });

  it("refuses a stale save, so two Super Admin sessions never overwrite each other", async () => {
    const stale = await permissionsVersion(customId);
    expect((await setPermissions(superAdmin, customId, [{ module: "DASHBOARD", action: "VIEW" }, { module: "AMC_SCHEDULE", action: "VIEW" }, { module: "SERVICE_STATUS", action: "VIEW" }, { module: "SERVICE_STATUS", action: "EXPORT" }])).status).toBe(200);
    const again = await api()
      .put(`/api/roles/${customId}/permissions`)
      .set(superAdmin.headers)
      .send({ permissions: [{ module: "DASHBOARD", action: "VIEW" }], expectedVersion: stale });
    expect(again.status).toBe(409);
  });

  it("a holder signs in with exactly the role's permissions, and the API enforces them", async () => {
    await insertUser({ email: "supervisor@custom.example.com", roles: ["SITE_SUPERVISOR"] });
    const headers = bearer(await loginToken("supervisor@custom.example.com"));

    const session = await me(headers);
    expect(session.status).toBe(200);
    expect(session.body.data.user.roles.map((role: { code: string }) => role.code)).toEqual(["SITE_SUPERVISOR"]);
    expect(session.body.data.user.permissions).toEqual(["AMC_SCHEDULE:VIEW", "DASHBOARD:VIEW", "SERVICE_STATUS:EXPORT", "SERVICE_STATUS:VIEW"]);

    expect((await api().get("/api/amc/visits").set(headers)).status).toBe(200);
    expect((await api().get("/api/invoices").set(headers)).status).toBe(403);
    expect((await api().get("/api/users").set(headers)).status).toBe(403);
    expect((await api().get("/api/roles").set(headers)).status).toBe(403);
    expect((await createRole({ id: "", headers }, { code: "SELF_MADE", name: "Self made" })).status).toBe(403);

    // A change applies from the holder's next request, without signing in again.
    expect((await setPermissions(superAdmin, customId, [{ module: "DASHBOARD", action: "VIEW" }])).status).toBe(200);
    expect((await api().get("/api/amc/visits").set(headers)).status).toBe(403);
    expect((await me(headers)).body.data.user.permissions).toEqual(["DASHBOARD:VIEW"]);
  });

  it("Admin may assign the custom role only while holding all of its permissions, and never changes its own role", async () => {
    const target = await insertUser({ email: "assignee@custom.example.com", roles: ["VIEWER"] });
    expect((await api().put(`/api/users/${target}/roles`).set(admin.headers).send({ roleIds: [customId] })).status).toBe(200);

    // Give the custom role a permission Admin does not hold (no seeded role but Super Admin holds Reports).
    const roles = (await api().get("/api/roles").set(superAdmin.headers)).body.data.roles as { id: string; code: string; permissions: { module: string; action: string }[] }[];
    const adminGrants = new Set(roles.find((role) => role.code === "ADMINISTRATOR")!.permissions.map((p) => `${p.module}:${p.action}`));
    expect(adminGrants.has("REPORTS:VIEW")).toBe(false);
    expect((await setPermissions(superAdmin, customId, [{ module: "DASHBOARD", action: "VIEW" }, { module: "REPORTS", action: "VIEW" }])).status).toBe(200);

    const other = await insertUser({ email: "assignee2@custom.example.com", roles: ["VIEWER"] });
    expect((await api().put(`/api/users/${other}/roles`).set(admin.headers).send({ roleIds: [customId] })).status).toBe(403);
    expect((await api().get("/api/roles").set(admin.headers)).body.data.roles.find((role: { id: string }) => role.id === customId).assignable).toBe(false);
    // Changing one's own role is refused (409, "You cannot change your own role").
    expect((await api().put(`/api/users/${admin.id}/roles`).set(admin.headers).send({ roleIds: [customId] })).status).toBe(409);
  });

  it("protects built-in roles: never deleted, and only Super Admin renames or deactivates them", async () => {
    const roles = (await api().get("/api/roles").set(superAdmin.headers)).body.data.roles as { id: string; code: string; builtIn: boolean }[];
    for (const role of roles.filter((item) => item.builtIn)) {
      expect((await api().delete(`/api/roles/${role.id}`).set(superAdmin.headers)).status, role.code).toBe(403);
    }
    const viewer = roles.find((role) => role.code === "VIEWER")!;
    expect((await api().patch(`/api/roles/${viewer.id}`).set(admin.headers).send({ name: "Readers" })).status).toBe(403);
    const superRole = roles.find((role) => role.code === "ADMIN")!;
    expect((await api().patch(`/api/roles/${superRole.id}`).set(superAdmin.headers).send({ isActive: false })).status).toBe(403);
    expect((await setPermissions(superAdmin, superRole.id, [])).status).toBe(403);
  });

  it("is renamed by Super Admin, cannot be deactivated or deleted while held, and is deleted once unused", async () => {
    const renamed = await api().patch(`/api/roles/${customId}`).set(superAdmin.headers).send({ name: "Site Inspector" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ code: "SITE_SUPERVISOR", name: "Site Inspector" });

    expect((await api().patch(`/api/roles/${customId}`).set(superAdmin.headers).send({ isActive: false })).status).toBe(409);
    expect((await api().delete(`/api/roles/${customId}`).set(superAdmin.headers)).status).toBe(409);

    await pool.query("UPDATE user_roles SET role_id = (SELECT id FROM roles WHERE code = 'VIEWER') WHERE role_id = $1", [customId]);
    expect((await api().delete(`/api/roles/${customId}`).set(admin.headers)).status).toBe(403);
    expect((await api().delete(`/api/roles/${customId}`).set(superAdmin.headers)).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM role_permissions WHERE role_id = $1", [customId])).rowCount).toBe(0);
  });
});
