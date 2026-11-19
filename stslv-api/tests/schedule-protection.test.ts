import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Audit finding S-02 (P1 after the client UAT of 2026-11-16): a schedule change, from a contract edit or from
// Regenerate, removes only visits nobody has acted on. A visit with a Service Engineer, an uploaded Service Report
// (before completion) or another record about it is kept, never deleted and never duplicated; ordinary untouched
// visits still follow the contract's terms.

let admin: Session;
let clientId: string;

const patch = (url: string, body: Record<string, unknown>) => api().patch(`/api${url}`).set(admin.headers).send(body);
const post = (url: string, body: Record<string, unknown> = {}) => api().post(`/api${url}`).set(admin.headers).send(body);
const body = (overrides: Record<string, unknown>) => ({
  clientId,
  validFrom: "2027-01-01",
  validTo: "2027-12-31",
  contractValue: "1200.000",
  maintenanceFrequency: "QUARTERLY",
  defaultVisitAmount: "300.000",
  ...overrides,
});

async function setServiceEngineer(visitId: string, name: string | null) {
  const row = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [visitId]);
  const response = await patch(`/amc/service-status/${visitId}`, { salesEngineerName: name, expectedUpdatedAt: (row.rows[0]?.updated_at as Date).toISOString() });
  expect(response.status).toBe(200);
}

const engineerOf = async (visitId: string) =>
  (await pool.query<{ sales_engineer_name: string | null }>("SELECT sales_engineer_name FROM amc_visits WHERE id = $1", [visitId])).rows[0]?.sales_engineer_name;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await createClient(admin, "Protection Hotel");
});
afterAll(closePool);

