import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { loadUserHidden, loadUserPermissions, loadUserRoles, type AuthContext } from "../src/modules/auth/access";
import { exportContractsSchema } from "../src/modules/amc/amc.schemas";
import { buildContractsExport } from "../src/modules/amc/contracts.export";
import { buildClientsExport } from "../src/modules/clients/clients.export";
import { exportClientsSchema } from "../src/modules/clients/clients.schemas";
import { buildInvoicesExport } from "../src/modules/invoices/invoices.export";
import { exportInvoicesSchema } from "../src/modules/invoices/invoices.schemas";
import { buildSalesEngineersExport } from "../src/modules/masters/sales-engineers.service";
import { exportSalesEngineersSchema } from "../src/modules/masters/masters.schemas";
import { visibilityVersionOf } from "../src/modules/roles/roles.service";
import { VISIBILITY_KEYS } from "../src/shared/visibility-catalog";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, contractBody, createClient, grant, renewalEngineer, visitsOf, withRenewalDocument, type Session } from "./amc-helpers";
import { api, closePool, resetData, roleId, signedIn } from "./helpers";
import { completeVisit, invoiceBody, newInvoice } from "./invoices-helpers";

// Role visibility, step B (owner rule "Lock it", 2026-11-21): on pages whose edit form saves every field back, a field
// hidden from the role is blanked in every answer and left out of the downloads, and a save by that role always keeps
// the stored value, even when the request sends a different value or an empty one. Every record here is invented.

let folder: string;
let superAdmin: Session;
let editor: Session;

const EDITOR_ROLE = "VIS_FORMS_EDITOR_TEST";
const EDITOR_GRANTS: [string, string][] = [
  ["INVOICES", "VIEW"], ["INVOICES", "CREATE"], ["INVOICES", "EDIT"], ["INVOICES", "EXPORT"],
  ["AMC_CONTRACTS", "VIEW"], ["AMC_CONTRACTS", "EDIT"], ["AMC_CONTRACTS", "EXPORT"],
  ["AMC_RENEWAL", "VIEW"], ["AMC_RENEWAL", "CREATE"], ["AMC_SCHEDULE", "VIEW"],
  ["CLIENTS", "VIEW"], ["CLIENTS", "CREATE"], ["CLIENTS", "EDIT"], ["CLIENTS", "EXPORT"],
  ["SALES_ENGINEERS", "VIEW"], ["SALES_ENGINEERS", "EDIT"], ["SALES_ENGINEERS", "EXPORT"],
  ["SYSTEM_TYPES", "VIEW"], ["SYSTEM_TYPES", "EDIT"],
  ["MAINTENANCE_FREQUENCIES", "VIEW"], ["MAINTENANCE_FREQUENCIES", "EDIT"],
  ["DEPARTMENTS", "VIEW"], ["DEPARTMENTS", "EDIT"],
];

async function hiddenOf(code: string): Promise<string[]> {
  return (await pool.query<{ item_key: string }>("SELECT item_key FROM role_hidden_items WHERE role_id = $1 ORDER BY item_key", [await roleId(code)])).rows.map((row) => row.item_key);
}

async function setHidden(hidden: string[]) {
  const response = await api()
    .put(`/api/roles/${await roleId(EDITOR_ROLE)}/visibility`)
    .set(superAdmin.headers)
    .send({ hidden, expectedVersion: visibilityVersionOf(await hiddenOf(EDITOR_ROLE)) });
  expect(response.status).toBe(200);
}

async function authOf(userId: string): Promise<AuthContext> {
  const [roles, permissions, hidden] = await Promise.all([loadUserRoles(pool, userId), loadUserPermissions(pool, userId), loadUserHidden(pool, userId)]);
  return { user: { id: userId, email: "x@example.com", fullName: "Test" }, roles, permissions, mustChangePassword: false, hidden };
}

const columnsOf = (report: { tables: { columns: { key: string }[] }[] }) => report.tables[0]!.columns.map((column) => column.key);

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "stslv-role-visibility-forms-"));
  setStorageForTests(new LocalDiskStorage(folder));
  await resetData();
  superAdmin = await signedIn("super-forms@example.com", ["ADMIN"]);
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [EDITOR_ROLE]);
  await grant(EDITOR_ROLE, EDITOR_GRANTS);
  editor = await signedIn("editor-forms@example.com", [EDITOR_ROLE]);
});
beforeEach(async () => {
  await pool.query("DELETE FROM role_hidden_items");
});
afterAll(async () => {
  setStorageForTests(null);
  await rm(folder, { recursive: true, force: true });
  await closePool();
});

