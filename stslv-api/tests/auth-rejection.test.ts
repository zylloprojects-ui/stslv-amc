import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { testOutbox } from "../src/shared/mailer";
import { api, closePool, insertUser, PASSWORD, resetData, roleId, signedIn } from "./helpers";

let admin: Awaited<ReturnType<typeof signedIn>>;

const SIGNUP_RESPONSE = {
  success: true,
  data: { message: "Your registration has been submitted. An administrator will review it before you can sign in." },
};

const NOT_PENDING = {
  success: false,
  error: { code: "CONFLICT", message: "Only a pending sign-up request can be rejected." },
};

const signup = (fullName: string, email: string, password = PASSWORD) =>
  api().post("/api/auth/signup").send({ fullName, email, password });
const login = (email: string, password = PASSWORD) => api().post("/api/auth/login").send({ email, password });
const reject = (id: string, headers = admin.headers) => api().post(`/api/users/${id}/reject`).set(headers);

async function userRow(email: string) {
  const result = await pool.query<{
    id: string;
    full_name: string;
    password_hash: string;
    is_active: boolean;
    approval_status: string;
    roles: string[];
  }>(
    `SELECT u.id, u.full_name, u.password_hash, u.is_active, u.approval_status,
            ARRAY(SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY r.code) AS roles
     FROM users u WHERE lower(u.email) = lower($1)`,
    [email]
  );

  return result.rows[0];
}

/** Submits a sign-up request and returns the id of the pending account. */
async function pendingUser(fullName: string, email: string): Promise<string> {
  expect((await signup(fullName, email)).status).toBe(202);

  return (await userRow(email))?.id as string;
}

/** Everything the audit log holds, as text. */
async function auditText(): Promise<string> {
  const logs = await pool.query<{ text: string }>("SELECT row_to_json(l)::text AS text FROM activity_logs l");

  return logs.rows.map((row) => row.text).join("\n");
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
});
beforeEach(() => {
  testOutbox.length = 0;
});
afterAll(closePool);

