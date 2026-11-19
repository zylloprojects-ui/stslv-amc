import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { bootstrapProtectedAdmin, PROTECTED_ACCOUNT_MESSAGE, recoverProtectedAdmin } from "../src/modules/users/protected-account";
import { api, bearer, closePool, insertUser, loginToken, resetData, roleId, signedIn } from "./helpers";

// The one protected Super Admin (migration 0119): nobody but the account itself may manage it, whatever their role,
// and the database keeps its Super Admin role and active status whatever path writes to it.

const OWNER_EMAIL = "protected.owner@example.com";
const OWNER_PASSWORD = "A-Brand-New-Password-7";

let protectedId: string;
let owner: { Authorization: string };
let otherSuperAdmin: Awaited<ReturnType<typeof signedIn>>;
let serviceDept: Awaited<ReturnType<typeof signedIn>>;

async function snapshot(id: string) {
  const user = await pool.query(
    `SELECT u.email, u.full_name, u.is_active, u.approval_status, u.password_hash, u.must_change_password,
            array_agg(r.code ORDER BY r.code) AS roles
     FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
     WHERE u.id = $1 GROUP BY u.id`,
    [id]
  );
  const sessions = await pool.query("SELECT count(*)::int AS open FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL", [id]);

  return { ...user.rows[0], openSessions: sessions.rows[0]?.open };
}

/** Signs in with the temporary password and chooses a real one, as the owner does at the first sign-in. */
async function completeFirstSignIn(email: string, temporaryPassword: string, newPassword: string): Promise<void> {
  const temporaryToken = await loginToken(email, temporaryPassword);
  const changed = await api().post("/api/auth/complete-password-change").set(bearer(temporaryToken)).send({ newPassword });

  expect(changed.status).toBe(200);
}

beforeAll(async () => {
  await resetData();
  otherSuperAdmin = await signedIn("other.super@example.com", ["ADMIN"]);
  serviceDept = await signedIn("service.dept@example.com", ["ADMINISTRATOR"]);
});
afterAll(closePool);

describe("bootstrap", () => {
  it("creates one active Super Admin, recorded by user id, with a temporary password to replace at first sign-in", async () => {
    const created = await bootstrapProtectedAdmin({ email: OWNER_EMAIL, fullName: "Protected Owner" });
    protectedId = created.userId;

    expect(created.temporaryPassword).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/);
    expect((await pool.query("SELECT user_id::text AS id FROM protected_accounts")).rows).toEqual([{ id: protectedId }]);
    expect(await snapshot(protectedId)).toMatchObject({ is_active: true, approval_status: "APPROVED", must_change_password: true, roles: ["ADMIN"] });

    // The temporary password opens only the change-password step; afterwards the account has full Super Admin access.
    await completeFirstSignIn(OWNER_EMAIL, created.temporaryPassword, OWNER_PASSWORD);
    await expect(loginToken(OWNER_EMAIL, created.temporaryPassword)).rejects.toThrow();
    owner = bearer(await loginToken(OWNER_EMAIL, OWNER_PASSWORD));

    const me = await api().get("/api/auth/me").set(owner);
    expect(me.body.data.user.roles.map((role: { code: string }) => role.code)).toEqual(["ADMIN"]);
    expect(me.body.data.user.permissions).toEqual(expect.arrayContaining(["USERS:EDIT", "SETTINGS:VIEW"]));

    // Audited without the password.
    const log = await pool.query<{ user_id: string | null; text: string }>(
      "SELECT user_id, description || metadata::text AS text FROM activity_logs WHERE action = 'user.protected_account_created' AND entity_id = $1",
      [protectedId]
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.user_id).toBeNull();
    expect(log.rows[0]?.text).not.toContain(created.temporaryPassword);
  });

  it("runs only once, and never turns an existing account into the protected one", async () => {
    await expect(bootstrapProtectedAdmin({ email: "second@example.com", fullName: "Second" })).rejects.toThrow(/already exists/);
    expect((await pool.query("SELECT 1 FROM users WHERE email = 'second@example.com'")).rowCount).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM protected_accounts")).rows[0]?.n).toBe(1);
  });
});