describe("Catalogue", () => {
  it("offers only optional, non-identifying fields of these pages", () => {
    for (const key of ["invoiceTracking.column.total", "amcContracts.column.costPerVisit", "clients.column.email", "salesEngineers.column.department", "systemTypes.column.sortOrder", "maintenanceFrequencies.column.sortOrder", "departments.column.description"]) {
      expect(VISIBILITY_KEYS.has(key)).toBe(true);
    }
    // Row-identifying, required-on-create and amount-driving fields are never hideable.
    for (const key of ["invoiceTracking.column.amountExclVat", "invoiceTracking.column.invoiceNumber", "amcContracts.column.contractValue", "amcContracts.column.finalCredit", "amcContracts.column.reference", "amcContracts.column.billingBasis", "clients.column.name", "clients.column.clientType", "salesEngineers.column.name", "maintenanceFrequencies.column.intervalMonths"]) {
      expect(VISIBILITY_KEYS.has(key)).toBe(false);
    }
  });
});

describe("Invoice Tracking", () => {
  let invoiceId: string;

  beforeAll(async () => {
    const clientId = await createClient(superAdmin, "Forms Invoice Client");
    const contractId = await activeContract(superAdmin, clientId, { validFrom: "2025-01-01", validTo: "2025-12-31", maintenanceFrequency: "MONTHLY", contractValue: "4860.000", defaultVisitAmount: "405.000" });
    const [visit] = await visitsOf(contractId);
    await completeVisit(superAdmin, visit!.id);
    invoiceId = (await newInvoice(superAdmin, invoiceBody(clientId, [{ amcVisitId: visit!.id, amount: "405.000" }], { sourceReference: "ZOHO-REF-1", notes: "Stored invoice note" }))).id;
  });

  it("blanks hidden fields in the list, one invoice, the totals and the summary", async () => {
    await setHidden(["invoiceTracking.column.total", "invoiceTracking.column.zohoReference", "invoiceTracking.column.notes", "invoiceTracking.column.recordedBy"]);
    const list = await api().get("/api/invoices").set(editor.headers);
    expect(list.status).toBe(200);
    expect(list.body.data.roleHiddenColumns.sort()).toEqual(["notes", "recordedBy", "total", "zohoReference"]);
    expect(list.body.data.totals.totalAmount).toBeNull();
    expect(list.body.data.totals.amountExclVat).toBe("405.000");
    const item = list.body.data.items.find((invoice: { id: string }) => invoice.id === invoiceId);
    expect(item).toMatchObject({ totalAmount: null, sourceReference: null, notes: null, amountExclVat: "405.000", vatAmount: "20.250" });
    expect(item.createdBy.fullName).toBe("");
    expect(item.invoiceNumber).toBeTruthy();

    const one = await api().get(`/api/invoices/${invoiceId}`).set(editor.headers);
    expect(one.body.data).toMatchObject({ totalAmount: null, sourceReference: null, notes: null });
    const summary = await api().get("/api/invoices/summary").set(editor.headers);
    expect(summary.body.data.issued.totalAmount).toBeNull();
    expect(summary.body.data.issued.amountExclVat).not.toBeNull();

    // Super Admin hides nothing.
    const admin = await api().get(`/api/invoices/${invoiceId}`).set(superAdmin.headers);
    expect(admin.body.data).toMatchObject({ sourceReference: "ZOHO-REF-1", notes: "Stored invoice note", totalAmount: "425.250" });
  });

  it("leaves hidden columns out of the export", async () => {
    await setHidden(["invoiceTracking.column.total", "invoiceTracking.column.zohoReference", "invoiceTracking.column.notes"]);
    const { report } = await buildInvoicesExport(await authOf(editor.id), exportInvoicesSchema.parse({ format: "xlsx" }));
    const keys = columnsOf(report);
    expect(keys).not.toContain("totalAmount");
    expect(keys).not.toContain("sourceReference");
    expect(keys).not.toContain("notes");
    expect(keys).toContain("amountExclVat");
    expect(report.tables[0]!.totals!.values).not.toHaveProperty("totalAmount");
  });

  it("a save keeps the stored hidden values, whatever the request sends", async () => {
    await setHidden(["invoiceTracking.column.zohoReference", "invoiceTracking.column.notes"]);
    const saved = await api().patch(`/api/invoices/${invoiceId}`).set(editor.headers).send({ sourceReference: "CHANGED-REF", notes: "", vatAmount: "21.000" });
    expect(saved.status).toBe(200);
    expect(saved.body.data.sourceReference).toBeNull();
    const stored = (await pool.query("SELECT source_reference, notes, vat_amount FROM invoices WHERE id = $1", [invoiceId])).rows[0];
    expect(stored).toEqual({ source_reference: "ZOHO-REF-1", notes: "Stored invoice note", vat_amount: "21.000" });

    // Sent alone, a hidden field changes nothing at all.
    expect((await api().patch(`/api/invoices/${invoiceId}`).set(editor.headers).send({ notes: "Another" })).status).toBe(200);
    expect((await pool.query("SELECT notes FROM invoices WHERE id = $1", [invoiceId])).rows[0].notes).toBe("Stored invoice note");
  });
});

