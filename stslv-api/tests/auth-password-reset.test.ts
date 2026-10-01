import { createHash } from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../src/config/database";
import { resolveMailTransport } from "../src/config/env";
import { rateLimit } from "../src/middleware/rate-limit";
import { errorHandler } from "../src/shared/errors";
import { createMailer, testOutbox } from "../src/shared/mailer";
import { api, bearer, closePool, insertUser, loginToken, PASSWORD, resetData, signedIn } from "./helpers";

const NEW_PASSWORD = "A-Brand-New-Password-7";

const RESET_RESPONSE = {
  success: true,
  data: { message: "If an active account exists for that email, a password reset link has been sent to it." },
};

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const forgot = (email: unknown) => api().post("/api/auth/forgot-password").send({ email });
const check = (token: unknown) => api().post("/api/auth/reset-password/check").send({ token });
const reset = (token: unknown, password: unknown = NEW_PASSWORD) => api().post("/api/auth/reset-password").send({ token, password });
const login = (email: string, password: string) => api().post("/api/auth/login").send({ email, password });

/** The token inside the most recent reset email, as the user would receive it. */
function tokenFromLastEmail(): string {
  const match = /\/reset-password#token=([A-Za-z0-9_-]+)/.exec(testOutbox.at(-1)?.text ?? "");

  if (!match?.[1]) {
    throw new Error("No reset link was emailed.");
  }

  return match[1];
}

/** Asks for a reset link for the given user and returns the emailed token. */
async function requestToken(email: string): Promise<string> {
  const response = await forgot(email);

  expect(response.status).toBe(200);
  return tokenFromLastEmail();
}

async function tokenRows(userId: string) {
  const result = await pool.query<{
    id: string;
    token_hash: string;
    used_at: Date | null;
    revoked_at: Date | null;
    minutes: number;
  }>(
    `SELECT id, token_hash, used_at, revoked_at,
            round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes
     FROM password_reset_tokens WHERE user_id = $1 ORDER BY id`,
    [userId]
  );

  return result.rows;
}

let userId: string;

beforeAll(async () => {
  await resetData();
  await insertUser({ email: "admin@example.com", fullName: "Admin User", roles: ["ADMIN"] });
  userId = await insertUser({ email: "member@example.com", fullName: "Member User", roles: ["ACCOUNTANT"] });
  await insertUser({ email: "inactive@example.com", roles: ["ACCOUNTANT"], isActive: false });
});
beforeEach(() => {
  testOutbox.length = 0;
});
afterAll(closePool);

