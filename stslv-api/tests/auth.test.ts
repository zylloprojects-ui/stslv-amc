import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, bearer, closePool, insertUser, loginToken, PASSWORD, resetData } from "./helpers";

const TEST_SECRET = process.env.JWT_SECRET as string;
let adminId: string;

beforeAll(async () => {
  await resetData();
  adminId = await insertUser({ email: "admin@example.com", fullName: "Admin User", roles: ["ADMIN"] });
  await insertUser({ email: "inactive@example.com", roles: ["ADMIN"], isActive: false });
});
afterAll(closePool);

describe("POST /api/auth/login", () => {
  it("signs in with a correct email and password", async () => {
    const response = await api().post("/api/auth/login").send({ email: "admin@example.com", password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.token).toEqual(expect.any(String));
    expect(response.body.data.user).toMatchObject({
      id: adminId,
      email: "admin@example.com",
      fullName: "Admin User",
      roles: [{ code: "ADMIN", name: "Admin" }],
    });
    expect(response.body.data.user.permissions).toContain("CLIENTS:CREATE");
  });

  it("never returns the password or its hash", async () => {
    const response = await api().post("/api/auth/login").send({ email: "admin@example.com", password: PASSWORD });
    const body = JSON.stringify(response.body).toLowerCase();

    expect(body).not.toContain("password");
    expect(body).not.toContain("$2");
  });

  it("accepts the email in any letter case", async () => {
    const response = await api().post("/api/auth/login").send({ email: " ADMIN@Example.com ", password: PASSWORD });

    expect(response.status).toBe(200);
  });

  it("records the sign-in", async () => {
    const result = await pool.query(
      "SELECT 1 FROM activity_logs WHERE action = 'auth.login' AND user_id = $1",
      [adminId]
    );
    const user = await pool.query<{ last_login_at: Date | null }>("SELECT last_login_at FROM users WHERE id = $1", [adminId]);

    expect(result.rowCount).toBeGreaterThan(0);
    expect(user.rows[0]?.last_login_at).not.toBeNull();
  });

  it("rejects a wrong password, an unknown email and an inactive user with the same response", async () => {
    const wrongPassword = await api().post("/api/auth/login").send({ email: "admin@example.com", password: "wrong-password" });
    const unknownEmail = await api().post("/api/auth/login").send({ email: "nobody@example.com", password: PASSWORD });
    const inactive = await api().post("/api/auth/login").send({ email: "inactive@example.com", password: PASSWORD });

    for (const response of [wrongPassword, unknownEmail, inactive]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Incorrect email or password." },
      });
    }
  });

  it("validates the request body", async () => {
    const response = await api().post("/api/auth/login").send({ email: "not-an-email", password: "" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details.map((detail: { field: string }) => detail.field).sort()).toEqual(["email", "password"]);
  });

  it("returns a consistent error for malformed JSON", async () => {
    const response = await api().post("/api/auth/login").set("Content-Type", "application/json").send("{not json");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_JSON");
  });
});

describe("authenticated access", () => {
  it("returns the current user for a valid token", async () => {
    const response = await api().get("/api/auth/me").set(bearer(await loginToken("admin@example.com")));

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe("admin@example.com");
  });

  it("rejects a request without a token", async () => {
    for (const path of ["/api/auth/me", "/api/clients", "/api/users", "/api/roles", "/api/dashboard/summary"]) {
      const response = await api().get(path);

      expect(response.status, path).toBe(401);
      expect(response.body.error.code, path).toBe("UNAUTHORIZED");
    }
  });

  it("rejects a malformed token", async () => {
    const response = await api().get("/api/auth/me").set(bearer("not-a-real-token"));

    expect(response.status).toBe(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const forged = jwt.sign({}, "some-other-secret-some-other-secret-1234", { subject: adminId, expiresIn: 3600 });
    const response = await api().get("/api/auth/me").set(bearer(forged));

    expect(response.status).toBe(401);
  });

  it("rejects an unsigned token", async () => {
    const unsigned = jwt.sign({}, "", { subject: adminId, algorithm: "none" });
    const response = await api().get("/api/auth/me").set(bearer(unsigned));

    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ iat: Math.floor(Date.now() / 1000) - 7200 }, TEST_SECRET, { subject: adminId, expiresIn: 3600 });
    const response = await api().get("/api/auth/me").set(bearer(expired));

    expect(response.status).toBe(401);
  });

  it("rejects the token of a user who has since been deactivated", async () => {
    await insertUser({ email: "leaver@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("leaver@example.com");

    expect((await api().get("/api/auth/me").set(bearer(token))).status).toBe(200);

    await pool.query("UPDATE users SET is_active = false WHERE email = 'leaver@example.com'");

    expect((await api().get("/api/auth/me").set(bearer(token))).status).toBe(401);
  });

  it("returns a consistent error for an unknown route", async () => {
    const response = await api().get("/api/no-such-route");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "The requested API route does not exist." },
    });
  });
});

describe("POST /api/auth/change-password", () => {
  it("changes the password, invalidates older tokens and stores only a hash", async () => {
    const userId = await insertUser({ email: "changer@example.com", roles: ["ACCOUNTANT"] });
    const oldToken = await loginToken("changer@example.com");
    const newPassword = "A-Brand-New-Password-7";

    // Token timestamps have one-second resolution.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await api()
      .post("/api/auth/change-password")
      .set(bearer(oldToken))
      .send({ currentPassword: PASSWORD, newPassword });

    expect(response.status).toBe(200);
    expect((await api().get("/api/auth/me").set(bearer(oldToken))).status).toBe(401);
    expect((await api().get("/api/auth/me").set(bearer(response.body.data.token))).status).toBe(200);
    expect((await api().post("/api/auth/login").send({ email: "changer@example.com", password: PASSWORD })).status).toBe(401);
    expect((await api().post("/api/auth/login").send({ email: "changer@example.com", password: newPassword })).status).toBe(200);

    const stored = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [userId]);
    expect(stored.rows[0]?.password_hash).toMatch(/^\$2[aby]\$/);
    expect(stored.rows[0]?.password_hash).not.toContain(newPassword);
  });

  it("requires the correct current password and a strong enough new one", async () => {
    const token = await loginToken("admin@example.com");

    const wrongCurrent = await api()
      .post("/api/auth/change-password")
      .set(bearer(token))
      .send({ currentPassword: "wrong-password", newPassword: "Another-Good-Password-1" });
    const tooShort = await api()
      .post("/api/auth/change-password")
      .set(bearer(token))
      .send({ currentPassword: PASSWORD, newPassword: "short" });

    expect(wrongCurrent.status).toBe(400);
    expect(tooShort.status).toBe(400);
    expect((await api().post("/api/auth/login").send({ email: "admin@example.com", password: PASSWORD })).status).toBe(200);
  });
});

describe("existing health routes", () => {
  it("still respond without authentication", async () => {
    const health = await api().get("/api/health");
    const database = await api().get("/api/health/database");

    expect(health.body).toEqual({ success: true, message: "STSLV AMC API is running" });
    expect(database.body).toMatchObject({ success: true, message: "Database connected" });
  });
});
