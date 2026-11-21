import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { setStorageForTests } from "../src/modules/attachments/attachments.service";
import { buildAccountsExport } from "../src/modules/accounts/accounts.export";
import { loadUserHidden, loadUserPermissions, loadUserRoles, type AuthContext } from "../src/modules/auth/access";
import { visibilityVersionOf } from "../src/modules/roles/roles.service";
import { VISIBILITY_CATALOG, VISIBILITY_KEYS } from "../src/shared/visibility-catalog";
import { exportAccountsSchema } from "../src/modules/accounts/accounts.schemas";
import { buildMasterStatusExport } from "../src/modules/amc/master-status.export";
import { exportMasterStatusSchema } from "../src/modules/amc/master-status.schemas";
import { LocalDiskStorage } from "../src/shared/storage";
import { activeContract, contractDocument, createClient, grant, logsFor, type Session } from "./amc-helpers";
import { api, closePool, resetData, roleId, signedIn, withoutOneRoleConstraint } from "./helpers";

// Role visibility (owner request 2026-11-21, migration 0123): Roles & Permissions hides single parts of a page
// (a Dashboard row or panel, an Invoices column, an action) from a role that keeps the page. Enforced by the API:
// hidden data is not sent, hidden downloads are refused, and exports leave hidden columns out. Records are invented.

let folder: string;
let superAdmin: Session;

const ACCOUNTS_ROLE = "VIS_ACCOUNTS_TEST";
const OTHER_ROLE = "VIS_OTHER_TEST";
const ROLE_GRANTS: [string, string][] = [
  ["DASHBOARD", "VIEW"],
  ["AMC_CONTRACTS", "VIEW"],
  ["AMC_SCHEDULE", "VIEW"],
  ["INVOICES", "VIEW"],
  ["ACCOUNTS", "VIEW"],
  ["ACCOUNTS", "EXPORT"],
  ["MASTER_AMC_STATUS", "VIEW"],
  ["SERVICE_STATUS", "VIEW"],
];

async function customRole(code: string, permissions: [string, string][]) {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1) ON CONFLICT DO NOTHING", [code]);
  await grant(code, permissions);
}

async function hiddenOf(code: string): Promise<string[]> {
  return (await pool.query<{ item_key: string }>("SELECT item_key FROM role_hidden_items WHERE role_id = $1 ORDER BY item_key", [await roleId(code)])).rows.map((row) => row.item_key);
}

/** Saves the hidden items of a role through the API, from its current version. */
async function setHidden(code: string, hidden: string[], session: Session = superAdmin) {
  const id = await roleId(code);
  return api()
    .put(`/api/roles/${id}/visibility`)
    .set(session.headers)
    .send({ hidden, expectedVersion: visibilityVersionOf(await hiddenOf(code)) });
}

const dashboard = async (session: Session) => {
  const response = await api().get("/api/dashboard/operations").set(session.headers);
  expect(response.status).toBe(200);
  return response.body.data;
};

const accounts = async (session: Session) => {
  const response = await api().get("/api/accounts").query({ pageSize: 200 }).set(session.headers);
  expect(response.status).toBe(200);
  return response.body.data;
};

async function authOf(userId: string): Promise<AuthContext> {
  const [roles, permissions, hidden] = await Promise.all([loadUserRoles(pool, userId), loadUserPermissions(pool, userId), loadUserHidden(pool, userId)]);
  return { user: { id: userId, email: "x@example.com", fullName: "Test" }, roles, permissions, mustChangePassword: false, hidden };
}

beforeAll(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "stslv-role-visibility-"));
  setStorageForTests(new LocalDiskStorage(folder));
  await resetData();
  superAdmin = await signedIn("super@example.com", ["ADMIN"]);
  await customRole(ACCOUNTS_ROLE, ROLE_GRANTS);
  await customRole(OTHER_ROLE, ROLE_GRANTS);
  const client = await createClient(superAdmin, "Visibility Client");
  await activeContract(superAdmin, client, { contractDocument: contractDocument(Buffer.from("%PDF-1.4\n% vis\n%%EOF\n", "latin1"), "vis.pdf") });
});
beforeEach(async () => {
  await pool.query("DELETE FROM role_hidden_items");
});
afterAll(async () => {
  setStorageForTests(null);
  await rm(folder, { recursive: true, force: true });
  await closePool();
});

