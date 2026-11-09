import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { REPORTS } from "../src/modules/reports/reports.service";
import { activeContract, createClient, testReference, type Session } from "./amc-helpers";
import { api, closePool, resetData, roleId, signedIn } from "./helpers";

// Reports permission isolation (P2, 2026-11-09): a report needs REPORTS:VIEW plus View of its
// source module; its export needs REPORTS:EXPORT plus Export of that module. Checked for all six roles.

// The expected owner of each report, written out independently of the service.
const SOURCE: Record<string, string> = {
  "contract-summary": "AMC_CONTRACTS",
  "contract-value-review": "AMC_CONTRACTS",
  renewal: "AMC_RENEWAL",
  "expiry-renewal": "AMC_RENEWAL",
  "renewal-history": "AMC_RENEWAL",
  "scheduled-services": "ACCOUNTS",
  "completed-services": "ACCOUNTS",
  "pending-services": "ACCOUNTS",
  "monthly-maintenance": "ACCOUNTS",
  accounts: "ACCOUNTS",
  "client-summary": "ACCOUNTS",
  "engineer-summary": "ACCOUNTS",
};
const ROLES = ["ADMIN", "ADMINISTRATOR", "FINANCE_EXECUTIVE", "MASTER_DATA_EXECUTIVE", "AMC_OPERATIONS_EXECUTIVE", "VIEWER"] as const;

const sessions = new Map<string, Session>();
const get = (url: string, session: Session, query: Record<string, unknown> = {}) => api().get(`/api${url}`).query(query).set(session.headers);

async function grantsOf(code: string): Promise<Set<string>> {
  const result = await pool.query<{ key: string }>("SELECT rp.module || ':' || rp.action AS key FROM role_permissions rp WHERE rp.role_id = $1", [await roleId(code)]);
  return new Set(result.rows.map((row) => row.key));
}

async function grant(code: string, keys: string[]) {
  const id = await roleId(code);
  for (const key of keys) {
    const [module, action] = key.split(":");
    await pool.query("INSERT INTO role_permissions (role_id, module, action) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [id, module, action]);
  }
}

async function revoke(code: string, keys: string[]) {
  const id = await roleId(code);
  for (const key of keys) {
    const [module, action] = key.split(":");
    await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND module = $2 AND action = $3", [id, module, action]);
  }
}

beforeAll(async () => {
  await resetData();
  for (const code of ROLES) sessions.set(code, await signedIn(`${code.toLowerCase()}@reports.example.com`, [code]));
  const admin = sessions.get("ADMIN")!;
  const clientId = await createClient(admin, "Reports Permission Hotel");
  await activeContract(admin, clientId, { amcReference: testReference("RPTPERM"), clientId, systemDescription: "FIRE", validFrom: "2027-01-01", validTo: "2027-12-31", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "300.000", status: "ACTIVE" });
});
afterAll(closePool);

describe("Reports permission isolation", () => {
  it("names a source module for every report", () => {
    expect(Object.fromEntries(Object.entries(REPORTS).map(([id, spec]) => [id, spec.sources.join(",")]))).toEqual(SOURCE);
  });

  it("keeps Super Admin's access to every report and every export", async () => {
    const admin = sessions.get("ADMIN")!;
    const list = await get("/reports", admin);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(12);
    expect(list.body.data.every((item: { canExport: boolean }) => item.canExport)).toBe(true);
    expect((await get("/reports/accounts", admin)).status).toBe(200);
    expect((await get("/reports/accounts/export", admin, { format: "xlsx" })).status).toBe(200);
    expect((await get("/reports/options", admin)).status).toBe(200);
  });

  it.each(ROLES.filter((code) => code !== "ADMIN"))("refuses %s without a Reports grant, whatever its source permissions", async (code) => {
    const session = sessions.get(code)!;
    const held = await grantsOf(code);
    expect(held.has("REPORTS:VIEW")).toBe(false);
    expect((await get("/reports", session)).status).toBe(403);
    expect((await get("/reports/options", session)).status).toBe(403);
    for (const type of Object.keys(SOURCE)) {
      expect((await get(`/reports/${type}`, session)).status).toBe(403);
      expect((await get(`/reports/${type}/export`, session, { format: "pdf" })).status).toBe(403);
    }
  });

  it.each(ROLES.filter((code) => code !== "ADMIN"))("with Reports granted, %s sees only the reports of the modules it may view, and exports only where it may export them", async (code) => {
    const session = sessions.get(code)!;
    await grant(code, ["REPORTS:VIEW", "REPORTS:EXPORT"]);
    try {
      const held = await grantsOf(code);
      const viewable = Object.keys(SOURCE).filter((type) => held.has(`${SOURCE[type]}:VIEW`)).sort();
      const exportable = viewable.filter((type) => held.has(`${SOURCE[type]}:EXPORT`)).sort();

      const list = await get("/reports", session);
      expect(list.status).toBe(200);
      expect(list.body.data.map((item: { id: string }) => item.id).sort()).toEqual(viewable);
      expect(list.body.data.filter((item: { canExport: boolean }) => item.canExport).map((item: { id: string }) => item.id).sort()).toEqual(exportable);
      expect((await get("/reports/options", session)).status).toBe(viewable.length > 0 ? 200 : 403);

      for (const type of Object.keys(SOURCE)) {
        const read = await get(`/reports/${type}`, session);
        expect(read.status, `${code} reading ${type}`).toBe(viewable.includes(type) ? 200 : 403);
        if (read.status === 403) expect(JSON.stringify(read.body)).not.toMatch(/"rows"|"totals"/);
        const file = await get(`/reports/${type}/export`, session, { format: "xlsx" });
        expect(file.status, `${code} exporting ${type}`).toBe(exportable.includes(type) ? 200 : 403);
      }
    } finally {
      await revoke(code, ["REPORTS:VIEW", "REPORTS:EXPORT"]);
    }
  });

  it("refuses a financial report to a role with Reports but not Accounts, and writes no export audit entry", async () => {
    const code = "MASTER_DATA_EXECUTIVE";
    const session = sessions.get(code)!;
    await grant(code, ["REPORTS:VIEW", "REPORTS:EXPORT"]);
    try {
      const before = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_logs WHERE action = 'report.exported'");
      expect((await get("/reports/scheduled-services", session)).status).toBe(403);
      expect((await get("/reports/accounts/export", session, { format: "xlsx" })).status).toBe(403);
      const after = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_logs WHERE action = 'report.exported'");
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    } finally {
      await revoke(code, ["REPORTS:VIEW", "REPORTS:EXPORT"]);
    }
  });

  it("refuses an export when the source module's Export is withdrawn, while the report still reads", async () => {
    const code = "ADMINISTRATOR";
    const session = sessions.get(code)!;
    const held = await grantsOf(code);
    await grant(code, ["REPORTS:VIEW", "REPORTS:EXPORT", "ACCOUNTS:VIEW", "ACCOUNTS:EXPORT"]);
    await revoke(code, ["ACCOUNTS:EXPORT"]);
    try {
      expect((await get("/reports/accounts", session)).status).toBe(200);
      expect((await get("/reports/accounts/export", session, { format: "pdf" })).status).toBe(403);
      // Revocation takes effect on the next request.
      await revoke(code, ["ACCOUNTS:VIEW"]);
      expect((await get("/reports/accounts", session)).status).toBe(403);
    } finally {
      await revoke(code, ["REPORTS:VIEW", "REPORTS:EXPORT"]);
      await grant(code, [...held].filter((key) => key.startsWith("ACCOUNTS:")));
    }
  });
});