describe("POST /api/users/:id/reject", () => {
  it("lets an Admin reject a pending registration", async () => {
    const id = await pendingUser("Rita Rejected", "rita@example.com");
    const response = await reject(id);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id,
      email: "rita@example.com",
      fullName: "Rita Rejected",
      isActive: false,
      approvalStatus: "REJECTED",
      roles: [],
    });
    expect(JSON.stringify(response.body).toLowerCase()).not.toContain("password");
    expect(await userRow("rita@example.com")).toMatchObject({ is_active: false, approval_status: "REJECTED", roles: [] });
  });

  it("takes the registration out of the pending list", async () => {
    const waiting = await pendingUser("Wendy Waiting", "wendy@example.com");
    const list = await api().get("/api/users").set(admin.headers);
    const pending = list.body.data.filter((user: { approvalStatus: string }) => user.approvalStatus === "PENDING");

    expect(pending.map((user: { id: string }) => user.id)).toEqual([waiting]);
    expect(list.body.data.find((user: { email: string }) => user.email === "rita@example.com")).toMatchObject({
      approvalStatus: "REJECTED",
      isActive: false,
    });
  });

  it("does not let the rejected person sign in, and answers exactly as for a wrong password", async () => {
    const rejected = await login("rita@example.com");
    const wrong = await login("admin@example.com", "wrong-password");

    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual(wrong.body);
  });

  it("removes a role given while the request was pending", async () => {
    const id = await pendingUser("Rob Roled", "rob@example.com");

    await api()
      .put(`/api/users/${id}/roles`)
      .set(admin.headers)
      .send({ roleIds: [await roleId("ACCOUNTANT"), await roleId("PROCUREMENT")] });
    expect((await userRow("rob@example.com"))?.roles).toEqual(["ACCOUNTANT", "PROCUREMENT"]);

    const response = await reject(id);

    expect(response.body.data.roles).toEqual([]);
    expect((await userRow("rob@example.com"))?.roles).toEqual([]);
    expect((await pool.query("SELECT 1 FROM user_roles WHERE user_id = $1", [id])).rowCount).toBe(0);
  });

  it("cancels any password reset token of the account", async () => {
    const id = await pendingUser("Tara Token", "tara@example.com");
    const token = "a-token-that-was-issued-to-this-account-earlier";

    await pool.query(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
      [id, createHash("sha256").update(token).digest("hex")]
    );
    expect((await api().post("/api/auth/reset-password/check").send({ token })).body.data.status).toBe("invalid");

    await reject(id);

    const stored = await pool.query<{ revoked: boolean; used: boolean }>(
      "SELECT revoked_at IS NOT NULL AS revoked, used_at IS NOT NULL AS used FROM password_reset_tokens WHERE user_id = $1",
      [id]
    );
    expect(stored.rows).toEqual([{ revoked: true, used: false }]);

    const attempt = await api().post("/api/auth/reset-password").send({ token, password: "A-Brand-New-Password-7" });
    expect(attempt.status).toBe(400);
    expect(attempt.body.error.code).toBe("RESET_TOKEN_INVALID");

    // A rejected person cannot obtain a new link either.
    expect((await api().post("/api/auth/forgot-password").send({ email: "tara@example.com" })).status).toBe(200);
    expect(testOutbox).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM password_reset_tokens WHERE user_id = $1", [id])).rowCount).toBe(1);
  });

  it("records the rejection in the activity log, without any secret", async () => {
    const rob = await userRow("rob@example.com");
    const log = await pool.query<{ user_id: string; module: string; description: string; metadata: unknown }>(
      "SELECT user_id, module, description, metadata FROM activity_logs WHERE action = 'user.registration_rejected' AND entity_id = $1",
      [rob?.id]
    );

    expect(log.rows).toEqual([
      {
        user_id: admin.id,
        module: "USERS",
        description: 'Sign-up request of "Rob Roled" (rob@example.com) rejected.',
        metadata: { removedRoles: ["ACCOUNTANT", "PROCUREMENT"] },
      },
    ]);

    const text = await auditText();
    const hashes = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users");
    const tokens = await pool.query<{ token_hash: string }>("SELECT token_hash FROM password_reset_tokens");

    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("$2");
    expect(text).not.toContain("a-token-that-was-issued");
    for (const row of hashes.rows) expect(text).not.toContain(row.password_hash);
    for (const row of tokens.rows) expect(text).not.toContain(row.token_hash);
  });
});