describe("POST /api/auth/forgot-password", () => {
  it("emails a reset link to an existing, active user", async () => {
    const response = await forgot(" Member@Example.com ");

    expect(response.status).toBe(200);
    expect(response.body).toEqual(RESET_RESPONSE);
    expect(testOutbox).toHaveLength(1);
    expect(testOutbox[0]).toMatchObject({ to: "member@example.com", subject: "Reset your STSLEV AMC password" });
    // The link points at the web application, with the token after "#".
    expect(testOutbox[0]?.text).toMatch(/http:\/\/app\.test\/reset-password#token=[A-Za-z0-9_-]{43}\n/);
  });

  it("gives an unknown email, and an inactive account, exactly the same public response", async () => {
    const known = await forgot("member@example.com");
    testOutbox.length = 0;
    const unknown = await forgot("nobody@example.com");
    const inactive = await forgot("inactive@example.com");

    for (const response of [unknown, inactive]) {
      expect(response.status).toBe(known.status);
      expect(response.body).toEqual(known.body);
    }
    // Nothing was created or sent for them.
    expect(testOutbox).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM password_reset_tokens WHERE user_id <> $1", [userId])).rowCount).toBe(0);
  });

  it("never returns the token, and validates the request", async () => {
    const response = await forgot("member@example.com");
    const token = tokenFromLastEmail();

    expect(JSON.stringify(response.body)).not.toContain(token);
    expect((await forgot("not-an-email")).status).toBe(400);
    expect((await api().post("/api/auth/forgot-password").send({})).status).toBe(400);
    expect((await api().post("/api/auth/forgot-password").send({ email: "member@example.com", userId })).status).toBe(400);
  });

  it("stores only the SHA-256 hash of the token, never the token", async () => {
    const token = await requestToken("member@example.com");
    const rows = await tokenRows(userId);
    const latest = rows.at(-1);

    expect(latest?.token_hash).toBe(sha256(token));
    expect(latest?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(latest?.minutes).toBe(30);

    // The raw token appears nowhere in the database: not in its table, not in the audit log.
    const stored = await pool.query<{ text: string }>("SELECT row_to_json(t)::text AS text FROM password_reset_tokens t");
    const logged = await pool.query<{ text: string }>("SELECT row_to_json(l)::text AS text FROM activity_logs l");

    for (const row of [...stored.rows, ...logged.rows]) {
      expect(row.text).not.toContain(token);
    }
    // The audit log does not carry the hash either.
    expect(logged.rows.some((row) => row.text.includes(sha256(token)))).toBe(false);
  });

  it("issues a different, unguessable token each time, unrelated to the login token", async () => {
    const first = await requestToken("member@example.com");
    const second = await requestToken("member@example.com");

    expect(first).not.toBe(second);
    expect(Buffer.from(first, "base64url")).toHaveLength(32);
    // It is not a JWT and is not accepted as a session.
    expect(jwt.decode(first)).toBeNull();
    expect((await api().get("/api/auth/me").set(bearer(first))).status).toBe(401);
  });

  it("revokes the earlier link when a new one is requested, keeping one outstanding token", async () => {
    const first = await requestToken("member@example.com");
    const second = await requestToken("member@example.com");
    const rows = await tokenRows(userId);

    expect(rows.filter((row) => row.used_at === null && row.revoked_at === null)).toHaveLength(1);
    expect((await check(first)).body.data.status).toBe("invalid");
    expect((await check(second)).body.data.status).toBe("valid");

    const stale = await reset(first);
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe("RESET_TOKEN_INVALID");
    expect((await login("member@example.com", PASSWORD)).status).toBe(200);
  });

  it("records the request in the audit log", async () => {
    const result = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'auth.password_reset_requested' AND user_id = $1", [
      userId,
    ]);

    expect(result.rowCount).toBeGreaterThan(0);
  });
});

