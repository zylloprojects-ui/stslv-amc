import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, bearer, closePool, insertUser, loginToken, permissionsVersion, resetData, roleId, signedIn } from "./helpers";

// Approved 2026-11-09: Super Admin AND Admin manage custom roles and assign them to users. Admin is held to:
//   - custom roles only: built-in roles (Super Admin, Admin, the executive roles, Viewer, the legacy roles) and their
//     permissions stay with Super Admin;
//   - its own authority: nothing it does not hold may be granted, revoked or assigned, and a role reaching beyond
//     Admin's permissions (set up by Super Admin) cannot be changed by Admin at all;
//   - no promotion: Admin never obtains Super Admin, never changes its own role, never gives a role Users & Access;
//   - Users & Access Edit: Super Admin removing it from Admin takes role management away.
// Every rule is enforced by the API; the web only shows what the API allows.

type Session = { id: string; headers: { Authorization: string } };
type Grant = { module: string; action: string };
type ListedRole = { id: string; code: string; manageable: boolean; manageReason: string | null; permissionsEditable: boolean; lockedReason: string | null; assignable: boolean };

let superAdmin: Session;
let admin: Session;
let finance: Session;

const ROLE_ADMINISTRATORS_ONLY = "Only Super Admin, and Admin with Users & Access Edit, can change roles and their permissions.";
const BUILT_IN = "Only Super Admin can change a built-in role or its permissions.";
const BEYOND = "This role grants permissions you do not hold. Only Super Admin can change it.";

const createRole = (session: Session, body: Record<string, unknown>) => api().post("/api/roles").set(session.headers).send(body);
const updateRole = (session: Session, id: string, body: Record<string, unknown>) => api().patch(`/api/roles/${id}`).set(session.headers).send(body);
const deleteRole = (session: Session, id: string) => api().delete(`/api/roles/${id}`).set(session.headers);
const setPermissions = async (session: Session, id: string, permissions: Grant[]) =>
  api().put(`/api/roles/${id}/permissions`).set(session.headers).send({ permissions, expectedVersion: await permissionsVersion(id) });
const assignRole = (session: Session, userId: string, id: string) => api().put(`/api/users/${userId}/roles`).set(session.headers).send({ roleIds: [id] });
const listed = async (session: Session) => {
  const response = await api().get("/api/roles").set(session.headers);
  return { canManageRoles: response.body.data.canManageRoles as boolean, roles: response.body.data.roles as ListedRole[] };
};
const grantsOf = async (code: string) =>
  (await pool.query<Grant>("SELECT rp.module, rp.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1 ORDER BY 1, 2", [code])).rows;
const keys = (grants: Grant[]) => grants.map((grant) => `${grant.module}:${grant.action}`).sort();

const VIEWS: Grant[] = [
  { module: "DASHBOARD", action: "VIEW" },
  { module: "AMC_SCHEDULE", action: "VIEW" },
  { module: "SERVICE_STATUS", action: "VIEW" },
];

beforeAll(async () => {
  await resetData();
  superAdmin = await signedIn("super@admin-roles.example.com", ["ADMIN"]);
  admin = await signedIn("admin@admin-roles.example.com", ["ADMINISTRATOR"]);
  finance = await signedIn("finance@admin-roles.example.com", ["FINANCE_EXECUTIVE"]);
});
afterAll(closePool);

