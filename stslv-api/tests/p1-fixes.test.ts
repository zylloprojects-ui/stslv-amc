import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { businessToday, CONTRACT_TIME_ZONE, expiryApplyEnabled, runContractExpiry } from "../src/modules/amc/contract-expiry.service";
import { reportNumberLockEnabled } from "../src/modules/amc/service-status.service";
import { FIXED_ACCESS, PERMISSION_CATALOG } from "../src/shared/permission-catalog";
import { activeContract, createClient, logsFor, referenceOf, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// P1 fixes (2026-11-09): one service scope for Dashboard / Service Status / Accounts, cancelled-contract
// financial handling, controlled contract expiry, the Service Report No. lock after Paid, and the
// permission descriptions. Every figure below is reconciled across the modules that show it.

let admin: Session;
let administrator: Session;
let operations: Session;
let finance: Session;
let clientId: string;

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${url}`).query(query).set(session.headers);
const patch = (url: string, body: Record<string, unknown>, session: Session = admin) => api().patch(`/api${url}`).set(session.headers).send(body);
const post = (url: string, body: Record<string, unknown> = {}, session: Session = admin) => api().post(`/api${url}`).set(session.headers).send(body);

const addDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const visitUpdatedAt = async (id: string) => (await get(`/amc/visits/${id}`)).body.data.updatedAt as string;
const serviceUpdatedAt = async (id: string) => (await get(`/amc/service-status/${id}`)).body.data.updatedAt as string;
const complete = async (id: string) => {
  await withServiceReport(id);
  expect((await patch(`/amc/execution/visits/${id}`, { status: "COMPLETED", completedDate: await today() })).status).toBe(200);
};
const setInvoiceNo = async (id: string, invoiceNo: string | null, session: Session = admin) =>
  patch(`/amc/visits/${id}/manual-invoice`, { invoiceNo, expectedUpdatedAt: await visitUpdatedAt(id) }, session);
/** A number entered before the 2026-11-04 completion rule, on a service still not completed (such records exist). */
const legacyInvoiceNo = async (id: string, invoiceNo: string) => {
  const by = (await pool.query("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0].id;
  await pool.query("UPDATE amc_visits_all SET manual_invoice_no = $1, manual_invoice_at = now(), manual_invoice_by = $2, updated_at = now() WHERE id = $3", [invoiceNo, by, id]);
};
const visit = async (id: string) =>
  (await pool.query<{ status: string; visit_amount: string | null; manual_invoice_no: string | null; service_report_no: string | null; completed_date: string | null }>(
    "SELECT status, visit_amount, manual_invoice_no, service_report_no, completed_date::text AS completed_date FROM amc_visits_all WHERE id = $1",
    [id]
  )).rows[0]!;
const accountsItem = async (id: string, contractId: string) =>
  ((await get("/accounts", { search: await referenceOf(contractId), pageSize: 200 })).body.data.items as { id: string; paymentStatus: string; manualInvoiceNo: string | null }[]).find(
    (item) => item.id === id
  );

/** A monthly contract over this month: services last month, this month and ahead. */
const monthlyTerms = async (name: string, overrides: Record<string, unknown> = {}) => {
  const now = await today();
  return {
    systemDescription: name,
    validFrom: addDays(now, -60),
    validTo: addDays(now, 300),
    maintenanceFrequency: "MONTHLY",
    contractValue: "1200.000",
    billingBasis: "CONTRACT_VALUE",
    ...overrides,
  };
};

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  administrator = await signedIn("administrator@example.com", ["ADMINISTRATOR"]);
  operations = await signedIn("operations@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
  finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
  clientId = await createClient(admin, "P1 Fixes Tower");
});
afterAll(async () => {
  delete process.env.SERVICE_REPORT_NO_LOCK_ENABLED;
  await closePool();
});

// ---------------------------------------------------------------------------------------------
// Tasks 1 and 5: one scope, cancelled contracts, reconciliation
// ---------------------------------------------------------------------------------------------

describe("cancelled-contract financial handling", () => {
  it("cancelling before any work removes the open unpaid services everywhere and keeps their amounts", async () => {
    const id = await activeContract(admin, clientId, await monthlyTerms("CANCEL-BEFORE"));
    const before = await visitsOf(id);
    const invoices = (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n;

    expect((await post(`/amc/contracts/${id}/status`, { status: "CANCELLED", reason: "Client withdrew", cancelOpenVisits: true })).status).toBe(200);
    const after = await visitsOf(id);

    expect(after.every((row) => row.status === "CANCELLED")).toBe(true);
    // Amounts are never reset or recalculated by a cancellation.
    expect(after.map((row) => row.visit_amount)).toEqual(before.map((row) => row.visit_amount));
    expect((await get("/accounts", { search: await referenceOf(id) })).body.data.total).toBe(0);
    expect((await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n).toBe(invoices);
  });

  it("cancelling after completion and payment keeps the Paid service visible in Accounts with its number and amount", async () => {
    const id = await activeContract(admin, clientId, await monthlyTerms("CANCEL-AFTER"));
    const [done, paidLegacy, open] = await visitsOf(id);
    await complete(done!.id);
    expect((await setInvoiceNo(done!.id, "P1-PAID-1")).status).toBe(200);
    // A Paid service entered before the completion rule, still Scheduled.
    await legacyInvoiceNo(paidLegacy!.id, "P1-LEGACY-1");
    const basis = (await get(`/amc/contracts/${id}`)).body.data;
    const invoices = (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n;

    expect((await post(`/amc/contracts/${id}/status`, { status: "CANCELLED", reason: "Client closed", cancelOpenVisits: true })).status).toBe(200);

    // Completed + Paid: unchanged.
    expect(await visit(done!.id)).toMatchObject({ status: "COMPLETED", manual_invoice_no: "P1-PAID-1", visit_amount: done!.visit_amount });
    // Paid but not completed: not cancelled, never reset, number kept.
    expect(await visit(paidLegacy!.id)).toMatchObject({ status: "SCHEDULED", manual_invoice_no: "P1-LEGACY-1", visit_amount: paidLegacy!.visit_amount });
    // Open unpaid work is cancelled.
    expect((await visit(open!.id)).status).toBe("CANCELLED");

    // Both Paid services stay in Accounts; the cancelled one does not.
    expect(await accountsItem(done!.id, id)).toMatchObject({ paymentStatus: "PAID", manualInvoiceNo: "P1-PAID-1" });
    expect(await accountsItem(paidLegacy!.id, id)).toMatchObject({ paymentStatus: "PAID", manualInvoiceNo: "P1-LEGACY-1" });
    expect(await accountsItem(open!.id, id)).toBeUndefined();

    // No invoice generated; Billing Basis and the schedule engine's figures untouched.
    expect((await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n).toBe(invoices);
    const afterBasis = (await get(`/amc/contracts/${id}`)).body.data;
    expect(afterBasis.billingBasis).toBe(basis.billingBasis);
    expect(afterBasis.schedule.annualAmount).toBe(basis.schedule.annualAmount);
    expect(afterBasis.schedule.perServiceAmount).toBe(basis.schedule.perServiceAmount);

    // Reactivating never resets a Paid or completed service to Scheduled / unpaid.
    expect((await post(`/amc/contracts/${id}/status`, { status: "ACTIVE" })).status).toBe(200);
    expect(await visit(done!.id)).toMatchObject({ status: "COMPLETED", manual_invoice_no: "P1-PAID-1" });
    expect(await visit(paidLegacy!.id)).toMatchObject({ manual_invoice_no: "P1-LEGACY-1" });
  });

  it("cancelling without cancelling the visits still keeps open unpaid work out of every count", async () => {
    const id = await activeContract(admin, clientId, await monthlyTerms("CANCEL-KEEP-VISITS"));
    expect((await post(`/amc/contracts/${id}/status`, { status: "CANCELLED", reason: "Paused", cancelOpenVisits: false })).status).toBe(200);
    expect((await visitsOf(id)).every((row) => row.status === "SCHEDULED")).toBe(true);
    expect((await get("/accounts", { search: await referenceOf(id) })).body.data.total).toBe(0);
    expect((await get("/amc/service-status", { search: await referenceOf(id) })).body.data.total).toBe(0);
  });
});

describe("Dashboard, Service Status, Accounts and Master AMC Status reconcile", () => {
  beforeAll(async () => {
    // One more live contract, part completed and Paid, part completed and unpaid, part open.
    const id = await activeContract(admin, clientId, await monthlyTerms("RECONCILE"));
    const visits = await visitsOf(id);
    await complete(visits[0]!.id);
    await complete(visits[1]!.id);
    expect((await setInvoiceNo(visits[0]!.id, "P1-REC-1")).status).toBe(200);
  });

  it("gives the same service counts and Paid totals on every page", async () => {
    const dashboard = (await get("/dashboard/operations")).body.data;
    const services = dashboard.kpis.services;
    const payments = dashboard.kpis.payments;
    const status = (await get("/amc/service-status", { pageSize: 1 })).body.data;
    const accounts = (await get("/accounts", { pageSize: 1 })).body.data;
    const master = (await get("/amc/master-status", { pageSize: 1 })).body.data;

    // Services Overall = Service Status total = Accounts rows = Master AMC Status rows.
    expect(services.overall).toBeGreaterThan(0);
    expect(status.kpis.total).toBe(services.overall);
    expect(accounts.kpis.rows).toBe(services.overall);
    expect(master.total).toBe(services.overall);
    // Overall = Invoices Generated + Invoices Not Generated.
    expect(payments.paid + payments.unpaid).toBe(services.overall);
    // Overall = Completed + Pending.
    expect(status.kpis.completed).toBe(services.overall - services.openOverall);
    expect(accounts.kpis.completed).toBe(services.overall - services.openOverall);
    // Paid includes the Paid services of the cancelled contract (2 there + 1 here).
    expect(payments.paid).toBe(3);
    expect(accounts.kpis.invoiceFilled).toBe(payments.paid);

    // This month: the four current-month cards add up, and equal the workload chart's first bar.
    expect(payments.scheduledThisMonth.withInvoiceNo + payments.scheduledThisMonth.withoutInvoiceNo).toBe(services.thisMonth);
    expect(services.completedThisMonth + services.openThisMonth).toBe(services.thisMonth);
    expect(dashboard.workload.months[0].planned).toBe(services.thisMonth);
  });

  it("matches an independent count of the documented rule", async () => {
    const { rows } = await pool.query<{ total: number; open: number; paid: number; paid_value: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE v.status <> 'COMPLETED')::int AS open,
              count(*) FILTER (WHERE v.manual_invoice_no IS NOT NULL)::int AS paid,
              COALESCE(sum(v.visit_amount) FILTER (WHERE v.manual_invoice_no IS NOT NULL), 0)::numeric(16,3)::text AS paid_value
       FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED')
         AND (c.status <> 'CANCELLED' OR v.status = 'COMPLETED' OR v.manual_invoice_no IS NOT NULL)`
    );
    const expected = rows[0]!;
    const dashboard = (await get("/dashboard/operations")).body.data;

    expect(dashboard.kpis.services).toMatchObject({ overall: expected.total, openOverall: expected.open });
    expect(dashboard.kpis.payments).toMatchObject({ paid: expected.paid, paidValue: expected.paid_value });
    const management = (await get("/amc/management/summary")).body.data.invoices;
    expect(management).toMatchObject({ paid: { count: expected.paid }, paidTotal: { amount: expected.paid_value } });
  });
});

