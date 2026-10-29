import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, contractBody, createClient, renewalEngineer } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// Contract renewals (migration 0072): a renewal is a new contract linked to the
// one it renews, which stays unchanged. Every record here is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let clientId: string;
let otherClientId: string;
let sourceId: string;
// Every renewal names an active sales engineer; this one is used unless a test says otherwise.
let defaultEngineerId: string;

const renew = (id: string, overrides: Record<string, unknown> = {}, session: Session = admin) =>
  api()
    .post(`/api/amc/contracts/${id}/renewals`)
    .set(session.headers)
    .send(contractBody(clientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId: defaultEngineerId, ...overrides }));

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  clientId = await createClient(admin, "Renewal Test Client");
  otherClientId = await createClient(admin, "Other Test Client");
  defaultEngineerId = await renewalEngineer();
  sourceId = await activeContract(admin, clientId, { validFrom: "2027-01-01", validTo: "2027-12-31" });
});
afterAll(closePool);

describe("POST /api/amc/contracts/:id/renewals", () => {
  let renewalId: string;

  it("creates a new linked contract and leaves the source contract, visits and history untouched", async () => {
    const before = (await api().get(`/api/amc/contracts/${sourceId}`).set(admin.headers)).body.data;
    const visitsBefore = await pool.query("SELECT id, status, visit_amount FROM amc_visits WHERE amc_contract_id = $1 ORDER BY id", [sourceId]);

    const response = await renew(sourceId);

    expect(response.status).toBe(201);
    renewalId = response.body.data.id as string;
    expect(renewalId).not.toBe(sourceId);
    expect(response.body.data).toMatchObject({ status: "DRAFT", validFrom: "2028-01-01", validTo: "2028-12-31", client: { id: clientId } });

    const after = (await api().get(`/api/amc/contracts/${sourceId}`).set(admin.headers)).body.data;
    expect(after).toEqual(before);
    const visitsAfter = await pool.query("SELECT id, status, visit_amount FROM amc_visits WHERE amc_contract_id = $1 ORDER BY id", [sourceId]);
    expect(visitsAfter.rows).toEqual(visitsBefore.rows);
  });

  it("shows the link from both sides and records it in both histories", async () => {
    const source = (await api().get(`/api/amc/contracts/${sourceId}/renewals`).set(admin.headers)).body.data;
    expect(source.renewedFrom).toBeNull();
    expect(source.renewals.map((item: { id: string }) => item.id)).toEqual([renewalId]);

    const renewal = (await api().get(`/api/amc/contracts/${renewalId}/renewals`).set(admin.headers)).body.data;
    expect(renewal.renewedFrom).toMatchObject({ id: sourceId, validFrom: "2027-01-01", validTo: "2027-12-31", status: "ACTIVE" });
    expect(renewal.renewals).toEqual([]);

    const sourceHistory = (await api().get(`/api/amc/contracts/${sourceId}/history`).set(admin.headers)).body.data.items;
    expect(sourceHistory[0].action).toBe("amc_contract.renewal_created");
    const renewalHistory = (await api().get(`/api/amc/contracts/${renewalId}/history`).set(admin.headers)).body.data.items;
    expect(renewalHistory.map((item: { action: string }) => item.action)).toContain("amc_contract.renewal_of");
  });

  it("allows only one open renewal, and another once that renewal is cancelled", async () => {
    const second = await renew(sourceId);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe("This contract already has a renewal. Open that renewal instead, or cancel it first.");

    await api().post(`/api/amc/contracts/${renewalId}/status`).set(admin.headers).send({ status: "CANCELLED" });
    expect((await renew(sourceId)).status).toBe(201);
  });

  it("is for the same client and follows the usual contract checks", async () => {
    const other = await activeContract(admin, clientId, { validFrom: "2027-01-01", validTo: "2027-06-30", systemDescription: "CCTV" });

    const wrongClient = await renew(other, { clientId: otherClientId });
    expect(wrongClient.status).toBe(400);
    expect(wrongClient.body.error.details[0].field).toBe("clientId");

    expect((await renew(other, { validTo: "2027-12-31", validFrom: "2028-01-01" })).status).toBe(400);
    expect((await renew("999999")).status).toBe(404);
  });

  it("needs permission to create contracts", async () => {
    expect((await renew(sourceId, {}, execution)).status).toBe(403);
    expect((await api().get(`/api/amc/contracts/${sourceId}/renewals`).set(execution.headers)).status).toBe(200);
  });
});

describe("GET /api/amc/reports/renewals", () => {
  it("lists every renewal with its source, newest first", async () => {
    const response = await api().get("/api/amc/reports/renewals").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(2);
    expect(response.body.data.items[0]).toMatchObject({ renewal: { client: { name: "Renewal Test Client" } }, source: { id: sourceId, status: "ACTIVE" } });
    expect((await api().get("/api/amc/reports/renewals").set(execution.headers)).status).toBe(200);
  });
});

