import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, createContract, logsFor } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// AMC contracts on the maintenance frequency master (migration 0076): the four
// existing frequencies without regression, the new fixed intervals, custom
// months, service labels, and the rules for disabled frequencies. Every
// record is invented. The custom scheduling rule is PROVISIONAL.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let clientId: string;

const CONTRACTS = "/api/amc/contracts";

/** The stored visits of a contract with their labels, in date order. */
async function visits(contractId: string) {
  const result = await pool.query<{ id: string; period_start: string; period_end: string; cycle_no: number | null; service_code: string | null; notes: string | null }>(
    `SELECT id, period_start::text AS period_start, period_end::text AS period_end, cycle_no, service_code, notes
     FROM amc_visits WHERE amc_contract_id = $1 ORDER BY period_start, id`,
    [contractId]
  );

  return result.rows;
}

const labels = async (contractId: string) => (await visits(contractId)).map((visit) => `Y${visit.cycle_no}-${visit.service_code}`);
const starts = async (contractId: string) => (await visits(contractId)).map((visit) => visit.period_start);
const setActive = (codes: string[], active: boolean) => pool.query("UPDATE maintenance_frequencies SET is_active = $2 WHERE code = ANY($1)", [codes, active]);
const patch = (id: string, body: Record<string, unknown>) => api().patch(`${CONTRACTS}/${id}`).set(admin.headers).send(body);

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await createClient(admin, "Frequency Contract Client");
});
afterAll(closePool);

describe("the four existing frequencies", () => {
  it("generate the same visits as before, now labelled per contract year", async () => {
    const quarterly = await activeContract(admin, clientId, { systemDescription: "Q" });
    expect(await starts(quarterly)).toEqual(["2027-01-01", "2027-04-01", "2027-07-01", "2027-10-01"]);
    expect(await labels(quarterly)).toEqual(["Y1-Q1", "Y1-Q2", "Y1-Q3", "Y1-Q4"]);

    const monthly = await activeContract(admin, clientId, { systemDescription: "M", maintenanceFrequency: "MONTHLY" });
    expect((await labels(monthly)).at(-1)).toBe("Y1-M12");

    const halfYearly = await activeContract(admin, clientId, { systemDescription: "H", maintenanceFrequency: "HALF_YEARLY", validTo: "2028-12-31" });
    expect(await labels(halfYearly)).toEqual(["Y1-H1", "Y1-H2", "Y2-H1", "Y2-H2"]);

    const annually = await activeContract(admin, clientId, { systemDescription: "A", maintenanceFrequency: "ANNUALLY", validTo: "2029-12-31" });
    expect(await labels(annually)).toEqual(["Y1-A1", "Y2-A1", "Y3-A1"]);
  });

  it("returns the label with each visit, and the contract with its (empty) custom months", async () => {
    const id = await activeContract(admin, clientId, { systemDescription: "LABEL" });
    const list = await api().get("/api/amc/visits").query({ contractId: id }).set(admin.headers);

    expect(list.status).toBe(200);
    expect(list.body.data.items.map((visit: { serviceCode: string; cycleNo: number }) => `${visit.cycleNo}-${visit.serviceCode}`)).toEqual(["1-Q1", "1-Q2", "1-Q3", "1-Q4"]);
    expect((await api().get(`${CONTRACTS}/${id}`).set(admin.headers)).body.data.customMonths).toEqual([]);
  });

  it("refuses an unknown frequency code", async () => {
    const response = await createContract(admin, clientId, { maintenanceFrequency: "WEEKLY" });

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe("maintenanceFrequency");
  });
});

