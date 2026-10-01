import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { ACTIONS, MODULES } from "../src/shared/permissions";
import { api, closePool, insertUser, PASSWORD, resetData, roleId, signedIn } from "./helpers";

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let accountant: Session;

beforeEach(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
});
afterAll(closePool);

/** Grants extra permissions to a role directly in the database. */
async function grant(roleCode: string, permissions: [string, string][]) {
  for (const [module, action] of permissions) {
    await pool.query(
      "INSERT INTO role_permissions (role_id, module, action) SELECT id, $2, $3 FROM roles WHERE code = $1 ON CONFLICT DO NOTHING",
      [roleCode, module, action]
    );
  }
}

describe("permission enforcement on client routes", () => {
  it("lets a view-only role read clients but not change them", async () => {
    const created = await api().post("/api/clients").set(admin.headers).send({ name: "IBIS" });
    const id = created.body.data.id;

    expect((await api().get("/api/clients").set(accountant.headers)).status).toBe(200);
    expect((await api().get(`/api/clients/${id}`).set(accountant.headers)).status).toBe(200);

    const attempts = [
      await api().post("/api/clients").set(accountant.headers).send({ name: "Not Allowed" }),
      await api().patch(`/api/clients/${id}`).set(accountant.headers).send({ name: "Renamed" }),
      await api().post(`/api/clients/${id}/deactivate`).set(accountant.headers),
      await api().post(`/api/clients/${id}/reactivate`).set(accountant.headers),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }

    const stored = await pool.query("SELECT name, is_active FROM clients");
    expect(stored.rows).toEqual([{ name: "IBIS", is_active: true }]);
  });

  it("checks each action separately: EDIT does not imply DELETE", async () => {
    await grant("ACCOUNTANT", [["CLIENTS", "EDIT"]]);
    const created = await api().post("/api/clients").set(admin.headers).send({ name: "IBIS" });
    const id = created.body.data.id;

    expect((await api().patch(`/api/clients/${id}`).set(accountant.headers).send({ phone: "123" })).status).toBe(200);
    expect((await api().post(`/api/clients/${id}/deactivate`).set(accountant.headers)).status).toBe(403);
    expect((await api().post("/api/clients").set(accountant.headers).send({ name: "New" })).status).toBe(403);
  });

  it("gives a user with no role no access at all", async () => {
    const nobody = await signedIn("norole@example.com", []);

    for (const path of ["/api/clients", "/api/users", "/api/roles", "/api/dashboard/summary"]) {
      expect((await api().get(path).set(nobody.headers)).status, path).toBe(403);
    }

    const me = await api().get("/api/auth/me").set(nobody.headers);
    expect(me.body.data.user.permissions).toEqual([]);
  });

  it("ignores the permissions of an inactive role", async () => {
    await pool.query("UPDATE roles SET is_active = false WHERE code = 'ACCOUNTANT'");

    expect((await api().get("/api/clients").set(accountant.headers)).status).toBe(403);
  });

  it("combines the permissions of several roles", async () => {
    const both = await signedIn("both@example.com", ["PROCUREMENT", "INVOICING"]);
    const me = await api().get("/api/auth/me").set(both.headers);

    expect(me.body.data.user.permissions).toEqual(expect.arrayContaining(["PROCUREMENT:CREATE", "INVOICES:CREATE"]));
    expect(me.body.data.user.permissions).not.toContain("EXPENSES:CREATE");
  });
});

describe("user administration is restricted", () => {
  it("blocks every user and role route for a role without USERS permissions", async () => {
    const attempts = [
      await api().get("/api/users").set(accountant.headers),
      await api().post("/api/users").set(accountant.headers).send({ email: "x@example.com", fullName: "X", password: PASSWORD }),
      await api().patch(`/api/users/${admin.id}`).set(accountant.headers).send({ fullName: "Hacked" }),
      await api().post(`/api/users/${admin.id}/deactivate`).set(accountant.headers),
      await api().put(`/api/users/${accountant.id}/roles`).set(accountant.headers).send({ roleIds: [await roleId("ADMIN")] }),
      await api().post(`/api/users/${admin.id}/reset-password`).set(accountant.headers).send({ password: PASSWORD }),
      await api().get("/api/roles").set(accountant.headers),
      await api().put(`/api/roles/${await roleId("ACCOUNTANT")}/permissions`).set(accountant.headers).send({ permissions: [] }),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
    }
  });
});

