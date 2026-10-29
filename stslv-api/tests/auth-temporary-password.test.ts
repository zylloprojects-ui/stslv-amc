import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "../src/config/database";
import { env, resolveMailTransport } from "../src/config/env";
import { rateLimit } from "../src/middleware/rate-limit";
import { generateTemporaryPassword } from "../src/modules/auth/temporary-password";
import { errorHandler } from "../src/shared/errors";
import { createMailer } from "../src/shared/mailer";
import { api, bearer, closePool, insertUser, loginToken, PASSWORD, resetData, signedIn } from "./helpers";

const NEW_PASSWORD = "A-Brand-New-Password-7";
const TEMPORARY_FORMAT = /^[A-HJ-NP-RT-Za-km-np-rt-z2346789]{4}(-[A-HJ-NP-RT-Za-km-np-rt-z2346789]{4}){3}$/;

const login = (email: string, password: string) => api().post("/api/auth/login").send({ email, password });
const issue = (headers: { Authorization: string }, userId: string, body: object = { identityVerified: true }) =>
  api().post(`/api/users/${userId}/temporary-password`).set(headers).send(body);
const complete = (token: string, newPassword: unknown = NEW_PASSWORD) =>
  api().post("/api/auth/complete-password-change").set(bearer(token)).send({ newPassword });

let admin: { id: string; headers: { Authorization: string } };
let secondAdmin: { id: string; headers: { Authorization: string } };

/** A fresh active Accountant, so each test starts from a normal account. */
async function employee(email: string): Promise<string> {
  return insertUser({ email, fullName: `Employee ${email}`, roles: ["ACCOUNTANT"] });
}

/** Issues a temporary password as the first admin and returns it. */
async function temporaryFor(userId: string): Promise<string> {
  const response = await issue(admin.headers, userId);

  expect(response.status).toBe(200);
  return response.body.data.temporaryPassword as string;
}

async function userState(id: string) {
  const result = await pool.query<{ must_change_password: boolean; expires_at: Date | null; minutes: number | null; password_hash: string }>(
    `SELECT must_change_password, temporary_password_expires_at AS expires_at, password_hash,
            round(extract(epoch FROM temporary_password_expires_at - now()) / 60)::int AS minutes
     FROM users WHERE id = $1`,
    [id]
  );

  return result.rows[0];
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  secondAdmin = await signedIn("second.admin@example.com", ["ADMIN"]);
});
afterAll(closePool);