describe("POST /api/auth/reset-password", () => {
  it("rejects a token that was never issued", async () => {
    for (const token of ["not-a-real-token", "x".repeat(43), jwt.sign({}, process.env.JWT_SECRET as string, { subject: userId })]) {
      expect((await check(token)).body.data.status).toBe("invalid");

      const response = await reset(token);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("RESET_TOKEN_INVALID");
    }
    expect((await reset("")).status).toBe(400);
    expect((await api().post("/api/auth/reset-password").send({ password: NEW_PASSWORD })).status).toBe(400);
  });

  it("does not accept a login token as a reset token", async () => {
    const sessionToken = await loginToken("member@example.com");
    const response = await reset(sessionToken);

    expect(response.body.error.code).toBe("RESET_TOKEN_INVALID");
    expect((await login("member@example.com", PASSWORD)).status).toBe(200);
  });

  it("rejects an expired token", async () => {
    const token = await requestToken("member@example.com");

    await pool.query(
      "UPDATE password_reset_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE token_hash = $1",
      [sha256(token)]
    );

    expect((await check(token)).body.data.status).toBe("expired");

    const response = await reset(token);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("RESET_TOKEN_EXPIRED");
    expect((await login("member@example.com", PASSWORD)).status).toBe(200);
    expect((await login("member@example.com", NEW_PASSWORD)).status).toBe(401);
  });

  it("enforces the password rules before spending the token", async () => {
    const token = await requestToken("member@example.com");

    for (const body of [{ token, password: "short" }, { token, password: "x".repeat(73) }, { token }]) {
      const response = await api().post("/api/auth/reset-password").send(body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await check(token)).body.data.status).toBe("valid");
  });

  it("sets the new password, spends the token and signs out existing sessions", async () => {
    const oldSession = await loginToken("member@example.com");
    const token = await requestToken("member@example.com");

    // Session tokens have one-second resolution.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await reset(token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: null });

    // The old password fails, the new one works.
    expect((await login("member@example.com", PASSWORD)).status).toBe(401);
    const signedInAgain = await login("member@example.com", NEW_PASSWORD);
    expect(signedInAgain.status).toBe(200);
    // Roles are unchanged by a reset.
    expect(signedInAgain.body.data.user.roles.map((role: { code: string }) => role.code)).toEqual(["ACCOUNTANT"]);
    expect((await api().get("/api/auth/me").set(bearer(oldSession))).status).toBe(401);

    // A bcrypt hash is stored, never the password.
    const stored = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
    expect(stored.rows[0]?.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(NEW_PASSWORD);

    const row = (await tokenRows(userId)).at(-1);
    expect(row?.used_at).not.toBeNull();

    const log = await pool.query<{ text: string }>(
      `SELECT coalesce(description, '') || coalesce(metadata::text, '') AS text
       FROM activity_logs WHERE action = 'auth.password_reset_completed' AND user_id = $1`,
      [userId]
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.text).not.toContain(NEW_PASSWORD);
    expect(log.rows[0]?.text).not.toContain(token);
  });

  it("cannot reuse a spent token", async () => {
    const token = await requestToken("member@example.com");

    expect((await reset(token, "First-New-Password-1")).status).toBe(200);
    expect((await check(token)).body.data.status).toBe("used");

    const again = await reset(token, "Second-New-Password-2");

    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("RESET_TOKEN_USED");
    expect((await login("member@example.com", "First-New-Password-1")).status).toBe(200);
    expect((await login("member@example.com", "Second-New-Password-2")).status).toBe(401);
  });

  it("lets the same link be spent only once when used twice at the same moment", async () => {
    const token = await requestToken("member@example.com");
    const results = await Promise.all([reset(token, "Race-Password-One-1"), reset(token, "Race-Password-Two-2")]);

    expect(results.map((response) => response.status).sort()).toEqual([200, 400]);
  });

  it("cancels an outstanding link when the account is deactivated or the password is changed another way", async () => {
    const admin = { headers: bearer(await loginToken("admin@example.com")) };
    const target = await signedIn("target@example.com", ["EXECUTION"]);

    // Deactivation.
    const whileActive = await requestToken("target@example.com");
    await api().post(`/api/users/${target.id}/deactivate`).set(admin.headers);
    expect((await check(whileActive)).body.data.status).toBe("invalid");
    expect((await reset(whileActive)).body.error.code).toBe("RESET_TOKEN_INVALID");
    await api().post(`/api/users/${target.id}/activate`).set(admin.headers);
    expect((await check(whileActive)).body.data.status).toBe("invalid");

    // An administrator's reset.
    const beforeAdminReset = await requestToken("target@example.com");
    await api().post(`/api/users/${target.id}/reset-password`).set(admin.headers).send({ password: "Admin-Chosen-Password-3" });
    expect((await check(beforeAdminReset)).body.data.status).toBe("invalid");

    // The user's own change of password.
    const beforeOwnChange = await requestToken("target@example.com");
    const session = bearer(await loginToken("target@example.com", "Admin-Chosen-Password-3"));
    await api()
      .post("/api/auth/change-password")
      .set(session)
      .send({ currentPassword: "Admin-Chosen-Password-3", newPassword: "Own-Chosen-Password-4" });
    expect((await check(beforeOwnChange)).body.data.status).toBe("invalid");
    expect((await login("target@example.com", "Own-Chosen-Password-4")).status).toBe(200);
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

  it("does not print the token, the link or the recipient when email is not configured", async () => {
    const message = { to: "member@example.com", subject: "Reset your STSLEV AMC password", text: "http://app.test/reset-password#token=SECRET" };
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

      // The development transport is the only one that shows the link.
      await createMailer("log").send(message);
      expect(outputs.flatMap((output) => output.mock.calls.flat()).join("\n")).toContain("SECRET");
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
