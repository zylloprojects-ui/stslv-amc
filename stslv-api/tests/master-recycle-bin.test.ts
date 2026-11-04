import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, logsFor } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// Recycle Bin for clients, system types and sales engineers (migration 0106, approved 2026-11-04),
// beside AMC contracts (0101): the bin lists current state only, restore keeps ids and links, permanent
// deletion only for records never used, Super Admin only, and the database guards every rule.
// Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let superAdmin: Session;
let admin: Session;
let masterExecutive: Session;
let viewer: Session;

const BIN = "/api/security/recycle-bin";

const clientCodeOf = (id: string) => `CL-${id.padStart(5, "0")}`;

async function systemType(code: string, name = code) {
  const response = await api().post("/api/masters/system-types").set(superAdmin.headers).send({ code, name });
  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

async function engineer(code: string, name: string, extra: Record<string, unknown> = {}) {
  const response = await api().post("/api/masters/sales-engineers").set(superAdmin.headers).send({ code, name, ...extra });
  expect(response.status).toBe(201);
  return response.body.data.id as string;
}

/** A project for the client: the simplest record that links to a client (invoices must reconcile at commit). */
function insertProject(jobNumber: string, clientId: string, db: { query: typeof pool.query } = pool) {
  return db.query("INSERT INTO projects (job_number, client_id, description, job_date, job_value, vat_rate) VALUES ($1, $2, 'Job', '2026-09-01', 500, 5)", [
    jobNumber,
    clientId,
  ]);
}

const listBin = (query: Record<string, string> = {}, session: Session = superAdmin) => api().get(BIN).query(query).set(session.headers);
const restoreItem = (segment: string, id: string, session: Session = superAdmin) => api().post(`${BIN}/${segment}/${id}/restore`).set(session.headers);
const checkItem = (segment: string, id: string, session: Session = superAdmin) => api().get(`${BIN}/${segment}/${id}/check`).set(session.headers);
const purgeItem = (segment: string, id: string, confirm: string, session: Session = superAdmin) =>
  api().delete(`${BIN}/${segment}/${id}`).set(session.headers).send({ confirm });

beforeAll(async () => {
  await resetData();
  superAdmin = await signedIn("superadmin@example.com", ["ADMIN"]);
  admin = await signedIn("admin@example.com", ["ADMINISTRATOR"]);
  masterExecutive = await signedIn("masters@example.com", ["MASTER_DATA_EXECUTIVE"]);
  viewer = await signedIn("viewer@example.com", ["VIEWER"]);
  // Admin must hold every Delete it could use, so each 403 below is the Super Admin rule, not a missing grant.
  await pool.query(
    `INSERT INTO role_permissions (role_id, module, action)
     SELECT r.id, m.module, a.action FROM roles r
     CROSS JOIN (VALUES ('CLIENTS'), ('SYSTEM_TYPES'), ('SALES_ENGINEERS'), ('AMC_CONTRACTS')) AS m (module)
     CROSS JOIN (VALUES ('VIEW'), ('DELETE'), ('EDIT')) AS a (action)
     WHERE r.code IN ('ADMINISTRATOR', 'MASTER_DATA_EXECUTIVE') ON CONFLICT DO NOTHING`
  );
});
afterAll(closePool);

describe("moving to the Recycle Bin and restoring", () => {
  it("keeps each record with its id, code and timestamps, hides it everywhere, and restores it unchanged", async () => {
    const clientId = await createClient(superAdmin, "Recyclable Client");
    const typeId = await systemType("RB-TYPE", "Recyclable Type");
    const engineerId = await engineer("RB-ENG", "Recyclable Engineer");
    const items = [
      { segment: "clients", id: clientId, table: "clients_all", remove: `/api/clients/${clientId}`, get: `/api/clients/${clientId}` },
      { segment: "system-types", id: typeId, table: "system_types_all", remove: `/api/masters/system-types/${typeId}`, get: `/api/masters/system-types/${typeId}` },
      { segment: "sales-engineers", id: engineerId, table: "sales_engineers_all", remove: `/api/masters/sales-engineers/${engineerId}`, get: `/api/masters/sales-engineers/${engineerId}` },
    ];

    for (const item of items) {
      const before = (await pool.query(`SELECT to_jsonb(t) - 'deleted_at' - 'deleted_by' AS row FROM ${item.table} t WHERE id = $1`, [item.id])).rows[0]?.row;

      const moved = await api().delete(item.remove).set(superAdmin.headers);
      expect(moved.status).toBe(200);
      expect(moved.body.data).toEqual({ deleted: true, recycleBin: true });
      expect((await api().get(item.get).set(superAdmin.headers)).status).toBe(404);

      const kept = await pool.query(`SELECT to_jsonb(t) - 'deleted_at' - 'deleted_by' AS row, deleted_by FROM ${item.table} t WHERE id = $1`, [item.id]);
      // Every value, updated_at included, is unchanged: deleted_at and deleted_by record the move.
      expect(kept.rows[0]?.row).toEqual(before);
      expect(kept.rows[0]?.deleted_by).toBe(superAdmin.id);

      const restored = await restoreItem(item.segment, item.id);
      expect(restored.status).toBe(200);
      expect(restored.body.data).toMatchObject({ id: item.id, warnings: [] });
      expect((await api().get(item.get).set(superAdmin.headers)).status).toBe(200);

      const after = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${item.table} t WHERE id = $1`, [item.id])).rows[0]?.row;
      expect(after).toMatchObject({ ...before, deleted_at: null, deleted_by: null });

      // Restoring twice: the second answers that nothing is in the Recycle Bin.
      expect((await restoreItem(item.segment, item.id)).status).toBe(404);
    }

    expect((await logsFor("clients", clientId)).map((log) => log.action)).toEqual(["client.created", "client.deleted", "client.restored"]);
    expect((await logsFor("system_types", typeId)).map((log) => log.action)).toEqual(["system_type.created", "system_type.deleted", "system_type.restored"]);
    expect((await logsFor("sales_engineers", engineerId)).map((log) => log.action)).toEqual(["sales_engineer.created", "sales_engineer.deleted", "sales_engineer.restored"]);
  });

  it("refuses while a live contract uses the record, counting every status, and never says 0", async () => {
    const clientId = await createClient(superAdmin, "Busy Client");
    const typeId = await systemType("BUSY", "Busy Type");
    const engineerId = await engineer("BUSY-ENG", "Busy Engineer");
    const contract = await activeContract(superAdmin, clientId, { systemTypeId: typeId, salesEngineerId: engineerId });
    // A cancelled contract still blocks: it is a live record.
    await pool.query("UPDATE amc_contracts_all SET status = 'CANCELLED' WHERE id = $1", [contract]);

    for (const path of [`/api/clients/${clientId}`, `/api/masters/system-types/${typeId}`, `/api/masters/sales-engineers/${engineerId}`]) {
      const refused = await api().delete(path).set(superAdmin.headers);

      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toContain("1 AMC contract (1 Cancelled)");
      expect(refused.body.error.message).not.toMatch(/\b0 AMC/);
    }

    const usage = await api().get(`/api/masters/system-types/${typeId}/usage`).set(superAdmin.headers);
    expect(usage.body.data).toMatchObject({ contracts: { total: 1, byStatus: { CANCELLED: 1 } }, recycledContracts: 0, canMoveToRecycleBin: false });
  });

  it("is the System Types fix: a type used only by a contract in the Recycle Bin moves, and its list shows the count apart", async () => {
    const clientId = await createClient(superAdmin, "HVAC Client");
    const typeId = await systemType("HVAC-RB", "HVAC");
    const contract = await activeContract(superAdmin, clientId, { systemTypeId: typeId });
    expect((await api().delete(`/api/amc/contracts/${contract}`).set(superAdmin.headers)).status).toBe(200);

    const listed = (await api().get("/api/masters/system-types").query({ search: "HVAC-RB" }).set(superAdmin.headers)).body.data.items[0];
    expect(listed).toMatchObject({ contractCount: 0, recycledContractCount: 1 });

    const usage = await api().get(`/api/masters/system-types/${typeId}/usage`).set(superAdmin.headers);
    expect(usage.body.data).toMatchObject({ contracts: { total: 0 }, recycledContracts: 1, canMoveToRecycleBin: true, blockers: [] });

    // Before 0106 this was "HVAC is used by 0 AMC contracts and cannot be deleted."
    expect((await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers)).status).toBe(200);
  });

  it("refuses a client used by a project (invoices and import rows likewise: tests/clients.test.ts)", async () => {
    const clientId = await createClient(superAdmin, "Project Client");
    await insertProject("RBPRJ-1", clientId);

    const refused = await api().delete(`/api/clients/${clientId}`).set(superAdmin.headers);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("1 project");

    // And the database refuses it again, should the API check be bypassed.
    await expect(pool.query("UPDATE clients_all SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [clientId, superAdmin.id])).rejects.toMatchObject({ code: "RB002" });
  });

  it("keeps names and codes reserved while in the Recycle Bin, and says so", async () => {
    const clientId = await createClient(superAdmin, "Reserved Name");
    const typeId = await systemType("RESV", "Reserved Type");
    const engineerId = await engineer("RESV-ENG", "Reserved Engineer", { employeeNo: "EMP-RESV" });
    await api().delete(`/api/clients/${clientId}`).set(superAdmin.headers);
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);
    await api().delete(`/api/masters/sales-engineers/${engineerId}`).set(superAdmin.headers);

    const client = await api().post("/api/clients").set(superAdmin.headers).send({ name: " reserved name ", clientType: "COMPANY" });
    expect(client.status).toBe(409);
    expect(client.body.error.message).toContain("is in the Recycle Bin");

    const type = await api().post("/api/masters/system-types").set(superAdmin.headers).send({ code: "resv", name: "Another" });
    expect(type.status).toBe(409);
    expect(type.body.error.details[0]).toMatchObject({ field: "code" });
    expect(type.body.error.message).toContain("Recycle Bin");

    for (const body of [{ code: "resv-eng", name: "Other A" }, { code: "OTHER-B", name: "Reserved Engineer" }, { code: "OTHER-C", name: "Other C", employeeNo: "emp-resv" }]) {
      const response = await api().post("/api/masters/sales-engineers").set(superAdmin.headers).send(body);
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain("Recycle Bin");
    }

    // Restoring can never collide, because nothing could take the name meanwhile.
    expect((await restoreItem("clients", clientId)).status).toBe(200);
    expect((await restoreItem("system-types", typeId)).status).toBe(200);
    expect((await restoreItem("sales-engineers", engineerId)).status).toBe(200);
  });

  it("keeps an engineer's linked user account reserved while it is in the Recycle Bin", async () => {
    const linked = await signedIn("linked-engineer@example.com", ["VIEWER"]);
    const engineerId = await engineer("LINKED", "Linked Engineer", { userId: linked.id });
    await api().delete(`/api/masters/sales-engineers/${engineerId}`).set(superAdmin.headers);

    const options = await api().get("/api/masters/sales-engineers/user-options").set(superAdmin.headers);
    expect(options.body.data.map((user: { id: string }) => user.id)).not.toContain(linked.id);

    const second = await api().post("/api/masters/sales-engineers").set(superAdmin.headers).send({ code: "LINKED-2", name: "Second Link", userId: linked.id });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain("Recycle Bin");
  });

  it("restores a deactivated record as deactivated, with a warning", async () => {
    const typeId = await systemType("WASOFF", "Was Off");
    await api().post(`/api/masters/system-types/${typeId}/status`).set(superAdmin.headers).send({ isActive: false });
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);

    const check = await checkItem("system-types", typeId);
    expect(check.body.data.restore).toMatchObject({ allowed: true, blockers: [] });
    expect(check.body.data.restore.warnings[0]).toContain("restored as deactivated");

    const restored = await restoreItem("system-types", typeId);
    expect(restored.body.data.warnings).toHaveLength(1);
    expect((await pool.query("SELECT is_active FROM system_types WHERE id = $1", [typeId])).rows[0]?.is_active).toBe(false);
  });
});

describe("the Recycle Bin list", () => {
  it("shows only records currently in it: never deactivated, reactivated or restored ones", async () => {
    const departmentId = (await api().post("/api/masters/departments").set(superAdmin.headers).send({ code: "RB-DEPT", name: "Bin Department" })).body.data.id as string;
    const engineerId = await engineer("RB-TOGGLE", "Toggle Engineer");

    // Deactivated and reactivated twice: none of it is a Recycle Bin entry.
    for (let round = 0; round < 2; round += 1) {
      await api().post(`/api/masters/departments/${departmentId}/status`).set(superAdmin.headers).send({ isActive: false });
      await api().post(`/api/masters/departments/${departmentId}/status`).set(superAdmin.headers).send({ isActive: true });
      await api().post(`/api/masters/sales-engineers/${engineerId}/status`).set(superAdmin.headers).send({ isActive: false });
      await api().post(`/api/masters/sales-engineers/${engineerId}/status`).set(superAdmin.headers).send({ isActive: true });
    }
    // Deactivated and left so: still not in the Recycle Bin.
    await api().post(`/api/masters/sales-engineers/${engineerId}/status`).set(superAdmin.headers).send({ isActive: false });

    const listed = await listBin({ search: "Toggle" });
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toEqual([]);

    // Moved, it appears once; restored, it is gone; the history keeps every event.
    await api().delete(`/api/masters/sales-engineers/${engineerId}`).set(superAdmin.headers);
    expect((await listBin({ search: "Toggle" })).body.data.items).toMatchObject([{ type: "SALES_ENGINEER", id: engineerId, reference: "RB-TOGGLE", isActive: false }]);
    await restoreItem("sales-engineers", engineerId);
    expect((await listBin({ search: "Toggle" })).body.data.items).toEqual([]);

    const history = await api().get("/api/security/deletions").query({ entityType: "sales_engineers", pageSize: "100" }).set(superAdmin.headers);
    const actions = history.body.data.items.filter((item: { entityId: string }) => item.entityId === engineerId).map((item: { action: string }) => item.action);
    expect(actions).toEqual([
      "sales_engineer.restored",
      "sales_engineer.deleted",
      "sales_engineer.deactivated",
      "sales_engineer.reactivated",
      "sales_engineer.deactivated",
      "sales_engineer.reactivated",
      "sales_engineer.deactivated",
    ]);
    // Each entry shows the engineer's status now: deactivated, not in the Recycle Bin.
    expect(new Set(history.body.data.items.filter((item: { entityId: string }) => item.entityId === engineerId).map((item: { currentStatus: string }) => item.currentStatus))).toEqual(
      new Set(["INACTIVE"])
    );
    const reactivated = await api().get("/api/security/deletions").query({ kind: "RESTORED", entityType: "departments" }).set(superAdmin.headers);
    expect(reactivated.body.data.items.filter((item: { entityId: string }) => item.entityId === departmentId)).toHaveLength(2);
  });

  it("lists all four types newest first, filters, pages accurately and counts per type", async () => {
    const clientId = await createClient(superAdmin, "Paged Client");
    const contract = await activeContract(superAdmin, clientId, { systemDescription: "PAGED-SYSTEM" });
    const typeId = await systemType("PAGED", "Paged Type");
    const engineerId = await engineer("PAGED-ENG", "Paged Engineer");
    await api().delete(`/api/amc/contracts/${contract}`).set(superAdmin.headers);
    await api().delete(`/api/clients/${clientId}`).set(superAdmin.headers);
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);
    await api().delete(`/api/masters/sales-engineers/${engineerId}`).set(superAdmin.headers);

    const all = await listBin({ search: "Paged" });
    expect(all.body.data.total).toBe(4);
    // Newest first: the engineer was moved last. The contract matches by its client's name.
    expect(all.body.data.items.map((item: { type: string }) => item.type)).toEqual(["SALES_ENGINEER", "SYSTEM_TYPE", "CLIENT", "AMC_CONTRACT"]);
    expect(all.body.data.items[3]).toMatchObject({ id: contract, name: "Paged Client", details: "PAGED-SYSTEM", contract: { services: expect.any(Number) } });
    expect(all.body.data.items[2]).toMatchObject({ reference: clientCodeOf(clientId), deletedBy: { id: superAdmin.id } });

    const page2 = await listBin({ search: "Paged", pageSize: "3", page: "2" });
    expect(page2.body.data).toMatchObject({ total: 4, page: 2, pageSize: 3 });
    expect(page2.body.data.items.map((item: { type: string }) => item.type)).toEqual(["AMC_CONTRACT"]);

    expect((await listBin({ search: "Paged", type: "CLIENT" })).body.data.items.map((item: { id: string }) => item.id)).toEqual([clientId]);
    expect((await listBin({ search: "PAGED-ENG" })).body.data.total).toBe(1);
    expect((await listBin({ type: "NOPE" })).status).toBe(400);
    expect((await listBin({ deletedBy: admin.id, search: "Paged" })).body.data.total).toBe(0);
    expect((await listBin({ from: "2999-01-01" })).body.data.total).toBe(0);
    expect(all.body.data.counts.CLIENT).toBeGreaterThanOrEqual(1);
    expect(all.body.data.options.deletedBy).toEqual([{ id: superAdmin.id, fullName: expect.any(String) }]);
  });
});

describe("contract restore and parents in the Recycle Bin", () => {
  it("refuses to restore a contract while its system type or engineer is in the Recycle Bin, and warns about deactivated ones", async () => {
    const clientId = await createClient(superAdmin, "Parent Client");
    const typeId = await systemType("PARENT", "Parent Type");
    const engineerId = await engineer("PARENT-ENG", "Parent Engineer");
    const contract = await activeContract(superAdmin, clientId, { systemTypeId: typeId, salesEngineerId: engineerId });
    await api().delete(`/api/amc/contracts/${contract}`).set(superAdmin.headers);
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);
    await api().delete(`/api/masters/sales-engineers/${engineerId}`).set(superAdmin.headers);

    const check = await checkItem("amc-contracts", contract);
    expect(check.body.data.restore.allowed).toBe(false);
    expect(check.body.data.restore.blockers).toHaveLength(2);
    expect(check.body.data.purge).toMatchObject({ allowed: false, confirmText: null });

    const refused = await restoreItem("amc-contracts", contract);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('system type PARENT "Parent Type" is in the Recycle Bin');

    // The database refuses it too, should the API check be bypassed.
    await expect(pool.query("UPDATE amc_contracts_all SET deleted_at = NULL, deleted_by = NULL WHERE id = $1", [contract])).rejects.toMatchObject({ code: "RB001" });

    await restoreItem("system-types", typeId);
    await restoreItem("sales-engineers", engineerId);
    await api().post(`/api/masters/sales-engineers/${engineerId}/status`).set(superAdmin.headers).send({ isActive: false });

    const warned = await checkItem("amc-contracts", contract);
    expect(warned.body.data.restore).toMatchObject({ allowed: true, blockers: [] });
    expect(warned.body.data.restore.warnings[0]).toContain('sales engineer PARENT-ENG "Parent Engineer" is deactivated');
    expect((await restoreItem("amc-contracts", contract)).status).toBe(200);
  });

  it("never deletes an AMC contract permanently", async () => {
    const clientId = await createClient(superAdmin, "Never Purged Client");
    const contract = await activeContract(superAdmin, clientId);
    await api().delete(`/api/amc/contracts/${contract}`).set(superAdmin.headers);

    const response = await purgeItem("amc-contracts", contract, "anything");
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("never deleted permanently");
    expect((await pool.query("SELECT 1 FROM amc_contracts_all WHERE id = $1", [contract])).rowCount).toBe(1);
  });

  it("refuses at the database any new link to a record in the Recycle Bin", async () => {
    const clientId = await createClient(superAdmin, "Guarded Client");
    const typeId = await systemType("GUARD", "Guarded Type");
    const contract = await activeContract(superAdmin, await createClient(superAdmin, "Live Client"));
    await api().delete(`/api/clients/${clientId}`).set(superAdmin.headers);
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);

    await expect(
      pool.query("INSERT INTO invoices (invoice_number, client_id, invoice_date, amount_excl_vat, vat_amount, created_by) VALUES ('GUARD-1', $1, '2026-09-15', 10, 0, $2)", [clientId, superAdmin.id])
    ).rejects.toMatchObject({ code: "RB001" });
    await expect(pool.query("UPDATE amc_contracts_all SET client_id = $2 WHERE id = $1", [contract, clientId])).rejects.toMatchObject({ code: "RB001" });
    await expect(pool.query("UPDATE amc_contracts_all SET system_type_id = $2 WHERE id = $1", [contract, typeId])).rejects.toMatchObject({ code: "RB001" });

    // Through the API, a client in the Recycle Bin is simply not found.
    const invoice = await api()
      .post("/api/invoices")
      .set(superAdmin.headers)
      .send({ invoiceNumber: "GUARD-2", clientId, invoiceDate: "2026-09-15", amountExclVat: "10.000", vatAmount: "0.000" });
    expect([400, 404, 409]).toContain(invoice.status);
    expect((await pool.query("SELECT 1 FROM invoices WHERE invoice_number = 'GUARD-2'")).rowCount).toBe(0);
  });
});

describe("permanent deletion", () => {
  it("deletes a never-used record permanently after the code is typed, and logs all of it", async () => {
    const clientId = await createClient(superAdmin, "Never Used Client");
    const typeId = await systemType("NEVER", "Never Used Type");
    await api().delete(`/api/clients/${clientId}`).set(superAdmin.headers);
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);

    const check = await checkItem("clients", clientId);
    expect(check.body.data.purge).toEqual({ allowed: true, reasons: [], confirmText: clientCodeOf(clientId) });

    const wrong = await purgeItem("clients", clientId, "CL-99999");
    expect(wrong.status).toBe(400);
    expect((await pool.query("SELECT 1 FROM clients_all WHERE id = $1", [clientId])).rowCount).toBe(1);

    expect((await purgeItem("clients", clientId, clientCodeOf(clientId).toLowerCase())).status).toBe(200);
    expect((await purgeItem("system-types", typeId, "never")).status).toBe(200);
    expect((await pool.query("SELECT 1 FROM clients_all WHERE id = $1", [clientId])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM system_types_all WHERE id = $1", [typeId])).rowCount).toBe(0);

    const purged = (await logsFor("clients", clientId)).at(-1);
    expect(purged).toMatchObject({ action: "client.purged", metadata: { recycleBin: true, deleted: { id: Number(clientId), name: "Never Used Client", client_type: "COMPANY" } } });
    expect((await listBin({ search: "Never Used" })).body.data.total).toBe(0);
  });

  it("is only possible from the Recycle Bin", async () => {
    const typeId = await systemType("LIVE-ONE", "Live One");

    expect((await purgeItem("system-types", typeId, "LIVE-ONE")).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM system_types WHERE id = $1", [typeId])).rowCount).toBe(1);
  });

  it("refuses when earlier use cannot be ruled out: imported, renamed after use, or named in contract text", async () => {
    // 1. No creation entry in the Audit Log: imported or seeded, so its past is unknown.
    const imported = (await pool.query<{ id: string }>("INSERT INTO system_types (code, name) VALUES ('IMPORTED', 'Imported Type') RETURNING id")).rows[0]!.id;
    await api().delete(`/api/masters/system-types/${imported}`).set(superAdmin.headers);
    const importedCheck = await checkItem("system-types", imported);
    expect(importedCheck.body.data.purge.allowed).toBe(false);
    expect(importedCheck.body.data.purge.reasons.join(" ")).toContain("creation is not recorded");
    expect((await purgeItem("system-types", imported, "IMPORTED")).status).toBe(409);

    // 2. Linked to a contract, then unlinked: the contract's history names the type by its earlier name.
    const clientId = await createClient(superAdmin, "History Client");
    const usedType = await systemType("WASUSED", "Was Used Type");
    const otherType = await systemType("REPLACER", "Replacer Type");
    const contract = await activeContract(superAdmin, clientId, { systemTypeId: usedType });
    expect((await api().put(`/api/amc/contracts/${contract}/masters`).set(superAdmin.headers).send({ systemTypeId: otherType })).status).toBe(200);
    expect((await api().patch(`/api/masters/system-types/${usedType}`).set(superAdmin.headers).send({ name: "Renamed Since" })).status).toBe(200);
    expect((await api().delete(`/api/masters/system-types/${usedType}`).set(superAdmin.headers)).status).toBe(200);
    const usedCheck = await checkItem("system-types", usedType);
    expect(usedCheck.body.data.purge.allowed).toBe(false);
    expect(usedCheck.body.data.purge.reasons.join(" ")).toContain("Audit Log refers to it");

    // 3. An engineer named in a contract's typed Responsible Engineer text.
    const typedEngineer = await engineer("TYPED", "Typed Engineer");
    await pool.query("UPDATE amc_contracts_all SET responsible_engineer = ' typed engineer ' WHERE id = $1", [contract]);
    await api().delete(`/api/masters/sales-engineers/${typedEngineer}`).set(superAdmin.headers);
    const typedCheck = await checkItem("sales-engineers", typedEngineer);
    expect(typedCheck.body.data.purge.reasons.join(" ")).toContain("responsible engineer");
    expect((await purgeItem("sales-engineers", typedEngineer, "TYPED")).status).toBe(409);
    expect((await pool.query("SELECT 1 FROM sales_engineers_all WHERE id = $1", [typedEngineer])).rowCount).toBe(1);
  });
});

describe("permissions", () => {
  it("allows Recycle Bin management to Super Admin only, whatever other roles hold", async () => {
    const clientId = await createClient(superAdmin, "Permission Client");
    const typeId = await systemType("PERM", "Permission Type");
    const engineerId = await engineer("PERM-ENG", "Permission Engineer");

    for (const session of [admin, masterExecutive, viewer]) {
      for (const path of [`/api/clients/${clientId}`, `/api/masters/system-types/${typeId}`, `/api/masters/sales-engineers/${engineerId}`]) {
        expect((await api().delete(path).set(session.headers)).status).toBe(403);
      }
    }
    expect((await pool.query("SELECT count(*)::int AS count FROM clients_all WHERE id = $1 AND deleted_at IS NULL", [clientId])).rows[0]?.count).toBe(1);

    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);

    // Admin may open the page (Deletion History) but not the Recycle Bin or its actions; others not at all.
    for (const session of [admin, masterExecutive, viewer]) {
      expect((await listBin({}, session)).status).toBe(403);
      expect((await checkItem("system-types", typeId, session)).status).toBe(403);
      expect((await restoreItem("system-types", typeId, session)).status).toBe(403);
      expect((await purgeItem("system-types", typeId, "PERM", session)).status).toBe(403);
    }
    expect((await api().get("/api/security/deletions").set(admin.headers)).status).toBe(200);
    expect((await api().get("/api/security/deletions").set(viewer.headers)).status).toBe(403);
    expect((await listBin()).status).toBe(200);
    expect((await api().get(BIN)).status).toBe(401);
    expect((await pool.query("SELECT 1 FROM system_types_all WHERE id = $1 AND deleted_at IS NOT NULL", [typeId])).rowCount).toBe(1);
  });

  it("audits every move, restore and permanent deletion with who did it", async () => {
    const typeId = await systemType("AUDIT", "Audited Type");
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);
    await restoreItem("system-types", typeId);
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);
    await purgeItem("system-types", typeId, "AUDIT");

    const logs = await pool.query<{ action: string; user_id: string; module: string }>(
      "SELECT action, user_id, module FROM activity_logs WHERE entity_type = 'system_types' AND entity_id = $1 ORDER BY id",
      [typeId]
    );
    expect(logs.rows).toEqual([
      { action: "system_type.created", user_id: superAdmin.id, module: "SYSTEM_TYPES" },
      { action: "system_type.deleted", user_id: superAdmin.id, module: "SYSTEM_TYPES" },
      { action: "system_type.restored", user_id: superAdmin.id, module: "SYSTEM_TYPES" },
      { action: "system_type.deleted", user_id: superAdmin.id, module: "SYSTEM_TYPES" },
      { action: "system_type.purged", user_id: superAdmin.id, module: "SYSTEM_TYPES" },
    ]);
  });
});

describe("concurrency and rollback", () => {
  it("serializes a move with a link being made: an uncommitted project makes the move wait, then refuse", async () => {
    const clientId = await createClient(superAdmin, "Race Client");
    const other = await pool.connect();

    try {
      await other.query("BEGIN");
      await insertProject("RACE-1", clientId, other);

      const move = api().delete(`/api/clients/${clientId}`).set(superAdmin.headers).then((response) => response);
      // The move is waiting on the project's lock on the client; commit it.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await other.query("COMMIT");

      const response = await move;
      expect(response.status).toBe(409);
      expect(response.body.error.message).toContain("1 project");
    } finally {
      other.release();
    }
    expect((await pool.query("SELECT deleted_at FROM clients_all WHERE id = $1", [clientId])).rows[0]?.deleted_at).toBeNull();
  });

  it("serializes a link with a move: a link made while the move commits is refused by the guard", async () => {
    const clientId = await createClient(superAdmin, "Race Client Two");
    const mover = await pool.connect();
    const linker = await pool.connect();

    try {
      await mover.query("BEGIN");
      await mover.query("UPDATE clients_all SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [clientId, superAdmin.id]);

      const link = insertProject("RACE-2", clientId, linker)
        .then(
          () => "inserted",
          (error: { code?: string }) => error.code
        );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await mover.query("COMMIT");

      expect(await link).toBe("RB001");
    } finally {
      mover.release();
      linker.release();
    }
    expect((await pool.query("SELECT 1 FROM projects WHERE job_number = 'RACE-2'")).rowCount).toBe(0);
  });

  it("lets only one of two simultaneous restores, or a restore and a permanent deletion, succeed", async () => {
    const typeId = await systemType("TWICE", "Twice Type");
    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);

    const statuses = (await Promise.all([restoreItem("system-types", typeId), restoreItem("system-types", typeId)])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 404]);
    expect((await logsFor("system_types", typeId)).filter((log) => log.action === "system_type.restored")).toHaveLength(1);

    await api().delete(`/api/masters/system-types/${typeId}`).set(superAdmin.headers);
    const raced = (await Promise.all([restoreItem("system-types", typeId), purgeItem("system-types", typeId, "TWICE")])).map((response) => response.status);
    expect(raced.filter((status) => status === 200)).toHaveLength(1);

    const row = await pool.query("SELECT deleted_at FROM system_types_all WHERE id = $1", [typeId]);
    // Either restored (row live) or deleted permanently (no row): never half of each.
    expect(raced[0] === 200 ? row.rows[0]?.deleted_at : row.rowCount).toBe(raced[0] === 200 ? null : 0);
  });

  it("rolls everything back when a step fails after the move", async () => {
    const clientId = await createClient(superAdmin, "Rollback Probe Client");
    await pool.query(`CREATE FUNCTION rb_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'client.deleted' AND NEW.description LIKE '%Rollback Probe%' THEN RAISE EXCEPTION 'probe'; END IF; RETURN NEW; END; $$`);
    await pool.query("CREATE TRIGGER rb_test_fail BEFORE INSERT ON activity_logs FOR EACH ROW EXECUTE FUNCTION rb_test_fail()");

    try {
      const response = await api().delete(`/api/clients/${clientId}`).set(superAdmin.headers);
      expect(response.status).toBe(500);
    } finally {
      await pool.query("DROP TRIGGER rb_test_fail ON activity_logs");
      await pool.query("DROP FUNCTION rb_test_fail()");
    }

    expect((await pool.query("SELECT deleted_at, deleted_by FROM clients_all WHERE id = $1", [clientId])).rows[0]).toEqual({ deleted_at: null, deleted_by: null });
    expect((await logsFor("clients", clientId)).map((log) => log.action)).toEqual(["client.created"]);
  });
});
