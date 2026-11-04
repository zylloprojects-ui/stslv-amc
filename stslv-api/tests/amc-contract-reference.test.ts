import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, contractBody, createClient, newContractBody, renewalEngineer, visitsOf } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Manual AMC Reference Number (migration 0105): typed when a contract or renewal is created, never generated,
// unique for ever without regard to case (cancelled and Recycle Bin contracts included), and read-only afterwards.
// Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;
let admin: Session;
let clientId: string;

const DUPLICATE = "AMC Reference Number already exists. Please enter a different number.";

beforeAll(async () => {
  await resetData();
  admin = await signedIn("reference-admin@example.com", ["ADMIN"]);
  clientId = await createClient(admin, "Reference Test Hotel");
});
afterAll(closePool);

// A new contract also carries its sales engineer, system type, Final Credit and contract document (0103).
const create = async (amcReference: unknown, overrides: Record<string, unknown> = {}) =>
  api().post("/api/amc/contracts").set(admin.headers).send(await newContractBody(clientId, { amcReference, ...overrides }));
const get = (id: string) => api().get(`/api/amc/contracts/${id}`).set(admin.headers);

describe("creating a contract with a manual AMC Reference Number", () => {
  it("saves the reference as typed, trimmed, with its case kept", async () => {
    const response = await create("  STSLV-AMC-2026-015  ");

    expect(response.status).toBe(201);
    expect(response.body.data.amcReference).toBe("STSLV-AMC-2026-015");
    expect((await get(response.body.data.id)).body.data.amcReference).toBe("STSLV-AMC-2026-015");

    const stored = await pool.query("SELECT amc_reference FROM amc_contracts WHERE id = $1", [response.body.data.id]);
    expect(stored.rows[0]).toEqual({ amc_reference: "STSLV-AMC-2026-015" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
    ["a number instead of text", 15],
    ["characters outside the convention", "AMC#001"],
    ["a leading symbol", "-AMC-001"],
    ["longer than 50 characters", `AMC-${"9".repeat(47)}`],
  ])("rejects a reference that is %s", async (_label, value) => {
    const response = await create(value);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe("amcReference");
  });

  it("accepts the documented examples", async () => {
    for (const reference of ["AMC-0901", "AMC-2026-001", "STSLV-AMC-2026-016", "AMC 2026/17 & B.1"]) {
      expect((await create(reference)).status, reference).toBe(201);
    }
  });

  it("rejects a duplicate, without regard to case, with the agreed message", async () => {
    expect((await create("DUP-REF-001")).status).toBe(201);

    for (const again of ["DUP-REF-001", "dup-ref-001", "  Dup-Ref-001 "]) {
      const response = await create(again);

      expect(response.status, again).toBe(409);
      expect(response.body.error).toMatchObject({ code: "CONFLICT", message: DUPLICATE, details: [{ field: "amcReference", message: DUPLICATE }] });
    }
  });

  it("never lets a cancelled contract's reference be reused", async () => {
    const id = (await create("CANCELLED-REF-001")).body.data.id as string;
    const cancel = await api().post(`/api/amc/contracts/${id}/status`).set(admin.headers).send({ status: "CANCELLED", reason: "Test" });
    expect(cancel.status).toBe(200);

    const response = await create("CANCELLED-REF-001");
    expect(response.status).toBe(409);
    expect(response.body.error.message).toBe(DUPLICATE);
  });

  it("never lets a Recycle Bin contract's reference be reused, and restores it unchanged", async () => {
    const id = (await create("BIN-REF-001")).body.data.id as string;
    expect((await api().delete(`/api/amc/contracts/${id}`).set(admin.headers)).status).toBe(200);
    expect((await get(id)).status).toBe(404);

    const bin = await api().get("/api/security/recycle-bin/amc-contracts").set(admin.headers);
    expect(bin.body.data.find((row: { id: string }) => row.id === id)).toMatchObject({ amcReference: "BIN-REF-001" });

    const reuse = await create("bin-ref-001");
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.message).toBe(DUPLICATE);

    expect((await api().post(`/api/security/recycle-bin/amc-contracts/${id}/restore`).set(admin.headers)).status).toBe(200);
    expect((await get(id)).body.data.amcReference).toBe("BIN-REF-001");
  });

  it("lets only one of two simultaneous requests with the same reference succeed", async () => {
    const responses = await Promise.all([1, 2, 3].map(() => create("RACE-REF-001")));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    const stored = await pool.query("SELECT count(*)::int AS count FROM amc_contracts_all WHERE lower(amc_reference) = 'race-ref-001'");
    expect(stored.rows[0]).toEqual({ count: 1 });
  });

  it("is enforced by the database as well (required, trimmed, allowed characters, unique)", async () => {
    const insert = (reference: string | null) =>
      pool.query(
        `INSERT INTO amc_contracts (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency, amc_reference)
         VALUES ($1, '2027-01-01', '2027-12-31', 'FIRE', 100, 'QUARTERLY', $2)`,
        [clientId, reference]
      );

    await expect(insert(null)).rejects.toMatchObject({ code: "23502" });
    await expect(insert(" PADDED")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("BAD#REF")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("dup-ref-001")).rejects.toMatchObject({ code: "23505", constraint: "amc_contracts_reference_uq" });
  });
});

describe("after creation", () => {
  it("cannot be changed through the edit route", async () => {
    const id = (await create("READ-ONLY-001")).body.data.id as string;
    const response = await api().patch(`/api/amc/contracts/${id}`).set(admin.headers).send({ amcReference: "CHANGED-001", notes: "x" });

    expect(response.status).toBe(400);
    expect(response.body.error.details[0]).toEqual({ field: "amcReference", message: "The AMC Reference Number cannot be changed after the contract is created." });
    expect((await get(id)).body.data.amcReference).toBe("READ-ONLY-001");

    // Other fields still edit normally, and the reference stays.
    const edit = await api().patch(`/api/amc/contracts/${id}`).set(admin.headers).send({ notes: "Edited" });
    expect(edit.status).toBe(200);
    expect(edit.body.data.amcReference).toBe("READ-ONLY-001");
  });
});

describe("renewals", () => {
  it("require their own unique reference and never generate one", async () => {
    const engineer = await renewalEngineer();
    const sourceId = await activeContract(admin, clientId, { amcReference: "RENEW-SRC-001", validFrom: "2027-01-01", validTo: "2027-12-31" });
    const renew = (overrides: Record<string, unknown>) =>
      api()
        .post(`/api/amc/contracts/${sourceId}/renewals`)
        .set(admin.headers)
        .send({ ...contractBody(clientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId: engineer }), ...overrides });

    const missing = await renew({ amcReference: undefined });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].field).toBe("amcReference");

    const reused = await renew({ amcReference: "renew-src-001" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.message).toBe(DUPLICATE);

    const renewed = await renew({ amcReference: "RENEW-NEW-001" });
    expect(renewed.status).toBe(201);
    expect(renewed.body.data.amcReference).toBe("RENEW-NEW-001");

    const links = (await api().get(`/api/amc/contracts/${renewed.body.data.id}/renewals`).set(admin.headers)).body.data;
    expect(links.renewedFrom).toMatchObject({ id: sourceId, reference: "RENEW-SRC-001" });
    const history = (await api().get("/api/amc/reports/renewals").set(admin.headers)).body.data.items;
    expect(history.find((item: { renewal: { id: string } }) => item.renewal.id === renewed.body.data.id)).toMatchObject({
      renewal: { reference: "RENEW-NEW-001" },
      source: { id: sourceId, reference: "RENEW-SRC-001" },
    });
  });
});