describe("issuing a temporary password", () => {
  it("returns a random password once, valid for 15 minutes, and stores only its hash", async () => {
    const id = await employee("issue@example.com");
    const response = await issue(admin.headers, id);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data.temporaryPassword).toMatch(TEMPORARY_FORMAT);
    expect(Date.parse(response.body.data.expiresAt)).toBeGreaterThan(Date.now() + 14 * 60_000);

    const state = await userState(id);

    expect(state?.must_change_password).toBe(true);
    expect(state?.minutes).toBe(15);
    expect(state?.password_hash).toMatch(/^\$2[aby]\$/);
    expect(state?.password_hash).not.toContain(response.body.data.temporaryPassword);
    // The users list shows that a temporary password is outstanding, never the password.
    const listed = (await api().get("/api/users").set(admin.headers)).body.data.find((user: { id: string }) => user.id === id);

    expect(listed.temporaryCredentialExpiresAt).toBe(response.body.data.expiresAt);
    expect(JSON.stringify(listed)).not.toContain(response.body.data.temporaryPassword);
  });

  it("generates unpredictable passwords from the unambiguous alphabet", () => {
    const samples = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));

    expect(samples.size).toBe(200);
    for (const sample of samples) {
      expect(sample).toMatch(TEMPORARY_FORMAT);
    }
  });

  it("stops the old password working and signs the user out of every existing session", async () => {
    const id = await employee("sessions@example.com");
    const oldSession = await loginToken("sessions@example.com");

    expect((await api().get("/api/clients").set(bearer(oldSession))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await temporaryFor(id);

    expect((await api().get("/api/auth/me").set(bearer(oldSession))).status).toBe(401);
    expect((await login("sessions@example.com", PASSWORD)).status).toBe(401);
  });

  it("requires the administrator to confirm the person's identity", async () => {
    const id = await employee("identity@example.com");

    for (const body of [{}, { identityVerified: false }, { identityVerified: "yes" }, { identityVerified: true, password: "Chosen-By-Admin-1" }]) {
      expect((await issue(admin.headers, id, body)).status).toBe(400);
    }
    expect((await userState(id))?.must_change_password).toBe(false);
  });

  it("invalidates the previous temporary password when a new one is issued", async () => {
    const id = await employee("reissue@example.com");
    const first = await temporaryFor(id);
    const firstSession = (await login("reissue@example.com", first)).body.data.token as string;

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await temporaryFor(id);

    expect(second).not.toBe(first);
    expect((await login("reissue@example.com", first)).status).toBe(401);
    expect((await api().get("/api/auth/me").set(bearer(firstSession))).status).toBe(401);
    expect((await login("reissue@example.com", second)).status).toBe(200);
  });

  it("is refused for deactivated and unapproved accounts", async () => {
    const inactive = await insertUser({ email: "inactive@example.com", roles: ["ACCOUNTANT"], isActive: false });
    const pending = await pool.query<{ id: string }>(
      "INSERT INTO users (email, full_name, password_hash, is_active, approval_status) VALUES ('pending@example.com', 'Pending', 'not-a-real-hash-pending', false, 'PENDING') RETURNING id"
    );

    const deactivated = await issue(admin.headers, inactive);
    const unapproved = await issue(admin.headers, pending.rows[0]!.id);

    expect(deactivated.status).toBe(409);
    expect(deactivated.body.error.message).toMatch(/deactivated/);
    expect(unapproved.status).toBe(409);
    expect(unapproved.body.error.message).toMatch(/not been approved/);
  });

  it("does not let a deactivated account sign in with an outstanding temporary password", async () => {
    const id = await employee("later-deactivated@example.com");
    const temporary = await temporaryFor(id);

    await api().post(`/api/users/${id}/deactivate`).set(admin.headers);

    const response = await login("later-deactivated@example.com", temporary);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 404 for an unknown user", async () => {
    expect((await issue(admin.headers, "999999")).status).toBe(404);
  });
});