describe("Roles & Permissions: page visibility settings", () => {
  it("lists the catalogue and every role's hidden items (none by default)", async () => {
    const response = await api().get("/api/roles").set(superAdmin.headers);
    expect(response.status).toBe(200);
    expect(response.body.data.visibilityCatalog).toEqual(JSON.parse(JSON.stringify(VISIBILITY_CATALOG)));
    for (const role of response.body.data.roles) expect(role.hiddenItems).toEqual([]);
  });

  it("saves hidden items, logs the change, and refuses a stale save", async () => {
    const saved = await setHidden(ACCOUNTS_ROLE, ["dashboard.row.portfolio"]);
    expect(saved.status).toBe(200);
    expect(saved.body.data.hiddenItems).toEqual(["dashboard.row.portfolio"]);
    expect(await hiddenOf(ACCOUNTS_ROLE)).toEqual(["dashboard.row.portfolio"]);

    const logs = await logsFor("roles", await roleId(ACCOUNTS_ROLE));
    expect(logs.some((log: { action: string }) => log.action === "role.visibility_changed")).toBe(true);

    const stale = await api()
      .put(`/api/roles/${await roleId(ACCOUNTS_ROLE)}/visibility`)
      .set(superAdmin.headers)
      .send({ hidden: [], expectedVersion: visibilityVersionOf([]) });
    expect(stale.status).toBe(409);
    expect(await hiddenOf(ACCOUNTS_ROLE)).toEqual(["dashboard.row.portfolio"]);
  });

  it("refuses an unknown item, Super Admin's own role, and users who may not manage roles", async () => {
    expect((await setHidden(ACCOUNTS_ROLE, ["dashboard.row.nothing"])).status).toBe(400);
    expect((await setHidden("ADMIN", ["dashboard.row.portfolio"])).status).toBe(403);

    const plain = await signedIn("plain-roles@example.com", [OTHER_ROLE]);
    expect((await setHidden(ACCOUNTS_ROLE, ["dashboard.row.portfolio"], plain)).status).toBe(403);
    expect(await hiddenOf(ACCOUNTS_ROLE)).toEqual([]);
  });

  it("only knows keys of the catalogue", () => {
    expect(VISIBILITY_KEYS.has("dashboard.row.portfolio")).toBe(true);
    expect(VISIBILITY_KEYS.has("invoices.action.downloadContract")).toBe(true);
    expect([...VISIBILITY_KEYS].every((key) => /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2}$/.test(key))).toBe(true);
  });
});

describe("Dashboard rows and panels", () => {
  it("leaves out exactly the hidden row, and everything else is unchanged", async () => {
    const user = await signedIn("dash-row@example.com", [ACCOUNTS_ROLE]);
    const before = await dashboard(user);
    expect(before.kpis.contracts).not.toBeNull();

    expect((await setHidden(ACCOUNTS_ROLE, ["dashboard.row.portfolio"])).status).toBe(200);
    const after = await dashboard(user);

    expect(after.kpis.contracts).toBeNull();
    // The other rows and panels are exactly as before.
    expect(after.kpis.services).toEqual(before.kpis.services);
    expect(after.kpis.payments).toEqual(before.kpis.payments);
    expect(after.yearToDate).toEqual(before.yearToDate);
    expect(after.tillDate).toEqual(before.tillDate);
    expect(after.schedule).toEqual(before.schedule);
    expect(after.workload).toEqual(before.workload);
    // The session tells the page what to leave out.
    const me = await api().get("/api/auth/me").set(user.headers);
    expect(me.body.data.user?.hidden ?? me.body.data.hidden).toEqual(["dashboard.row.portfolio"]);
  });

  it("removes only the figures of a hidden row that shares a section with others", async () => {
    const user = await signedIn("dash-month@example.com", [ACCOUNTS_ROLE]);
    expect((await setHidden(ACCOUNTS_ROLE, ["dashboard.row.month", "dashboard.panel.workload", "dashboard.panel.calendar", "dashboard.row.ytd"])).status).toBe(200);
    const data = await dashboard(user);

    expect(data.kpis.services).not.toHaveProperty("thisMonth");
    expect(data.kpis.services).toHaveProperty("overall");
    expect(data.kpis.payments).not.toHaveProperty("scheduledThisMonth");
    expect(data.kpis.payments).toHaveProperty("paid");
    expect(data.kpis.contracts).not.toBeNull();
    expect(data.workload).toBeNull();
    expect(data.schedule).toBeNull();
    expect(data.yearToDate).toBeNull();
    expect(data.periodInvoices).not.toHaveProperty("yearToDate");
    expect(data.tillDate).not.toBeNull();
  });

  it("never hides anything from Super Admin", async () => {
    expect((await setHidden(ACCOUNTS_ROLE, ["dashboard.row.portfolio"])).status).toBe(200);
    expect((await dashboard(superAdmin)).kpis.contracts).not.toBeNull();
  });
});

