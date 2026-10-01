import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { testOutbox } from "../src/shared/mailer";
import { api, bearer, closePool, loginToken, PASSWORD, resetData, roleId, signedIn } from "./helpers";

let admin: Awaited<ReturnType<typeof signedIn>>;

const SIGNUP_RESPONSE = {
  success: true,
  data: { message: "Your registration has been submitted. An administrator will review it before you can sign in." },
};

const signup = (body: Record<string, unknown>) => api().post("/api/auth/signup").send(body);

async function userRow(email: string) {
  const result = await pool.query<{
    id: string;
    full_name: string;
    password_hash: string;
    is_active: boolean;
    approval_status: string;
    roles: number;
  }>(
    `SELECT u.id, u.full_name, u.password_hash, u.is_active, u.approval_status,
            (SELECT count(*)::int FROM user_roles ur WHERE ur.user_id = u.id) AS roles
     FROM users u WHERE lower(u.email) = lower($1)`,
    [email]
  );

  return result.rows[0];
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
beforeEach(() => {
  testOutbox.length = 0;
});
afterAll(closePool);

describe("POST /api/auth/signup", () => {
  it("records a pending, inactive account with no role, and returns no session", async () => {
    const response = await signup({ fullName: "  New Person ", email: " New.Person@Example.com ", password: PASSWORD });

    expect(response.status).toBe(202);
    expect(response.body).toEqual(SIGNUP_RESPONSE);

    const row = await userRow("new.person@example.com");

    expect(row).toMatchObject({ full_name: "New Person", is_active: false, approval_status: "PENDING", roles: 0 });
    // The response carries no token and no account data.
    expect(JSON.stringify(response.body)).not.toMatch(/token|"id"|permissions/i);
  });

  it("stores a bcrypt hash, never the password, and logs neither", async () => {
    const row = await userRow("new.person@example.com");

    expect(row?.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(row?.password_hash).not.toContain(PASSWORD);

    const logs = await pool.query<{ user_id: string; entity_id: string; text: string }>(
      `SELECT user_id, entity_id, coalesce(description, '') || coalesce(metadata::text, '') AS text
       FROM activity_logs WHERE action = 'auth.signup_submitted'`
    );

    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({ user_id: row?.id, entity_id: row?.id });
    expect(logs.rows[0]?.text).not.toContain(PASSWORD);
    expect(logs.rows[0]?.text).not.toContain("$2");
  });

  it("rejects an invalid email, a weak or over-long password and a missing name, creating nothing", async () => {
    const base = { fullName: "Valid Name", email: "valid@example.com", password: PASSWORD };

    const badEmail = await signup({ ...base, email: "not-an-email" });
    const noEmail = await signup({ ...base, email: "" });
    const weak = await signup({ ...base, password: "short" });
    const tooLong = await signup({ ...base, password: "x".repeat(73) });
    const noPassword = await signup({ fullName: base.fullName, email: base.email });
    const noName = await signup({ ...base, fullName: "   " });

    for (const response of [badEmail, noEmail, weak, tooLong, noPassword, noName]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(badEmail.body.error.details).toEqual([{ field: "email", message: "Enter a valid email address." }]);
    expect(weak.body.error.details).toEqual([{ field: "password", message: "Password must be at least 10 characters." }]);
    expect(await userRow("valid@example.com")).toBeUndefined();
  });

  it("refuses a self-selected role, permission or status instead of applying it", async () => {
    const base = { fullName: "Escalator", email: "escalator@example.com", password: PASSWORD };
    const adminRoleId = await roleId("ADMIN");

    for (const extra of [
      { roleIds: [adminRoleId] },
      { role: "ADMIN" },
      { roles: ["ADMIN"] },
      { permissions: ["USERS:EDIT"] },
      { isActive: true },
      { is_active: true },
      { approvalStatus: "APPROVED" },
    ]) {
      const response = await signup({ ...base, ...extra });

      expect(response.status, JSON.stringify(extra)).toBe(400);
    }

    expect(await userRow("escalator@example.com")).toBeUndefined();
    expect((await pool.query("SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'ADMIN'")).rowCount).toBe(1);
  });

  it("answers a duplicate email exactly like a new one, and leaves the existing account untouched", async () => {
    const before = await userRow("admin@example.com");
    const duplicate = await signup({ fullName: "Impostor", email: "ADMIN@example.com", password: "Another-Password-99" });
    const fresh = await signup({ fullName: "Fresh Person", email: "fresh@example.com", password: PASSWORD });

    expect(duplicate.status).toBe(fresh.status);
    expect(duplicate.body).toEqual(fresh.body);
    expect(duplicate.body).toEqual(SIGNUP_RESPONSE);

    // Same name, same password, still active, still Admin.
    expect(await userRow("admin@example.com")).toEqual(before);
    expect((await pool.query("SELECT 1 FROM users WHERE lower(email) = 'admin@example.com'")).rowCount).toBe(1);
    expect((await api().post("/api/auth/login").send({ email: "admin@example.com", password: PASSWORD })).status).toBe(200);
    expect(
      (await api().post("/api/auth/login").send({ email: "admin@example.com", password: "Another-Password-99" })).status
    ).toBe(401);

    // The attempt is audited, and only the owner of the address is told.
    const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'auth.signup_duplicate' AND entity_id = $1", [
      before?.id,
    ]);
    expect(log.rowCount).toBe(1);
    expect(testOutbox.map((message) => message.to)).toEqual(["admin@example.com"]);
    expect(testOutbox[0]?.text).not.toContain("Another-Password-99");
  });

  it("does not let a second sign-up overwrite a pending one", async () => {
    const before = await userRow("fresh@example.com");
    const again = await signup({ fullName: "Someone Else", email: "fresh@example.com", password: "Different-Password-1" });

    expect(again.body).toEqual(SIGNUP_RESPONSE);
    expect(await userRow("fresh@example.com")).toEqual(before);
  });
});

describe("a pending sign-up has no access", () => {
  it("cannot sign in, and gets the same answer as a wrong password", async () => {
    const pending = await api().post("/api/auth/login").send({ email: "new.person@example.com", password: PASSWORD });
    const wrong = await api().post("/api/auth/login").send({ email: "admin@example.com", password: "wrong-password" });

    expect(pending.status).toBe(401);
    expect(pending.body).toEqual(wrong.body);
    expect(pending.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("cannot obtain a password reset link", async () => {
    const response = await api().post("/api/auth/forgot-password").send({ email: "new.person@example.com" });

    expect(response.status).toBe(200);
    expect(testOutbox).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM password_reset_tokens")).rowCount).toBe(0);
  });

  it("cannot be made active while pending, even directly in the database", async () => {
    await expect(
      pool.query("UPDATE users SET is_active = true WHERE lower(email) = 'new.person@example.com'")
    ).rejects.toMatchObject({ code: "23514", constraint: "users_pending_inactive_ck" });
  });
});

describe("administrator approval in Users & Access", () => {
  it("lists the request as pending, with no role", async () => {
    const response = await api().get("/api/users").set(admin.headers);
    const pending = response.body.data.find((user: { email: string }) => user.email === "new.person@example.com");
    const adminRow = response.body.data.find((user: { email: string }) => user.email === "admin@example.com");

    expect(pending).toMatchObject({ fullName: "New Person", isActive: false, approvalStatus: "PENDING", roles: [], lastLoginAt: null });
    expect(adminRow).toMatchObject({ isActive: true, approvalStatus: "APPROVED" });
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain("password");
  });

  it("lets an Admin assign a role and activate; the person can then sign in with that role only", async () => {
    const id = (await userRow("new.person@example.com"))?.id as string;

    const roles = await api()
      .put(`/api/users/${id}/roles`)
      .set(admin.headers)
      .send({ roleIds: [await roleId("PROCUREMENT")] });

    expect(roles.status).toBe(200);
    // A role alone does not open the account.
    expect(roles.body.data).toMatchObject({ isActive: false, approvalStatus: "PENDING" });
    expect((await api().post("/api/auth/login").send({ email: "new.person@example.com", password: PASSWORD })).status).toBe(401);

    const activated = await api().post(`/api/users/${id}/activate`).set(admin.headers);

    expect(activated.status).toBe(200);
    expect(activated.body.data).toMatchObject({ isActive: true, approvalStatus: "APPROVED", roles: [{ code: "PROCUREMENT" }] });

    const login = await api().post("/api/auth/login").send({ email: "new.person@example.com", password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.data.user.roles.map((role: { code: string }) => role.code)).toEqual(["PROCUREMENT"]);
    expect(login.body.data.user.permissions).toContain("PROCUREMENT:CREATE");
    expect(login.body.data.user.permissions).not.toContain("USERS:VIEW");
    expect((await api().get("/api/users").set(bearer(login.body.data.token))).status).toBe(403);

    const log = await pool.query<{ user_id: string; metadata: unknown }>(
      "SELECT user_id, metadata FROM activity_logs WHERE action = 'user.registration_approved' AND entity_id = $1",
      [id]
    );
    expect(log.rows).toEqual([{ user_id: admin.id, metadata: { roles: ["PROCUREMENT"] } }]);
  });

  it("treats a later deactivation and reactivation as ordinary, not as a new approval", async () => {
    const id = (await userRow("new.person@example.com"))?.id as string;

    const deactivated = await api().post(`/api/users/${id}/deactivate`).set(admin.headers);
    expect(deactivated.body.data).toMatchObject({ isActive: false, approvalStatus: "APPROVED" });
    expect((await api().post("/api/auth/login").send({ email: "new.person@example.com", password: PASSWORD })).status).toBe(401);

    const reactivated = await api().post(`/api/users/${id}/activate`).set(admin.headers);
    expect(reactivated.body.data).toMatchObject({ isActive: true, approvalStatus: "APPROVED" });

    const actions = await pool.query<{ action: string }>(
      "SELECT action FROM activity_logs WHERE entity_type = 'users' AND entity_id = $1 AND user_id = $2 ORDER BY id",
      [id, admin.id]
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      "user.roles_changed",
      "user.registration_approved",
      "user.deactivated",
      "user.activated",
    ]);
  });

  it("gives an account approved without a role no access at all", async () => {
    const id = (await userRow("fresh@example.com"))?.id as string;

    await api().post(`/api/users/${id}/activate`).set(admin.headers);

    const headers = bearer(await loginToken("fresh@example.com"));

    expect((await api().get("/api/auth/me").set(headers)).body.data.user.permissions).toEqual([]);
    for (const path of ["/api/clients", "/api/users", "/api/dashboard/summary", "/api/projects"]) {
      expect((await api().get(path).set(headers)).status, path).toBe(403);
    }
  });

  it("does not let a user without user-management permission approve a sign-up", async () => {
    await signup({ fullName: "Waiting Person", email: "waiting@example.com", password: PASSWORD });
    const id = (await userRow("waiting@example.com"))?.id as string;
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);

    expect((await api().post(`/api/users/${id}/activate`).set(accountant.headers)).status).toBe(403);
    expect((await api().post(`/api/users/${id}/activate`)).status).toBe(401);
    expect(await userRow("waiting@example.com")).toMatchObject({ is_active: false, approval_status: "PENDING" });
  });
});

describe("administrator-created users are unaffected", () => {
  it("are created approved and active, and can sign in at once", async () => {
    const response = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "created@example.com", fullName: "Created By Admin", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ isActive: true, approvalStatus: "APPROVED", roles: [{ code: "EXECUTION" }] });
    expect((await api().post("/api/auth/login").send({ email: "created@example.com", password: PASSWORD })).status).toBe(200);
  });

  it("still reports a duplicate email to the administrator", async () => {
    const response = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "waiting@example.com", fullName: "Duplicate", password: PASSWORD });

    expect(response.status).toBe(409);
  });
});