describe("who may reject, and what may be rejected", () => {
  it("refuses a user without user-management permission, and a visitor", async () => {
    const id = (await userRow("wendy@example.com"))?.id as string;
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);

    const forbidden = await reject(id, accountant.headers);
    const anonymous = await api().post(`/api/users/${id}/reject`);

    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN");
    expect(anonymous.status).toBe(401);
    expect(await userRow("wendy@example.com")).toMatchObject({ approval_status: "PENDING", is_active: false });
    expect((await pool.query("SELECT 1 FROM activity_logs WHERE action = 'user.registration_rejected' AND entity_id = $1", [id])).rowCount).toBe(0);
  });

  it("refuses a user who may only view users", async () => {
    const id = (await userRow("wendy@example.com"))?.id as string;

    await pool.query("INSERT INTO roles (code, name) VALUES ('USER_VIEWER', 'User Viewer')");
    await pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, 'USERS', 'VIEW' FROM roles WHERE code = 'USER_VIEWER'");
    const viewer = await signedIn("viewer@example.com", ["USER_VIEWER"]);

    expect((await api().get("/api/users").set(viewer.headers)).status).toBe(200);
    expect((await reject(id, viewer.headers)).status).toBe(403);
    expect(await userRow("wendy@example.com")).toMatchObject({ approval_status: "PENDING" });
  });

  it("cannot reject an approved, active account: Admin-created, self-registered, or the Admin", async () => {
    const created = await api()
      .post("/api/users")
      .set(admin.headers)
      .send({ email: "created@example.com", fullName: "Created By Admin", password: PASSWORD, roleIds: [await roleId("EXECUTION")] });
    const approvedId = await pendingUser("Anna Approved", "anna@example.com");
    await api().put(`/api/users/${approvedId}/roles`).set(admin.headers).send({ roleIds: [await roleId("INVOICING")] });
    await api().post(`/api/users/${approvedId}/activate`).set(admin.headers);

    for (const [id, email, roles] of [
      [created.body.data.id, "created@example.com", ["EXECUTION"]],
      [approvedId, "anna@example.com", ["INVOICING"]],
      [admin.id, "admin@example.com", ["ADMIN"]],
    ] as const) {
      const response = await reject(id);

      expect(response.status, email).toBe(409);
      expect(response.body, email).toEqual(NOT_PENDING);
      expect(await userRow(email), email).toMatchObject({ approval_status: "APPROVED", is_active: true, roles });
      expect((await login(email)).status, email).toBe(200);
    }
  });

  it("cannot reject an approved account that has been deactivated", async () => {
    const id = await insertUser({ email: "leaver@example.com", roles: ["ACCOUNTANT"], isActive: false });
    const response = await reject(id);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(NOT_PENDING);
    expect(await userRow("leaver@example.com")).toMatchObject({ approval_status: "APPROVED", is_active: false, roles: ["ACCOUNTANT"] });
  });

  it("cannot reject the same registration twice, and reports an unknown user as not found", async () => {
    const id = (await userRow("rita@example.com"))?.id as string;

    expect((await reject(id)).status).toBe(409);
    expect((await reject("999999")).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM activity_logs WHERE action = 'user.registration_rejected' AND entity_id = $1", [id])).rowCount).toBe(1);
  });

  it("decides once when approve and reject arrive together", async () => {
    const id = await pendingUser("Rae Race", "rae@example.com");
    const [approval, rejection] = await Promise.all([api().post(`/api/users/${id}/activate`).set(admin.headers), reject(id)]);
    const row = await userRow("rae@example.com");

    expect([approval.status, rejection.status].sort()).toEqual([200, 409]);
    // Either approved and active, or rejected and inactive: never a mixture.
    expect([
      { approval_status: "APPROVED", is_active: true },
      { approval_status: "REJECTED", is_active: false },
    ]).toContainEqual({ approval_status: row?.approval_status, is_active: row?.is_active });
  });
});

describe("a rejected registration stays closed", () => {
  it("cannot be activated or given a role by an administrator", async () => {
    const id = (await userRow("rita@example.com"))?.id as string;

    const activate = await api().post(`/api/users/${id}/activate`).set(admin.headers);
    const roles = await api()
      .put(`/api/users/${id}/roles`)
      .set(admin.headers)
      .send({ roleIds: [await roleId("ACCOUNTANT")] });

    expect(activate.status).toBe(409);
    expect(roles.status).toBe(409);
    expect(await userRow("rita@example.com")).toMatchObject({ approval_status: "REJECTED", is_active: false, roles: [] });
  });

  it("cannot be made active directly in the database", async () => {
    await expect(pool.query("UPDATE users SET is_active = true WHERE email = 'rita@example.com'")).rejects.toMatchObject({
      code: "23514",
      constraint: "users_unapproved_inactive_ck",
    });
    await expect(pool.query("UPDATE users SET approval_status = 'BANNED' WHERE email = 'rita@example.com'")).rejects.toMatchObject({
      code: "23514",
      constraint: "users_approval_status_ck",
    });
  });
});