describe("Admin manages custom roles", () => {
  it("adds, configures, renames, deactivates, reactivates and deletes a custom role, each change logged as Admin", async () => {
    expect((await listed(admin)).canManageRoles).toBe(true);

    const created = await createRole(admin, { code: "WORKSHOP", name: "Workshop", description: "Workshop staff" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ code: "WORKSHOP", builtIn: false, permissions: [], manageable: true, permissionsEditable: true });
    const id = created.body.data.id as string;

    const configured = await setPermissions(admin, id, VIEWS);
    expect(configured.status).toBe(200);
    expect(keys(configured.body.data.permissions)).toEqual(["AMC_SCHEDULE:VIEW", "DASHBOARD:VIEW", "SERVICE_STATUS:VIEW"]);

    expect((await updateRole(admin, id, { name: "Workshop Team" })).status).toBe(200);
    expect((await updateRole(admin, id, { isActive: false })).status).toBe(200);
    expect((await updateRole(admin, id, { isActive: true })).status).toBe(200);
    expect((await deleteRole(admin, id)).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM roles WHERE id = $1", [id])).rowCount).toBe(0);

    const log = await pool.query<{ action: string }>(
      "SELECT action FROM activity_logs WHERE entity_type = 'roles' AND entity_id = $1 AND user_id = $2 ORDER BY id",
      [id, admin.id]
    );
    expect(log.rows.map((row) => row.action)).toEqual(["role.created", "role.permissions_changed", "role.updated", "role.updated", "role.updated", "role.deleted"]);
  });

  it("assigns a custom role to a user, whose access is then exactly that role's", async () => {
    const id = (await createRole(admin, { code: "SITE_CHECKER", name: "Site Checker" })).body.data.id as string;
    expect((await setPermissions(admin, id, VIEWS)).status).toBe(200);

    const user = await insertUser({ email: "checker@admin-roles.example.com", roles: ["VIEWER"] });
    expect((await assignRole(admin, user, id)).status).toBe(200);

    const headers = bearer(await loginToken("checker@admin-roles.example.com"));
    const me = await api().get("/api/auth/me").set(headers);
    expect(me.body.data.user.roles.map((role: { code: string }) => role.code)).toEqual(["SITE_CHECKER"]);
    expect(me.body.data.user.permissions).toEqual(["AMC_SCHEDULE:VIEW", "DASHBOARD:VIEW", "SERVICE_STATUS:VIEW"]);
    // Enforced by the API: nothing outside the role, and no role management.
    expect((await api().get("/api/amc/visits").set(headers)).status).toBe(200);
    expect((await api().get("/api/invoices").set(headers)).status).toBe(403);
    expect((await api().post("/api/roles").set(headers).send({ code: "SELF_MADE", name: "Self made" })).status).toBe(403);
  });
});

describe("Admin is kept within its authority", () => {
  it("cannot change any built-in role, its permissions, or its status", async () => {
    for (const code of ["ADMIN", "ADMINISTRATOR", "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER", "ACCOUNTANT"]) {
      const id = await roleId(code);
      const before = await grantsOf(code);
      const name = (await pool.query<{ name: string }>("SELECT name FROM roles WHERE id = $1", [id])).rows[0]?.name;

      expect((await setPermissions(admin, id, [])).status, code).toBe(403);
      const renamed = await updateRole(admin, id, { name: `Renamed ${code}` });
      expect(renamed.status, code).toBe(403);
      if (code !== "ADMIN") expect(renamed.body.error.message, code).toBe(BUILT_IN);
      expect((await updateRole(admin, id, { isActive: false })).status, code).toBe(403);
      expect((await deleteRole(admin, id)).status, code).toBe(403);

      expect(await grantsOf(code), code).toEqual(before);
      expect((await pool.query<{ name: string }>("SELECT name FROM roles WHERE id = $1", [id])).rows[0]?.name, code).toBe(name);
    }

    const roles = (await listed(admin)).roles;
    for (const role of roles.filter((item) => ["ADMIN", "ADMINISTRATOR", "VIEWER"].includes(item.code))) {
      expect(role, role.code).toMatchObject({ manageable: false, permissionsEditable: false });
    }
  });

  it("cannot grant or revoke a permission it does not hold", async () => {
    const id = (await createRole(admin, { code: "REPORT_READER", name: "Report Reader" })).body.data.id as string;
    // No seeded role but Super Admin holds Reports.
    expect(keys(await grantsOf("ADMINISTRATOR"))).not.toContain("REPORTS:VIEW");

    const refused = await setPermissions(admin, id, [{ module: "DASHBOARD", action: "VIEW" }, { module: "REPORTS", action: "VIEW" }]);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/REPORTS:VIEW because you do not hold it yourself/);
    expect(await grantsOf("REPORT_READER")).toEqual([]);
  });

  it("cannot change, rename, delete or assign a custom role that reaches beyond Admin's permissions", async () => {
    const id = (await createRole(superAdmin, { code: "ANALYST", name: "Analyst" })).body.data.id as string;
    expect((await setPermissions(superAdmin, id, [{ module: "DASHBOARD", action: "VIEW" }, { module: "REPORTS", action: "VIEW" }])).status).toBe(200);

    const role = (await listed(admin)).roles.find((item) => item.id === id);
    expect(role).toMatchObject({ manageable: false, manageReason: BEYOND, permissionsEditable: false, lockedReason: BEYOND, assignable: false });

    expect((await setPermissions(admin, id, [{ module: "DASHBOARD", action: "VIEW" }])).status).toBe(403);
    expect((await updateRole(admin, id, { name: "Renamed" })).body.error.message).toBe(BEYOND);
    expect((await deleteRole(admin, id)).status).toBe(403);
    const user = await insertUser({ email: "analyst@admin-roles.example.com", roles: ["VIEWER"] });
    expect((await assignRole(admin, user, id)).status).toBe(403);
    expect(keys(await grantsOf("ANALYST"))).toEqual(["DASHBOARD:VIEW", "REPORTS:VIEW"]);

    // Super Admin still manages it.
    expect((await updateRole(superAdmin, id, { name: "Data Analyst" })).status).toBe(200);
  });

  it("cannot give a role Users & Access; Super Admin can, and Admin may then take it away", async () => {
    const id = (await createRole(admin, { code: "HELP_DESK", name: "Help Desk" })).body.data.id as string;
    const refused = await setPermissions(admin, id, [{ module: "USERS", action: "VIEW" }]);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toMatch(/Only Super Admin can give a role USERS:VIEW/);
    expect(await grantsOf("HELP_DESK")).toEqual([]);

    expect((await setPermissions(superAdmin, id, [{ module: "USERS", action: "VIEW" }])).status).toBe(200);
    expect((await setPermissions(admin, id, [])).status).toBe(200);
    expect(await grantsOf("HELP_DESK")).toEqual([]);
  });
});

