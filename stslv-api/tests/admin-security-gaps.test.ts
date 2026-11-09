import ExcelJS from "exceljs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { pool } from "../src/config/database";
import { env } from "../src/config/env";
import { loadMigrationFiles } from "../src/db/migrate";
import { cleanUserAgent } from "../src/modules/auth/auth.service";
import { formatBackupDate, httpsCheck, modeCheck } from "../src/modules/dashboard/readiness.service";
import { FIXED_ACCESS, PERMISSION_CATALOG } from "../src/shared/permission-catalog";
import { grant } from "./amc-helpers";
import { api, bearer, closePool, insertUser, loginToken, PASSWORD, resetData, signedIn } from "./helpers";

// Security events, readiness checks, Users search and export, Login History user agent,
// Audit Log export and the sign-out event. Every record here is invented test data.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let manager: Session; // holds USERS:VIEW but is not an administrator
let execution: Session;

const BROWSER = "Mozilla/5.0 (Test Browser) Gap/1.0";

const binary = (res: request.Response, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk: Buffer) => chunks.push(chunk));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};
const fetchFile = (path: string, query: Record<string, string>, session: Session | null = admin) => {
  const call = api().get(path).query(query).buffer(true).parse(binary as never);

  return session ? call.set(session.headers) : call;
};
async function sheetText(response: { body: unknown }, name: string): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as ExcelJS.Buffer);
  const rows: string[][] = [];

  (workbook.getWorksheet(name) as ExcelJS.Worksheet).eachRow((row) => {
    rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? "")));
  });

  return rows;
}
const latestLog = async (action: string) =>
  (await pool.query<{ user_id: string | null; description: string; metadata: Record<string, unknown> }>("SELECT user_id, description, metadata FROM activity_logs WHERE action = $1 ORDER BY id DESC LIMIT 1", [action])).rows[0];

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  await grant("ACCOUNTANT", [["USERS", "VIEW"]]);
  manager = await signedIn("manager@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  await insertUser({ email: "zara@example.com", fullName: "Zara Searchable", roles: ["EXECUTION"] });
});
afterAll(closePool);

describe("Security events", () => {
  it("lists an approved registration and a sign-out", async () => {
    await api().post("/api/auth/signup").send({ fullName: "New Starter", email: "starter@example.com", password: PASSWORD });
    const id = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'starter@example.com'")).rows[0]?.id as string;
    const role = (await pool.query<{ id: string }>("SELECT id FROM roles WHERE code = 'EXECUTION'")).rows[0]?.id as string;
    await api().put(`/api/users/${id}/roles`).set(admin.headers).send({ roleIds: [role] });
    expect((await api().post(`/api/users/${id}/activate`).set(admin.headers)).status).toBe(200);

    const events = await api().get("/api/security/events").query({ action: "user.registration_approved" }).set(admin.headers);
    expect(events.body.data.total).toBe(1);
    expect(events.body.data.actions).toEqual(expect.arrayContaining(["user.registration_approved", "auth.logout"]));
  });
});