describe("who may issue a temporary password", () => {
  it("refuses an administrator's own account", async () => {
    const response = await issue(admin.headers, admin.id);

    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/your own account/);
    expect((await userState(admin.id))?.must_change_password).toBe(false);
  });

  it("lets another administrator recover an administrator, who must then change it", async () => {
    const lockedOut = await signedIn("locked.admin@example.com", ["ADMIN"]);
    const response = await issue(secondAdmin.headers, lockedOut.id);
    const session = await login("locked.admin@example.com", response.body.data.temporaryPassword);

    expect(response.status).toBe(200);
    expect(session.body.data.user.credentialChangeRequired).toBe(true);
    // Holding every permission does not let them past the change-password screen.
    expect((await api().get("/api/users").set(bearer(session.body.data.token))).status).toBe(403);
  });

  it("refuses roles without user editing", async () => {
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
    const target = await employee("target1@example.com");

    expect((await issue(accountant.headers, target)).status).toBe(403);
    expect((await issue(accountant.headers, accountant.id)).status).toBe(403);
    expect((await userState(target))?.must_change_password).toBe(false);
  });

  it("refuses a non-Admin role even when it is granted USERS:EDIT", async () => {
    await pool.query(
      `INSERT INTO roles (code, name, description) VALUES ('USER_EDITOR', 'User editor', 'Test role')`
    );
    await pool.query(
      `INSERT INTO role_permissions (role_id, module, action)
       SELECT id, 'USERS', unnest(ARRAY['VIEW', 'EDIT']) FROM roles WHERE code = 'USER_EDITOR'`
    );
    const editor = await signedIn("user.editor@example.com", ["USER_EDITOR", "ACCOUNTANT"]);
    const target = await employee("target2@example.com");
    const response = await issue(editor.headers, target);

    expect(response.status).toBe(403);
    expect(response.body.error.message).toBe("Only an administrator can issue a temporary password.");
    expect((await userState(target))?.must_change_password).toBe(false);
  });

  it("refuses a request without a session", async () => {
    const target = await employee("target3@example.com");

    expect((await api().post(`/api/users/${target}/temporary-password`).send({ identityVerified: true })).status).toBe(401);
  });

  it("limits how many temporary passwords one administrator can issue", async () => {
    const limiter = await signedIn("limited.admin@example.com", ["ADMIN"]);
    const target = await employee("limited.target@example.com");
    const configured = env.temporaryPasswordRateLimit;

    env.temporaryPasswordRateLimit = 2;
    try {
      const statuses = [];

      for (let attempt = 0; attempt < 4; attempt += 1) {
        statuses.push((await issue(limiter.headers, target)).status);
      }
      expect(statuses).toEqual([200, 200, 429, 429]);
      // Counted per administrator: another administrator is not blocked.
      expect((await issue(secondAdmin.headers, target)).status).toBe(200);
    } finally {
      env.temporaryPasswordRateLimit = configured;
    }
  });
});

describe("signing in with a temporary password", () => {
  it("signs in, but only the change-password screen is open", async () => {
    const id = await employee("forced@example.com");
    const temporary = await temporaryFor(id);
    const session = await login("forced@example.com", temporary);
    const token = session.body.data.token as string;

    expect(session.status).toBe(200);
    expect(session.body.data.user.credentialChangeRequired).toBe(true);
    expect((await api().get("/api/auth/me").set(bearer(token))).body.data.user.credentialChangeRequired).toBe(true);

    // Direct API calls to any other protected route are refused.
    const blocked = [
      await api().get("/api/clients").set(bearer(token)),
      await api().get("/api/dashboard/summary").set(bearer(token)),
      await api().get("/api/amc/contracts").set(bearer(token)),
      await api().post("/api/clients").set(bearer(token)).send({ name: "Sneaky" }),
      await api().post("/api/auth/change-password").set(bearer(token)).send({ currentPassword: temporary, newPassword: NEW_PASSWORD }),
    ];

    for (const response of blocked) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    }
  });

  it("sets the new password, ends every session and lets the user sign in normally", async () => {
    const id = await employee("complete@example.com");
    const temporary = await temporaryFor(id);
    const token = (await login("complete@example.com", temporary)).body.data.token as string;
    const response = await complete(token);

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(NEW_PASSWORD);

    const state = await userState(id);

    expect(state?.must_change_password).toBe(false);
    expect(state?.expires_at).toBeNull();

    // The temporary-password session ends at once, even within the same second.
    expect((await api().get("/api/auth/me").set(bearer(token))).status).toBe(401);
    expect((await complete(token, "Yet-Another-Password-8")).status).toBe(401);

    // The temporary password no longer works; the new one does, normally.
    expect((await login("complete@example.com", temporary)).status).toBe(401);
    const normal = await login("complete@example.com", NEW_PASSWORD);

    expect(normal.status).toBe(200);
    expect(normal.body.data.user.credentialChangeRequired).toBe(false);
    expect((await api().get("/api/clients").set(bearer(normal.body.data.token))).status).toBe(200);
  });

  it("validates the new password", async () => {
    const id = await employee("validate@example.com");
    const temporary = await temporaryFor(id);
    const token = (await login("validate@example.com", temporary)).body.data.token as string;

    expect((await complete(token, "short")).status).toBe(400);
    expect((await api().post("/api/auth/complete-password-change").set(bearer(token)).send({})).status).toBe(400);

    const same = await complete(token, temporary);

    expect(same.status).toBe(400);
    expect(same.body.error.details).toEqual([{ field: "newPassword", message: "Choose a password different from the temporary one." }]);
    expect((await userState(id))?.must_change_password).toBe(true);
  });

  it("refuses an expired temporary password, at sign-in and mid-change", async () => {
    const id = await employee("expired@example.com");
    const temporary = await temporaryFor(id);
    const token = (await login("expired@example.com", temporary)).body.data.token as string;

    await pool.query("UPDATE users SET temporary_password_expires_at = now() - interval '1 second' WHERE id = $1", [id]);

    const signIn = await login("expired@example.com", temporary);

    expect(signIn.status).toBe(401);
    expect(signIn.body.error).toEqual({
      code: "TEMPORARY_PASSWORD_EXPIRED",
      message: "Your temporary password has expired. Ask your administrator for a new one.",
    });
    expect((await complete(token)).status).toBe(401);
    expect((await api().get("/api/auth/me").set(bearer(token))).status).toBe(401);
    // A wrong password still gets the ordinary answer, so expiry is not revealed to a guesser.
    expect((await login("expired@example.com", "Not-The-Password-1")).body.error.code).toBe("INVALID_CREDENTIALS");
    expect((await userState(id))?.must_change_password).toBe(true);
  });

  it("refuses the forced-change route to a normal session", async () => {
    const token = await loginToken("admin@example.com");
    const response = await complete(token);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PASSWORD_CHANGE_NOT_REQUIRED");
  });

  it("keeps normal sign-in, sessions and My account password change working", async () => {
    await employee("normal@example.com");
    const session = await login("normal@example.com", PASSWORD);

    expect(session.status).toBe(200);
    expect(session.body.data.user.credentialChangeRequired).toBe(false);
    expect((await api().get("/api/clients").set(bearer(session.body.data.token))).status).toBe(200);

    const changed = await api()
      .post("/api/auth/change-password")
      .set(bearer(session.body.data.token))
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(changed.status).toBe(200);
    expect((await login("normal@example.com", NEW_PASSWORD)).status).toBe(200);
  });
});