describe("signing up again after a rejection", () => {
  it("answers exactly as for a new email", async () => {
    const again = await signup("Rita Returns", "RITA@example.com", "A-Second-Password-22");
    const fresh = await signup("Nora New", "nora@example.com");

    expect(again.status).toBe(fresh.status);
    expect(again.body).toEqual(fresh.body);
    expect(again.body).toEqual(SIGNUP_RESPONSE);
    // Nothing is emailed in either case.
    expect(testOutbox).toHaveLength(0);
  });

  it("puts the same account back to pending: inactive, no role, new details, no access", async () => {
    const row = await userRow("rita@example.com");

    expect(row).toMatchObject({ full_name: "Rita Returns", approval_status: "PENDING", is_active: false, roles: [] });
    expect((await pool.query("SELECT 1 FROM users WHERE lower(email) = 'rita@example.com'")).rowCount).toBe(1);
    expect(row?.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);

    // Still no way in: not with the new password, not with the old one.
    expect((await login("rita@example.com", "A-Second-Password-22")).status).toBe(401);
    expect((await login("rita@example.com", PASSWORD)).status).toBe(401);

    const log = await pool.query<{ user_id: string; metadata: unknown }>(
      "SELECT user_id, metadata FROM activity_logs WHERE action = 'auth.signup_submitted' AND entity_id = $1 ORDER BY id",
      [row?.id]
    );
    expect(log.rows).toEqual([
      { user_id: row?.id, metadata: { source: "sign-up page" } },
      { user_id: row?.id, metadata: { source: "sign-up page", previouslyRejected: true } },
    ]);
    expect(await auditText()).not.toContain("A-Second-Password-22");
  });

  it("needs an administrator again: approval gives access with the newly chosen password only", async () => {
    const id = (await userRow("rita@example.com"))?.id as string;

    await api().put(`/api/users/${id}/roles`).set(admin.headers).send({ roleIds: [await roleId("EXECUTION")] });
    const approved = await api().post(`/api/users/${id}/activate`).set(admin.headers);

    expect(approved.body.data).toMatchObject({ isActive: true, approvalStatus: "APPROVED", roles: [{ code: "EXECUTION" }] });
    expect((await login("rita@example.com", PASSWORD)).status).toBe(401);
    expect((await login("rita@example.com", "A-Second-Password-22")).status).toBe(200);
  });

  it("never downgrades an approved account, active or deactivated", async () => {
    for (const email of ["rita@example.com", "created@example.com", "admin@example.com", "leaver@example.com"]) {
      const before = await userRow(email);
      const response = await signup("Someone Else", email.toUpperCase(), "An-Attacker-Password-33");

      expect(response.status, email).toBe(202);
      expect(response.body, email).toEqual(SIGNUP_RESPONSE);
      // Same name, same password hash, same status, same roles.
      expect(await userRow(email), email).toEqual(before);
      expect(before?.approval_status, email).toBe("APPROVED");
    }
    expect((await login("admin@example.com")).status).toBe(200);
    expect((await login("admin@example.com", "An-Attacker-Password-33")).status).toBe(401);
  });

  it("does not let a second request overwrite one that is already pending", async () => {
    const before = await userRow("wendy@example.com");
    const response = await signup("Not Wendy", "wendy@example.com", "An-Attacker-Password-33");

    expect(response.body).toEqual(SIGNUP_RESPONSE);
    expect(await userRow("wendy@example.com")).toEqual(before);
  });

  it("gives the same public response for a new, pending, approved and rejected email", async () => {
    const rejectedId = await pendingUser("Quinn Quiet", "quinn@example.com");
    await reject(rejectedId);

    const responses = await Promise.all([
      signup("Brand New", "brand.new@example.com"),
      signup("Pending Again", "wendy@example.com"),
      signup("Approved Again", "admin@example.com"),
      signup("Rejected Again", "quinn@example.com"),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(202);
      expect(response.body).toEqual(SIGNUP_RESPONSE);
      expect(Object.keys(response.headers).sort()).toEqual(Object.keys(responses[0]?.headers ?? {}).sort());
    }
  });

  it("refuses a role, permission or status sent with the new request", async () => {
    const id = await pendingUser("Eve Escalator", "eve@example.com");
    await reject(id);

    for (const extra of [{ roleIds: [await roleId("ADMIN")] }, { role: "ADMIN" }, { isActive: true }, { approvalStatus: "APPROVED" }]) {
      const response = await api()
        .post("/api/auth/signup")
        .send({ fullName: "Eve Escalator", email: "eve@example.com", password: PASSWORD, ...extra });

      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await userRow("eve@example.com")).toMatchObject({ approval_status: "REJECTED", is_active: false, roles: [] });
    expect((await pool.query("SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'ADMIN'")).rowCount).toBe(1);
  });
});