describe("Readiness", () => {
  const checkOf = async (id: string) => ((await api().get("/api/security/overview").set(admin.headers)).body.data.checks as { id: string; state: string; detail: string }[]).find((check) => check.id === id);

  it("names the latest applied database update", async () => {
    const newest = loadMigrationFiles().at(-1)?.filename.replace(/\.sql$/, "") as string;

    expect((await checkOf("migrations"))?.detail).toContain(`Latest applied: ${newest}.`);
  });

  it("shows the Node version and the run mode, without a score", async () => {
    expect((await checkOf("runtime"))?.detail).toContain(process.version);
    expect(await checkOf("mode")).toMatchObject({ state: "ATTENTION" });

    const overview = (await api().get("/api/security/overview").set(admin.headers)).body.data;
    expect(JSON.stringify(Object.keys(overview))).not.toMatch(/score/i);
  });

  it("run mode repeats only known names", () => {
    expect(modeCheck("production").state).toBe("OK");
    expect(modeCheck("development").detail).toContain("development");
    expect(modeCheck("weird-private-value").detail).not.toContain("weird-private-value");
  });

  it("formats a backup date for reading, with its time zone", () => {
    expect(formatBackupDate("2026-10-31T10:00:05.000Z")).toBe("31 Oct 2026, 14:00 Oman time");
  });

  it("HTTPS says unknown when it cannot tell", async () => {
    expect(httpsCheck(null).state).toBe("UNAVAILABLE");
    expect(httpsCheck({ secure: true, proxyTrusted: true, proxyReported: true }).state).toBe("OK");
    expect(httpsCheck({ secure: false, proxyTrusted: true, proxyReported: true }).state).toBe("ATTENTION");
    expect(httpsCheck({ secure: false, proxyTrusted: true, proxyReported: false }).detail).toMatch(/^Unknown/);

    // No trusted proxy: a forwarded header proves nothing.
    const untrusted = await checkOfHeader(0, "https");
    expect(untrusted?.state).toBe("UNAVAILABLE");
    expect(untrusted?.detail).toMatch(/^Unknown/);
    // One trusted proxy: its header is believed.
    expect((await checkOfHeader(1, "https"))?.state).toBe("OK");
    expect((await checkOfHeader(1, "http"))?.state).toBe("ATTENTION");
  });

  async function checkOfHeader(hops: number, proto: string) {
    const original = env.trustProxyHops;
    env.trustProxyHops = hops;
    try {
      const response = await request(createApp()).get("/api/security/overview").set(admin.headers).set("X-Forwarded-Proto", proto);

      return (response.body.data.checks as { id: string; state: string; detail: string }[]).find((check) => check.id === "https");
    } finally {
      env.trustProxyHops = original;
    }
  }

  it("Roles & Permissions names the Security Center for readiness, and lists Reports and the new modules", () => {
    const labels = FIXED_ACCESS.adminOnly.map((page) => page.label);
    expect(labels).toContain("System readiness (Security Center)");
    expect(labels.join()).not.toContain("Dashboard");

    const sections = PERMISSION_CATALOG.map((section) => ({ retired: "retired" in section && section.retired, modules: section.modules.map((entry) => entry.module as string) }));
    const current = sections.filter((section) => !section.retired).flatMap((section) => section.modules);
    expect(current).toEqual(expect.arrayContaining(["REPORTS", "MASTER_AMC_STATUS", "ACCOUNTS", "SUGGESTIONS", "SUGGESTIONS_REVIEW"]));
  });
});

describe("GET /api/users", () => {
  const list = (query: Record<string, string>, session: Session = admin) => api().get("/api/users").query(query).set(session.headers);

  it("still answers a plain array to callers without parameters", async () => {
    const response = await list({});

    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.data.length).toBeGreaterThan(3);
  });

  it("searches, filters by status and pages", async () => {
    const found = (await list({ search: "searchable", page: "1" })).body.data;
    expect(found).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(found.items[0].email).toBe("zara@example.com");

    expect((await list({ search: "zara@" })).body.data.total).toBe(1);

    await pool.query("UPDATE users SET is_active = false WHERE email = 'zara@example.com'");
    const inactive = (await list({ status: "INACTIVE" })).body.data;
    expect(inactive.items.map((user: { email: string }) => user.email)).toEqual(["zara@example.com"]);
    await pool.query("UPDATE users SET is_active = true WHERE email = 'zara@example.com'");

    const first = (await list({ page: "1", pageSize: "2" })).body.data;
    const second = (await list({ page: "2", pageSize: "2" })).body.data;
    expect(first.items).toHaveLength(2);
    expect(first.total).toBeGreaterThan(2);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(typeof first.pendingTotal).toBe("number");
  });

  it("refuses a wrong status, a non-manager and no sign-in; never returns a password hash", async () => {
    expect((await list({ status: "NOPE" })).status).toBe(400);
    expect((await list({ page: "1" }, execution)).status).toBe(403);
    expect((await api().get("/api/users").query({ page: "1" })).status).toBe(401);
    expect(JSON.stringify((await list({ page: "1" })).body)).not.toMatch(/password_hash|\$2[aby]\$/);
  });

  it("edits a full name through the existing route, for USERS:EDIT only", async () => {
    const id = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'zara@example.com'")).rows[0]?.id as string;

    expect((await api().patch(`/api/users/${id}`).set(admin.headers).send({ fullName: "Zara Searchable" })).status).toBe(200);
    expect((await api().patch(`/api/users/${id}`).set(manager.headers).send({ fullName: "Changed" })).status).toBe(403);
    expect((await api().patch(`/api/users/${id}`).send({ fullName: "Changed" })).status).toBe(401);
  });
});

