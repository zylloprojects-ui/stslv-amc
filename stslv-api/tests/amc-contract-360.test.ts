import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { exportInvoicesSchema } from "../src/modules/invoices/invoices.schemas";
import { activeContract, createClient, createContract, visitsOf } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { completeVisit, invoiceBody, newInvoice, type Session } from "./invoices-helpers";
import { resetProjectData } from "./projects-helpers";

// The contract page (AMC Contract 360): the contract's activity history and
// the invoices that cover its visits. Every record here is invented test data.

let admin: Session;
let execution: Session;
let procurement: Session;
let accountant: Session;
let clientId: string;
let contractId: string;
let otherContractId: string;
let draftId: string;

const history = (id: string, session: Session = admin, query: Record<string, string> = {}) =>
  api().get(`/api/amc/contracts/${id}/history`).query(query).set(session.headers);
const invoicesFor = (id: string, session: Session = admin) =>
  api().get("/api/invoices").query({ amcContractId: id }).set(session.headers);

let invoiceA: string;
let invoiceB: string;
let invoiceOther: string;

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);

  clientId = await createClient(admin, "Test Tower");
  contractId = await activeContract(admin, clientId, {
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    maintenanceFrequency: "QUARTERLY",
    contractValue: "1620.000",
    defaultVisitAmount: "405.000",
  });
  otherContractId = await activeContract(admin, clientId, {
    validFrom: "2025-01-01",
    validTo: "2025-12-31",
    maintenanceFrequency: "HALF_YEARLY",
    systemDescription: "CCTV",
    contractValue: "800.000",
    defaultVisitAmount: "400.000",
  });
  draftId = (await createContract(admin, clientId, { systemDescription: "FM200" })).body.data.id as string;

  // Two changes to the first contract, so it has created, updated and status entries.
  await api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send({ notes: "Keys at reception" });
  await api()
    .post(`/api/amc/contracts/${draftId}/status`)
    .set(admin.headers)
    .send({ status: "CANCELLED", reason: "Client chose another provider." });

  const visits = await visitsOf(contractId);
  const otherVisits = await visitsOf(otherContractId);

  for (const visit of [visits[0], visits[1], otherVisits[0]]) {
    await completeVisit(admin, visit?.id as string);
  }

  invoiceA = (await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visits[0]?.id as string, amount: "405.000" }]))).id;
  // One invoice covering a visit of each contract: it belongs to both contracts.
  invoiceB = (
    await newInvoice(
      admin,
      invoiceBody(
        clientId,
        [
          { amcVisitId: visits[1]?.id as string, amount: "405.000" },
          { amcVisitId: otherVisits[0]?.id as string, amount: "400.000" },
        ],
        { amountExclVat: "805.000", vatAmount: "40.250" }
      )
    )
  ).id;
  invoiceOther = (await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: otherVisits[0]?.id as string, amount: "100.000" }], { amountExclVat: "100.000", vatAmount: "5.000" }))).id;
});
afterAll(closePool);

