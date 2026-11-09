import jwt from "jsonwebtoken";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, bearer, closePool, insertUser, loginToken, PASSWORD, resetData, signedIn } from "./helpers";

// Server-side sessions (migration 0108): one session per sign-in, revocation (sign-out, all devices, administrator,
// password change, temporary password, deactivation) and the 30-minute inactivity limit.

const me = (token: string, idleSeconds?: number) => {
  const request = api().get("/api/auth/me").set(bearer(token));
  return idleSeconds === undefined ? request : request.set("X-Idle-Seconds", String(idleSeconds));
};
const sessionIdOf = (token: string) => (jwt.decode(token) as { sid?: string }).sid as string;
const sessionRow = async (id: string) =>
  (await pool.query<{ revoked_reason: string | null; revoked_by: string | null; last_activity_at: Date; user_agent: string | null }>("SELECT revoked_reason, revoked_by, last_activity_at, user_agent FROM user_sessions WHERE id = $1", [id])).rows[0];

beforeEach(async () => {
  await resetData();
});

afterAll(async () => {
  await closePool();
});

describe("sign-in creates a server-side session", () => {
  it("puts the session id in the token and records the device", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const response = await api().post("/api/auth/login").set("User-Agent", "Test Browser 1.0").send({ email: "ana@example.com", password: PASSWORD });

    expect(response.status).toBe(200);
    const sid = sessionIdOf(response.body.data.token);
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await sessionRow(sid)).toMatchObject({ revoked_reason: null, user_agent: "Test Browser 1.0" });
    expect((await me(response.body.data.token)).status).toBe(200);
  });

  it("refuses a validly signed token that names no session (issued before 0108)", async () => {
    const id = await insertUser({ email: "old@example.com", roles: ["ACCOUNTANT"] });
    const legacy = jwt.sign({}, process.env.JWT_SECRET as string, { algorithm: "HS256", subject: id, expiresIn: 3600 });

    const response = await me(legacy);
    expect(response.status).toBe(401);
  });

  it("refuses a token naming another user's session", async () => {
    const ana = await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const bob = await insertUser({ email: "bob@example.com", roles: ["ACCOUNTANT"] });
    const bobSession = sessionIdOf(await loginToken("bob@example.com"));
    const forged = jwt.sign({ sid: bobSession }, process.env.JWT_SECRET as string, { algorithm: "HS256", subject: ana, expiresIn: 3600 });

    expect((await me(forged)).status).toBe(401);
    expect(bob).toBeTruthy();
  });
});

describe("sign-out and sign out of all devices", () => {
  it("signing out ends only that session", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const laptop = await loginToken("ana@example.com");
    const phone = await loginToken("ana@example.com");

    expect((await api().post("/api/auth/logout").set(bearer(laptop)).send({})).status).toBe(200);

    expect((await me(laptop)).body.error.code).toBe("SESSION_REVOKED");
    expect((await me(phone)).status).toBe(200);
    expect(await sessionRow(sessionIdOf(laptop))).toMatchObject({ revoked_reason: "LOGOUT" });
  });

  it("sign out of all devices ends every session, this one included, and is logged", async () => {
    const id = await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const tokens = [await loginToken("ana@example.com"), await loginToken("ana@example.com"), await loginToken("ana@example.com")];

    const response = await api().post("/api/auth/logout-all").set(bearer(tokens[0] as string)).send({});
    expect(response.body.data).toEqual({ sessionsEnded: 3 });

    for (const token of tokens) expect((await me(token)).status).toBe(401);
    const log = await pool.query("SELECT 1 FROM activity_logs WHERE action = 'auth.logout_all' AND user_id = $1", [id]);
    expect(log.rowCount).toBe(1);
  });

  it("lists the user's own open sessions with the current one marked, and ends one by id", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    await insertUser({ email: "bob@example.com", roles: ["ACCOUNTANT"] });
    const laptop = await loginToken("ana@example.com");
    const phone = await loginToken("ana@example.com");
    const bobs = await loginToken("bob@example.com");

    const list = await api().get("/api/auth/sessions").set(bearer(laptop));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data.find((s: { current: boolean }) => s.current).id).toBe(sessionIdOf(laptop));

    // Another user's session cannot be ended (answered as not found, nothing changes).
    const foreign = await api().delete(`/api/auth/sessions/${sessionIdOf(bobs)}`).set(bearer(laptop));
    expect(foreign.status).toBe(404);
    expect((await me(bobs)).status).toBe(200);
    expect((await api().delete("/api/auth/sessions/not-a-uuid").set(bearer(laptop))).status).toBe(404);

    expect((await api().delete(`/api/auth/sessions/${sessionIdOf(phone)}`).set(bearer(laptop))).status).toBe(200);
    expect((await me(phone)).status).toBe(401);
    expect((await me(laptop)).status).toBe(200);
    expect((await api().get("/api/auth/sessions").set(bearer(laptop))).body.data).toHaveLength(1);
  });
});

