import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { api, serve } from "./helpers";

// Test servers listen on 127.0.0.1 (tests/helpers.ts, tests/setup-loopback.ts), so a port another program holds on
// 127.0.0.1 is never shared with them and every supertest request reaches the app under test.
const open: Server[] = [];
const listening = (server: Server, port: number, host: string) =>
  new Promise<AddressInfo>((resolve, reject) => {
    open.push(server);
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address() as AddressInfo));
  });

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("test servers", () => {
  it("api() reaches the application on 127.0.0.1", async () => {
    const response = await api().get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(new URL(response.request.url).hostname).toBe("127.0.0.1");
  });

  it("serve() runs an app a test builds itself on 127.0.0.1", async () => {
    const probe = express().get("/probe", (_req, res) => res.json({ ok: true }));
    const response = await (await serve(probe))().get("/probe");

    expect(response.body).toEqual({ ok: true });
    expect(new URL(response.request.url).hostname).toBe("127.0.0.1");
  });

  it("refuse supertest's own random port on every address, which can reach another program", () => {
    expect(() => request(express()).get("/")).toThrow(/must listen on 127\.0\.0\.1/);
  });

  it("on 127.0.0.1, cannot take a port another program already holds there", async () => {
    const stranger = await listening(createServer(), 0, "127.0.0.1");

    await expect(listening(createServer(), stranger.port, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
