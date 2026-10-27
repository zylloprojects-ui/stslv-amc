import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, contractBody, createClient } from "./amc-helpers";
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

const renew = (id: string, overrides: Record<string, unknown> = {}, session: Session = admin) =>
  api()
    .post(`/api/amc/contracts/${id}/renewals`)
    .set(session.headers)
    .send(contractBody(clientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", ...overrides }));

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  clientId = await createClient(admin, "Renewal Test Client");
  otherClientId = await createClient(admin, "Other Test Client");
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