describe("inactivity limit (SESSION_IDLE_TIMEOUT_MINUTES, default 30)", () => {
  it("ends a session whose last activity is more than 30 minutes ago", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");
    const sid = sessionIdOf(token);

    await pool.query("UPDATE user_sessions SET last_activity_at = now() - interval '31 minutes' WHERE id = $1", [sid]);

    const response = await me(token);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("SESSION_IDLE_TIMEOUT");
    expect(response.body.error.message).toContain("30 minutes");
    expect(await sessionRow(sid)).toMatchObject({ revoked_reason: "IDLE_TIMEOUT", revoked_by: null });
  });

  it("background polling that reports the person idle does not keep the session alive", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");
    const sid = sessionIdOf(token);

    // 20 minutes ago the person last did something; the page keeps polling.
    await pool.query("UPDATE user_sessions SET last_activity_at = now() - interval '20 minutes' WHERE id = $1", [sid]);
    expect((await me(token, 20 * 60)).status).toBe(200);
    const after = await sessionRow(sid);
    expect(Date.now() - (after?.last_activity_at.getTime() ?? 0)).toBeGreaterThan(19 * 60_000);

    // Eleven more minutes of polling without input (simulated): 31 minutes since the last real use.
    await pool.query("UPDATE user_sessions SET last_activity_at = last_activity_at - interval '11 minutes' WHERE id = $1", [sid]);
    const idle = await me(token, 31 * 60);
    expect(idle.status).toBe(401);
    expect(idle.body.error.code).toBe("SESSION_IDLE_TIMEOUT");
  });

  it("real activity moves the last-activity time forward, and never backwards", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");
    const sid = sessionIdOf(token);

    await pool.query("UPDATE user_sessions SET last_activity_at = now() - interval '25 minutes' WHERE id = $1", [sid]);
    expect((await me(token, 0)).status).toBe(200);
    const fresh = (await sessionRow(sid))?.last_activity_at.getTime() ?? 0;
    expect(Date.now() - fresh).toBeLessThan(60_000);

    // Another tab reporting a long idle time does not undo it.
    expect((await me(token, 40 * 60)).status).toBe(200);
    expect((await sessionRow(sid))?.last_activity_at.getTime()).toBe(fresh);
  });

  it("ends a session past its absolute lifetime even if it was used a moment ago", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");
    const sid = sessionIdOf(token);

    await pool.query("UPDATE user_sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 minute' WHERE id = $1", [sid]);

    const response = await me(token, 0);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect((await api().get("/api/auth/sessions").set(bearer(await loginToken("ana@example.com")))).body.data.map((s: { id: string }) => s.id)).not.toContain(sid);
  });

  it("ignores a nonsense idle header", async () => {
    await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");

    expect((await api().get("/api/auth/me").set(bearer(token)).set("X-Idle-Seconds", "-5")).status).toBe(200);
    expect((await api().get("/api/auth/me").set(bearer(token)).set("X-Idle-Seconds", "abc")).status).toBe(200);
  });
});