describe("the sales engineer of a renewal", () => {
  const engineer = async (name: string, isActive = true) =>
    (await pool.query<{ id: string }>("INSERT INTO sales_engineers (name, is_active) VALUES ($1, $2) RETURNING id", [name, isActive])).rows[0]!.id;
  const linkedTo = async (contractId: string) =>
    (await api().get(`/api/amc/contracts/${contractId}/masters`).set(admin.headers)).body.data.salesEngineer as { id: string; name: string; isActive: boolean } | null;
  // A fresh source per case, linked to the given engineer.
  const sourceWith = async (engineerId: string | null, systemDescription: string) => {
    const id = await activeContract(admin, clientId, { validFrom: "2027-01-01", validTo: "2027-12-31", systemDescription });
    if (engineerId) await pool.query("UPDATE amc_contracts SET sales_engineer_id = $1 WHERE id = $2", [engineerId, id]);
    return id;
  };
  const contractCount = async () => (await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM amc_contracts")).rows[0]!.n;

  let alpha: string;
  let beta: string;

  beforeAll(async () => {
    alpha = await engineer("Renewal Engineer Alpha");
    beta = await engineer("Renewal Engineer Beta");
  });

  it("keeps the active engineer of the renewed contract when the renewal names them", async () => {
    const source = await sourceWith(alpha, "SE-ACTIVE");
    const response = await renew(source, { systemDescription: "SE-ACTIVE", salesEngineerId: alpha });

    expect(response.status).toBe(201);
    expect(await linkedTo(response.body.data.id)).toMatchObject({ id: alpha, name: "Renewal Engineer Alpha", isActive: true });
    expect(await linkedTo(source)).toMatchObject({ id: alpha });
  });

  it("saves a different active engineer chosen for the renewal, and leaves the renewed contract as it was", async () => {
    const source = await sourceWith(alpha, "SE-CHANGED");
    const response = await renew(source, { systemDescription: "SE-CHANGED", salesEngineerId: beta });

    expect(response.status).toBe(201);
    expect(await linkedTo(response.body.data.id)).toMatchObject({ id: beta });
    expect(await linkedTo(source)).toMatchObject({ id: alpha });
  });

  it("requires an active engineer when the renewed contract's engineer is no longer active, and never fills one in", async () => {
    const former = await engineer("Renewal Engineer Former", false);
    const source = await sourceWith(former, "SE-INACTIVE");
    const before = await contractCount();

    for (const overrides of [{ salesEngineerId: undefined }, { salesEngineerId: null }]) {
      const refused = await renew(source, { systemDescription: "SE-INACTIVE", ...overrides });
      expect(refused.status).toBe(400);
      expect(refused.body.error.details).toEqual([
        {
          field: "salesEngineerId",
          message: "Renewal Engineer Former, the sales engineer of the contract being renewed, is no longer active. Select an active sales engineer.",
        },
      ]);
    }
    // The inactive engineer cannot be chosen either.
    const inactive = await renew(source, { systemDescription: "SE-INACTIVE", salesEngineerId: former });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.details[0].field).toBe("salesEngineerId");
    expect(await contractCount()).toBe(before);

    const chosen = await renew(source, { systemDescription: "SE-INACTIVE", salesEngineerId: beta });
    expect(chosen.status).toBe(201);
    expect(await linkedTo(chosen.body.data.id)).toMatchObject({ id: beta });
    expect(await linkedTo(source)).toMatchObject({ id: former, isActive: false });
  });

  it("requires an active engineer even when the renewed contract had none", async () => {
    const source = await sourceWith(null, "SE-NONE");
    const before = await contractCount();

    for (const overrides of [{ salesEngineerId: undefined }, { salesEngineerId: null }]) {
      const refused = await renew(source, { systemDescription: "SE-NONE", ...overrides });
      expect(refused.status).toBe(400);
      expect(refused.body.error.details).toEqual([{ field: "salesEngineerId", message: "Select an active sales engineer for the renewal." }]);
    }
    expect(await contractCount()).toBe(before);

    const chosen = await renew(source, { systemDescription: "SE-NONE", salesEngineerId: alpha });
    expect(chosen.status).toBe(201);
    expect(await linkedTo(chosen.body.data.id)).toMatchObject({ id: alpha });
  });

  it("does not let a new contract that is not a renewal need an engineer", async () => {
    const created = await api().post("/api/amc/contracts").set(admin.headers).send(contractBody(clientId, { systemDescription: "SE-NEW", status: "DRAFT" }));

    expect(created.status).toBe(201);
    expect(await linkedTo(created.body.data.id)).toBeNull();
  });
});