describe("role permissions are data", () => {
  it("lists the roles with their permissions and the module/action catalogue", async () => {
    const response = await api().get("/api/roles").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.modules).toEqual([...MODULES]);
    expect(response.body.data.actions).toEqual([...ACTIONS]);
    expect(response.body.data.roles.map((role: { code: string }) => role.code)).toEqual([
      "ADMIN",
      "ACCOUNTANT",
      "PROCUREMENT",
      "EXECUTION",
      "INVOICING",
    ]);

    const adminRole = response.body.data.roles[0];
    expect(adminRole.permissions).toHaveLength(MODULES.length * ACTIONS.length);
    expect(adminRole).toMatchObject({ permissionsEditable: false, userCount: 1 });
  });

  it("lets an Admin change a role, and the change applies to existing sessions at once", async () => {
    const id = await roleId("ACCOUNTANT");

    expect((await api().post("/api/clients").set(accountant.headers).send({ name: "Before" })).status).toBe(403);

    const response = await api()
      .put(`/api/roles/${id}/permissions`)
      .set(admin.headers)
      .send({
        permissions: [
          { module: "CLIENTS", action: "VIEW" },
          { module: "CLIENTS", action: "CREATE" },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.permissions).toEqual([
      { module: "CLIENTS", action: "CREATE" },
      { module: "CLIENTS", action: "VIEW" },
    ]);

    // Same token as before: no new login needed.
    expect((await api().post("/api/clients").set(accountant.headers).send({ name: "After" })).status).toBe(201);
    expect((await api().get("/api/dashboard/summary").set(accountant.headers)).status).toBe(403);

    const log = await pool.query<{ metadata: { added: string[]; removed: string[] } }>(
      "SELECT metadata FROM activity_logs WHERE action = 'role.permissions_changed'"
    );
    expect(log.rows[0]?.metadata.added).toEqual(["CLIENTS:CREATE"]);
    expect(log.rows[0]?.metadata.removed).toContain("DASHBOARD:VIEW");
  });

  it("does not allow the Admin role's permissions to be changed", async () => {
    const response = await api()
      .put(`/api/roles/${await roleId("ADMIN")}/permissions`)
      .set(admin.headers)
      .send({ permissions: [] });

    expect(response.status).toBe(403);
    expect((await api().get("/api/users").set(admin.headers)).status).toBe(200);
  });

  it("rejects unknown modules or actions", async () => {
    const response = await api()
      .put(`/api/roles/${await roleId("ACCOUNTANT")}/permissions`)
      .set(admin.headers)
      .send({ permissions: [{ module: "PAYROLL", action: "VIEW" }] });

    expect(response.status).toBe(400);
  });
});

describe("privilege escalation is blocked", () => {
  // An accountant who has been given user-management access, but nothing else extra.
  beforeEach(async () => {
    await grant("ACCOUNTANT", [
      ["USERS", "VIEW"],
      ["USERS", "CREATE"],
      ["USERS", "EDIT"],
    ]);
  });

  it("cannot create a user with a role that exceeds their own permissions", async () => {
    const withAdminRole = await api()
      .post("/api/users")
      .set(accountant.headers)
      .send({ email: "new-admin@example.com", fullName: "New Admin", password: PASSWORD, roleIds: [await roleId("ADMIN")] });
    const withOwnRole = await api()
      .post("/api/users")
      .set(accountant.headers)
      .send({ email: "peer@example.com", fullName: "Peer", password: PASSWORD, roleIds: [await roleId("ACCOUNTANT")] });

    expect(withAdminRole.status).toBe(403);
    expect((await pool.query("SELECT 1 FROM users WHERE email = 'new-admin@example.com'")).rowCount).toBe(0);
    expect(withOwnRole.status).toBe(201);
  });

  it("cannot assign a stronger role to an existing user, or change their own roles", async () => {
    const peer = await insertUser({ email: "peer@example.com", roles: ["ACCOUNTANT"] });

    const promotePeer = await api()
      .put(`/api/users/${peer}/roles`)
      .set(accountant.headers)
      .send({ roleIds: [await roleId("ACCOUNTANT"), await roleId("ADMIN")] });
    const promoteSelf = await api()
      .put(`/api/users/${accountant.id}/roles`)
      .set(accountant.headers)
      .send({ roleIds: [await roleId("ADMIN")] });

    expect(promotePeer.status).toBe(403);
    expect(promoteSelf.status).toBe(409);
  });

  it("cannot manage a user who holds more permissions than they do", async () => {
    const attempts = [
      await api().post(`/api/users/${admin.id}/reset-password`).set(accountant.headers).send({ password: "Taken-Over-Password-1" }),
      await api().post(`/api/users/${admin.id}/deactivate`).set(accountant.headers),
      await api().patch(`/api/users/${admin.id}`).set(accountant.headers).send({ fullName: "Renamed" }),
      await api().put(`/api/users/${admin.id}/roles`).set(accountant.headers).send({ roleIds: [] }),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
    }

    // The admin's password is unchanged.
    expect((await api().post("/api/auth/login").send({ email: "admin@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("cannot grant or revoke a permission they do not hold", async () => {
    const id = await roleId("ACCOUNTANT");
    const current = (await api().get("/api/roles").set(accountant.headers)).body.data.roles.find(
      (role: { code: string }) => role.code === "ACCOUNTANT"
    ).permissions;

    const addBeyond = await api()
      .put(`/api/roles/${id}/permissions`)
      .set(accountant.headers)
      .send({ permissions: [...current, { module: "SETTINGS", action: "EDIT" }] });
    const revokeBeyond = await api()
      .put(`/api/roles/${await roleId("PROCUREMENT")}/permissions`)
      .set(accountant.headers)
      .send({ permissions: [] });

    expect(addBeyond.status).toBe(403);
    expect(revokeBeyond.status).toBe(403);
    expect((await pool.query("SELECT 1 FROM role_permissions WHERE module = 'SETTINGS' AND action = 'EDIT'")).rowCount).toBe(1);
  });
});

describe("the system always keeps an active Admin", () => {
  it("does not let an Admin deactivate themselves or change their own roles", async () => {
    const deactivate = await api().post(`/api/users/${admin.id}/deactivate`).set(admin.headers);
    const roles = await api().put(`/api/users/${admin.id}/roles`).set(admin.headers).send({ roleIds: [] });

    expect(deactivate.status).toBe(409);
    expect(roles.status).toBe(409);
  });

  it("does not let the only active Admin be deactivated or lose the Admin role", async () => {
    // A custom role with every permission but not the ADMIN code.
    await pool.query("INSERT INTO roles (code, name) VALUES ('SUPERVISOR', 'Supervisor')");
    await pool.query(
      `INSERT INTO role_permissions (role_id, module, action)
       SELECT (SELECT id FROM roles WHERE code = 'SUPERVISOR'), module, action
       FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'ADMIN'`
    );
    const supervisor = await signedIn("supervisor@example.com", ["SUPERVISOR"]);

    const deactivate = await api().post(`/api/users/${admin.id}/deactivate`).set(supervisor.headers);
    const removeRole = await api().put(`/api/users/${admin.id}/roles`).set(supervisor.headers).send({ roleIds: [] });

    expect(deactivate.status).toBe(409);
    expect(removeRole.status).toBe(409);

    // With a second active Admin it is allowed.
    await insertUser({ email: "second-admin@example.com", roles: ["ADMIN"] });
    expect((await api().post(`/api/users/${admin.id}/deactivate`).set(supervisor.headers)).status).toBe(200);
  });
});