describe("new fixed intervals", () => {
  it("are refused while their frequencies are inactive, as seeded", async () => {
    for (const code of ["BI_MONTHLY", "EVERY_4_MONTHS", "CUSTOM"]) {
      const response = await createContract(admin, clientId, { maintenanceFrequency: code, ...(code === "CUSTOM" ? { customMonths: [3] } : {}) });
      expect(response.status, code).toBe(400);
      expect(response.body.error.details[0].field, code).toBe("maintenanceFrequency");
    }
  });

  it("schedule six bi-monthly and three four-monthly visits a year once active", async () => {
    await setActive(["BI_MONTHLY", "EVERY_4_MONTHS"], true);

    const biMonthly = await activeContract(admin, clientId, { systemDescription: "BM", maintenanceFrequency: "BI_MONTHLY" });
    expect(await starts(biMonthly)).toEqual(["2027-01-01", "2027-03-01", "2027-05-01", "2027-07-01", "2027-09-01", "2027-11-01"]);
    expect(await labels(biMonthly)).toEqual(["Y1-BM1", "Y1-BM2", "Y1-BM3", "Y1-BM4", "Y1-BM5", "Y1-BM6"]);

    const everyFour = await activeContract(admin, clientId, { systemDescription: "T", maintenanceFrequency: "EVERY_4_MONTHS", validTo: "2028-12-31" });
    expect(await labels(everyFour)).toEqual(["Y1-T1", "Y1-T2", "Y1-T3", "Y2-T1", "Y2-T2", "Y2-T3"]);
    expect((await visits(everyFour))[0]).toMatchObject({ period_start: "2027-01-01", period_end: "2027-04-30" });
  });

  it("refuses custom months on a fixed frequency", async () => {
    const response = await createContract(admin, clientId, { maintenanceFrequency: "QUARTERLY", customMonths: [2, 5] });

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe("customMonths");
  });
});

describe("custom months (PROVISIONAL rule)", () => {
  let custom: string;

  it("validates the selected months", async () => {
    await setActive(["CUSTOM"], true);
    const body = (customMonths?: unknown) => ({ maintenanceFrequency: "CUSTOM", validFrom: "2027-01-15", validTo: "2028-01-14", ...(customMonths === undefined ? {} : { customMonths }) });

    for (const [months, field] of [
      [undefined, "customMonths"],
      [[], "customMonths"],
      [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "customMonths"],
      [[2, 2], "customMonths"],
      [[0], "customMonths.0"],
      [[13], "customMonths.0"],
    ] as const) {
      const response = await createContract(admin, clientId, body(months));
      expect(response.status, JSON.stringify(months)).toBe(400);
      expect(response.body.error.details[0].field, JSON.stringify(months)).toBe(field);
    }
  });

  it("stores the months and schedules one visit in each, on the contract start day", async () => {
    custom = await activeContract(admin, clientId, { systemDescription: "C", maintenanceFrequency: "CUSTOM", validFrom: "2027-01-15", validTo: "2028-01-14", customMonths: [11, 2, 8, 5] });

    expect((await api().get(`${CONTRACTS}/${custom}`).set(admin.headers)).body.data.customMonths).toEqual([2, 5, 8, 11]);
    expect(await starts(custom)).toEqual(["2027-02-15", "2027-05-15", "2027-08-15", "2027-11-15"]);
    expect(await labels(custom)).toEqual(["Y1-C1", "Y1-C2", "Y1-C3", "Y1-C4"]);
  });

  it("previews a change of months without changing anything", async () => {
    const before = await visits(custom);
    const preview = await api().get(`${CONTRACTS}/${custom}/schedule/preview`).query({ customMonths: "3,9" }).set(admin.headers);

    expect(preview.status).toBe(200);
    expect(preview.body.data.customMonths).toEqual([3, 9]);
    expect(preview.body.data.toCreate.map((period: { periodStart: string; serviceCode: string }) => `${period.periodStart} ${period.serviceCode}`)).toEqual([
      "2027-03-15 C1",
      "2027-09-15 C2",
    ]);
    expect(await visits(custom)).toEqual(before);
  });

  it("replaces untouched visits when the months change, and keeps a visit someone acted on with its label", async () => {
    const first = await patch(custom, { customMonths: [3, 9] });
    expect(first.status).toBe(200);
    expect(await starts(custom)).toEqual(["2027-03-15", "2027-09-15"]);

    // Someone acts on the March visit.
    const march = (await visits(custom))[0] as { id: string };
    await pool.query("UPDATE amc_visits SET notes = 'Site visit agreed' WHERE id = $1", [march.id]);

    const second = await patch(custom, { customMonths: [6, 12] });
    expect(second.status).toBe(200);

    const after = await visits(custom);
    expect(after.map((visit) => `${visit.period_start} ${visit.service_code}`)).toEqual(["2027-03-15 C1", "2027-06-15 C1", "2027-12-15 C2"]);
    expect(after[0]).toMatchObject({ id: march.id, cycle_no: 1, service_code: "C1", notes: "Site visit agreed" });

    const updated = (await logsFor("amc_contracts", custom)).filter((log) => log.action === "amc_contract.updated").at(-1);
    expect(updated?.metadata).toMatchObject({ changes: { customMonths: { from: "3,9", to: "6,12" } } });
  });

  it("switches to a fixed frequency (months cleared) and back (months required)", async () => {
    const plain = await activeContract(admin, clientId, { systemDescription: "SWITCH", maintenanceFrequency: "CUSTOM", customMonths: [4] });

    const toFixed = await patch(plain, { maintenanceFrequency: "HALF_YEARLY" });
    expect(toFixed.status).toBe(200);
    expect(toFixed.body.data.customMonths).toEqual([]);
    expect(await labels(plain)).toEqual(["Y1-H1", "Y1-H2"]);

    const missing = await patch(plain, { maintenanceFrequency: "CUSTOM" });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].field).toBe("customMonths");

    const toCustom = await patch(plain, { maintenanceFrequency: "CUSTOM", customMonths: [5, 10] });
    expect(toCustom.status).toBe(200);
    expect(await starts(plain)).toEqual(["2027-05-01", "2027-10-01"]);
  });
});

