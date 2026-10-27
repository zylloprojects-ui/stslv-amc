import express from "express";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { closePool } from "./helpers";

const original = env.trustProxyHops;

afterEach(() => {
  env.trustProxyHops = original;
});
afterAll(closePool);

/** The address Express attributes a request to, under the API's own proxy setting. */
async function addressSeen(hops: number, forwardedFor: string): Promise<string> {
  env.trustProxyHops = hops;

  const probe = express();
  probe.set("trust proxy", createApp().get("trust proxy"));
  probe.get("/whoami", (req, res) => {
    res.json({ ip: req.ip });
  });

  const response = await request(probe).get("/whoami").set("X-Forwarded-For", forwardedFor);

  return response.body.ip;
}

describe("reverse proxy trust (TRUST_PROXY)", () => {
  it("trusts no proxy by default, as in local development", () => {
    env.trustProxyHops = 0;

    expect(createApp().get("trust proxy")).toBe(false);
  });

  it("ignores a forwarded address when no proxy is trusted", async () => {
    expect(await addressSeen(0, "203.0.113.9")).not.toBe("203.0.113.9");
  });

  it("uses the address reported by the one trusted proxy", async () => {
    expect(await addressSeen(1, "203.0.113.9")).toBe("203.0.113.9");
  });

  it("does not let a caller choose its own address behind the trusted proxy", async () => {
    // The caller sent "198.51.100.1"; the proxy appended the address it really saw.
    expect(await addressSeen(1, "198.51.100.1, 203.0.113.9")).toBe("203.0.113.9");
  });
});
