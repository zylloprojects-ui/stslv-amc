import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, bearer, closePool, loginToken, PASSWORD, resetData, roleId, signedIn, withoutOneRoleConstraint } from "./helpers";

let admin: Awaited<ReturnType<typeof signedIn>>;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("create user", () => {
  it("creates a user with a role, who can then sign in with that role's permissions", async () => {
    const response = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({
        email: "Procurement.User@Example.com",
        fullName: "Procurement User",
        password: PASSWORD,
        roleIds: [await roleId("PROCUREMENT")],
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      email: "procurement.user@example.com",
      fullName: "Procurement User",
      isActive: true,
      roles: [{ code: "PROCUREMENT", name: "Procurement" }],
    });

    const login = await api().post("/api/auth/login").send({ email: "procurement.user@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.permissions).toContain("PROCUREMENT:CREATE");
    expect(login.body.data.user.permissions).not.toContain("USERS:VIEW");

    const log = await pool.query<{ user_id: string; metadata: unknown }>(
      "SELECT user_id, metadata FROM activity_logs WHERE action = 'user.created' AND entity_id = $1",
      [response.body.data.id]
    );
    expect(log.rows).toEqual([{ user_id: admin.id, metadata: { roles: ["PROCUREMENT"] } }]);
  });

  it("stores a bcrypt hash, never the password, and never returns either", async () => {
    const response = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "hash-check@example.com", fullName: "Hash Check", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });
    const stored = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
      response.body.data.id,
    ]);
    const list = await api().get("/api/users").set(admin.headers);

    expect(stored.rows[0]?.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(PASSWORD);

    for (const body of [response.body, list.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(PASSWORD);
      expect(text.toLowerCase()).not.toContain("password");
      expect(text).not.toContain("$2");
    }

    // The audit log must not contain it either.
    const logs = await pool.query<{ text: string }>("SELECT coalesce(description, '') || coalesce(metadata::text, '') AS text FROM activity_logs");
    expect(logs.rows.some((row) => row.text.includes(PASSWORD) || row.text.includes("$2"))).toBe(false);
  });

  it("rejects a duplicate email, a weak password, invalid fields and unknown roles", async () => {
    const base = { email: "valid@example.com", fullName: "Valid", password: PASSWORD, roleIds: [await roleId("EXECUTION")] };

    const duplicate = await api().post("/api/users").set(admin.headers).send({ ...base, email: "ADMIN@example.com" });
    const weak = await api().post("/api/users").set(admin.headers).send({ ...base, password: "short" });
    const tooLong = await api().post("/api/users").set(admin.headers).send({ ...base, password: "x".repeat(73) });
    const badEmail = await api().post("/api/users").set(admin.headers).send({ ...base, email: "nope" });
    const noName = await api().post("/api/users").set(admin.headers).send({ ...base, fullName: " " });
    const unknownRole = await api().post("/api/users").set(admin.headers).send({ ...base, roleIds: ["999999"] });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details).toEqual([{ field: "email", message: "A user with this email already exists." }]);
    for (const response of [weak, tooLong, badEmail, noName, unknownRole]) {
      expect(response.status).toBe(400);
    }
    expect((await pool.query("SELECT 1 FROM users WHERE email = 'valid@example.com'")).rowCount).toBe(0);
  });
});