describe("audit trail", () => {
  it("records who issued it, for whom and when, and never a password", async () => {
    const id = await employee("audited@example.com");
    const temporary = await temporaryFor(id);
    const token = (await login("audited@example.com", temporary)).body.data.token as string;

    await complete(token);

    const entries = await pool.query<{ action: string; user_id: string | null; entity_id: string; description: string; metadata: Record<string, unknown> | null; created_at: Date }>(
      `SELECT action, user_id, entity_id, description, metadata, created_at FROM activity_logs
       WHERE entity_id = $1 AND action IN ('user.temporary_password_issued', 'auth.login', 'auth.temporary_password_replaced')
       ORDER BY id`,
      [id]
    );

    expect(entries.rows.map((row) => row.action)).toEqual(["user.temporary_password_issued", "auth.login", "auth.temporary_password_replaced"]);
    expect(entries.rows[0]).toMatchObject({
      user_id: admin.id,
      description: 'Temporary password issued for user "Employee audited@example.com" (audited@example.com).',
      metadata: { identityVerified: true, expiresAt: expect.any(String) },
    });
    expect(entries.rows[0]?.created_at).toBeInstanceOf(Date);
    expect(entries.rows[1]?.metadata).toMatchObject({ temporaryPassword: true });
    expect(entries.rows[2]?.user_id).toBe(id);

    const everything = await pool.query<{ text: string }>("SELECT row_to_json(l)::text AS text FROM activity_logs l");
    const hashes = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users");

    for (const row of everything.rows) {
      expect(row.text).not.toContain(temporary);
      expect(row.text).not.toContain(NEW_PASSWORD);
      for (const hash of hashes.rows) expect(row.text).not.toContain(hash.password_hash);
    }
  });

  it("records an expired temporary password as its own sign-in failure reason", async () => {
    const id = await employee("expired.audit@example.com");
    const temporary = await temporaryFor(id);

    await pool.query("UPDATE users SET temporary_password_expires_at = now() - interval '1 second' WHERE id = $1", [id]);
    await login("expired.audit@example.com", temporary);

    const entry = await pool.query<{ metadata: { reason: string } }>(
      "SELECT metadata FROM activity_logs WHERE action = 'auth.login_failed' AND entity_id = $1",
      [id]
    );

    expect(entry.rows.map((row) => row.metadata.reason)).toEqual(["temporary_password_expired"]);
  });
});