describe("Users export", () => {
  it("follows the filters, is audited, and holds no secret", async () => {
    const response = await fetchFile("/api/users/export", { format: "xlsx", search: "zara" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");

    const text = (await sheetText(response, "Users")).flat().join(" ");
    expect(text).toContain("zara@example.com");
    expect(text).not.toContain("execution@example.com");
    expect(text).not.toMatch(/\$2[aby]\$/);

    expect(await latestLog("users.exported")).toMatchObject({ user_id: admin.id, metadata: { format: "xlsx", filters: { search: "zara" }, rowCount: 1 } });
    expect((await fetchFile("/api/users/export", { format: "pdf" })).status).toBe(200);
  });

  it("is refused to non-administrators and without sign-in", async () => {
    expect((await fetchFile("/api/users/export", { format: "xlsx" }, manager)).status).toBe(403);
    expect((await fetchFile("/api/users/export", { format: "xlsx" }, execution)).status).toBe(403);
    expect((await fetchFile("/api/users/export", { format: "xlsx" }, null)).status).toBe(401);
  });
});

describe("Login History", () => {
  const login = (email: string, password: string, agent?: string) => {
    const call = api().post("/api/auth/login").send({ email, password });

    return agent === undefined ? call.unset("User-Agent") : call.set("User-Agent", agent);
  };
  const logins = (query: Record<string, string> = {}, session: Session = admin) => api().get("/api/audit/logins").query(query).set(session.headers);

  it("records the user agent on success and failure", async () => {
    await login("zara@example.com", PASSWORD, BROWSER);
    await login("zara@example.com", "Wrong-Password-1", BROWSER);

    const items = (await logins({ search: "zara" })).body.data.items as { outcome: string; userAgent: string | null }[];
    expect(items.slice(0, 2).map((item) => [item.outcome, item.userAgent])).toEqual([
      ["FAILED", BROWSER],
      ["SUCCESS", BROWSER],
    ]);
  });

  it("limits the length, removes control characters, and treats it as text", () => {
    expect(cleanUserAgent("x".repeat(5000))).toHaveLength(300);
    expect(cleanUserAgent("a\u0000b\u0007c\nd")).toBe("a b c d");
    expect(cleanUserAgent("   ")).toBeNull();
    expect(cleanUserAgent(undefined)).toBeNull();
  });

  it("leaves it blank on an older entry", async () => {
    const id = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'zara@example.com'")).rows[0]?.id;
    await pool.query("INSERT INTO activity_logs (user_id, action, module, entity_type, entity_id, description, metadata) VALUES ($1, 'auth.login', 'AUTH', 'users', $1, 'Older sign-in.', '{\"ip\":\"203.0.113.9\"}')", [id]);

    const items = (await logins({ search: "203.0.113.9" })).body.data.items;
    expect(items[0]).toMatchObject({ ip: "203.0.113.9", userAgent: null });
  });

  it("exports with the filters, holds a hostile user agent as text, and is audited", async () => {
    await login("zara@example.com", PASSWORD, "=HYPERLINK(\"http://example.invalid\")");

    const failedOnly = await sheetText(await fetchFile("/api/audit/logins/export", { format: "xlsx", outcome: "FAILED", search: "zara" }), "Login History");
    expect(failedOnly.flat()).toContain(BROWSER);
    expect(failedOnly.flat()).not.toContain("Successful");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await fetchFile("/api/audit/logins/export", { format: "xlsx", search: "zara" })).body as ExcelJS.Buffer);
    let formulas = 0;
    (workbook.getWorksheet("Login History") as ExcelJS.Worksheet).eachRow((row) => row.eachCell((cell) => {
      if (cell.type === ExcelJS.ValueType.Formula) formulas += 1;
    }));
    expect(formulas).toBe(0);

    expect(await latestLog("login_history.exported")).toMatchObject({ user_id: admin.id, metadata: { format: "xlsx", filters: { search: "zara" } } });
    expect((await fetchFile("/api/audit/logins/export", { format: "pdf", search: "zara" })).status).toBe(200);
  });

  it("export is for administrators; the list stays open to user managers", async () => {
    expect((await logins({}, manager)).status).toBe(200);
    expect((await fetchFile("/api/audit/logins/export", { format: "xlsx" }, manager)).status).toBe(403);
    expect((await fetchFile("/api/audit/logins/export", { format: "xlsx" }, null)).status).toBe(401);
  });
});