describe("disabled frequencies", () => {
  let kept: string;

  it("stay on the contracts that use them; those contracts can still be edited and rescheduled", async () => {
    kept = await activeContract(admin, clientId, { systemDescription: "KEPT", maintenanceFrequency: "HALF_YEARLY" });
    await setActive(["HALF_YEARLY"], false);

    expect((await patch(kept, { notes: "Unrelated change" })).status).toBe(200);

    const longer = await patch(kept, { validTo: "2028-12-31" });
    expect(longer.status).toBe(200);
    expect(longer.body.data.maintenanceFrequency).toBe("HALF_YEARLY");
    expect(await labels(kept)).toEqual(["Y1-H1", "Y1-H2", "Y2-H1", "Y2-H2"]);
  });

  it("cannot be chosen for a new contract, a change of frequency or a renewal", async () => {
    expect((await createContract(admin, clientId, { maintenanceFrequency: "HALF_YEARLY" })).status).toBe(400);

    const other = await activeContract(admin, clientId, { systemDescription: "OTHER" });
    const change = await patch(other, { maintenanceFrequency: "HALF_YEARLY" });
    expect(change.status).toBe(400);
    expect(change.body.error.details[0].field).toBe("maintenanceFrequency");

    const renewal = await api()
      .post(`${CONTRACTS}/${kept}/renewals`)
      .set(admin.headers)
      .send({ clientId, validFrom: "2029-01-01", validTo: "2029-12-31", systemDescription: "KEPT", contractValue: "100.000", maintenanceFrequency: "HALF_YEARLY" });
    expect(renewal.status).toBe(400);

    await setActive(["HALF_YEARLY"], true);
  });
});

describe("visits generated before migration 0076", () => {
  it("keep no label, and a later regeneration leaves them alone", async () => {
    const id = await activeContract(admin, clientId, { systemDescription: "OLD" });
    // As if generated before 0076: no label on the first visit.
    const first = (await visits(id))[0] as { id: string };
    await pool.query("UPDATE amc_visits SET cycle_no = NULL, service_code = NULL WHERE id = $1", [first.id]);

    const regenerated = await api().post(`${CONTRACTS}/${id}/schedule/generate`).set(admin.headers).send({});
    expect(regenerated.status).toBe(200);

    expect((await visits(id))[0]).toMatchObject({ id: first.id, cycle_no: null, service_code: null });
    const list = await api().get("/api/amc/visits").query({ contractId: id }).set(admin.headers);
    expect(list.body.data.items[0]).toMatchObject({ id: first.id, serviceCode: null, cycleNo: null, sequenceNo: 1 });
  });
});