describe("Schedule changes keep acted-on visits (S-02)", () => {
  it("refuses shortening the validity past a visit with a Service Engineer, and keeps it with its engineer", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "ENG SHRINK" }));
    const visits = await visitsOf(id);
    await setServiceEngineer(visits[3]!.id, "Vijay Service");

    const refused = await patch(`/amc/contracts/${id}`, { validTo: "2027-06-30" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/fall outside the new validity period/);
    expect((await visitsOf(id)).map((visit) => visit.id)).toEqual(visits.map((visit) => visit.id));
    expect(await engineerOf(visits[3]!.id)).toBe("Vijay Service");
  });

  it("refuses shortening the validity past a visit with a Number of Working Days, and keeps the number (0121)", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "DAYS SHRINK" }));
    const visits = await visitsOf(id);
    const row = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [visits[3]!.id]);
    expect((await patch(`/amc/service-status/${visits[3]!.id}`, { workingDays: 0, expectedUpdatedAt: (row.rows[0]?.updated_at as Date).toISOString() })).status).toBe(200);

    const refused = await patch(`/amc/contracts/${id}`, { validTo: "2027-06-30" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Number of Working Days/);
    expect((await visitsOf(id)).map((visit) => visit.id)).toEqual(visits.map((visit) => visit.id));
    const kept = await pool.query<{ working_days: number | null }>("SELECT working_days FROM amc_visits WHERE id = $1", [visits[3]!.id]);
    expect(kept.rows[0]?.working_days).toBe(0);
  });

  it("refuses shortening the validity past a visit with a Number of Manpower, and keeps the number (0122)", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "MANPOWER SHRINK" }));
    const visits = await visitsOf(id);
    const row = await pool.query<{ updated_at: Date }>("SELECT updated_at FROM amc_visits WHERE id = $1", [visits[3]!.id]);
    expect((await patch(`/amc/service-status/${visits[3]!.id}`, { manpowerCount: 0, expectedUpdatedAt: (row.rows[0]?.updated_at as Date).toISOString() })).status).toBe(200);

    const refused = await patch(`/amc/contracts/${id}`, { validTo: "2027-06-30" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Number of Manpower/);
    expect((await visitsOf(id)).map((visit) => visit.id)).toEqual(visits.map((visit) => visit.id));
    const kept = await pool.query<{ manpower_count: number | null }>("SELECT manpower_count FROM amc_visits WHERE id = $1", [visits[3]!.id]);
    expect(kept.rows[0]?.manpower_count).toBe(0);
  });

  it("refuses shortening the validity past a visit with an uploaded Service Report, and keeps it", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "REPORT SHRINK" }));
    const visits = await visitsOf(id);
    const attachment = await withServiceReport(visits[2]!.id);

    expect((await patch(`/amc/contracts/${id}`, { validTo: "2027-06-30" })).status).toBe(409);
    expect((await visitsOf(id)).map((visit) => visit.id)).toEqual(visits.map((visit) => visit.id));
    const stillThere = await pool.query("SELECT 1 FROM attachments WHERE id = $1 AND entity_id = $2", [attachment, visits[2]!.id]);
    expect(stillThere.rowCount).toBe(1);
  });

  it("still removes ordinary untouched visits when the validity is shortened", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "PLAIN SHRINK" }));
    const visits = await visitsOf(id);

    expect((await patch(`/amc/contracts/${id}`, { validTo: "2027-06-30" })).status).toBe(200);
    const after = await visitsOf(id);
    expect(after.map((visit) => visit.id)).toEqual([visits[0]!.id, visits[1]!.id]);
    expect(after.map((visit) => visit.period_start)).toEqual(["2027-01-01", "2027-04-01"]);
  });

  it("keeps the visit with a Service Engineer when its period's end moves, and schedules no second service for it", async () => {
    // Valid To 2027-11-30: the last quarter runs to 30 November. Extending to 31 December moves that period's end.
    const id = await activeContract(admin, clientId, body({ systemDescription: "ENG EXTEND", validTo: "2027-11-30" }));
    const visits = await visitsOf(id);
    const last = visits[3]!;
    expect(last.period_end).toBe("2027-11-30");
    await setServiceEngineer(last.id, "Ravi Field");

    expect((await patch(`/amc/contracts/${id}`, { validTo: "2027-12-31" })).status).toBe(200);
    const after = await visitsOf(id);
    // Same four visits: the engineer's visit is the same record, with the same number and period; nothing is duplicated.
    expect(after).toHaveLength(4);
    expect(after[3]).toMatchObject({ id: last.id, sequence_no: last.sequence_no, period_start: "2027-10-01", period_end: "2027-11-30" });
    expect(await engineerOf(last.id)).toBe("Ravi Field");
    expect(new Set(after.map((visit) => visit.period_start)).size).toBe(4);
  });

  it("an untouched visit whose period's end moves is still replaced by the regular one (unchanged behaviour)", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "PLAIN EXTEND", validTo: "2027-11-30" }));
    const visits = await visitsOf(id);

    expect((await patch(`/amc/contracts/${id}`, { validTo: "2027-12-31" })).status).toBe(200);
    const after = await visitsOf(id);
    expect(after).toHaveLength(4);
    expect(after[3]).toMatchObject({ period_start: "2027-10-01", period_end: "2027-12-31" });
    expect(after[3]!.id).not.toBe(visits[3]!.id);
  });

  it("Regenerate keeps a visit with a Service Engineer that it would otherwise replace, and still recalculates its amount", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "REGEN", billingBasis: "CONTRACT_VALUE" }));
    const visits = await visitsOf(id);
    // An older visit whose stored period no longer matches the terms (as after a past term change): Regenerate replaces
    // such a visit when nobody has acted on it.
    await pool.query("UPDATE amc_visits SET period_end = '2027-12-30' WHERE id = $1", [visits[3]!.id]);
    await setServiceEngineer(visits[3]!.id, "Anil Tech");
    await pool.query("UPDATE amc_visits SET visit_amount = '1.000' WHERE id = $1", [visits[3]!.id]);

    const preview = (await api().get(`/api/amc/contracts/${id}/schedule/regenerate`).set(admin.headers)).body.data;
    expect(preview).toMatchObject({ canApply: true, toRemove: 0, toCreate: 0 });

    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Billing basis check" })).status).toBe(200);
    const after = await visitsOf(id);
    expect(after.map((visit) => visit.id)).toEqual(visits.map((visit) => visit.id));
    expect(await engineerOf(visits[3]!.id)).toBe("Anil Tech");
    // Regenerate's own rule is unchanged: an open, unpaid visit gets the calculated amount (here the cycle's last service).
    expect(after[3]!.visit_amount).toBe("300.000");
  });

  it("Regenerate still replaces such a visit when nobody has acted on it", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "REGEN PLAIN", billingBasis: "CONTRACT_VALUE" }));
    const visits = await visitsOf(id);
    await pool.query("UPDATE amc_visits SET period_end = '2027-12-30' WHERE id = $1", [visits[3]!.id]);

    const preview = (await api().get(`/api/amc/contracts/${id}/schedule/regenerate`).set(admin.headers)).body.data;
    expect(preview).toMatchObject({ toRemove: 1, toCreate: 1 });
    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Billing basis check" })).status).toBe(200);
    const after = await visitsOf(id);
    expect(after).toHaveLength(4);
    expect(after[3]).toMatchObject({ period_start: "2027-10-01", period_end: "2027-12-31" });
  });
});
