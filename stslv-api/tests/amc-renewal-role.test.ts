import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { BUILT_IN_ROLE_NAMES } from "../src/shared/role-names";
import {
  AMC_RENEWAL_ROLE_CODE,
  BUILT_IN_ROLE_CODES,
  defaultGrants,
  isBuiltInRole,
  isInRoleScope,
  isPrivilegedRole,
  isSuperAdmin,
  OPERATIONAL_ROLE_CODES,
  roleScope,
} from "../src/shared/role-model";
import { api, closePool, insertUser, permissionsVersion, resetData, roleId, signedIn } from "./helpers";

// The "AMC Renewal" role (migration 0120, requested 2026-11-19): a built-in operational role like Accounts, AMC Sales
// and AMC Operations Executive. It starts with no permissions; Super Admin configures it in Roles & Permissions.

type Session = Awaited<ReturnType<typeof signedIn>>;

const CODE = AMC_RENEWAL_ROLE_CODE;
const migration0120 = loadMigrationFiles().find((migration) => migration.name === "amc_renewal_role")?.sql ?? "";

let superAdmin: Session;
let serviceDept: Session;

const grantsOf = async (code: string) =>
  (
    await pool.query<{ key: string }>(
      "SELECT rp.module || ':' || rp.action AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1",
      [code]
    )
  ).rows
    .map((row) => row.key)
    .sort();

const allGrants = async () =>
  (await pool.query("SELECT r.code, rp.module, rp.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY 1, 2, 3")).rows;

const setPermissions = async (session: Session, keys: string[]) => {
  const id = await roleId(CODE);

  return api()
    .put(`/api/roles/${id}/permissions`)
    .set(session.headers)
    .send({ expectedVersion: await permissionsVersion(id), permissions: keys.map((key) => ({ module: key.split(":")[0], action: key.split(":")[1] })) });
};

const status = async (session: Session, method: "get" | "post", path: string, body: object = {}) =>
  (method === "get" ? await api().get(path).set(session.headers) : await api().post(path).set(session.headers).send(body)).status;

beforeEach(async () => {
  await resetData();
  superAdmin = await signedIn("super@example.com", ["ADMIN"]);
  serviceDept = await signedIn("servicedept@example.com", ["ADMINISTRATOR"]);
});

afterAll(closePool);