describe("Accounts › Invoices columns and actions", () => {
  it("downloads the contract by default, and refuses it once the action is hidden while the column stays", async () => {
    const user = await signedIn("inv-action@example.com", [ACCOUNTS_ROLE]);
    const row = (await accounts(user)).items.find((item: { contractDocument: unknown }) => item.contractDocument);
    expect(row).toBeDefined();
    expect((await api().get(`/api/accounts/${row.id}/contract-document`).set(user.headers)).status).toBe(200);

    expect((await setHidden(ACCOUNTS_ROLE, ["invoices.action.downloadContract"])).status).toBe(200);
    const data = await accounts(user);
    expect(data.contractDocumentVisible).toBe(true);
    expect((await api().get(`/api/accounts/${row.id}/contract-document`).set(user.headers)).status).toBe(403);
    // Another role with the page keeps the download.
    const other = await signedIn("inv-other@example.com", [OTHER_ROLE]);
    expect((await api().get(`/api/accounts/${row.id}/contract-document`).set(other.headers)).status).toBe(200);
  });

  it("does not send a hidden column's data, and drops the totals built from it", async () => {
    const user = await signedIn("inv-columns@example.com", [ACCOUNTS_ROLE]);
    expect((await setHidden(ACCOUNTS_ROLE, ["invoices.column.amcContract", "invoices.column.visitValue", "invoices.column.client"])).status).toBe(200);
    const data = await accounts(user);

    expect(data.contractDocumentVisible).toBe(false);
    expect(data.roleHiddenColumns.sort()).toEqual(["amcContract", "client", "visitValue"]);
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      expect(item.contractDocument).toBeNull();
      expect(item.visitValue).toBeNull();
      expect(item.annualAmcValue).toBeNull();
      expect(item.client.name).toBe("");
      // The row itself stays.
      expect(item.reference).toBeTruthy();
      expect(item.scheduledDate).toBeTruthy();
    }
    expect(data.kpis).not.toHaveProperty("totalValue");
    expect(data.kpis).not.toHaveProperty("paidValue");
    expect(data.kpis.rows).toBe(data.items.length);
    // The column hides its download too.
    expect((await api().get(`/api/accounts/${data.items[0].id}/contract-document`).set(user.headers)).status).toBe(403);
  });

  it("leaves hidden columns and their totals out of the export, whatever the page asks for", async () => {
    const user = await signedIn("inv-export@example.com", [ACCOUNTS_ROLE]);
    expect((await setHidden(ACCOUNTS_ROLE, ["invoices.column.visitValue", "invoices.column.salesEngineer"])).status).toBe(200);
    const { report } = await buildAccountsExport(await authOf(user.id), exportAccountsSchema.parse({ format: "xlsx" }));
    const table = report.tables[0]!;
    const keys = table.columns.map((column) => column.key);

    expect(keys).not.toContain("visitValue");
    expect(keys).not.toContain("salesEngineer");
    expect(keys).toContain("invoiceNo");
    expect(table.totals?.values ?? {}).not.toHaveProperty("visitValue");
    expect((table.notes ?? []).join(" ")).not.toMatch(/Total value|Value of Paid services/);
  });
});

