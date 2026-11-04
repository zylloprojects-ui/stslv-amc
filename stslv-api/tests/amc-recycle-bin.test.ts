import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, contractBody, createClient, renewalEngineer, visitsOf, withServiceReport } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// AMC Recycle Bin (migration 0101, approved 2026-11-03): moving a contract to the Recycle Bin
// removes nothing; restoring brings back the same contract. Super Admin only. Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;
let superAdmin: Session;
let adminRole: Session;
let accountant: Session;
let clientId: string;

beforeAll(async () => {
  await resetData();
  superAdmin = await signedIn("superadmin@example.com", ["ADMIN"]);
  adminRole = await signedIn("admin-role@example.com", ["ADMINISTRATOR"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  // The Admin role must hold AMC Contracts Delete, so the 403 below is the Super Admin rule, not a missing grant.
  await pool.query(
    "INSERT INTO role_permissions (role_id, module, action) SELECT id, 'AMC_CONTRACTS', 'DELETE' FROM roles WHERE code = 'ADMINISTRATOR' ON CONFLICT DO NOTHING"
  );
  clientId = await createClient(superAdmin, "Recycle Bin Hotel");
});
afterAll(closePool);

const remove = (id: string, session: Session = superAdmin) => api().delete(`/api/amc/contracts/${id}`).set(session.headers);
const restore = (id: string, session: Session = superAdmin) => api().post(`/api/security/recycle-bin/amc-contracts/${id}/restore`).set(session.headers);
const bin = (session: Session = superAdmin) => api().get("/api/security/recycle-bin/amc-contracts").set(session.headers);
const logs = async (id: string) =>
  (await pool.query<{ action: string; metadata: Record<string, unknown> }>(
    "SELECT action, metadata FROM activity_logs WHERE entity_type = 'amc_contracts' AND entity_id = $1 ORDER BY id",
    [id]
  )).rows;

/** A contract with a completed service, an invoice for it, notes and a document: everything that must survive. */
async function workedContract(system: string) {
  const id = await activeContract(superAdmin, clientId, { systemDescription: system, validFrom: "2026-01-01", validTo: "2026-12-31" });
  const visits = await visitsOf(id);
  const first = visits[0]!;
  await withServiceReport(first.id);
  expect((await api().patch(`/api/amc/execution/visits/${first.id}`).set(superAdmin.headers).send({ status: "COMPLETED", completedDate: "2026-02-01" })).status).toBe(200);
  await pool.query("UPDATE amc_visits SET notes = 'Service report RB-1' WHERE id = $1", [visits[1]!.id]);
  const invoice = await api()
    .post("/api/invoices")
    .set(superAdmin.headers)
    .send({ invoiceNumber: `RB-${system}`, clientId, invoiceDate: "2026-02-05", amountExclVat: first.visit_amount, vatAmount: "0.000", allocations: [{ amcVisitId: first.id, amount: first.visit_amount }] });
  expect(invoice.status).toBe(201);
  await pool.query(
    `INSERT INTO attachments (entity_type, entity_id, category, title, original_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
     VALUES ('amc_contracts', $1, 'SIGNED_CONTRACT', 'Signed contract', 'signed.pdf', 'application/pdf', 10, repeat('a', 64), $2, $3)`,
    [id, `test/${id}.pdf`, superAdmin.id]
  );

  return { id, visits, invoiceId: invoice.body.data.id as string };
}

describe("moving an AMC contract to the Recycle Bin", () => {
  it("keeps the contract, services, invoice, document and history, and hides it from normal use", async () => {
    const { id, visits, invoiceId } = await workedContract("RB-KEEP");
    const activeBefore = (await api().get("/api/amc/summary").set(superAdmin.headers)).body.data.contracts.active;

    const response = await remove(id);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ deleted: true });
    // Nothing physically removed.
    const stored = await pool.query("SELECT deleted_at, deleted_by FROM amc_contracts_all WHERE id = $1", [id]);
    expect(stored.rows[0]?.deleted_at).not.toBeNull();
    expect(stored.rows[0]?.deleted_by).toBe(superAdmin.id);
    const keptVisits = await pool.query("SELECT id, status, notes FROM amc_visits_all WHERE amc_contract_id = $1 ORDER BY id", [id]);
    expect(keptVisits.rows.map((row) => row.id)).toEqual(visits.map((visit) => visit.id));
    expect(keptVisits.rows[0]?.status).toBe("COMPLETED");
    expect(keptVisits.rows[1]?.notes).toBe("Service report RB-1");
    // The document uploaded here and the contract document the contract was added with.
    expect((await pool.query("SELECT 1 FROM attachments WHERE entity_type = 'amc_contracts' AND entity_id = $1", [id])).rowCount).toBe(2);

    // The invoice stays, still showing what it covers.
    const invoice = await api().get(`/api/invoices/${invoiceId}`).set(superAdmin.headers);
    expect(invoice.status).toBe(200);
    expect(invoice.body.data.status).not.toBe("CANCELLED");
    expect(invoice.body.data.allocations[0].amcVisit).toMatchObject({ contractId: id, systemDescription: "RB-KEEP" });

    // Gone from normal use: the contract, its services, lists and counts.
    expect((await api().get(`/api/amc/contracts/${id}`).set(superAdmin.headers)).status).toBe(404);
    expect((await api().patch(`/api/amc/contracts/${id}`).set(superAdmin.headers).send({ notes: "x" })).status).toBe(404);
    expect((await api().get(`/api/amc/visits/${visits[0]!.id}`).set(superAdmin.headers)).status).toBe(404);
    expect((await api().get("/api/amc/contracts").query({ search: "RB-KEEP" }).set(superAdmin.headers)).body.data.total).toBe(0);
    expect((await api().get("/api/amc/visits").query({ contractId: id }).set(superAdmin.headers)).body.data.items ?? []).toEqual([]);
    expect((await api().get("/api/amc/summary").set(superAdmin.headers)).body.data.contracts.active).toBe(activeBefore - 1);
    expect((await api().get(`/api/attachments`).query({ entityType: "amc_contracts", entityId: id }).set(superAdmin.headers)).status).toBe(404);

    // Logged, and listed in the Recycle Bin with what it keeps.
    const entries = await logs(id);
    expect(entries.at(-1)).toMatchObject({ action: "amc_contract.deleted", metadata: { recycleBin: true } });
    const listed = (await bin()).body.data.find((row: { id: string }) => row.id === id);
    expect(listed).toMatchObject({ systemDescription: "RB-KEEP", services: visits.length, invoices: 1, documents: 2, deletedBy: "superadmin@example.com" });
    const deletionLog = await api().get("/api/security/deletions").set(superAdmin.headers);
    expect(deletionLog.body.data.items.some((item: { action: string; entityId: string }) => item.action === "amc_contract.deleted" && item.entityId === id)).toBe(true);

    // A second delete finds nothing.
    expect((await remove(id)).status).toBe(404);
  });

  it("restores the same contract, number and services, and logs it", async () => {
    const { id, visits } = await workedContract("RB-RESTORE");
    expect((await remove(id)).status).toBe(200);

    const restored = await restore(id);

    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ id, systemDescription: "RB-RESTORE", status: "ACTIVE" });
    expect((await api().get(`/api/amc/contracts/${id}`).set(superAdmin.headers)).status).toBe(200);
    expect((await visitsOf(id)).map((visit) => [visit.id, visit.status])).toEqual(visits.map((visit, index) => [visit.id, index === 0 ? "COMPLETED" : visit.status]));
    expect((await pool.query("SELECT deleted_at, deleted_by FROM amc_contracts_all WHERE id = $1", [id])).rows[0]).toEqual({ deleted_at: null, deleted_by: null });
    expect((await bin()).body.data.some((row: { id: string }) => row.id === id)).toBe(false);
    expect((await logs(id)).slice(-2).map((entry) => entry.action)).toEqual(["amc_contract.deleted", "amc_contract.restored"]);
    // Restoring a contract that is not in the Recycle Bin finds nothing.
    expect((await restore(id)).status).toBe(404);
  });

  it("never reuses an AMC number: a new contract gets a new id, and a restored one keeps its own", async () => {
    const first = await activeContract(superAdmin, clientId, { systemDescription: "RB-NUMBER" });
    expect((await remove(first)).status).toBe(200);
    const second = await activeContract(superAdmin, clientId, { systemDescription: "RB-NUMBER" });

    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
    expect((await restore(first)).body.data.id).toBe(first);
    const ids = (await pool.query<{ id: string }>("SELECT id FROM amc_contracts WHERE system_description = 'RB-NUMBER' ORDER BY id")).rows.map((row) => row.id);
    expect(ids).toEqual([first, second]);
  });

  it("is Super Admin only: Admin (with AMC Contracts Delete) and others get 403 on delete, list and restore", async () => {
    const id = await activeContract(superAdmin, clientId, { systemDescription: "RB-PERMISSION" });

    for (const session of [adminRole, accountant]) {
      expect((await remove(id, session)).status).toBe(403);
    }
    expect((await remove(id, adminRole)).body.error.message).toContain("Only Super Admin");
    expect((await api().get(`/api/amc/contracts/${id}`).set(superAdmin.headers)).status).toBe(200);
    expect((await logs(id)).some((entry) => entry.action === "amc_contract.deleted")).toBe(false);

    expect((await remove(id)).status).toBe(200);
    expect((await bin(adminRole)).status).toBe(403);
    expect((await restore(id, adminRole)).status).toBe(403);
    expect((await bin(accountant)).status).toBe(403);
    expect((await restore(id, accountant)).status).toBe(403);
    expect((await api().get("/api/security/recycle-bin/amc-contracts")).status).toBe(401);
    expect((await pool.query("SELECT deleted_at FROM amc_contracts_all WHERE id = $1", [id])).rows[0]?.deleted_at).not.toBeNull();
  });

  it("refuses a contract that has been renewed, and refuses restoring a renewal whose source was renewed again", async () => {
    const engineer = await renewalEngineer();
    const source = await activeContract(superAdmin, clientId, { systemDescription: "RB-SOURCE", validFrom: "2027-01-01", validTo: "2027-12-31" });
    const renew = () =>
      api()
        .post(`/api/amc/contracts/${source}/renewals`)
        .set(superAdmin.headers)
        .send(contractBody(clientId, { systemDescription: "RB-SOURCE", validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId: engineer }));
    const renewal = await renew();
    expect(renewal.status).toBe(201);
    const renewalId = renewal.body.data.id as string;

    const refused = await remove(source);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("was renewed as");
    expect((await api().get(`/api/amc/contracts/${source}`).set(superAdmin.headers)).status).toBe(200);

    // The renewal itself may go to the Recycle Bin; the source can then be renewed again.
    expect((await remove(renewalId)).status).toBe(200);
    const second = await renew();
    expect(second.status).toBe(201);

    const blocked = await restore(renewalId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain("has since been renewed");
    expect((await pool.query("SELECT deleted_at FROM amc_contracts_all WHERE id = $1", [renewalId])).rows[0]?.deleted_at).not.toBeNull();
  });

  it("a client whose only contract is in the Recycle Bin can follow it there, but can never be deleted permanently (0106)", async () => {
    const otherClient = await createClient(superAdmin, "Client With Binned Contract");
    const id = await activeContract(superAdmin, otherClient, { systemDescription: "RB-CLIENT" });

    // While the contract is live, the client cannot go to the Recycle Bin.
    const refused = await api().delete(`/api/clients/${otherClient}`).set(superAdmin.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("1 AMC contract (1 Active)");

    expect((await remove(id)).status).toBe(200);
    expect((await api().delete(`/api/clients/${otherClient}`).set(superAdmin.headers)).status).toBe(200);

    // The contract stays listed in the Recycle Bin although its client is there too.
    expect((await bin()).body.data.map((item: { id: string }) => item.id)).toContain(id);

    const purge = await api().delete(`/api/security/recycle-bin/clients/${otherClient}`).set(superAdmin.headers).send({ confirm: `CL-${otherClient.padStart(5, "0")}` });
    expect(purge.status).toBe(409);
    expect(purge.body.error.message).toContain("1 AMC contract (1 in the Recycle Bin)");
    expect((await pool.query("SELECT 1 FROM clients_all WHERE id = $1", [otherClient])).rowCount).toBe(1);

    // The contract cannot be restored before its client.
    const blocked = await restore(id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain(`client CL-${otherClient.padStart(5, "0")} "Client With Binned Contract" is in the Recycle Bin`);

    expect((await api().post(`/api/security/recycle-bin/clients/${otherClient}/restore`).set(superAdmin.headers)).status).toBe(200);
    expect((await restore(id)).status).toBe(200);
  });
});