describe("migration 0120: the AMC Renewal role", () => {
  it("adds the role, active, named AMC Renewal, with no permissions and nobody holding it", async () => {
    const row = await pool.query<{ name: string; is_active: boolean; description: string }>("SELECT name, is_active, description FROM roles WHERE code = $1", [CODE]);

    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ name: "AMC Renewal", is_active: true });
    expect(row.rows[0]?.description).toContain("no permissions");
    expect(await grantsOf(CODE)).toEqual([]);
    expect((await pool.query("SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = $1", [CODE])).rowCount).toBe(0);
  });

  it("writes only the roles row: no permission, assignment or audit change", () => {
    const statements = migration0120.replace(/^--.*$/gm, "");

    expect(statements).not.toMatch(/role_permissions|user_roles|activity_logs|users\b/i);
    expect(statements).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
    expect(statements.match(/\bINSERT INTO (\w+)/gi)).toEqual(["INSERT INTO roles"]);
  });

  it("leaves every other role's permissions exactly as the role model seeds them", async () => {
    for (const code of OPERATIONAL_ROLE_CODES.filter((code) => code !== CODE)) {
      expect(await grantsOf(code), code).toEqual([...defaultGrants(code)].sort());
    }
  });

  it("stops, changing nothing, when the code is already taken (a run twice, or a custom role with that code)", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      const before = (await client.query("SELECT id, code, name FROM roles ORDER BY id")).rows;
      await client.query("SAVEPOINT before_0120");
      await expect(client.query(migration0120)).rejects.toThrow(/0120: a role with the code AMC_RENEWAL_EXECUTIVE or the name "AMC Renewal" already exists: AMC Renewal \(AMC_RENEWAL_EXECUTIVE\)/);
      await client.query("ROLLBACK TO SAVEPOINT before_0120");
      expect((await client.query("SELECT id, code, name FROM roles ORDER BY id")).rows).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("stops, changing nothing, when a custom role already uses the name (any case)", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM roles WHERE code = $1", [CODE]);
      await client.query("INSERT INTO roles (code, name) VALUES ('RENEWALS_TEAM', 'amc renewal')");
      await client.query("SAVEPOINT before_0120");
      await expect(client.query(migration0120)).rejects.toThrow(/already exists: amc renewal \(RENEWALS_TEAM\)/);
      await client.query("ROLLBACK TO SAVEPOINT before_0120");
      expect((await client.query("SELECT 1 FROM roles WHERE code = $1", [CODE])).rowCount).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("applies on a database without the role", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM roles WHERE code = $1", [CODE]);
      const others = (await client.query("SELECT r.code, rp.module, rp.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY 1, 2, 3")).rows;
      await client.query(migration0120);
      expect((await client.query("SELECT name FROM roles WHERE code = $1", [CODE])).rows).toEqual([{ name: "AMC Renewal" }]);
      expect((await client.query("SELECT r.code, rp.module, rp.action FROM role_permissions rp JOIN roles r ON r.id = rp.role_id ORDER BY 1, 2, 3")).rows).toEqual(others);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("the role model treats AMC Renewal like the other operational roles", () => {
  it("is built-in, operational, not privileged, and never Super Admin", () => {
    expect(isBuiltInRole(CODE)).toBe(true);
    expect(BUILT_IN_ROLE_CODES).toContain(CODE);
    expect(OPERATIONAL_ROLE_CODES).toContain(CODE);
    expect(isPrivilegedRole(CODE)).toBe(false);
    expect(isSuperAdmin([{ code: CODE }])).toBe(false);
    expect(BUILT_IN_ROLE_NAMES.AMC_RENEWAL_EXECUTIVE).toBe("AMC Renewal");
    expect(defaultGrants(CODE)).toEqual([]);
  });

  it("may hold any supported permission except Users & Access, like Accounts", () => {
    expect(isInRoleScope(CODE, "AMC_RENEWAL", "CREATE")).toBe(true);
    expect(isInRoleScope(CODE, "AMC_CONTRACTS", "EDIT")).toBe(true);
    expect(isInRoleScope(CODE, "USERS", "VIEW")).toBe(false);
    expect(roleScope(CODE)).toEqual(roleScope("FINANCE_EXECUTIVE"));
  });
});

describe("Roles & Permissions", () => {
  it("lists AMC Renewal alongside the other roles, editable and assignable by Super Admin, never deletable", async () => {
    const response = await api().get("/api/roles").set(superAdmin.headers);
    expect(response.status).toBe(200);

    const roles = response.body.data.roles as { code: string; name: string; builtIn: boolean; permissionsEditable: boolean; manageable: boolean; assignable: boolean; scope: string[] | null; permissions: unknown[] }[];
    const role = roles.find((entry) => entry.code === CODE);

    expect(roles.map((entry) => entry.code)).toEqual(expect.arrayContaining(["ADMINISTRATOR", "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", CODE]));
    expect(role).toMatchObject({ name: "AMC Renewal", builtIn: true, permissionsEditable: true, manageable: true, assignable: true, permissions: [] });
    expect(role?.scope?.some((key) => key.startsWith("USERS:"))).toBe(false);
  });

  it("Super Admin configures its permissions, with every supported action, and no other role changes", async () => {
    const others = (await allGrants()).filter((row) => row.code !== CODE);
    const wanted = [
      "AMC_RENEWAL:VIEW", "AMC_RENEWAL:CREATE", "AMC_RENEWAL:EXPORT",
      "AMC_CONTRACTS:VIEW", "AMC_CONTRACTS:CREATE", "AMC_CONTRACTS:EDIT", "AMC_CONTRACTS:DELETE", "AMC_CONTRACTS:EXPORT",
      "CLIENTS:READ", "DASHBOARD:VIEW",
    ];

    const saved = await setPermissions(superAdmin, wanted);
    expect(saved.status).toBe(200);
    expect(await grantsOf(CODE)).toEqual([...wanted].sort());
    expect((await allGrants()).filter((row) => row.code !== CODE)).toEqual(others);

    // Logged like every permission change.
    const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'role.permissions_changed' AND entity_id = $1", [await roleId(CODE)]);
    expect(log.rowCount).toBe(1);

    // And removed again.
    expect((await setPermissions(superAdmin, [])).status).toBe(200);
    expect(await grantsOf(CODE)).toEqual([]);
  });

  it("refuses Users & Access, a missing dependency and an unused permission", async () => {
    const users = await setPermissions(superAdmin, ["USERS:VIEW"]);
    expect(users.status).toBe(403);
    expect(users.body.error.message).toContain("cannot be given USERS:VIEW");

    const dependency = await setPermissions(superAdmin, ["AMC_RENEWAL:CREATE"]);
    expect(dependency.status).toBe(400);
    expect(dependency.body.error.message).toBe("AMC_RENEWAL:CREATE also needs AMC_RENEWAL:VIEW. Grant both, or neither.");

    expect((await setPermissions(superAdmin, ["AMC_RENEWAL:VIEW", "AMC_RENEWAL:DELETE"])).status).toBe(400);
    expect(await grantsOf(CODE)).toEqual([]);
  });

  it("Service Dept may configure it within its own permissions (as for Accounts), but never rename, deactivate or delete it", async () => {
    expect((await setPermissions(serviceDept, ["AMC_RENEWAL:VIEW"])).status).toBe(200);
    expect(await grantsOf(CODE)).toEqual(["AMC_RENEWAL:VIEW"]);
    expect((await setPermissions(serviceDept, ["USERS:VIEW"])).status).toBe(403);

    const id = await roleId(CODE);
    expect((await api().patch(`/api/roles/${id}`).set(serviceDept.headers).send({ name: "Renewals" })).status).toBe(403);
    expect((await api().patch(`/api/roles/${id}`).set(serviceDept.headers).send({ isActive: false })).status).toBe(403);
    expect((await api().delete(`/api/roles/${id}`).set(serviceDept.headers)).status).toBe(403);
  });

  it("is never deleted, even by Super Admin; a custom role cannot take its code", async () => {
    const response = await api().delete(`/api/roles/${await roleId(CODE)}`).set(superAdmin.headers);
    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe("A built-in role cannot be deleted. Deactivate it instead.");

    expect((await api().post("/api/roles").set(superAdmin.headers).send({ code: CODE, name: "Another" })).status).toBe(409);
    expect((await api().post("/api/roles").set(superAdmin.headers).send({ code: "OTHER_RENEWAL", name: "AMC Renewal" })).status).toBe(409);
  });

  it("a user holding the role cannot open or change Roles & Permissions", async () => {
    await setPermissions(superAdmin, ["AMC_RENEWAL:VIEW"]);
    const renewal = await signedIn("renewal@example.com", [CODE]);

    expect(await status(renewal, "get", "/api/roles")).toBe(403);
    expect((await api().put(`/api/roles/${await roleId(CODE)}/permissions`).set(renewal.headers).send({ expectedVersion: await permissionsVersion(await roleId(CODE)), permissions: [] })).status).toBe(403);
    expect(await grantsOf(CODE)).toEqual(["AMC_RENEWAL:VIEW"]);
  });
});

describe("assigning the role", () => {
  it("Super Admin and Service Dept assign it; the user's session carries it", async () => {
    const first = await insertUser({ email: "first@example.com", roles: ["VIEWER"] });
    const byOwner = await api().put(`/api/users/${first}/roles`).set(superAdmin.headers).send({ roleIds: [await roleId(CODE)] });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.data.roles.map((role: { code: string; name: string }) => [role.code, role.name])).toEqual([[CODE, "AMC Renewal"]]);

    const created = await api()
      .post("/api/users")
      .set(serviceDept.headers)
      .send({ email: "second@example.com", fullName: "Second", password: "Correct-Horse-42", roleIds: [await roleId(CODE)] });
    expect(created.status).toBe(201);

    const renewal = await signedIn("renewal@example.com", [CODE]);
    const me = await api().get("/api/auth/me").set(renewal.headers);
    expect(me.status).toBe(200);
    expect(me.body.data.user.roles.map((role: { code: string }) => role.code)).toEqual([CODE]);
    expect(me.body.data.user.permissions).toEqual([]);
  });

  it("cannot be deactivated while someone holds it", async () => {
    await insertUser({ email: "holder@example.com", roles: [CODE] });
    const response = await api().patch(`/api/roles/${await roleId(CODE)}`).set(superAdmin.headers).send({ isActive: false });

    expect(response.status).toBe(409);
  });
});

describe("access is exactly what is configured, checked by the API", () => {
  it("with no permissions (as added), the user opens nothing", async () => {
    const renewal = await signedIn("renewal@example.com", [CODE]);

    for (const path of [
      "/api/dashboard/summary",
      "/api/amc/renewals/queue",
      "/api/amc/reports/renewals",
      "/api/amc/contracts",
      "/api/amc/visits",
      "/api/clients",
      "/api/invoices",
      "/api/accounts",
      "/api/users",
      "/api/roles",
      "/api/audit/activity",
      "/api/suggestions/review",
    ]) {
      expect(await status(renewal, "get", path), path).toBe(403);
    }
    expect(await status(renewal, "post", "/api/clients", { name: "X", clientType: "COMPANY" })).toBe(403);
  });

  it("opens the granted pages and actions only, and changes apply on the next request", async () => {
    const renewal = await signedIn("renewal@example.com", [CODE]);

    await setPermissions(superAdmin, ["AMC_RENEWAL:VIEW"]);
    expect(await status(renewal, "get", "/api/amc/renewals/queue")).toBe(200);
    expect(await status(renewal, "get", "/api/amc/reports/renewals")).toBe(200);
    // View only: no export, and nothing outside the grant.
    expect(await status(renewal, "get", "/api/amc/renewals/queue/export?format=xlsx")).toBe(403);
    expect(await status(renewal, "post", "/api/amc/contracts/1/renewals", {})).toBe(403);
    expect(await status(renewal, "get", "/api/amc/contracts")).toBe(403);
    expect(await status(renewal, "get", "/api/clients")).toBe(403);
    expect(await status(renewal, "get", "/api/users")).toBe(403);

    await setPermissions(superAdmin, ["AMC_RENEWAL:VIEW", "AMC_RENEWAL:EXPORT", "AMC_CONTRACTS:VIEW"]);
    expect(await status(renewal, "get", "/api/amc/renewals/queue/export?format=xlsx")).not.toBe(403);
    expect(await status(renewal, "get", "/api/amc/contracts")).toBe(200);

    await setPermissions(superAdmin, []);
    expect(await status(renewal, "get", "/api/amc/renewals/queue")).toBe(403);
    expect(await status(renewal, "get", "/api/amc/contracts")).toBe(403);
  });
});