// ---------------------------------------------------------------------------------------------
// Task 3: controlled contract expiry
// ---------------------------------------------------------------------------------------------

describe("contract expiry", () => {
  let ended: string;
  let endsToday: string;
  let current: string;
  let cancelledEnded: string;
  let paidVisit: string;

  beforeAll(async () => {
    // Earlier contracts of this file all run for 300 more days, so only these are candidates.
    const now = await businessToday();
    ended = await activeContract(admin, clientId, { systemDescription: "EXPIRY-ENDED", validFrom: addDays(now, -400), validTo: addDays(now, -10), maintenanceFrequency: "QUARTERLY", contractValue: "400.000", billingBasis: "CONTRACT_VALUE" });
    endsToday = await activeContract(admin, clientId, { systemDescription: "EXPIRY-TODAY", validFrom: addDays(now, -300), validTo: now, maintenanceFrequency: "QUARTERLY", contractValue: "400.000" });
    current = await activeContract(admin, clientId, { systemDescription: "EXPIRY-CURRENT", validFrom: addDays(now, -30), validTo: addDays(now, 300), maintenanceFrequency: "QUARTERLY", contractValue: "400.000" });
    cancelledEnded = await activeContract(admin, clientId, { systemDescription: "EXPIRY-CANCELLED", validFrom: addDays(now, -400), validTo: addDays(now, -5), maintenanceFrequency: "QUARTERLY", contractValue: "400.000" });
    expect((await post(`/amc/contracts/${cancelledEnded}/status`, { status: "CANCELLED", reason: "Closed" })).status).toBe(200);

    const visits = await visitsOf(ended);
    paidVisit = visits[0]!.id;
    await complete(paidVisit);
    expect((await setInvoiceNo(paidVisit, "P1-EXP-1")).status).toBe(200);
  });

  const status = async (id: string) => (await pool.query<{ status: string }>("SELECT status FROM amc_contracts WHERE id = $1", [id])).rows[0]!.status;

  it("is measured in the business time zone and is off unless enabled", () => {
    expect(CONTRACT_TIME_ZONE).toBe("Asia/Muscat");
    expect(expiryApplyEnabled({})).toBe(false);
    expect(expiryApplyEnabled({ AMC_CONTRACT_EXPIRY_ENABLED: "false" })).toBe(false);
    expect(expiryApplyEnabled({ AMC_CONTRACT_EXPIRY_ENABLED: "true" })).toBe(true);
  });

  it("a dry run lists only Active contracts past Valid To and changes nothing", async () => {
    const logs = (await pool.query("SELECT count(*)::int AS n FROM activity_logs")).rows[0].n;
    const run = await runContractExpiry();

    expect(run.dryRun).toBe(true);
    expect(run.timeZone).toBe("Asia/Muscat");
    expect(run.candidates.map((row) => row.id)).toEqual([ended]);
    expect(run.expired).toBe(0);
    expect(await status(ended)).toBe("ACTIVE");
    expect((await pool.query("SELECT count(*)::int AS n FROM activity_logs")).rows[0].n).toBe(logs);
  });

  it("refuses to apply while disabled, and refuses a future as-of date", async () => {
    await expect(runContractExpiry({ apply: true })).rejects.toThrow(/disabled/);
    await expect(runContractExpiry({ apply: true, enabled: false })).rejects.toThrow(/disabled/);
    await expect(runContractExpiry({ asOf: addDays(await businessToday(), 2) })).rejects.toThrow(/cannot be after today/);
    await expect(runContractExpiry({ asOf: "2026-02-30x" })).rejects.toThrow(/calendar date/);
    expect(await status(ended)).toBe("ACTIVE");
  });

  it("applies once, preserves visits, Paid numbers and amounts, audits the change, and is idempotent", async () => {
    const visitsBefore = await visitsOf(ended);
    const run = await runContractExpiry({ apply: true, enabled: true });

    expect(run).toMatchObject({ dryRun: false, expired: 1, skipped: 0 });
    expect(await status(ended)).toBe("EXPIRED");
    // Not yet past validity, cancelled: untouched.
    expect(await status(endsToday)).toBe("ACTIVE");
    expect(await status(current)).toBe("ACTIVE");
    expect(await status(cancelledEnded)).toBe("CANCELLED");

    // Visits, amounts and the Paid number are exactly as before.
    expect(await visitsOf(ended)).toEqual(visitsBefore);
    expect((await visit(paidVisit)).manual_invoice_no).toBe("P1-EXP-1");
    expect(await accountsItem(paidVisit, ended)).toMatchObject({ paymentStatus: "PAID" });

    const log = (await logsFor("amc_contracts", ended)).filter((entry) => entry.action === "amc_contract.status_changed").at(-1)!;
    expect(log.user_id).toBeNull();
    expect(log.metadata).toMatchObject({ changes: { status: { from: "ACTIVE", to: "EXPIRED" } }, automatic: true, asOf: run.asOf, timeZone: "Asia/Muscat" });

    const again = await runContractExpiry({ apply: true, enabled: true });
    expect(again).toMatchObject({ expired: 0, candidates: [] });
    expect((await logsFor("amc_contracts", ended)).filter((entry) => entry.metadata?.automatic === true)).toHaveLength(1);
  });

  it("an expired contract can still be reactivated by a person through the normal status change", async () => {
    // Its renewal path is unchanged: EXPIRED -> ACTIVE stays allowed.
    expect((await post(`/amc/contracts/${ended}/status`, { status: "ACTIVE" })).status).toBe(200);
    expect(await status(ended)).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------------------------
// Task 4: Service Report No. lock after Paid
// ---------------------------------------------------------------------------------------------

describe("Service Report No. lock", () => {
  let paid: string;
  let unpaid: string;

  beforeAll(async () => {
    const id = await activeContract(admin, clientId, await monthlyTerms("REPORT-LOCK"));
    const visits = await visitsOf(id);
    paid = visits[0]!.id;
    unpaid = visits[1]!.id;
    await complete(paid);
    await complete(unpaid);
    expect((await patch(`/amc/service-status/${paid}`, { reportNumber: "SR-1", expectedUpdatedAt: await serviceUpdatedAt(paid) })).status).toBe(200);
    expect((await setInvoiceNo(paid, "P1-LOCK-1")).status).toBe(200);
  });
  afterEach(() => {
    delete process.env.SERVICE_REPORT_NO_LOCK_ENABLED;
  });

  const save = async (id: string, body: Record<string, unknown>, session: Session) =>
    patch(`/amc/service-status/${id}`, { ...body, expectedUpdatedAt: await serviceUpdatedAt(id) }, session);

  it("is off by default: behaviour is unchanged until the rule is approved", async () => {
    expect(reportNumberLockEnabled()).toBe(false);
    const item = (await get(`/amc/service-status/${paid}`)).body.data;
    expect(item).toMatchObject({ paid: true, reportNumberLocked: false });
    expect((await save(paid, { reportNumber: "SR-1A" }, operations)).status).toBe(200);
    expect((await save(paid, { reportNumber: "SR-1" }, operations)).status).toBe(200);
  });

  it("when on, locks a Paid service's number for everyone without an override, keeping the stored value", async () => {
    process.env.SERVICE_REPORT_NO_LOCK_ENABLED = "true";
    const list = (await get("/amc/service-status", { pageSize: 1 })).body.data;
    expect(list.reportNumberLockEnabled).toBe(true);
    expect((await get(`/amc/service-status/${paid}`)).body.data).toMatchObject({ reportNumber: "SR-1", reportNumberLocked: true });

    const refused = await save(paid, { reportNumber: "SR-2" }, operations);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("REPORT_NUMBER_LOCKED");
    expect((await save(paid, { reportNumber: null }, admin)).status).toBe(409);
    expect((await visit(paid)).service_report_no).toBe("SR-1");

    // Re-saving the same number changes nothing and is allowed.
    expect((await save(paid, { reportNumber: "SR-1" }, operations)).status).toBe(200);
    // An unpaid service stays editable.
    expect((await get(`/amc/service-status/${unpaid}`)).body.data.reportNumberLocked).toBe(false);
    expect((await save(unpaid, { reportNumber: "SR-U" }, operations)).status).toBe(200);
  });

  it("allows only an administrator's override, with a reason, recorded in the Audit Log", async () => {
    process.env.SERVICE_REPORT_NO_LOCK_ENABLED = "true";

    expect((await save(paid, { reportNumber: "SR-2", reportNumberOverrideReason: "x" }, admin)).status).toBe(400);
    expect((await save(paid, { reportNumberOverrideReason: "Typo in the number" }, admin)).status).toBe(400);
    expect((await save(paid, { reportNumber: "SR-2", reportNumberOverrideReason: "Typo in the number" }, operations)).status).toBe(403);
    expect((await visit(paid)).service_report_no).toBe("SR-1");

    const ok = await save(paid, { reportNumber: "SR-2", reportNumberOverrideReason: "Typo in the number" }, administrator);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ reportNumber: "SR-2", reportNumberLocked: true });

    const entry = (await logsFor("amc_visits", paid)).at(-1)!;
    expect(entry).toMatchObject({ action: "amc_visit.service_report_no_override", user_id: administrator.id });
    expect(entry.metadata).toMatchObject({ override: true, reason: "Typo in the number", changes: { serviceReportNo: { from: "SR-1", to: "SR-2" } } });

    // The Paid number itself is untouched.
    expect((await visit(paid)).manual_invoice_no).toBe("P1-LOCK-1");
  });

  it("unlocks again once the Invoice No. is cleared (Unpaid)", async () => {
    process.env.SERVICE_REPORT_NO_LOCK_ENABLED = "true";
    expect((await setInvoiceNo(paid, null)).status).toBe(200);
    expect((await save(paid, { reportNumber: "SR-3" }, operations)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 2: permission descriptions match the enforced rules
// ---------------------------------------------------------------------------------------------

describe("permission descriptions", () => {
  const entry = (module: string) => PERMISSION_CATALOG.flatMap((section) => section.modules).find((item) => item.module === module)!;

  it("Accounts explains the Invoice No. permission and the Paid reference status, and no longer points at Create", () => {
    const accounts = entry("ACCOUNTS");
    expect(accounts.description).toContain("Invoice Tracking: Edit");
    expect(accounts.description).toMatch(/does not confirm that money was received/);
    expect(accounts.description).not.toMatch(/Invoice Tracking: Create/);
    expect(entry("INVOICES").actions.EDIT).toMatch(/manual Invoice No\./);
  });

  it("the Invoice No. route is enforced by Invoice Tracking: Edit, not by Accounts", async () => {
    const id = await activeContract(admin, clientId, await monthlyTerms("PERM-INVOICE"));
    const [first] = await visitsOf(id);
    await complete(first!.id);

    // AMC Operations Executive holds no INVOICES:EDIT: refused. Finance Executive holds it: allowed.
    expect((await setInvoiceNo(first!.id, "P1-PERM-1", operations)).status).toBe(403);
    expect((await setInvoiceNo(first!.id, "P1-PERM-1", finance)).status).toBe(200);
  });

  it("the Recycle Bin is described as Super Admin only, as the API enforces", async () => {
    expect(FIXED_ACCESS.superAdminOnly.map((page) => page.label).join()).toMatch(/Recycle Bin/);
    expect(FIXED_ACCESS.adminOnly.map((page) => page.label)).not.toContain("Recycle Bin");
    expect(FIXED_ACCESS.adminOnly.map((page) => page.label).join()).toMatch(/Deletion History/);

    expect((await get("/security/recycle-bin", {}, administrator)).status).toBe(403);
    expect((await get("/security/deletions", {}, administrator)).status).toBe(200);
    expect((await get("/security/recycle-bin", {}, admin)).status).toBe(200);
  });
});
