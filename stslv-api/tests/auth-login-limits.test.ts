import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { pool } from "../src/config/database";
import { rateLimit } from "../src/middleware/rate-limit";
import { errorHandler } from "../src/shared/errors";
import { closePool, insertUser, PASSWORD, resetData } from "./helpers";

const original = {
  trustProxyHops: env.trustProxyHops,
  loginRateLimit: env.loginRateLimit,
  loginFailureLimit: env.loginFailureLimit,
};

// One trusted proxy, so each test can sign in from its own address via X-Forwarded-For
// and the counts kept by one test never affect another.
env.trustProxyHops = 1;
const app = createApp();
env.trustProxyHops = original.trustProxyHops;

let addressCounter = 0;
const newAddress = () => `203.0.113.${++addressCounter}`;

const signIn = (address: string, email: string, password: string) =>
  request(app).post("/api/auth/login").set("X-Forwarded-For", address).send({ email, password });

const TOO_MANY = {
  success: false,
  error: { code: "TOO_MANY_REQUESTS", message: "Too many attempts. Please wait a few minutes and try again." },
};

let userId: string;
let inactiveId: string;

beforeAll(async () => {
  await resetData();
  userId = await insertUser({ email: "user@example.com", fullName: "Limited User", roles: ["ADMIN"] });
  inactiveId = await insertUser({ email: "inactive@example.com", fullName: "Inactive User", isActive: false });
});
afterEach(() => {
  env.loginRateLimit = original.loginRateLimit;
  env.loginFailureLimit = original.loginFailureLimit;
});
afterAll(closePool);

async function failedLogins() {
  const result = await pool.query<{
    user_id: string | null;
    module: string;
    entity_type: string;
    entity_id: string | null;
    description: string;
    metadata: { reason: string; ip: string };
    text: string;
  }>(
    `SELECT user_id, module, entity_type, entity_id, description, metadata, row_to_json(l)::text AS text
       FROM activity_logs l WHERE action = 'auth.login_failed' ORDER BY id`
  );

  return result.rows;
}

describe("failed sign-in logging", () => {
  afterEach(async () => {
    await pool.query("DELETE FROM activity_logs WHERE action = 'auth.login_failed'");
  });

  it("records a wrong password against the account, without the password", async () => {
    const address = newAddress();
    const response = await signIn(address, "user@example.com", "Wrong-Password-1");

    expect(response.status).toBe(401);

    const [entry, ...rest] = await failedLogins();

    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({
      user_id: null,
      module: "AUTH",
      entity_type: "users",
      entity_id: userId,
      description: "Failed sign-in for Limited User.",
      metadata: { reason: "wrong_password", ip: address },
    });
    expect(entry?.text).not.toContain("Wrong-Password-1");
    expect(entry?.text).not.toContain("password_hash");
  });

  it("records an inactive account even when its password is correct", async () => {
    const response = await signIn(newAddress(), "inactive@example.com", PASSWORD);

    expect(response.status).toBe(401);
    expect(await failedLogins()).toEqual([
      expect.objectContaining({ entity_id: inactiveId, metadata: expect.objectContaining({ reason: "inactive_account" }) }),
    ]);
  });

  it("records an unknown email without storing the email or the password", async () => {
    const response = await signIn(newAddress(), "Typed-A-Secret@nowhere.example", "Some-Password-9");

    expect(response.status).toBe(401);

    const [entry] = await failedLogins();

    expect(entry).toMatchObject({
      user_id: null,
      entity_id: null,
      description: "Failed sign-in for an email with no account.",
      metadata: { reason: "unknown_account" },
    });
    expect(entry?.text.toLowerCase()).not.toContain("typed-a-secret");
    expect(entry?.text).not.toContain("Some-Password-9");
  });

  it("does not record a successful sign-in as a failure, and still records the sign-in", async () => {
    const response = await signIn(newAddress(), "user@example.com", PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.data.token).toEqual(expect.any(String));
    expect(await failedLogins()).toHaveLength(0);
    expect(
      (await pool.query("SELECT 1 FROM activity_logs WHERE action = 'auth.login' AND user_id = $1", [userId])).rowCount
    ).toBeGreaterThan(0);
  });

  it("keeps the same answer for every kind of failure", async () => {
    const responses = await Promise.all([
      signIn(newAddress(), "user@example.com", "Wrong-Password-1"),
      signIn(newAddress(), "inactive@example.com", PASSWORD),
      signIn(newAddress(), "nobody@example.com", PASSWORD),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        success: false,
        error: { code: "INVALID_CREDENTIALS", message: "Incorrect email or password." },
      });
    }
  });
});