describe("other administrators cannot manage the protected account", () => {
  it("refuses another Super Admin and Service Dept on every user-management action, and changes nothing", async () => {
    const before = await snapshot(protectedId);
    const viewerRole = await roleId("VIEWER");
    const sessionId = (await pool.query<{ id: string }>("SELECT id::text AS id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1", [protectedId])).rows[0]?.id ?? "1";

    for (const actor of [otherSuperAdmin.headers, serviceDept.headers]) {
      const attempts = [
        await api().patch(`/api/users/${protectedId}`).set(actor).send({ fullName: "Renamed" }),
        await api().post(`/api/users/${protectedId}/deactivate`).set(actor),
        await api().put(`/api/users/${protectedId}/roles`).set(actor).send({ roleIds: [viewerRole] }),
        await api().post(`/api/users/${protectedId}/temporary-password`).set(actor).send({ identityVerified: true }),
        await api().post(`/api/users/${protectedId}/sessions/revoke`).set(actor),
        await api().delete(`/api/users/${protectedId}/sessions/${sessionId}`).set(actor),
        await api().get(`/api/users/${protectedId}/sessions`).set(actor),
      ];

      for (const response of attempts) {
        expect(response.status).toBe(403);
      }
      // Super Admin is refused because of the protection itself, not some other rule.
      if (actor === otherSuperAdmin.headers) {
        for (const response of attempts) {
          expect(response.body.error.message).toBe(PROTECTED_ACCOUNT_MESSAGE);
        }
      }
    }

    expect(await snapshot(protectedId)).toEqual(before);
    expect((await api().get("/api/auth/me").set(owner)).status).toBe(200);
  });

  it("still lists the protected account in Users & Access, marked as protected (and only it)", async () => {
    const list = await api().get("/api/users").set(otherSuperAdmin.headers);
    const page = await api().get("/api/users?page=1&pageSize=25").set(otherSuperAdmin.headers);

    expect(list.status).toBe(200);
    for (const items of [list.body.data, page.body.data.items] as { email: string; isProtected: boolean }[][]) {
      expect(items.filter((user) => user.isProtected).map((user) => user.email)).toEqual([OWNER_EMAIL]);
    }
  });

  it("keeps the protected account's sessions out of other administrators' Security Center, but not its own", async () => {
    type Listed = { items: { user: { id: string } }[] };
    const others = (await api().get("/api/security/sessions").set(otherSuperAdmin.headers)).body.data as Listed;
    const own = (await api().get("/api/security/sessions").set(owner)).body.data as Listed;

    expect(others.items.length).toBeGreaterThan(0);
    expect(others.items.some((item) => String(item.user.id) === protectedId)).toBe(false);
    expect(own.items.some((item) => String(item.user.id) === protectedId)).toBe(true);
    expect(own.items.some((item) => String(item.user.id) === otherSuperAdmin.id)).toBe(true);
  });

  it("leaves other Super Admins with the full, unchanged Super Admin permissions", async () => {
    const role = await pool.query<{ key: string }>(
      "SELECT rp.module || ':' || rp.action AS key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'ADMIN' ORDER BY 1"
    );
    const me = await api().get("/api/auth/me").set(otherSuperAdmin.headers);

    expect([...me.body.data.user.permissions].sort()).toEqual(role.rows.map((row) => row.key).sort());
  });
});

