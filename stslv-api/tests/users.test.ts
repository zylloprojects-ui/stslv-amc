import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, bearer, closePool, loginToken, PASSWORD, resetData, roleId, signedIn } from "./helpers";

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
      .send({ email: "hash-check@example.com", fullName: "Hash Check", password: PASSWORD });
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
    const base = { email: "valid@example.com", fullName: "Valid", password: PASSWORD };

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

  it("assigns and removes roles, changing what the user may do", async () => {
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
      .send({ roleIds: [await roleId("INVOICING"), await roleId("ACCOUNTANT")] });

    expect(response.status).toBe(200);
    expect(response.body.data.roles.map((role: { code: string }) => role.code)).toEqual(["ACCOUNTANT", "INVOICING"]);

    const permissions = (await api().get("/api/auth/me").set(headers)).body.data.user.permissions;
    expect(permissions).toContain("INVOICES:CREATE");
    expect(permissions).not.toContain("AMC_EXECUTION:EDIT");

    const log = await pool.query<{ metadata: unknown }>(
      "SELECT metadata FROM activity_logs WHERE action = 'user.roles_changed' AND entity_id = $1",
      [id]
    );
    expect(log.rows[0]?.metadata).toEqual({ added: ["ACCOUNTANT", "INVOICING"], removed: ["EXECUTION"] });

    const cleared = await api().put(`/api/users/${id}/roles`).set(admin.headers).send({ roleIds: [] });
    expect(cleared.body.data.roles).toEqual([]);
    expect((await api().get("/api/clients").set(headers)).status).toBe(403);
  });

  it("resets a password: the new one works and the old one stops working", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "reset@example.com", fullName: "Reset Me", password: PASSWORD });
    const newPassword = "Freshly-Reset-Password-9";

    const response = await api()
      .post(`/api/users/${created.body.data.id}/reset-password`)
      .set(admin.headers)
      .send({ password: newPassword });

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(newPassword);
    expect((await api().post("/api/auth/login").send({ email: "reset@example.com", password: PASSWORD })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: "reset@example.com", password: newPassword })).status).toBe(200);
  });

  it("renames a user and returns 404 for an unknown user", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "rename@example.com", fullName: "Old Name", password: PASSWORD });

    const renamed = await api().patch(`/api/users/${created.body.data.id}`).set(admin.headers).send({ fullName: "New Name" });
    const missing = await api().patch("/api/users/999999").set(admin.headers).send({ fullName: "Nobody" });

    expect(renamed.body.data.fullName).toBe("New Name");
    expect(missing.status).toBe(404);
  });
});