describe("password changes end other sessions", () => {
  it("changing one's own password ends every other session; this device continues with a fresh token", async () => {
    await insertUser({ email: "ana@example.com", fullName: "Ana Lima", roles: ["ACCOUNTANT"] });
    const laptop = await loginToken("ana@example.com");
    const phone = await loginToken("ana@example.com");

    const changed = await api().post("/api/auth/change-password").set(bearer(laptop)).send({ currentPassword: PASSWORD, newPassword: "Brand-New-Secret-77" });
    expect(changed.status).toBe(200);
    const fresh = changed.body.data.token as string;

    expect(sessionIdOf(fresh)).toBe(sessionIdOf(laptop));
    expect((await me(fresh)).status).toBe(200);
    expect((await me(phone)).status).toBe(401);
    expect(await sessionRow(sessionIdOf(phone))).toMatchObject({ revoked_reason: "PASSWORD_CHANGED" });
  });

  it("a temporary password issued by an administrator ends all the user's sessions", async () => {
    const admin = await signedIn("admin@example.com", ["ADMIN"]);
    const userId = await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");

    const issued = await api().post(`/api/users/${userId}/temporary-password`).set(admin.headers).send({ identityVerified: true });
    expect(issued.status).toBe(200);

    expect((await me(token)).status).toBe(401);
    expect(await sessionRow(sessionIdOf(token))).toMatchObject({ revoked_reason: "TEMPORARY_PASSWORD", revoked_by: admin.id });
  });

  it("deactivating a user ends their sessions", async () => {
    const admin = await signedIn("admin@example.com", ["ADMIN"]);
    const userId = await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");

    expect((await api().post(`/api/users/${userId}/deactivate`).set(admin.headers).send({})).status).toBe(200);
    expect(await sessionRow(sessionIdOf(token))).toMatchObject({ revoked_reason: "DEACTIVATED" });
  });
});

describe("administrator session management", () => {
  it("Super Admin lists every open session and signs a user out of one or all devices", async () => {
    const admin = await signedIn("admin@example.com", ["ADMIN"]);
    const userId = await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });
    const first = await loginToken("ana@example.com");
    const second = await loginToken("ana@example.com");

    const all = await api().get("/api/security/sessions").set(admin.headers);
    expect(all.status).toBe(200);
    expect(all.body.data.enabled).toBe(true);
    expect(all.body.data.idleTimeoutMinutes).toBe(30);
    expect(all.body.data.items.filter((s: { user: { id: string } }) => s.user.id === userId)).toHaveLength(2);

    const listed = await api().get(`/api/users/${userId}/sessions`).set(admin.headers);
    expect(listed.body.data).toHaveLength(2);

    expect((await api().delete(`/api/users/${userId}/sessions/${sessionIdOf(first)}`).set(admin.headers)).body.data).toEqual({ sessionsEnded: 1 });
    expect((await me(first)).status).toBe(401);
    expect((await me(second)).status).toBe(200);

    expect((await api().post(`/api/users/${userId}/sessions/revoke`).set(admin.headers).send({})).body.data).toEqual({ sessionsEnded: 1 });
    expect((await me(second)).body.error.code).toBe("SESSION_REVOKED");
    expect(await sessionRow(sessionIdOf(second))).toMatchObject({ revoked_reason: "REVOKED_BY_ADMIN", revoked_by: admin.id });

    const logged = await pool.query("SELECT action FROM activity_logs WHERE entity_id = $1 AND action LIKE 'user.session%' ORDER BY id", [userId]);
    expect(logged.rows.map((row) => row.action)).toEqual(["user.session_revoked", "user.sessions_revoked"]);
  });

  it("Admin cannot end a Super Admin's sessions; a non-administrator cannot see or end anyone's", async () => {
    const superAdminId = await insertUser({ email: "owner@example.com", roles: ["ADMIN"] });
    const superToken = await loginToken("owner@example.com");
    const admin = await signedIn("admin@example.com", ["ADMINISTRATOR"]);
    const accountant = await signedIn("acc@example.com", ["ACCOUNTANT"]);
    const userId = await insertUser({ email: "ana@example.com", roles: ["ACCOUNTANT"] });

    expect((await api().post(`/api/users/${superAdminId}/sessions/revoke`).set(admin.headers).send({})).status).toBe(403);
    expect((await me(superToken)).status).toBe(200);

    for (const request of [
      api().get("/api/security/sessions").set(accountant.headers),
      api().get(`/api/users/${userId}/sessions`).set(accountant.headers),
      api().post(`/api/users/${userId}/sessions/revoke`).set(accountant.headers).send({}),
    ]) {
      expect((await request).status).toBe(403);
    }
    expect((await api().get("/api/security/sessions")).status).toBe(401);
  });
});