describe("manage user", () => {
  it("lists users with their roles", async () => {
    const response = await api().get("/api/users").set(admin.headers);
    const adminRow = response.body.data.find((user: { email: string }) => user.email === "admin@example.com");

    expect(response.status).toBe(200);
    expect(adminRow).toMatchObject({ id: admin.id, isActive: true, roles: [{ code: "ADMIN" }] });
    expect(adminRow.lastLoginAt).toEqual(expect.any(String));
  });

  it("deactivates and reactivates a user; a deactivated user cannot sign in or use an old token", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "toggle@example.com", fullName: "Toggle", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });
    const id = created.body.data.id;
    const token = await loginToken("toggle@example.com");

    const deactivated = await api().post(`/api/users/${id}/deactivate`).set(admin.headers);
    expect(deactivated.body.data.isActive).toBe(false);
    expect((await api().get("/api/auth/me").set(bearer(token))).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: "toggle@example.com", password: PASSWORD })).status).toBe(401);

    const activated = await api().post(`/api/users/${id}/activate`).set(admin.headers);
    expect(activated.body.data.isActive).toBe(true);
    expect((await api().post("/api/auth/login").send({ email: "toggle@example.com", password: PASSWORD })).status).toBe(200);

    const logs = await pool.query<{ action: string }>(
      "SELECT action FROM activity_logs WHERE entity_type = 'users' AND entity_id = $1 AND user_id = $2 ORDER BY id",
      [id, admin.id]
    );
    expect(logs.rows.map((row) => row.action)).toEqual(["user.created", "user.deactivated", "user.activated"]);
  });

  it("replaces the user's one role with another, changing what the user may do at once", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "roles@example.com", fullName: "Role Change", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });
    const id = created.body.data.id;
    const headers = bearer(await loginToken("roles@example.com"));

    expect((await api().get("/api/auth/me").set(headers)).body.data.user.permissions).toContain("AMC_EXECUTION:EDIT");

    const response = await api()
      .put(`/api/users/${id}/roles`)
      .set(admin.headers)
      .send({ roleIds: [await roleId("INVOICING")] });

    expect(response.status).toBe(200);
    // The old role is replaced, not kept beside the new one.
    expect(response.body.data.roles.map((role: { code: string }) => role.code)).toEqual(["INVOICING"]);
    expect((await pool.query("SELECT 1 FROM user_roles WHERE user_id = $1", [id])).rowCount).toBe(1);

    const permissions = (await api().get("/api/auth/me").set(headers)).body.data.user.permissions;
    expect(permissions).toContain("INVOICES:CREATE");
    expect(permissions).not.toContain("AMC_EXECUTION:EDIT");

    const log = await pool.query<{ metadata: unknown }>(
      "SELECT metadata FROM activity_logs WHERE action = 'user.roles_changed' AND entity_id = $1",
      [id]
    );
    expect(log.rows[0]?.metadata).toEqual({ added: ["INVOICING"], removed: ["EXECUTION"] });
  });

  it("issues a temporary password: the old one stops working and the temporary one must be changed", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "reset@example.com", fullName: "Reset Me", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });

    const response = await api()
      .post(`/api/users/${created.body.data.id}/temporary-password`)
      .set(admin.headers)
      .send({ identityVerified: true });
    const temporary = response.body.data.temporaryPassword as string;

    expect(response.status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: "reset@example.com", password: PASSWORD })).status).toBe(401);

    const session = await api().post("/api/auth/login").send({ email: "reset@example.com", password: temporary });

    expect(session.status).toBe(200);
    expect(session.body.data.user.credentialChangeRequired).toBe(true);
  });

  it("renames a user and returns 404 for an unknown user", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "rename@example.com", fullName: "Old Name", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });

    const renamed = await api().patch(`/api/users/${created.body.data.id}`).set(admin.headers).send({ fullName: "New Name" });
    const missing = await api().patch("/api/users/999999").set(admin.headers).send({ fullName: "Nobody" });

    expect(renamed.body.data.fullName).toBe("New Name");
    expect(missing.status).toBe(404);
  });
});

describe("one role per user", () => {
  const ONE_ROLE = "Select exactly one role.";

  it("creates a user only with exactly one role", async () => {
    const base = { fullName: "One Role", password: PASSWORD };
    const none = await api().post("/api/users").set(admin.headers).send({ ...base, email: "none@example.com" });
    const empty = await api().post("/api/users").set(admin.headers).send({ ...base, email: "empty@example.com", roleIds: [] });
    const two = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ ...base, email: "two@example.com", roleIds: [await roleId("ACCOUNTANT"), await roleId("INVOICING")] });

    for (const response of [none, empty, two]) {
      expect(response.status).toBe(400);
      expect(response.body.error.details).toContainEqual({ field: "roleIds", message: ONE_ROLE });
    }
    expect((await pool.query("SELECT 1 FROM users WHERE email IN ('none@example.com', 'empty@example.com', 'two@example.com')")).rowCount).toBe(0);

    // The same id twice is one role.
    const same = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ ...base, email: "same@example.com", roleIds: [await roleId("ACCOUNTANT"), await roleId("ACCOUNTANT")] });
    expect(same.status).toBe(201);
    expect(same.body.data.roles).toEqual([expect.objectContaining({ code: "ACCOUNTANT" })]);
  });

  it("refuses to give an existing user no role or several roles, and changes nothing", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "keep@example.com", fullName: "Keep Role", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });
    const id = created.body.data.id;

    const empty = await api().put(`/api/users/${id}/roles`).set(admin.headers).send({ roleIds: [] });
    const two = await api()
      .put(`/api/users/${id}/roles`)
      .set(admin.headers)
      .send({ roleIds: [await roleId("ACCOUNTANT"), await roleId("INVOICING")] });

    for (const response of [empty, two]) {
      expect(response.status).toBe(400);
      expect(response.body.error.details).toContainEqual({ field: "roleIds", message: ONE_ROLE });
    }
    const roles = await pool.query<{ code: string }>("SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1", [id]);
    expect(roles.rows).toEqual([{ code: "EXECUTION" }]);
  });

  it("replaces several roles held from before the rule with the one chosen (database before 0082)", async () => {
    await withoutOneRoleConstraint(async () => {
      const created = await api()
        .post("/api/users")
        .set(admin.headers)
        .send({ email: "legacy@example.com", fullName: "Legacy Roles", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });
      const id = created.body.data.id;
      // Assigned directly, as data from before the rule may be.
      await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [id, await roleId("INVOICING")]);

      const response = await api().put(`/api/users/${id}/roles`).set(admin.headers).send({ roleIds: [await roleId("ACCOUNTANT")] });

      expect(response.status).toBe(200);
      expect(response.body.data.roles.map((role: { code: string }) => role.code)).toEqual(["ACCOUNTANT"]);
      const log = await pool.query<{ metadata: { added: string[]; removed: string[] } }>(
        "SELECT metadata FROM activity_logs WHERE action = 'user.roles_changed' AND entity_id = $1",
        [id]
      );
      expect(log.rows[0]?.metadata.added).toEqual(["ACCOUNTANT"]);
      expect([...(log.rows[0]?.metadata.removed ?? [])].sort()).toEqual(["EXECUTION", "INVOICING"]);    });

  });
});
