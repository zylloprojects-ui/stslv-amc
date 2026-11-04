import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { colorState, COLOR_PRIORITY_RULE } from "../src/modules/amc/amc.schedule";
import { activeContract, createClient, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { cancelInvoice, invoiceBody, newInvoice } from "./invoices-helpers";

// Schedule corrections, the Color Priority rule, Billing Basis amounts, cross-module
// synchronisation, Deletion Log coverage and Security Center checks.

let admin: Session;
let viewer: Session;
let clientId: string;

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${url}`).query(query).set(session.headers);
const patch = (url: string, body: Record<string, unknown>, session: Session = admin) => api().patch(`/api${url}`).set(session.headers).send(body);
const post = (url: string, body: Record<string, unknown> = {}, session: Session = admin) => api().post(`/api${url}`).set(session.headers).send(body);
const body = (overrides: Record<string, unknown>) => ({ clientId, systemDescription: "FIRE", validFrom: "2027-01-01", validTo: "2027-12-31", contractValue: "1200.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "300.000", ...overrides });
const complete = async (id: string) => {
  await withServiceReport(id);
  expect((await patch(`/amc/execution/visits/${id}`, { status: "COMPLETED", completedDate: await today() })).status).toBe(200);
};
const visitRow = async (id: string) => (await get(`/amc/visits/${id}`)).body.data;

const setManualNo = async (visitId: string, invoiceNo: string | null) => {
  const updatedAt = (await visitRow(visitId)).updatedAt;
  expect((await patch(`/amc/visits/${visitId}/manual-invoice`, { invoiceNo, expectedUpdatedAt: updatedAt })).status).toBe(200);
};

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  viewer = await signedIn("viewer@example.com", ["VIEWER"]);
  clientId = await createClient(admin, "Sync Hotel");
});
afterAll(closePool);

describe("Schedule Engine", () => {
  it("a frequency change keeps recorded work, adds no duplicate period and removes only untouched visits", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "FREQ" }));
    const [first] = await visitsOf(id);
    await complete(first!.id);

    expect((await patch(`/amc/contracts/${id}`, { maintenanceFrequency: "MONTHLY" })).status).toBe(200);
    const after = await visitsOf(id);

    expect(after.find((visit) => visit.id === first!.id)?.status).toBe("COMPLETED");
    expect(new Set(after.map((visit) => visit.period_start)).size).toBe(after.length);
    // January stays the completed visit; every other month gets one.
    expect(after).toHaveLength(12);
  });

  it("refuses shrinking the validity past recorded work", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "SHRINK" }));
    const visits = await visitsOf(id);
    await complete(visits[3]!.id);

    expect((await patch(`/amc/contracts/${id}`, { validTo: "2027-06-30" })).status).toBeGreaterThanOrEqual(400);
    expect(await visitsOf(id)).toHaveLength(4);
  });

  it("does not generate for a cancelled or expired contract, and locks their terms", async () => {
    for (const status of ["CANCELLED", "EXPIRED"]) {
      const id = await activeContract(admin, clientId, body({ systemDescription: `END-${status}` }));
      expect((await post(`/amc/contracts/${id}/status`, { status, reason: "Test" })).status).toBe(200);
      const count = (await visitsOf(id)).length;

      expect((await post(`/amc/contracts/${id}/schedule/generate`)).status).toBeGreaterThanOrEqual(400);
      expect((await patch(`/amc/contracts/${id}`, { validTo: "2028-12-31" })).status).toBe(409);
      expect(await visitsOf(id)).toHaveLength(count);
    }
  });

  it("clamps month-end dates without drifting, and restarts service numbers each contract year", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "MONTHEND", maintenanceFrequency: "QUARTERLY", validFrom: "2027-01-31", validTo: "2029-01-30" }));
    const rows = await pool.query<{ scheduled_date: string; cycle_no: number; service_code: string }>("SELECT scheduled_date::text, cycle_no, service_code FROM amc_visits WHERE amc_contract_id = $1 ORDER BY sequence_no", [id]);

    expect(rows.rows.map((row) => row.scheduled_date).slice(0, 5)).toEqual(["2027-01-31", "2027-04-30", "2027-07-31", "2027-10-31", "2028-01-31"]);
    expect(rows.rows.map((row) => `${row.cycle_no}-${row.service_code}`)).toEqual(["1-Q1", "1-Q2", "1-Q3", "1-Q4", "2-Q1", "2-Q2", "2-Q3", "2-Q4"]);
  });

  it("does not change visit amounts when the amount or billing basis changes later", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "SNAPSHOT" }));
    await patch(`/amc/contracts/${id}`, { defaultVisitAmount: "999.000", billingBasis: "CONTRACT_VALUE" });

    expect((await visitsOf(id)).every((visit) => visit.visit_amount === "300.000")).toBe(true);
  });

  it("lists each schedule update in order", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "GENERATIONS" }));
    await patch(`/amc/contracts/${id}`, { validTo: "2028-03-31" });

    const list = (await get(`/amc/contracts/${id}/schedule/generations`)).body.data;
    expect(list.map((item: { generation: number; added: number }) => [item.generation, item.added])).toEqual([[1, 4], [2, 1]]);
    expect(list[0]).toMatchObject({ maintenanceFrequency: "QUARTERLY", validFrom: "2027-01-01" });
    expect(list[0].generatedBy).toBeTruthy();
  });
});

describe("Billing Basis amounts", () => {
  it("names the stored amount of each basis, requires a custom value, and clears it on leaving Custom", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "BASIS", finalCredit: "700.000" }));
    const read = async () => (await get(`/amc/contracts/${id}`)).body.data;

    expect((await read()).selectedBillingAmount).toBeNull();
    await patch(`/amc/contracts/${id}`, { billingBasis: "CONTRACT_VALUE" });
    expect((await read()).selectedBillingAmount).toBe("1200.000");
    await patch(`/amc/contracts/${id}`, { billingBasis: "FINAL_CREDIT" });
    expect((await read()).selectedBillingAmount).toBe("700.000");

    expect((await patch(`/amc/contracts/${id}`, { billingBasis: "CUSTOM" })).status).toBe(400);
    expect((await patch(`/amc/contracts/${id}`, { billingBasis: "CUSTOM", customBillingValue: "555.5" })).status).toBe(200);
    expect(await read()).toMatchObject({ selectedBillingAmount: "555.500", customBillingValue: "555.500" });

    await patch(`/amc/contracts/${id}`, { billingBasis: null });
    expect(await read()).toMatchObject({ billingBasis: null, customBillingValue: null, selectedBillingAmount: null });
  });
});

describe("Color Priority", () => {
  it("states the rule and applies it top down", () => {
    expect(COLOR_PRIORITY_RULE).toBe("Manual → Cancelled → Invoice Pending → First Service → Normal");
    const all = { override: "RED", cancelled: true, invoiceRecorded: false, firstService: true };
    expect(colorState(all)).toBe("MANUAL");
    expect(colorState({ ...all, override: null })).toBe("CANCELLED");
    expect(colorState({ ...all, override: null, cancelled: false })).toBe("INVOICE_PENDING");
    expect(colorState({ ...all, override: null, cancelled: false, invoiceRecorded: true })).toBe("FIRST_SERVICE");
    expect(colorState({ ...all, override: null, cancelled: false, invoiceRecorded: true, firstService: false })).toBe("NORMAL");
  });

  it("reads each state from real records, and a manual colour can be set, cleared and survives regeneration", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "COLOR", defaultVisitAmount: "300.000" }));
    const [first, second, third] = await visitsOf(id);
    expect((await visitRow(first!.id)).colorState).toBe("INVOICE_PENDING");

    for (const visit of [first!, second!]) {
      await complete(visit.id);
      await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visit.id, amount: "300.000" }], { amountExclVat: "300.000", vatAmount: "0.000", invoiceDate: await today() }));
    }
    // A Zoho record does not lift Invoice Pending: the reference says the manual Invoice No. does.
    expect((await visitRow(first!.id)).colorState).toBe("INVOICE_PENDING");
    await setManualNo(first!.id, "CP-1");
    await setManualNo(second!.id, "CP-2");
    expect((await visitRow(first!.id)).colorState).toBe("FIRST_SERVICE");
    expect((await visitRow(second!.id)).colorState).toBe("NORMAL");

    expect((await patch(`/amc/visits/${third!.id}/color`, { color: "PURPLE" })).body.data).toMatchObject({ colorState: "MANUAL", colorOverride: "PURPLE" });
    expect((await patch(`/amc/visits/${third!.id}/color`, { color: "PINK" })).status).toBe(400);
    expect((await patch(`/amc/visits/${third!.id}/color`, { color: "RED" }, viewer)).status).toBe(403);

    // A coloured visit counts as acted on: shrinking the validity past it is refused.
    expect((await patch(`/amc/contracts/${id}`, { validTo: "2027-05-31" })).status).toBeGreaterThanOrEqual(400);
    expect((await visitsOf(id)).map((visit) => visit.id)).toContain(third!.id);

    expect((await patch(`/amc/visits/${third!.id}/color`, { color: null })).body.data).toMatchObject({ colorState: "INVOICE_PENDING", colorOverride: null });

    await post(`/amc/contracts/${id}/status`, { status: "CANCELLED", reason: "Test" });
    expect((await visitRow(third!.id)).colorState).toBe("CANCELLED");

    // The colour leaves the money untouched.
    expect((await visitsOf(id)).every((visit) => visit.visit_amount === "300.000")).toBe(true);
  });
});

describe("Cross-module synchronisation", () => {
  it("clearing the Invoice No., cancelling a Zoho invoice and reopening a service reach Accounts, Master AMC Status, Dashboard and Reports", async () => {
    const other = await createClient(admin, "Sync Target");
    const id = await activeContract(admin, other, body({ clientId: other, systemDescription: "SYNC" }));
    const [first] = await visitsOf(id);
    await complete(first!.id);
    const invoice = await newInvoice(admin, invoiceBody(other, [{ amcVisitId: first!.id, amount: "300.000" }], { amountExclVat: "300.000", vatAmount: "0.000", invoiceDate: await today() }));

    const read = async () => {
      const accounts = (await get("/accounts", { clientId: other, pageSize: 50 })).body.data;
      const master = (await get("/amc/master-status", { clientId: other, pageSize: 50 })).body.data;
      const report = (await get("/reports/client-summary", { clientId: other })).body.data.rows[0];
      return {
        accountsColour: accounts.items.find((row: { id: string }) => row.id === first!.id).colour,
        masterColour: master.items.find((row: { id: string }) => row.id === first!.id).colour,
        filled: accounts.kpis.invoiceFilled,
        reported: report.paid,
        completed: report.completed,
        invoiced: (await get("/dashboard/operations")).body.data.kpis.payments.paid,
      };
    };

    await setManualNo(first!.id, "SYNC-1");
    const invoiced = await read();
    expect(invoiced).toMatchObject({ accountsColour: "GREEN", masterColour: "BLUE", filled: 1, reported: 1, completed: 1 });

    // A Zoho record's status does not change Paid; clearing the number does.
    await cancelInvoice(admin, invoice.id);
    expect(await read()).toMatchObject({ accountsColour: "GREEN", filled: 1 });
    await setManualNo(first!.id, null);
    const cancelled = await read();
    expect(cancelled).toMatchObject({ accountsColour: "BLUE", masterColour: "YELLOW", filled: 0, reported: 0, completed: 1 });
    expect(cancelled.invoiced).toBe(invoiced.invoiced - 1);

    const row = (await get("/amc/service-status", { clientId: other, pageSize: 50 })).body.data.items.find((item: { id: string }) => item.id === first!.id);
    // Completion lock (2026-11-04): completed work cannot be reopened.
    const reopened = await patch(`/amc/service-status/${first!.id}`, { status: "NOT_COMPLETED", expectedUpdatedAt: row.updatedAt });
    expect(reopened.status).toBe(409);
    expect(reopened.body.error.code).toBe("COMPLETION_LOCKED");
    expect(await read()).toMatchObject({ accountsColour: "BLUE", masterColour: "YELLOW", completed: 1 });
  });
});

describe("Deletion Log coverage", () => {
  const entries = async (query: Record<string, unknown> = {}) => (await get("/security/deletions", { pageSize: 100, ...query })).body.data.items as { action: string; kind: string; entityId: string }[];

  it("covers cancelled visits and contracts, cancelled invoices, and deactivated records, with the right kind", async () => {
    const id = await activeContract(admin, clientId, body({ systemDescription: "LOG" }));
    const [first] = await visitsOf(id);
    expect((await patch(`/amc/execution/visits/${first!.id}`, { status: "CANCELLED", statusReason: "Client asked" })).status).toBe(200);
    expect((await post(`/amc/contracts/${id}/status`, { status: "CANCELLED", reason: "Test" })).status).toBe(200);

    const engineer = (await post("/masters/sales-engineers", { code: "SE-LOG", name: "Log Engineer" })).body.data.id;
    expect((await post(`/masters/sales-engineers/${engineer}/status`, { isActive: false })).status).toBe(200);
    const gone = await createClient(admin, "Log Client");
    expect((await post(`/clients/${gone}/deactivate`)).status).toBe(200);

    const voided = await entries({ kind: "VOIDED" });
    expect(voided.some((item) => item.action === "amc_visit.status_changed" && item.entityId === first!.id)).toBe(true);
    expect(voided.some((item) => item.action === "amc_contract.status_changed" && item.entityId === id)).toBe(true);
    expect(voided.some((item) => item.action === "invoice.cancelled")).toBe(true);

    const deactivated = await entries({ kind: "DEACTIVATED" });
    expect(deactivated.some((item) => item.action === "client.deactivated" && item.entityId === gone)).toBe(true);
    expect(deactivated.some((item) => item.action.endsWith(".deactivated") && item.entityId === engineer)).toBe(true);

    // Ordinary status changes are not removals.
    expect((await entries()).some((item) => item.action === "amc_visit.completed")).toBe(false);
  });

  it("exports with the same filters and is limited to administrators", async () => {
    const file = await get("/security/deletions/export", { format: "pdf", kind: "VOIDED" }).responseType("blob");
    expect(file.status).toBe(200);
    expect((file.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
    expect((await get("/security/deletions/export", { format: "xlsx" }, viewer)).status).toBe(403);
  });
});

describe("Security Center", () => {
  it("reports checks without a score, pages events, and sends security headers", async () => {
    const overview = (await get("/security/overview")).body.data;
    expect(overview.checks.map((check: { id: string }) => check.id)).toEqual(expect.arrayContaining(["database", "migrations", "backup", "cors", "headers"]));
    expect(overview).not.toHaveProperty("score");

    await api().post("/api/auth/login").send({ email: "admin@example.com", password: "wrong-password" });
    const events = (await get("/security/events", { action: "auth.login_failed", pageSize: 5 })).body.data;
    expect(events.total).toBeGreaterThan(0);
    expect(events.items[0].action).toBe("auth.login_failed");
    expect((await get("/security/events", { action: "NOT VALID" })).status).toBe(400);
    expect((await get("/security/events", {}, viewer)).status).toBe(403);

    const health = await api().get("/api/health");
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["x-frame-options"]).toBe("DENY");
  });
});
