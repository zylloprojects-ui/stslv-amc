import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { logsFor } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Each master list's activity is filed under its own module (the one its permissions use since
// migration 0080), so the Audit Log's Module filter finds it. Entries written before this change
// stay as they were. Every record here is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;

interface Master {
  path: string;
  module: string;
  entityType: string;
  createBody: Record<string, unknown>;
  editBody: Record<string, unknown>;
  /** The body that disables, then enables, the record. */
  off: Record<string, unknown>;
  on: Record<string, unknown>;
}

const MASTERS: Master[] = [
  { path: "sales-engineers", module: "SALES_ENGINEERS", entityType: "sales_engineers", createBody: { name: "Audit Engineer" }, editBody: { name: "Audit Engineer Two" }, off: { isActive: false }, on: { isActive: true } },
  { path: "system-types", module: "SYSTEM_TYPES", entityType: "system_types", createBody: { code: "AUD", name: "Audit System" }, editBody: { name: "Audit System Two" }, off: { isActive: false }, on: { isActive: true } },
  { path: "departments", module: "DEPARTMENTS", entityType: "departments", createBody: { code: "AUDD", name: "Audit Department" }, editBody: { name: "Audit Department Two" }, off: { isActive: false }, on: { isActive: true } },
  {
    path: "maintenance-frequencies",
    module: "MAINTENANCE_FREQUENCIES",
    entityType: "maintenance_frequencies",
    createBody: { name: "Audit Every Quarter", code: "AUDIT_QUARTER", codePrefix: "AQ", serviceCount: 4, intervalMonths: 3 },
    editBody: { name: "Audit Every Quarter Two" },
    off: { status: "disabled", confirm: true },
    on: { status: "active", confirm: true },
  },
];

let historicalId: string;
let historicalBefore: Record<string, unknown>;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  // An entry written before the change, under Settings as it was then.
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO activity_logs (user_id, action, module, entity_type, entity_id, description)
     VALUES ($1, 'sales_engineer.created', 'SETTINGS', 'sales_engineers', '999', 'Historical entry') RETURNING id`,
    [admin.id]
  );
  historicalId = (inserted.rows[0] as { id: string }).id;
  historicalBefore = (await pool.query("SELECT * FROM activity_logs WHERE id = $1", [historicalId])).rows[0];
});
afterAll(closePool);

describe.each(MASTERS)("$path activity", (master) => {
  let id: string;

  it(`files create, edit, deactivate and reactivate under ${master.module}`, async () => {
    const base = `/api/masters/${master.path}`;
    const created = await api().post(base).set(admin.headers).send(master.createBody);
    expect(created.status).toBe(201);
    id = created.body.data.id as string;

    expect((await api().patch(`${base}/${id}`).set(admin.headers).send(master.editBody)).status).toBe(200);
    expect((await api().post(`${base}/${id}/status`).set(admin.headers).send(master.off)).status).toBe(200);
    expect((await api().post(`${base}/${id}/status`).set(admin.headers).send(master.on)).status).toBe(200);

    const logs = await logsFor(master.entityType, id);
    expect(logs.length).toBe(4);
    expect(logs.map((log) => log.module)).toEqual([master.module, master.module, master.module, master.module]);
  });

  it(`files the list's export under ${master.module}`, async () => {
    const before = await pool.query<{ max: string | null }>("SELECT max(id)::text AS max FROM activity_logs");
    const response = await api().get(`/api/masters/${master.path}/export`).query({ format: "xlsx" }).set(admin.headers);
    expect(response.status).toBe(200);

    const exported = await pool.query<{ module: string; action: string }>(
      "SELECT module, action FROM activity_logs WHERE id > $1 AND action LIKE '%.exported'",
      [before.rows[0]?.max ?? "0"]
    );
    expect(exported.rows).toEqual([{ module: master.module, action: `${master.entityType}.exported` }]);
  });

  it("is found by the Audit Log's Module filter, which lists the module", async () => {
    const options = (await api().get("/api/audit/activity/options").set(admin.headers)).body.data;
    expect(options.modules).toContain(master.module);

    const filtered = await api().get("/api/audit/activity").query({ module: master.module, pageSize: 100 }).set(admin.headers);
    expect(filtered.status).toBe(200);
    const entries = filtered.body.data.items as { module: string; entityId: string | null }[];
    expect(entries.filter((entry) => entry.entityId === id)).toHaveLength(4);
    expect(entries.every((entry) => entry.module === master.module)).toBe(true);
  });
});

describe("entries written before the change", () => {
  it("are kept exactly as they were, still under Settings", async () => {
    const after = (await pool.query("SELECT * FROM activity_logs WHERE id = $1", [historicalId])).rows[0];
    expect(after).toEqual(historicalBefore);

    const settings = await api().get("/api/audit/activity").query({ module: "SETTINGS", pageSize: 100 }).set(admin.headers);
    expect((settings.body.data.items as { id: string }[]).map((entry) => String(entry.id))).toContain(String(historicalId));
  });

  it("are the only master entries left under Settings", async () => {
    const leftovers = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM activity_logs WHERE module = 'SETTINGS' AND entity_type IN ('sales_engineers', 'system_types', 'departments', 'maintenance_frequencies')"
    );
    expect(leftovers.rows[0]?.n).toBe(1);
  });
});