describe("GET /api/amc/contracts/:id/history", () => {
  it("lists only this contract's entries, newest first, with the user who acted", async () => {
    const response = await history(contractId);

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(response.body.data.items.length);

    const actions = response.body.data.items.map((entry: { action: string }) => entry.action);

    expect(actions).toContain("amc_contract.created");
    expect(actions).toContain("amc_contract.updated");
    expect(actions).toContain("amc_contract.schedule_generated");
    expect(actions[actions.length - 1]).toBe("amc_contract.created");

    const stored = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM activity_logs WHERE entity_type = 'amc_contracts' AND entity_id = $1",
      [contractId]
    );

    expect(response.body.data.total).toBe(stored.rows[0]?.count);

    for (const entry of response.body.data.items) {
      expect(entry.user).toEqual({ id: admin.id, fullName: "admin@example.com" });
      expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    const times = response.body.data.items.map((entry: { createdAt: string }) => Date.parse(entry.createdAt));

    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("returns the recorded field changes and a status-change reason", async () => {
    const updated = (await history(contractId)).body.data.items.find((entry: { action: string }) => entry.action === "amc_contract.updated");

    expect(updated.changes).toEqual({ notes: { from: null, to: "Keys at reception" } });
    expect(updated.reason).toBeNull();

    const cancelled = (await history(draftId)).body.data.items.find(
      (entry: { action: string }) => entry.action === "amc_contract.status_changed"
    );

    expect(cancelled.changes).toEqual({ status: { from: "DRAFT", to: "CANCELLED" } });
    expect(cancelled.reason).toBe("Client chose another provider.");
  });

  it("never returns other internal details of an entry", async () => {
    const items = (await history(contractId)).body.data.items as Record<string, unknown>[];
    const generated = items.find((entry) => entry.action === "amc_contract.schedule_generated");

    expect(Object.keys(generated ?? {}).sort()).toEqual(["action", "changes", "createdAt", "description", "id", "reason", "user"]);
    expect(generated?.changes).toBeNull();
    // The stored details of a schedule generation (visit ids, period dates) are not returned.
    expect(JSON.stringify(items)).not.toContain('"metadata"');
    expect(JSON.stringify(items)).not.toContain('"removed":');
    expect(JSON.stringify(items)).not.toContain('"terms"');
  });

  it("does not include another contract's entries", async () => {
    const own = (await history(otherContractId)).body.data.items as { id: string }[];
    const stored = await pool.query<{ id: string }>(
      "SELECT id FROM activity_logs WHERE entity_type = 'amc_contracts' AND entity_id = $1",
      [otherContractId]
    );

    expect(own.length).toBeGreaterThan(0);
    expect(own.map((entry) => entry.id).sort()).toEqual(stored.rows.map((row) => row.id).sort());
    expect(JSON.stringify(own)).not.toContain("Keys at reception");
  });

  it("pages the entries", async () => {
    const first = await history(contractId, admin, { pageSize: "1" });
    const second = await history(contractId, admin, { pageSize: "1", page: "2" });

    expect(first.body.data.items).toHaveLength(1);
    expect(second.body.data.items).toHaveLength(1);
    expect(first.body.data.items[0].id).not.toBe(second.body.data.items[0].id);
    expect(first.body.data.total).toBeGreaterThanOrEqual(3);
    expect((await history(contractId, admin, { pageSize: "101" })).status).toBe(400);
  });

  it("answers 404 for an unknown contract or a malformed id, like the contract itself", async () => {
    expect((await history("999999")).status).toBe(404);
    expect((await history("abc")).status).toBe(404);
    expect((await api().get("/api/amc/contracts/abc").set(admin.headers)).status).toBe(404);
  });

  it("is open to roles that may view contracts and refused to others", async () => {
    expect((await history(contractId, execution)).status).toBe(200);
    expect((await history(contractId, procurement)).status).toBe(403);
    expect((await api().get(`/api/amc/contracts/${contractId}/history`)).status).toBe(401);
  });
});

describe("GET /api/invoices?amcContractId=", () => {
  const ids = (response: { body: { data: { items: { id: string }[] } } }) =>
    response.body.data.items.map((invoice) => invoice.id).sort();

  it("returns exactly the invoices that cover a visit of the contract", async () => {
    const response = await invoicesFor(contractId);

    expect(response.status).toBe(200);
    expect(ids(response)).toEqual([invoiceA, invoiceB].sort());
    expect(response.body.data.total).toBe(2);
    expect(response.body.data.totals.amountExclVat).toBe("1210.000");
  });

  it("includes an invoice that also covers another contract, for both contracts", async () => {
    expect(ids(await invoicesFor(otherContractId))).toEqual([invoiceB, invoiceOther].sort());
  });

  it("returns nothing for a contract without invoices", async () => {
    const response = await invoicesFor(draftId);

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([]);
  });

  it("leaves the list unchanged when the filter is not used", async () => {
    const all = await api().get("/api/invoices").set(admin.headers);

    expect(all.body.data.total).toBe(3);
  });

  it("validates the id and keeps the invoice permission", async () => {
    expect((await api().get("/api/invoices").query({ amcContractId: "abc" }).set(admin.headers)).status).toBe(400);
    expect((await invoicesFor(contractId, accountant)).status).toBe(200);
    expect((await invoicesFor(contractId, execution)).status).toBe(403);
  });

  it("is not part of the invoice export, whose filters are unchanged", () => {
    const parsed = exportInvoicesSchema.parse({ amcContractId: contractId, format: "xlsx" });

    expect(parsed).not.toHaveProperty("amcContractId");
    expect(parsed).toMatchObject({ format: "xlsx" });
  });
});