describe("Phase 2: Master AMC Status, Service Status, AMC Management", () => {
  it("Master AMC Status: does not send hidden columns, drops value totals, and leaves them out of the export", async () => {
    const user = await signedIn("ms-columns@example.com", [ACCOUNTS_ROLE]);
    const before = await api().get("/api/amc/master-status").query({ pageSize: 200 }).set(user.headers);
    expect(before.status).toBe(200);
    expect(before.body.data.items.some((item: { client: { name: string } }) => item.client.name !== "")).toBe(true);

    expect((await setHidden(ACCOUNTS_ROLE, ["masterStatus.column.client", "masterStatus.column.visitValue", "masterStatus.column.quotationNo"])).status).toBe(200);
    const data = (await api().get("/api/amc/master-status").query({ pageSize: 200 }).set(user.headers)).body.data;
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      expect(item.client.name).toBe("");
      expect(item.visitValue).toBeNull();
      expect(item.amcValue).toBeNull();
      expect(item.quotationNo).toBeNull();
      expect(item.reference).toBeTruthy();
    }
    expect(data.kpis).not.toHaveProperty("totalValue");
    expect(data.kpis.total).toBe(data.items.length);
    expect(data.amcValueVisible).toBe(false);

    const { report } = await buildMasterStatusExport(await authOf(user.id), exportMasterStatusSchema.parse({ format: "xlsx" }));
    const keys = report.tables[0]!.columns.map((column) => column.key);
    expect(keys).not.toContain("client");
    expect(keys).not.toContain("visitValue");
    expect(keys).not.toContain("quotationNo");
    expect(report.tables[0]!.totals).toBeUndefined();
  });

  it("Service Status: blanks hidden read-only columns and their totals; edited columns are not hideable", async () => {
    const user = await signedIn("ss-columns@example.com", [ACCOUNTS_ROLE]);
    expect(VISIBILITY_KEYS.has("serviceStatus.column.workingDays")).toBe(false);
    expect(VISIBILITY_KEYS.has("serviceStatus.column.report")).toBe(false);

    expect((await setHidden(ACCOUNTS_ROLE, ["serviceStatus.column.serviceValue", "serviceStatus.column.engineer"])).status).toBe(200);
    const data = (await api().get("/api/amc/service-status").query({ pageSize: 200 }).set(user.headers)).body.data;
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      expect(item.serviceValue).toBeNull();
      expect(item.salesEngineer).toBeNull();
    }
    // AMC Value stays, with its total; the Service Value total goes.
    expect(data.amcValueVisible).toBe(true);
    expect(data.totals).toHaveProperty("amcValue");
    expect(data.totals).not.toHaveProperty("serviceValue");

    // The single-service view follows the same rule.
    const one = await api().get(`/api/amc/service-status/${data.items[0].id}`).set(user.headers);
    expect(one.status).toBe(200);
    expect(one.body.data.serviceValue).toBeNull();
  });

  it("AMC Management: leaves out a hidden KPI group and panel, and keeps the rest", async () => {
    const user = await signedIn("mgmt@example.com", [ACCOUNTS_ROLE]);
    const before = (await api().get("/api/amc/management/summary").set(user.headers)).body.data;
    expect(before.contracts).toBeDefined();
    expect(before.expiry).toBeDefined();

    expect((await setHidden(ACCOUNTS_ROLE, ["amcManagement.group.contracts", "amcManagement.panel.expiry"])).status).toBe(200);
    const after = (await api().get("/api/amc/management/summary").set(user.headers)).body.data;
    expect(after).not.toHaveProperty("contracts");
    expect(after.kpis.contracts).toBeNull();
    expect(after).not.toHaveProperty("expiry");
    expect(after.recentContracts).toEqual(before.recentContracts);
    expect(after.schedule).toEqual(before.schedule);
    expect(after.kpis.services).toEqual(before.kpis.services);
  });
});