describe("the saved reference across modules", () => {
  let id: string;
  const REF = "XMOD-Ref-2027/01";

  beforeAll(async () => {
    id = await activeContract(admin, clientId, { amcReference: REF, systemDescription: "XMOD SYSTEM", validFrom: "2027-01-01", validTo: "2027-12-31" });
    // Relationships stay on ids: the visits link to the contract id, not the text.
    const visits = await visitsOf(id);
    expect(visits.length).toBeGreaterThan(0);
    const linked = await pool.query("SELECT count(*)::int AS count FROM amc_visits WHERE amc_contract_id = $1", [id]);
    expect(linked.rows[0]).toEqual({ count: visits.length });
  });

  const list = async (path: string) => {
    const response = await api().get(path).set(admin.headers);
    expect(response.status, path).toBe(200);
    return response.body.data;
  };

  it("shows on the register and Contract 360, and the register searches it", async () => {
    expect((await get(id)).body.data.amcReference).toBe(REF);
    const found = await list(`/api/amc/contracts?search=${encodeURIComponent("xmod-ref")}`);
    expect(found.items.map((item: { id: string }) => item.id)).toEqual([id]);
    expect(found.items[0].amcReference).toBe(REF);
  });

  it("shows on the AMC Schedule, which searches it", async () => {
    const visits = await list(`/api/amc/visits?contractId=${id}`);
    expect(new Set(visits.items.map((visit: { contract: { reference: string } }) => visit.contract.reference))).toEqual(new Set([REF]));
    const searched = await list(`/api/amc/visits?search=${encodeURIComponent("XMOD-REF-2027")}`);
    expect(searched.total).toBe(visits.total);
    const month = (await visitsOf(id))[0]!.scheduled_date.slice(0, 7);
    const monthly = await list(`/api/amc/visits/monthly-consolidated?month=${month}`);
    expect(monthly.items.find((item: { id: string }) => item.id === id)).toMatchObject({ reference: REF });
  });

  it.each([
    ["Service Status", "/api/amc/service-status"],
    ["Master AMC Status", "/api/amc/master-status"],
    ["Accounts", "/api/accounts"],
    ["Service Sales", "/api/services-sales"],
  ])("shows on %s and is found by its search", async (_label, path) => {
    const searched = await list(`${path}?search=${encodeURIComponent("xmod-ref-2027")}&pageSize=200`);

    expect(searched.items.length).toBeGreaterThan(0);
    expect(new Set(searched.items.map((item: { reference: string }) => item.reference))).toEqual(new Set([REF]));
  });

  it("names the contract in the Accounts contract filter", async () => {
    const options = await list("/api/accounts/options");
    expect(options.contracts.find((contract: { id: string }) => contract.id === id)).toMatchObject({ reference: REF });
  });

  it("appears in the consolidated reports", async () => {
    const report = await list("/api/reports/contract-summary?pageSize=200");
    expect(report.rows.map((row: { reference: string }) => row.reference)).toContain(REF);
    const services = await list("/api/reports/scheduled-services?pageSize=200");
    expect(services.rows.map((row: { reference: string }) => row.reference)).toContain(REF);
  });
});