describe("no privilege escalation", () => {
  it("Admin never obtains or hands out Super Admin or Admin, and never changes its own role", async () => {
    const superRole = await roleId("ADMIN");
    const adminRole = await roleId("ADMINISTRATOR");
    const someone = await insertUser({ email: "someone@admin-roles.example.com", roles: ["VIEWER"] });

    // On itself the own-role rule answers first (409); either way nothing changes.
    expect((await assignRole(admin, admin.id, superRole)).status).toBe(409);
    expect((await assignRole(admin, someone, superRole)).status).toBe(403);
    expect((await assignRole(admin, someone, adminRole)).status).toBe(403);

    // Its own role, even to a custom one within its authority, is not Admin's to change.
    const own = (await createRole(admin, { code: "OWN_PICK", name: "Own Pick" })).body.data.id as string;
    expect((await assignRole(admin, admin.id, own)).status).toBe(409);

    // A custom role never takes a built-in code or name.
    for (const code of ["ADMIN", "ADMINISTRATOR", "VIEWER"]) {
      expect((await createRole(admin, { code, name: `Copy of ${code}` })).status, code).toBe(409);
    }
    expect((await createRole(admin, { code: "SUPER_COPY", name: "Super Admin" })).status).toBe(409);

    // Its own role's permissions are fixed for Admin.
    expect((await setPermissions(admin, adminRole, [...(await grantsOf("ADMINISTRATOR")), { module: "REPORTS", action: "VIEW" }])).status).toBe(403);

    const me = await api().get("/api/auth/me").set(admin.headers);
    expect(me.body.data.user.roles.map((role: { code: string }) => role.code)).toEqual(["ADMINISTRATOR"]);
    expect(me.body.data.user.permissions).not.toContain("REPORTS:VIEW");
  });

  it("no other role manages roles, even holding Users & Access Edit", async () => {
    const clerkRole = (await createRole(superAdmin, { code: "USER_CLERK", name: "User Clerk" })).body.data.id as string;
    expect((await setPermissions(superAdmin, clerkRole, [{ module: "USERS", action: "VIEW" }, { module: "USERS", action: "EDIT" }])).status).toBe(200);
    await insertUser({ email: "clerk@admin-roles.example.com", roles: ["USER_CLERK"] });
    const clerk = { id: "", headers: bearer(await loginToken("clerk@admin-roles.example.com")) };

    expect((await listed(clerk)).canManageRoles).toBe(false);
    const refused = await createRole(clerk, { code: "CLERK_MADE", name: "Clerk made" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(ROLE_ADMINISTRATORS_ONLY);
    expect((await setPermissions(clerk, clerkRole, [])).status).toBe(403);
    expect((await createRole(finance, { code: "FINANCE_MADE", name: "Finance made" })).status).toBe(403);
  });

  it("Super Admin removing Users & Access Edit from Admin takes role management away; restoring it gives it back", async () => {
    const adminRole = await roleId("ADMINISTRATOR");
    const full = await grantsOf("ADMINISTRATOR");
    expect(keys(full)).toContain("USERS:EDIT");

    expect((await setPermissions(superAdmin, adminRole, full.filter((grant) => !(grant.module === "USERS" && grant.action === "EDIT")))).status).toBe(200);
    try {
      expect((await listed(admin)).canManageRoles).toBe(false);
      const refused = await createRole(admin, { code: "AFTER_REMOVAL", name: "After removal" });
      expect(refused.status).toBe(403);
      expect(refused.body.error.message).toBe(ROLE_ADMINISTRATORS_ONLY);
    } finally {
      expect((await setPermissions(superAdmin, adminRole, full)).status).toBe(200);
    }

    expect((await createRole(admin, { code: "AFTER_RESTORE", name: "After restore" })).status).toBe(201);
  });
});