describe("Step A: Invoice Acknowledgements, Service Sales, AMC Renewals, Reports", () => {
  it("Reports: a hidden report is left out of the list and refused, others stay", async () => {
    await grant(ACCOUNTS_ROLE, [["REPORTS", "VIEW"], ["REPORTS", "EXPORT"], ["AMC_CONTRACTS", "EXPORT"], ["AMC_RENEWAL", "VIEW"], ["AMC_RENEWAL", "EXPORT"], ["SERVICES_SALES", "VIEW"]]);
    const user = await signedIn("reports-vis@example.com", [ACCOUNTS_ROLE]);
    const before = (await api().get("/api/reports").set(user.headers)).body.data as { id: string }[];
    expect(before.map((report) => report.id)).toContain("contract-summary");

    expect((await setHidden(ACCOUNTS_ROLE, ["reports.report.contractSummary"])).status).toBe(200);
    const after = (await api().get("/api/reports").set(user.headers)).body.data as { id: string }[];
    expect(after.map((report) => report.id)).not.toContain("contract-summary");
    expect(after.length).toBe(before.length - 1);
    expect((await api().get("/api/reports/contract-summary").set(user.headers)).status).toBe(403);
    expect((await api().get("/api/reports/contract-summary/export").query({ format: "xlsx" }).set(user.headers)).status).toBe(403);
  });

  it("AMC Renewals: hidden queue columns are blanked and a hidden Renewal History is refused", async () => {
    const user = await signedIn("renewal-vis@example.com", [ACCOUNTS_ROLE]);
    expect((await api().get("/api/amc/reports/renewals").set(user.headers)).status).toBe(200);

    expect((await setHidden(ACCOUNTS_ROLE, ["amcRenewal.column.amount", "amcRenewal.column.client", "amcRenewal.panel.history"])).status).toBe(200);
    const queue = await api().get("/api/amc/renewals/queue").query({ pageSize: 200 }).set(user.headers);
    expect(queue.status).toBe(200);
    expect(queue.body.data.roleHiddenColumns.sort()).toEqual(["amount", "client"]);
    for (const item of queue.body.data.items) {
      expect(item.contractValue).toBe("");
      expect(item.client.name).toBe("");
      expect(item.reference).toBeTruthy();
    }
    expect((await api().get("/api/amc/reports/renewals").set(user.headers)).status).toBe(403);
    expect((await api().get("/api/amc/reports/renewals/export").query({ format: "xlsx" }).set(user.headers)).status).toBe(403);
  });

  it("Service Sales: hidden columns are blanked; Quote No. is never hideable", async () => {
    const user = await signedIn("sales-vis@example.com", [ACCOUNTS_ROLE]);
    expect(VISIBILITY_KEYS.has("serviceSales.column.quotation")).toBe(false);
    expect((await setHidden(ACCOUNTS_ROLE, ["serviceSales.column.client", "serviceSales.column.serviceReport"])).status).toBe(200);
    const list = await api().get("/api/services-sales").query({ pageSize: 200 }).set(user.headers);
    expect(list.status).toBe(200);
    expect(list.body.data.roleHiddenColumns.sort()).toEqual(["client", "serviceReport"]);
    for (const item of list.body.data.items) {
      expect(item.client.name).toBe("");
      expect(item.serviceReport).toBeNull();
    }
    // The report download follows the column.
    const anyVisit = (await pool.query<{ id: string }>("SELECT id::text FROM amc_visits LIMIT 1")).rows[0]!.id;
    expect((await api().get(`/api/services-sales/${anyVisit}/report`).set(user.headers)).status).toBe(403);
  });

  it("Invoice Acknowledgements: every answer of the router blanks the hidden columns and their totals", async () => {
    const { applyAcknowledgementVisibility } = await import("../src/modules/invoice-acknowledgements/invoice-acknowledgements.visibility.js");
    const item = {
      invoiceId: "1", invoiceNo: "INV-1", client: { id: "5", name: "Client" }, contracts: [{ id: "7", reference: "AMC-1", version: 1 }],
      invoiceDate: "2026-11-01", invoiceValue: "10.000", serviceValue: "9.000", acknowledgedAt: null, acknowledgedBy: null,
      document: { attachmentId: "3", uploadedBy: { id: "2", fullName: "Uploader" } },
    };
    let sent: { data: { items: (typeof item)[]; kpis: Record<string, unknown> } } | undefined;
    const res = { json: (body: typeof sent) => (sent = body) } as unknown as Parameters<typeof applyAcknowledgementVisibility>[1];
    const req = { auth: { hidden: new Set(["invoiceAcks.column.invoiceValue", "invoiceAcks.column.client", "invoiceAcks.column.uploadedBy"]) } } as unknown as Parameters<typeof applyAcknowledgementVisibility>[0];
    applyAcknowledgementVisibility(req, res, () => undefined);
    res.json({ success: true, data: { items: [item], kpis: { invoiceValueTotal: "10.000", serviceValueTotal: "9.000" } } });

    const out = sent!.data;
    expect(out.items[0]!.invoiceValue).toBeNull();
    expect(out.items[0]!.serviceValue).toBe("9.000");
    expect(out.items[0]!.client.name).toBe("");
    expect(out.items[0]!.document.attachmentId).toBe("3");
    expect(out.items[0]!.document.uploadedBy.fullName).toBe("");
    expect(out.kpis.invoiceValueTotal).toBeNull();
    expect(out.kpis.serviceValueTotal).toBe("9.000");
  });
});

describe("Several roles", () => {
  it("shows an item when any role that may open the page shows it; a role without the page has no say", async () => {
    await withoutOneRoleConstraint(async () => {
      const user = await signedIn("two-roles@example.com", [ACCOUNTS_ROLE, OTHER_ROLE]);
      expect((await setHidden(ACCOUNTS_ROLE, ["dashboard.row.portfolio"])).status).toBe(200);
      expect((await dashboard(user)).kpis.contracts).not.toBeNull();

      expect((await setHidden(OTHER_ROLE, ["dashboard.row.portfolio"])).status).toBe(200);
      expect((await dashboard(user)).kpis.contracts).toBeNull();

      // A third role without the Dashboard cannot make the row visible again.
      await customRole("VIS_NO_DASHBOARD_TEST", [["CLIENTS", "VIEW"]]);
      await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [user.id, await roleId("VIS_NO_DASHBOARD_TEST")]);
      expect((await dashboard(user)).kpis.contracts).toBeNull();
    });
  });
});
