import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { hashPassword, verifyPassword } from "../src/modules/auth/password";
import { PASSWORD_MESSAGES, passwordBase, passwordProblems } from "../src/shared/password-policy";
import { api, bearer, closePool, insertUser, loginToken, PASSWORD, resetData, signedIn } from "./helpers";

describe("password policy (rules)", () => {
  it("accepts long, varied passwords", () => {
    for (const password of ["Correct-Horse-42", "blue Tiger river 9", "Q7#vL2!mZp4s", "Sunrise over Muscat 2026"]) {
      expect(passwordProblems(password), password).toEqual([]);
    }
  });

  it("refuses short, one-kind, repetitive and well-known passwords", () => {
    expect(passwordProblems("Ab1!Ab1!Ab1")).toContain(PASSWORD_MESSAGES.tooShort);
    expect(passwordProblems("alllowercaseletters")).toContain(PASSWORD_MESSAGES.classes);
    expect(passwordProblems("Aa1!Aa1!Aa1!")).toContain(PASSWORD_MESSAGES.distinct);
    for (const weak of ["P@ssw0rd2026!", "Password1234", "Welcome@12345", "Qwerty123456!", "Admin@202626", "Stslv@2026!!", "2026#Muscat!!"]) {
      expect(passwordProblems(weak), weak).toContain(PASSWORD_MESSAGES.common);
    }
    expect(passwordProblems("é".repeat(40))).toContain(PASSWORD_MESSAGES.tooLong);
    expect(passwordBase("P@ssw0rd!")).toBe("password");
    expect(passwordBase("Welcome@2026")).toBe("welcome");
  });

  it("refuses a password containing the person's name or email name", () => {
    expect(passwordProblems("Fatima-Secure-91", { fullName: "Fatima Al Balushi" })).toContain(PASSWORD_MESSAGES.personal);
    expect(passwordProblems("x-B4lush1-River-7", { fullName: "Fatima Al Balushi" })).toContain(PASSWORD_MESSAGES.personal);
    expect(passwordProblems("Ops.Engineer-2026", { email: "ops.engineer@example.com" })).toContain(PASSWORD_MESSAGES.personal);
    // Short name parts (under 4 letters) are not checked.
    expect(passwordProblems("Al-River-Stone-7", { fullName: "Al Li" })).toEqual([]);
  });
});

describe("password policy (API)", () => {
  beforeEach(async () => {
    await resetData();
  });

  afterAll(async () => {
    await closePool();
  });

  it("keeps existing passwords working: an old 10-character password still signs in", async () => {
    const id = await insertUser({ email: "legacy@example.com", roles: ["ACCOUNTANT"] });
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword("tenletters"), id]);

    expect((await api().post("/api/auth/login").send({ email: "legacy@example.com", password: "tenletters" })).status).toBe(200);
  });

  it("refuses a weak new password on My account and keeps the old one", async () => {
    const id = await insertUser({ email: "ana@example.com", fullName: "Ana Lima", roles: ["ACCOUNTANT"] });
    const token = await loginToken("ana@example.com");

    for (const newPassword of ["Short-1", "Password2026!", "Ana-Lima-Secure-1"]) {
      const response = await api().post("/api/auth/change-password").set(bearer(token)).send({ currentPassword: PASSWORD, newPassword });
      expect(response.status, newPassword).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    const hash = (await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [id])).rows[0]?.password_hash as string;
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  });

  it("refuses a weak password when an administrator creates a user, and on sign-up", async () => {
    const admin = await signedIn("admin@example.com", ["ADMIN"]);
    const roleId = (await pool.query<{ id: string }>("SELECT id FROM roles WHERE code = 'ACCOUNTANT'")).rows[0]?.id;

    const created = await api().post("/api/users").set(admin.headers).send({ email: "new@example.com", fullName: "Nadia Rahman", password: "Nadia-Rahman-2026", roleIds: [roleId] });
    expect(created.status).toBe(400);
    expect(created.body.error.details).toContainEqual({ field: "password", message: PASSWORD_MESSAGES.personal });

    const signup = await api().post("/api/auth/signup").send({ fullName: "Omar Said", email: "omar@example.com", password: "Welcome@2026!" });
    expect(signup.status).toBe(400);
    expect(signup.body.error.details).toContainEqual({ field: "password", message: PASSWORD_MESSAGES.common });

    const fine = await api().post("/api/users").set(admin.headers).send({ email: "new@example.com", fullName: "Nadia Rahman", password: "Copper-Lantern-58", roleIds: [roleId] });
    expect(fine.status).toBe(201);
  });
});