describe("AMC Contracts", () => {
  let clientId: string;
  let contractId: string;

  beforeAll(async () => {
    clientId = await createClient(superAdmin, "Forms Contract Client");
    contractId = await activeContract(superAdmin, clientId, { defaultVisitAmount: "405.000", description: "Stored description", notes: "Stored notes", customerPoValue: "999.000" });
    // A change the history records, so its hidden values can be checked.
    expect((await api().patch(`/api/amc/contracts/${contractId}`).set(superAdmin.headers).send({ notes: "Stored notes 2" })).status).toBe(200);
  });

  it("blanks hidden fields in the register, the contract and its history", async () => {
    await setHidden(["amcContracts.column.costPerVisit", "amcContracts.column.customerPoValue", "amcContracts.column.description", "amcContracts.column.notes"]);
    const list = await api().get("/api/amc/contracts").query({ pageSize: 100 }).set(editor.headers);
    expect(list.status).toBe(200);
    expect(list.body.data.roleHiddenColumns.sort()).toEqual(["costPerVisit", "customerPoValue", "description", "notes"]);
    const item = list.body.data.items.find((contract: { id: string }) => contract.id === contractId);
    expect(item).toMatchObject({ defaultVisitAmount: null, customerPoValue: null, description: null, notes: null, contractValue: "1620.000" });
    expect(item.amcReference).toBeTruthy();

    const one = await api().get(`/api/amc/contracts/${contractId}`).set(editor.headers);
    expect(one.body.data).toMatchObject({ defaultVisitAmount: null, customerPoValue: null, description: null, notes: null });

    const history = await api().get(`/api/amc/contracts/${contractId}/history`).set(editor.headers);
    expect(history.status).toBe(200);
    for (const entry of history.body.data.items) {
      expect(entry.changes ?? {}).not.toHaveProperty("notes");
      expect(entry.description ?? "").not.toContain("999.000");
    }
  });

  it("leaves hidden columns out of the export", async () => {
    await setHidden(["amcContracts.column.costPerVisit", "amcContracts.column.customerPoValue"]);
    const { report } = await buildContractsExport(await authOf(editor.id), exportContractsSchema.parse({ format: "xlsx" }));
    const keys = columnsOf(report);
    expect(keys).not.toContain("visitValue");
    expect(keys).not.toContain("customerPoValue");
    expect(keys).toContain("contractValue");
  });

  it("a save keeps the stored hidden values, whatever the request sends", async () => {
    await setHidden(["amcContracts.column.costPerVisit", "amcContracts.column.customerPoValue", "amcContracts.column.description", "amcContracts.column.notes"]);
    const saved = await api()
      .patch(`/api/amc/contracts/${contractId}`)
      .set(editor.headers)
      .send({ defaultVisitAmount: "1.000", customerPoValue: "", description: "", notes: "Changed", responsibleEngineer: "New Responsible" });
    expect(saved.status).toBe(200);
    expect(saved.body.data.defaultVisitAmount).toBeNull();
    const stored = (await pool.query("SELECT default_visit_amount, customer_po_value, description, notes, responsible_engineer FROM amc_contracts WHERE id = $1", [contractId])).rows[0];
    expect(stored).toEqual({ default_visit_amount: "405.000", customer_po_value: "999.000", description: "Stored description", notes: "Stored notes 2", responsible_engineer: "New Responsible" });
    // The visits keep their amounts.
    expect((await visitsOf(contractId)).every((visit) => visit.visit_amount === "405.000")).toBe(true);
  });

  it("a renewal keeps what its form starts from for hidden fields", async () => {
    await setHidden(["amcContracts.column.costPerVisit", "amcContracts.column.customerPoValue", "amcContracts.column.description", "amcContracts.column.notes"]);
    const engineer = await renewalEngineer();
    const renewal = await api()
      .post(`/api/amc/contracts/${contractId}/renewals`)
      .set(editor.headers)
      .send(withRenewalDocument(contractBody(clientId, { validFrom: "2028-01-01", validTo: "2028-12-31", status: "DRAFT", salesEngineerId: engineer, defaultVisitAmount: "7.000", description: "Typed", notes: "Typed notes", customerPoValue: "5.000" })));
    expect(renewal.status).toBe(201);
    const stored = (await pool.query("SELECT default_visit_amount, customer_po_value, description, notes FROM amc_contracts WHERE id = $1", [renewal.body.data.id])).rows[0];
    expect(stored).toEqual({ default_visit_amount: "405.000", customer_po_value: null, description: "Stored description", notes: null });
  });
});