describe("failed sign-in limit (LOGIN_FAILURE_LIMIT, per address and email)", () => {
  it("refuses further attempts, even with the correct password, once the limit is reached", async () => {
    env.loginFailureLimit = 3;
    const address = newAddress();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await signIn(address, "user@example.com", "Wrong-Password-1")).status).toBe(401);
    }

    const blocked = await signIn(address, "user@example.com", PASSWORD);

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    expect(blocked.body.data).toBeUndefined();
  });

  it("does not lock the real user out from another address", async () => {
    env.loginFailureLimit = 2;
    const attacker = newAddress();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await signIn(attacker, "user@example.com", "Wrong-Password-1");
    }

    expect((await signIn(attacker, "user@example.com", PASSWORD)).status).toBe(429);
    expect((await signIn(newAddress(), "user@example.com", PASSWORD)).status).toBe(200);
  });

  it("counts each email separately and ignores letter case", async () => {
    env.loginFailureLimit = 2;
    const address = newAddress();

    await signIn(address, "user@example.com", "Wrong-Password-1");
    await signIn(address, "USER@example.com", "Wrong-Password-1");

    expect((await signIn(address, "User@Example.com", PASSWORD)).status).toBe(429);
    expect((await signIn(address, "inactive@example.com", "Wrong-Password-1")).status).toBe(401);
  });

  it("limits an unknown email the same way, so the limit does not reveal which emails have accounts", async () => {
    env.loginFailureLimit = 2;
    const address = newAddress();

    await signIn(address, "nobody@example.com", PASSWORD);
    await signIn(address, "nobody@example.com", PASSWORD);

    const blocked = await signIn(address, "nobody@example.com", PASSWORD);

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
  });

  it("clears the count after a successful sign-in", async () => {
    env.loginFailureLimit = 3;
    const address = newAddress();

    await signIn(address, "user@example.com", "Wrong-Password-1");
    await signIn(address, "user@example.com", "Wrong-Password-1");
    expect((await signIn(address, "user@example.com", PASSWORD)).status).toBe(200);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await signIn(address, "user@example.com", "Wrong-Password-1")).status).toBe(401);
    }
    expect((await signIn(address, "user@example.com", "Wrong-Password-1")).status).toBe(429);
  });

  it("does not count requests refused by validation", async () => {
    env.loginFailureLimit = 1;
    const address = newAddress();

    expect((await signIn(address, "not-an-email", "x")).status).toBe(400);
    expect((await signIn(address, "user@example.com", PASSWORD)).status).toBe(200);
  });
});

describe("sign-in request limit (LOGIN_RATE_LIMIT, per address)", () => {
  it("refuses every sign-in from an address over the limit, while other addresses still sign in", async () => {
    env.loginRateLimit = 3;
    const address = newAddress();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await signIn(address, "user@example.com", PASSWORD)).status).toBe(200);
    }

    const blocked = await signIn(address, "user@example.com", PASSWORD);

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(TOO_MANY);
    expect((await signIn(newAddress(), "user@example.com", PASSWORD)).status).toBe(200);
  });
});

describe("rateLimit middleware, counting only chosen responses", () => {
  function probe(options: { max: number; windowMs?: number }) {
    const limited = express();

    limited.use(express.json());
    limited.post(
      "/probe",
      rateLimit({
        windowMs: options.windowMs ?? 60_000,
        max: options.max,
        key: (req) => String(req.body.who),
        countWhen: (status) => status === 401,
        clearWhen: (status) => status === 200,
      }),
      (req, res) => {
        res.status(req.body.ok ? 200 : 401).json({ success: Boolean(req.body.ok) });
      }
    );
    limited.use(errorHandler);

    return limited;
  }

  it("counts only failures and keeps separate keys apart", async () => {
    const limited = probe({ max: 2 });
    const send = (who: string, ok: boolean) => request(limited).post("/probe").send({ who, ok });

    expect((await send("a", true)).status).toBe(200);
    expect((await send("a", false)).status).toBe(401);
    expect((await send("a", false)).status).toBe(401);
    expect((await send("a", true)).status).toBe(429);
    expect((await send("b", true)).status).toBe(200);
  });

  it("starts again after the window", async () => {
    const limited = probe({ max: 1, windowMs: 150 });
    const send = (ok: boolean) => request(limited).post("/probe").send({ who: "a", ok });

    expect((await send(false)).status).toBe(401);
    expect((await send(true)).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await send(true)).status).toBe(200);
  });

  it("reads a limit given as a function on every request", async () => {
    let max = 1;
    const limited = express();

    limited.post("/probe", rateLimit({ windowMs: 60_000, max: () => max }), (_req, res) => {
      res.json({ success: true });
    });
    limited.use(errorHandler);

    expect((await request(limited).post("/probe")).status).toBe(200);
    expect((await request(limited).post("/probe")).status).toBe(429);
    max = 5;
    expect((await request(limited).post("/probe")).status).toBe(200);
  });
});