describe("everything else keeps working", () => {
  it("lets the owner manage their own account where the existing rules allow it", async () => {
    const renamed = await api().patch(`/api/users/${protectedId}`).set(owner).send({ fullName: "Protected Owner Renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.fullName).toBe("Protected Owner Renamed");

    // The existing self-rules still apply to the owner too.
    expect((await api().put(`/api/users/${protectedId}/roles`).set(owner).send({ roleIds: [await roleId("VIEWER")] })).status).toBe(409);
    expect((await api().post(`/api/users/${protectedId}/deactivate`).set(owner)).status).toBe(409);
    expect((await api().get(`/api/users/${protectedId}/sessions`).set(owner)).status).toBe(200);
  });

  it("lets the owner change their own password, which signs out the old sessions", async () => {
    const changed = await api().post("/api/auth/change-password").set(owner).send({ currentPassword: OWNER_PASSWORD, newPassword: "Second-Strong-Password-5" });

    expect(changed.status).toBe(200);
    await expect(loginToken(OWNER_EMAIL, OWNER_PASSWORD)).rejects.toThrow();
    owner = bearer(await loginToken(OWNER_EMAIL, "Second-Strong-Password-5"));
    expect((await api().get("/api/auth/me").set(owner)).status).toBe(200);
  });

  it("lets the owner manage other accounts, other Super Admins included", async () => {
    const target = await insertUser({ email: "managed.by.owner@example.com", roles: ["VIEWER"] });

    expect((await api().put(`/api/users/${target}/roles`).set(owner).send({ roleIds: [await roleId("FINANCE_EXECUTIVE")] })).status).toBe(200);
    expect((await api().post(`/api/users/${otherSuperAdmin.id}/sessions/revoke`).set(owner)).status).toBe(200);
    otherSuperAdmin.headers = bearer(await loginToken("other.super@example.com"));
  });

  it("lets another Super Admin manage every unprotected account as before, Super Admins included", async () => {
    const plain = await insertUser({ email: "plain.user@example.com", roles: ["VIEWER"] });
    const secondSuper = await insertUser({ email: "second.super@example.com", roles: ["ADMIN"] });
    const actor = otherSuperAdmin.headers;

    expect((await api().patch(`/api/users/${plain}`).set(actor).send({ fullName: "Plain Renamed" })).status).toBe(200);
    expect((await api().put(`/api/users/${plain}/roles`).set(actor).send({ roleIds: [await roleId("FINANCE_EXECUTIVE")] })).status).toBe(200);
    expect((await api().post(`/api/users/${plain}/temporary-password`).set(actor).send({ identityVerified: true })).status).toBe(200);
    expect((await api().post(`/api/users/${plain}/deactivate`).set(actor)).status).toBe(200);
    expect((await api().post(`/api/users/${plain}/activate`).set(actor)).status).toBe(200);

    expect((await api().put(`/api/users/${secondSuper}/roles`).set(actor).send({ roleIds: [await roleId("VIEWER")] })).status).toBe(200);
    expect((await api().put(`/api/users/${secondSuper}/roles`).set(actor).send({ roleIds: [await roleId("ADMIN")] })).status).toBe(200);
    expect((await api().post(`/api/users/${secondSuper}/deactivate`).set(actor)).status).toBe(200);
  });

  it("lets Service Dept keep managing the accounts it could manage before", async () => {
    const plain = await insertUser({ email: "dept.managed@example.com", roles: ["VIEWER"] });

    expect((await api().post(`/api/users/${plain}/deactivate`).set(serviceDept.headers)).status).toBe(200);
  });
});

describe("database guards", () => {
  async function refused(sql: string, params: unknown[]): Promise<string> {
    const error = await pool.query(sql, params).then(
      () => null,
      (caught: { code?: string }) => caught
    );

    expect(error).not.toBeNull();
    return (error as { code: string }).code;
  }

  it("keeps the protection on one account: it cannot be added again, moved or removed", async () => {
    // Another administrator cannot give themselves the protection, even by writing to the table directly.
    expect(await refused("INSERT INTO protected_accounts (user_id) VALUES ($1)", [otherSuperAdmin.id])).toBe("23505");
    expect(await refused("UPDATE protected_accounts SET user_id = $1", [otherSuperAdmin.id])).toBe("42501");
    expect(await refused("DELETE FROM protected_accounts", [])).toBe("42501");
    expect((await pool.query("SELECT user_id::text AS id FROM protected_accounts")).rows).toEqual([{ id: protectedId }]);
  });

  it("keeps the Super Admin role and the active status of the protected account whatever path writes", async () => {
    const admin = await roleId("ADMIN");

    expect(await refused("DELETE FROM user_roles WHERE user_id = $1", [protectedId])).toBe("42501");
    expect(await refused("UPDATE user_roles SET role_id = $2 WHERE user_id = $1", [protectedId, await roleId("VIEWER")])).toBe("42501");
    expect(await refused("UPDATE users SET is_active = false WHERE id = $1", [protectedId])).toBe("42501");
    expect(await refused("UPDATE users SET approval_status = 'REJECTED', is_active = false WHERE id = $1", [protectedId])).toBe("42501");
    expect((await snapshot(protectedId)).roles).toEqual(["ADMIN"]);

    // Other accounts are untouched by the guards.
    const plain = await insertUser({ email: "guard.check@example.com", roles: ["ADMIN"] });
    await pool.query("UPDATE users SET is_active = false WHERE id = $1", [plain]);
    await pool.query("DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2", [plain, admin]);
  });
});

describe("emergency recovery", () => {
  it("refuses a recovery that does not name the protected account", async () => {
    const before = await snapshot(protectedId);

    await expect(recoverProtectedAdmin("other.super@example.com")).rejects.toThrow(/does not match/);
    expect(await snapshot(protectedId)).toEqual(before);
  });

  it("issues a new temporary password, signs the account out everywhere and audits it", async () => {
    const recovered = await recoverProtectedAdmin(` ${OWNER_EMAIL.toUpperCase()} `);

    expect(recovered.userId).toBe(protectedId);
    expect((await api().get("/api/auth/me").set(owner)).status).toBe(401);
    await expect(loginToken(OWNER_EMAIL, "Second-Strong-Password-5")).rejects.toThrow();
    expect(await snapshot(protectedId)).toMatchObject({ is_active: true, must_change_password: true, roles: ["ADMIN"], openSessions: 0 });

    await completeFirstSignIn(OWNER_EMAIL, recovered.temporaryPassword, "Recovered-Password-8");
    expect((await api().get("/api/auth/me").set(bearer(await loginToken(OWNER_EMAIL, "Recovered-Password-8")))).status).toBe(200);

    const log = await pool.query<{ text: string }>(
      "SELECT description || metadata::text AS text FROM activity_logs WHERE action = 'user.protected_account_recovered' AND entity_id = $1",
      [protectedId]
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.text).not.toContain(recovered.temporaryPassword);
  });
});

describe("before any protected account exists", () => {
  it("refuses recovery and leaves user management exactly as before", async () => {
    await resetData();
    expect((await pool.query("SELECT count(*)::int AS n FROM protected_accounts")).rows[0]?.n).toBe(0);
    await expect(recoverProtectedAdmin(OWNER_EMAIL)).rejects.toThrow(/no protected account/);

    const superAdmin = await signedIn("first.super@example.com", ["ADMIN"]);
    const target = await insertUser({ email: "any.super@example.com", roles: ["ADMIN"] });

    expect((await api().patch(`/api/users/${target}`).set(superAdmin.headers).send({ fullName: "Renamed" })).status).toBe(200);
    expect((await api().put(`/api/users/${target}/roles`).set(superAdmin.headers).send({ roleIds: [await roleId("VIEWER")] })).status).toBe(200);
  });
});