describe("Clients", () => {
  let clientId: string;

  beforeAll(async () => {
    const created = await api()
      .post("/api/clients")
      .set(superAdmin.headers)
      .send({ name: "Forms Client Record", contactPerson: "Stored Person", email: "stored@example.com", phone: "111", address: "Stored Street", notes: "Stored client note", clientType: "COMPANY", vatNumber: "OM111" });
    expect(created.status).toBe(201);
    clientId = created.body.data.id;
  });

  it("blanks hidden contact fields, never the id or name the pickers use", async () => {
    await setHidden(["clients.column.email", "clients.column.phone", "clients.column.notes"]);
    const list = await api().get("/api/clients").query({ pageSize: 100 }).set(editor.headers);
    const item = list.body.data.items.find((client: { id: string }) => client.id === clientId);
    expect(item).toMatchObject({ id: clientId, name: "Forms Client Record", email: null, phone: null, notes: null, contactPerson: "Stored Person" });
    expect(list.body.data.roleHiddenColumns.sort()).toEqual(["email", "notes", "phone"]);

    const { report } = await buildClientsExport(await authOf(editor.id), exportClientsSchema.parse({ format: "xlsx", status: "all" }));
    const keys = columnsOf(report);
    expect(keys).not.toContain("email");
    expect(keys).not.toContain("phone");
    expect(keys).not.toContain("remarks");
    expect(keys).toContain("contactPerson");
  });

  it("a save or a new client never takes a hidden field from the request", async () => {
    await setHidden(["clients.column.email", "clients.column.phone", "clients.column.notes"]);
    const saved = await api().patch(`/api/clients/${clientId}`).set(editor.headers).send({ email: "", phone: "999", notes: null, contactPerson: "New Person" });
    expect(saved.status).toBe(200);
    const stored = (await pool.query("SELECT email, phone, notes, contact_person FROM clients WHERE id = $1", [clientId])).rows[0];
    expect(stored).toEqual({ email: "stored@example.com", phone: "111", notes: "Stored client note", contact_person: "New Person" });

    const added = await api().post("/api/clients").set(editor.headers).send({ name: "Forms Client Added", email: "typed@example.com", contactPerson: "Typed", clientType: "COMPANY" });
    expect(added.status).toBe(201);
    const row = (await pool.query("SELECT email, contact_person FROM clients WHERE id = $1", [added.body.data.id])).rows[0];
    expect(row).toEqual({ email: null, contact_person: "Typed" });
  });
});