describe("retired email recovery", () => {
  it("no longer offers the email reset routes, or the administrator-chosen password route", async () => {
    const target = await employee("retired@example.com");

    expect((await api().post("/api/auth/forgot-password").send({ email: "retired@example.com" })).status).toBe(404);
    expect((await api().post("/api/auth/reset-password/check").send({ token: "x" })).status).toBe(404);
    expect((await api().post("/api/auth/reset-password").send({ token: "x", password: NEW_PASSWORD })).status).toBe(404);
    expect((await api().post(`/api/users/${target}/reset-password`).set(admin.headers).send({ password: NEW_PASSWORD })).status).toBe(404);
  });
});

describe("email delivery boundary", () => {
  it("never allows the console transport in production", () => {
    expect(() => resolveMailTransport("log", "production")).toThrow(/not allowed in production/);
    expect(resolveMailTransport("log", "development")).toBe("log");
    expect(resolveMailTransport("log", undefined)).toBe("log");
  });

  it("sends nothing unless a transport is chosen, and keeps the test transport to the tests", () => {
    expect(resolveMailTransport(undefined, "production")).toBe("none");
    expect(resolveMailTransport(undefined, undefined)).toBe("none");
    expect(resolveMailTransport("", "development")).toBe("none");
    expect(resolveMailTransport(undefined, "test")).toBe("memory");
    expect(() => resolveMailTransport("memory", "production")).toThrow(/only for the automated tests/);
    expect(() => resolveMailTransport("smtp", "production")).toThrow(/Invalid MAIL_TRANSPORT/);
  });

  it("does not print the content or the recipient when email is not configured", async () => {
    const message = { to: "member@example.com", subject: "STSLEV AMC account request", text: "SECRET body" };
    const outputs = [vi.spyOn(console, "warn"), vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];

    for (const output of outputs) {
      output.mockImplementation(() => {});
    }

    try {
      await createMailer("none").send(message);

      const printed = outputs.flatMap((output) => output.mock.calls.flat()).join("\n");

      expect(printed).toContain("Email not sent");
      expect(printed).not.toContain("SECRET");
      expect(printed).not.toContain("member@example.com");
    } finally {
      for (const output of outputs) {
        output.mockRestore();
      }
    }
  });
});

describe("public route rate limit", () => {
  it("refuses an address that exceeds the limit, with the standard error shape", async () => {
    const limited = express();

    limited.post("/limited", rateLimit({ windowMs: 60_000, max: 3 }), (_req, res) => {
      res.json({ success: true });
    });
    limited.use(errorHandler);

    const statuses: number[] = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await request(limited).post("/limited")).status);
    }

    const blocked = await request(limited).post("/limited");

    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(blocked.body).toEqual({
      success: false,
      error: { code: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait a few minutes and try again." },
    });
  });

  it("lets the address through again once the window has passed", async () => {
    const limited = express();

    limited.post("/limited", rateLimit({ windowMs: 150, max: 1 }), (_req, res) => {
      res.json({ success: true });
    });
    limited.use(errorHandler);

    expect((await request(limited).post("/limited")).status).toBe(200);
    expect((await request(limited).post("/limited")).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await request(limited).post("/limited")).status).toBe(200);
  });
});