describe("Audit Log export", () => {
  it("shows a network address where the entry holds one", async () => {
    const items = (await api().get("/api/audit/activity").query({ search: "signed in", pageSize: "100" }).set(admin.headers)).body.data.items as { ip: string | null }[];

    expect(items.some((item) => typeof item.ip === "string" && item.ip !== "")).toBe(true);

    const other = (await api().get("/api/audit/activity").query({ entityType: "roles" }).set(admin.headers)).body.data.items as { ip: string | null }[];
    for (const item of other) expect(item.ip).toBeNull();
  });

  it("follows the filters and is audited", async () => {
    const rows = await sheetText(await fetchFile("/api/audit/activity/export", { format: "xlsx", module: "AUTH", search: "failed sign-in" }), "Audit Log");
    const text = rows.flat().join(" ");

    expect(text).toContain("Failed sign-in");
    expect(text).not.toContain("Exported the Users list");
    expect(await latestLog("audit_log.exported")).toMatchObject({ user_id: admin.id, metadata: { format: "xlsx", filters: { module: "AUTH", search: "failed sign-in" } } });
    expect((await fetchFile("/api/audit/activity/export", { format: "pdf", module: "AUTH" })).status).toBe(200);
    expect((await fetchFile("/api/audit/activity/export", { format: "csv" })).status).toBe(400);
  });

  it("is refused to non-administrators, even a user manager, and without sign-in", async () => {
    expect((await fetchFile("/api/audit/activity/export", { format: "xlsx" }, manager)).status).toBe(403);
    expect((await fetchFile("/api/audit/activity/export", { format: "xlsx" }, null)).status).toBe(401);
  });

  it("holds no password, token or secret field", async () => {
    const zara = (await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'zara@example.com'")).rows[0]?.id as string;
    const issued = await api().post(`/api/users/${zara}/temporary-password`).set(admin.headers).send({ identityVerified: true });
    const temporary = issued.body.data.temporaryPassword as string;
    await pool.query("INSERT INTO activity_logs (user_id, action, module, entity_type, description, metadata) VALUES ($1, 'test.leak', 'AUTH', 'users', 'Leak probe.', $2)", [
      admin.id,
      JSON.stringify({ changes: { passwordHash: { from: "old-hash-value", to: "new-hash-value" }, fullName: { from: "A", to: "B" } } }),
    ]);

    const text = (await sheetText(await fetchFile("/api/audit/activity/export", { format: "xlsx" }), "Audit Log")).flat().join(" ");
    const listed = JSON.stringify((await api().get("/api/audit/activity").query({ search: "Leak probe" }).set(admin.headers)).body);

    expect(temporary.length).toBeGreaterThan(5);
    expect(text).not.toContain(temporary);
    expect(text).not.toContain("hash-value");
    expect(listed).not.toContain("hash-value");
    expect(text).toContain("fullName: A -> B");
    expect(text).not.toContain(admin.headers.Authorization.slice(7));
    expect(text).not.toContain(env.jwtSecret);
  });
});

describe("POST /api/auth/logout", () => {
  it("needs a sign-in", async () => {
    expect((await api().post("/api/auth/logout")).status).toBe(401);
  });

  it("records the sign-out, with no token, and ends the session on the server", async () => {
    const logged = vi.spyOn(console, "log");
    const errors = vi.spyOn(console, "error");
    const token = await loginToken("manager@example.com");

    const response = await api().post("/api/auth/logout").set(bearer(token)).set("User-Agent", BROWSER).send({});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: null });

    const entry = await latestLog("auth.logout");
    expect(entry).toMatchObject({ user_id: manager.id, metadata: { userAgent: BROWSER } });
    expect(JSON.stringify(entry)).not.toContain(token);

    // From migration 0108 signing out revokes the session: the same token is refused at once.
    const after = await api().get("/api/auth/me").set(bearer(token));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("SESSION_REVOKED");

    const printed = [...logged.mock.calls, ...errors.mock.calls].flat().map(String).join(" ");
    expect(printed).not.toContain(token);
    expect(printed).not.toContain(PASSWORD);
    logged.mockRestore();
    errors.mockRestore();
  });
});