describe("Master lists", () => {
  it("Sales Engineers: blanked, left out of the export, and kept on save", async () => {
    const department = await api().post("/api/masters/departments").set(superAdmin.headers).send({ code: "FRMDEP", name: "Forms Department", description: "Stored department text" });
    expect(department.status).toBe(201);
    const created = await api()
      .post("/api/masters/sales-engineers")
      .set(superAdmin.headers)
      .send({ code: "FRM-ENG", name: "Forms Engineer", employeeNo: "E-77", email: "eng@example.com", phone: "222", departmentId: department.body.data.id, notes: "Stored engineer note" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    await setHidden(["salesEngineers.column.email", "salesEngineers.column.department", "salesEngineers.column.notes"]);
    const one = await api().get(`/api/masters/sales-engineers/${id}`).set(editor.headers);
    expect(one.body.data).toMatchObject({ id, code: "FRM-ENG", name: "Forms Engineer", email: null, department: null, notes: null, phone: "222" });
    const options = await api().get("/api/masters/sales-engineers/options").set(editor.headers);
    expect(options.body.data.find((engineer: { id: string }) => engineer.id === id)).toMatchObject({ id, name: "Forms Engineer", email: null });

    const { report } = await buildSalesEngineersExport(await authOf(editor.id), exportSalesEngineersSchema.parse({ format: "xlsx" }));
    expect(columnsOf(report)).not.toContain("email");
    expect(columnsOf(report)).not.toContain("department");
    expect(columnsOf(report)).toContain("phone");

    const saved = await api().patch(`/api/masters/sales-engineers/${id}`).set(editor.headers).send({ email: "", departmentId: null, notes: "Changed", phone: "333" });
    expect(saved.status).toBe(200);
    const stored = (await pool.query("SELECT email, department_id::text, notes, phone FROM sales_engineers WHERE id = $1", [id])).rows[0];
    expect(stored).toEqual({ email: "eng@example.com", department_id: department.body.data.id, notes: "Stored engineer note", phone: "333" });

    // The department's own page follows its own rule.
    await setHidden(["departments.column.description"]);
    const dep = await api().get(`/api/masters/departments`).query({ pageSize: 100 }).set(editor.headers);
    expect(dep.body.data.items.find((item: { id: string }) => item.id === department.body.data.id)).toMatchObject({ description: null, name: "Forms Department" });
    expect((await api().patch(`/api/masters/departments/${department.body.data.id}`).set(editor.headers).send({ description: "" })).status).toBe(200);
    expect((await pool.query("SELECT description FROM departments WHERE id = $1", [department.body.data.id])).rows[0].description).toBe("Stored department text");
  });

  it("System Types and Maintenance Frequencies: the sort order is kept on save", async () => {
    const type = await api().post("/api/masters/system-types").set(superAdmin.headers).send({ code: "FRMTYPE", name: "Forms Type", description: "Stored type text", sortOrder: 42 });
    expect(type.status).toBe(201);
    await setHidden(["systemTypes.column.description", "systemTypes.column.sortOrder", "maintenanceFrequencies.column.sortOrder"]);

    const one = await api().get(`/api/masters/system-types/${type.body.data.id}`).set(editor.headers);
    expect(one.body.data).toMatchObject({ name: "Forms Type", description: null, sortOrder: null });
    expect((await api().patch(`/api/masters/system-types/${type.body.data.id}`).set(editor.headers).send({ description: "", sortOrder: 1, name: "Forms Type Renamed" })).status).toBe(200);
    expect((await pool.query("SELECT name, description, sort_order FROM system_types WHERE id = $1", [type.body.data.id])).rows[0]).toEqual({ name: "Forms Type Renamed", description: "Stored type text", sort_order: 42 });

    const frequency = (await pool.query<{ id: string; sort_order: number }>("SELECT id::text, sort_order FROM maintenance_frequencies WHERE code = 'MONTHLY'")).rows[0]!;
    const listed = await api().get("/api/masters/maintenance-frequencies").set(editor.headers);
    expect(listed.body.data.items.find((item: { id: string }) => item.id === frequency.id)).toMatchObject({ sortOrder: null, code: "MONTHLY" });
    expect((await api().patch(`/api/masters/maintenance-frequencies/${frequency.id}`).set(editor.headers).send({ sortOrder: 777 })).status).toBe(200);
    expect((await pool.query("SELECT sort_order FROM maintenance_frequencies WHERE id = $1", [frequency.id])).rows[0].sort_order).toBe(frequency.sort_order);
  });
});
