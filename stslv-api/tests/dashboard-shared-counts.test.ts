import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { BUSINESS_TODAY_SQL } from "../src/shared/business-date";
import { activeContract, contractBody, createClient, renewalEngineer, withRenewalDocument, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Dashboard (and AMC Management's shared cards, from the same sharedKpis(), 2026-11-10) counts each contract ONCE in Active AMCs,
// Annual AMC Value and Final Credit: Active and within validity in Oman, and not a renewal waiting for the period it
// renews. A renewal version is never added on top of its original; an Active contract past its Valid To is not counted.

let admin: Session;
let client: string;
const day = async (offset: number) => (await pool.query<{ d: string }>(`SELECT (${BUSINESS_TODAY_SQL} + $1::int)::text AS d`, [offset])).rows[0]!.d;
const contracts = async () => (await api().get("/api/dashboard/operations").set(admin.headers)).body.data.kpis.contracts;
const renew = async (sourceId: string, validFrom: string, validTo: string, contractValue: string, finalCredit: string) => {
  const response = await api()
    .post(`/api/amc/contracts/${sourceId}/renewals`)
    .set(admin.headers)
    .send(withRenewalDocument(contractBody(client, { validFrom, validTo, status: "DRAFT", salesEngineerId: await renewalEngineer(), contractValue, finalCredit })));
  expect(response.status).toBe(201);
  const activated = await api().post(`/api/amc/contracts/${response.body.data.id}/status`).set(admin.headers).send({ status: "ACTIVE" });
  expect(activated.status).toBe(200);
  return response.body.data.id as string;
};

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  client = await createClient(admin, "Shared Dashboard Client");
});

afterAll(async () => {
  await closePool();
});

describe("Active AMCs, Annual AMC Value and Final Credit count each contract once", () => {
  it("does not add an approved renewal on top of the original while the original runs", async () => {
    const original = await activeContract(admin, client, { systemDescription: "RUNNING", validFrom: await day(-300), validTo: await day(30), contractValue: "1200.000", finalCredit: "100.000" });
    const before = await contracts();
    expect(before).toMatchObject({ active: 1, activeValue: "1200.000", finalCreditTotal: "100.000", activeAwaitingPredecessor: 0 });

    // Version 2, approved early: it starts when the original ends.
    const renewal = await renew(original, await day(31), await day(395), "1500.000", "150.000");
    const after = await contracts();

    expect(after).toMatchObject({ active: 1, activeValue: "1200.000", finalCreditTotal: "100.000", activeAwaitingPredecessor: 1 });
    // Both periods are stored Active, with the same number; only one is counted.
    const stored = await pool.query("SELECT count(*)::int AS n FROM amc_contracts WHERE status = 'ACTIVE' AND version_root_id = $1", [original]);
    expect(stored.rows[0].n).toBe(2);
    expect(renewal).not.toBe(original);
  });

  it("counts the renewal instead once the original's validity has ended, and no longer counts the ended original", async () => {
    const original = await activeContract(admin, client, { systemDescription: "ENDED", validFrom: await day(-400), validTo: await day(-1), contractValue: "2000.000", finalCredit: "200.000" });
    await renew(original, await day(0), await day(364), "2400.000", "240.000");
    const figures = await contracts();

    // From the first test: RUNNING (1200.000 / 100.000) still counted, its renewal waiting. Here: the renewal of ENDED.
    expect(figures).toMatchObject({ active: 2, activeValue: "3600.000", finalCreditTotal: "340.000", activePastValidity: 1, activeAwaitingPredecessor: 1 });
  });

  it("gives the same figures to AMC Management's summary API (kept for compatibility)", async () => {
    const summary = (await api().get("/api/amc/management/summary").set(admin.headers)).body.data;
    expect(summary.contracts).toEqual(await contracts());
  });
});
