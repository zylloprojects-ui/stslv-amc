import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { businessDateAt, businessToday, runContractExpiry } from "../src/modules/amc/contract-expiry.service";
import { activeContract, contractBody, createClient, renewalEngineer, today, visitsOf, withRenewalDocument, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { invoiceBody, newInvoice } from "./invoices-helpers";

// Final verification of the six business rules the owner approved on 2026-11-09:
//   1. Active -> Expired on the day after Valid To, in Asia/Muscat.
//   2. Open visits keep their statuses and financial values on expiry.
//   3. An open renewal does not prevent expiry; the renewal stays independent.
//   4. The Service Report No. is locked once the service is Paid.
//   5. Super Admin and Admin may override with a mandatory reason, recorded in the Audit Log.
//   6. Historical Paid-but-not-Completed services are preserved without automatic correction.
// Feature switches are turned on here only, in the disposable test schema.

let admin: Session;
let administrator: Session;
let finance: Session;
let masterData: Session;
let operations: Session;
let viewer: Session;
let clientId: string;

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${url}`).query(query).set(session.headers);
const patch = (url: string, body: Record<string, unknown>, session: Session = admin) => api().patch(`/api${url}`).set(session.headers).send(body);
const post = (url: string, body: Record<string, unknown> = {}, session: Session = admin) => api().post(`/api${url}`).set(session.headers).send(body);

const addDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const complete = async (id: string) => {
  await withServiceReport(id);
  expect((await patch(`/amc/execution/visits/${id}`, { status: "COMPLETED", completedDate: await today() })).status).toBe(200);
};
const setInvoiceNo = async (id: string, invoiceNo: string | null) =>
  patch(`/amc/visits/${id}/manual-invoice`, { invoiceNo, expectedUpdatedAt: (await get(`/amc/visits/${id}`)).body.data.updatedAt });
/** A number entered before the 2026-11-04 completion rule, on a service that is still not completed. */
const legacyInvoiceNo = async (id: string, invoiceNo: string) => {
  const by = (await pool.query("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0].id;
  await pool.query("UPDATE amc_visits_all SET manual_invoice_no = $1, manual_invoice_at = now(), manual_invoice_by = $2, updated_at = now() WHERE id = $3", [invoiceNo, by, id]);
};

/** Every column of the rows that expiry must never touch, for an exact before/after comparison. */
async function snapshot() {
  const rows = async (sql: string) => (await pool.query(sql)).rows.map((row) => JSON.stringify(row));
  return {
    visits: await rows("SELECT * FROM amc_visits_all ORDER BY id"),
    invoices: await rows("SELECT * FROM invoices ORDER BY id"),
    allocations: await rows("SELECT * FROM invoice_allocations ORDER BY id"),
    attachments: await rows("SELECT * FROM attachments ORDER BY id"),
    visitLogs: await rows("SELECT * FROM activity_logs WHERE entity_type <> 'amc_contracts' ORDER BY id"),
  };
}

const contractStatus = async (id: string) => (await pool.query<{ status: string }>("SELECT status FROM amc_contracts_all WHERE id = $1", [id])).rows[0]!.status;
const automaticLogs = async (id: string) =>
  (await pool.query("SELECT metadata FROM activity_logs WHERE entity_type = 'amc_contracts' AND entity_id = $1 AND metadata->>'automatic' = 'true'", [id])).rows;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  administrator = await signedIn("administrator@example.com", ["ADMINISTRATOR"]);
  finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
  masterData = await signedIn("masterdata@example.com", ["MASTER_DATA_EXECUTIVE"]);
  operations = await signedIn("operations@example.com", ["AMC_OPERATIONS_EXECUTIVE"]);
  viewer = await signedIn("viewer@example.com", ["VIEWER"]);
  clientId = await createClient(admin, "Approved Rules Tower");
});
afterAll(async () => {
  delete process.env.SERVICE_REPORT_NO_LOCK_ENABLED;
  await closePool();
});

// ---------------------------------------------------------------------------------------------
// Rules 1-3: contract expiry
// ---------------------------------------------------------------------------------------------

describe("approved contract expiry", () => {
  let now: string;
  const ids: Record<string, string> = {};
  let openVisitBefore: { status: string; visit_amount: string | null }[];

  const contract = (name: string, validFrom: string, validTo: string) =>
    activeContract(admin, clientId, { systemDescription: name, validFrom, validTo, maintenanceFrequency: "QUARTERLY", contractValue: "400.000", billingBasis: "CONTRACT_VALUE" });

  beforeAll(async () => {
    now = await businessToday();
    ids.yesterday = await contract("ENDED-YESTERDAY", addDays(now, -360), addDays(now, -1));
    ids.today = await contract("ENDS-TODAY", addDays(now, -360), now);
    ids.future = await contract("FUTURE", addDays(now, 10), addDays(now, 375));
    ids.expired = await contract("ALREADY-EXPIRED", addDays(now, -400), addDays(now, -40));
    expect((await post(`/amc/contracts/${ids.expired}/status`, { status: "EXPIRED" })).status).toBe(200);
    ids.renewed = await contract("RENEWED-SOURCE", addDays(now, -363), addDays(now, -3));

    // Visits on the contract that ended yesterday: completed + Paid, completed + Zoho invoice, postponed, scheduled.
    const visits = await visitsOf(ids.yesterday);
    await complete(visits[0]!.id);
    expect((await setInvoiceNo(visits[0]!.id, "EXP-PAID-1")).status).toBe(200);
    await complete(visits[1]!.id);
    await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visits[1]!.id, amount: visits[1]!.visit_amount! }], { amountExclVat: visits[1]!.visit_amount, vatAmount: "0.000", invoiceDate: await today() }));
    expect((await patch(`/amc/execution/visits/${visits[2]!.id}`, { status: "POSTPONED", statusReason: "Client away" })).status).toBe(200);
    openVisitBefore = (await visitsOf(ids.yesterday)).map((row) => ({ status: row.status, visit_amount: row.visit_amount }));

    // An open (draft) renewal of a contract that ended three days ago.
    const engineer = await renewalEngineer();
    const renewal = await post(`/amc/contracts/${ids.renewed}/renewals`, withRenewalDocument(contractBody(clientId, { validFrom: addDays(now, -2), validTo: addDays(now, 362), status: "DRAFT", salesEngineerId: engineer })));
    expect(renewal.status).toBe(201);
    ids.renewal = renewal.body.data.id;
  });

  it("knows the Oman calendar day at the midnight boundary, whatever the session time zone", async () => {
    // Asia/Muscat is UTC+4 with no daylight saving.
    expect(await businessDateAt("2026-11-09T19:59:59Z")).toBe("2026-11-09");
    expect(await businessDateAt("2026-11-09T20:00:00Z")).toBe("2026-11-10");
    expect(await businessDateAt("2026-12-31T20:00:00Z")).toBe("2027-01-01");

    const client = await pool.connect();
    try {
      // A session far from Oman (UTC+14) still sees the Oman day.
      await client.query("SET TIME ZONE 'Pacific/Kiritimati'");
      expect(await businessDateAt("2026-11-09T19:59:59Z", client)).toBe("2026-11-09");
      expect(await businessDateAt("2026-11-09T20:00:00Z", client)).toBe("2026-11-10");
    } finally {
      await client.query("RESET TIME ZONE");
      client.release();
    }
  });

  it("expires on the day after Valid To, not on Valid To itself (as-of boundary)", async () => {
    const validTo = addDays(now, -1);
    // Measured on Valid To itself: still valid. Measured on the next Oman day: due to expire.
    expect((await runContractExpiry({ asOf: validTo })).candidates.map((row) => row.id)).not.toContain(ids.yesterday);
    expect((await runContractExpiry({ asOf: now })).candidates.map((row) => row.id)).toContain(ids.yesterday);
  });

  it("a dry run lists exactly the Active contracts past validity, renewed source included", async () => {
    const run = await runContractExpiry();
    expect(run.dryRun).toBe(true);
    expect(run.candidates.map((row) => row.id).sort()).toEqual([ids.yesterday!, ids.renewed!].sort());
  });

  it("applies the approved rule and changes nothing but the two contracts' status", async () => {
    const before = await snapshot();
    const renewalBefore = (await pool.query("SELECT * FROM amc_contracts_all WHERE id = $1", [ids.renewal])).rows[0];

    const run = await runContractExpiry({ apply: true, enabled: true });
    expect(run).toMatchObject({ expired: 2, skipped: 0, timeZone: "Asia/Muscat" });

    expect(await contractStatus(ids.yesterday!)).toBe("EXPIRED");
    expect(await contractStatus(ids.renewed!)).toBe("EXPIRED");
    expect(await contractStatus(ids.today!)).toBe("ACTIVE");
    expect(await contractStatus(ids.future!)).toBe("ACTIVE");
    expect(await contractStatus(ids.expired!)).toBe("EXPIRED");
    expect(await automaticLogs(ids.expired!)).toHaveLength(0);

    // Visits (open, postponed, completed, Paid), Zoho invoices and allocations, documents and visit history: byte for byte.
    expect(await snapshot()).toEqual(before);
    expect((await visitsOf(ids.yesterday!)).map((row) => ({ status: row.status, visit_amount: row.visit_amount }))).toEqual(openVisitBefore);
    // The renewal is independent: not touched at all, and still linked.
    expect((await pool.query("SELECT * FROM amc_contracts_all WHERE id = $1", [ids.renewal])).rows[0]).toEqual(renewalBefore);
    expect(renewalBefore.renewed_from_id).toBe(ids.renewed);
  });

  it("is idempotent: repeated runs change nothing and write no more audit entries", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await runContractExpiry({ apply: true, enabled: true })).toMatchObject({ expired: 0, candidates: [] });
    }
    expect(await automaticLogs(ids.yesterday!)).toHaveLength(1);
    expect(await automaticLogs(ids.renewed!)).toHaveLength(1);
  });

  it("concurrent runs expire each contract exactly once", async () => {
    const batch = [];
    for (let i = 0; i < 4; i += 1) batch.push(await contract(`CONCURRENT-${i}`, addDays(now, -365), addDays(now, -2 - i)));

    const runs = await Promise.all([1, 2, 3].map(() => runContractExpiry({ apply: true, enabled: true })));
    expect(runs.reduce((sum, run) => sum + run.expired, 0)).toBe(4);
    for (const id of batch) {
      expect(await contractStatus(id)).toBe("EXPIRED");
      expect(await automaticLogs(id)).toHaveLength(1);
    }
  });

  it("refuses to apply without explicit enablement, and keeps the dry-run default", async () => {
    await contract("NOT-ENABLED", addDays(now, -365), addDays(now, -1));
    await expect(runContractExpiry({ apply: true })).rejects.toThrow(/disabled/);
    expect((await runContractExpiry()).dryRun).toBe(true);
    expect((await runContractExpiry()).candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Rules 4-5: Service Report No. lock and override, across the six-role model
// ---------------------------------------------------------------------------------------------

describe("approved Service Report No. lock", () => {
  let scheduled: string;
  let completedUnpaid: string;
  let paid: string;

  const updatedAt = async (id: string) => (await get(`/amc/service-status/${id}`)).body.data.updatedAt as string;
  const save = async (id: string, body: Record<string, unknown>, session: Session) =>
    patch(`/amc/service-status/${id}`, { ...body, expectedUpdatedAt: await updatedAt(id) }, session);
  const reportNo = async (id: string) => (await pool.query<{ service_report_no: string | null }>("SELECT service_report_no FROM amc_visits_all WHERE id = $1", [id])).rows[0]!.service_report_no;
  const lastLog = async (id: string) =>
    (await pool.query("SELECT action, user_id, metadata FROM activity_logs WHERE entity_type = 'amc_visits' AND entity_id = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0];

  beforeAll(async () => {
    const now = await today();
    const id = await activeContract(admin, clientId, {
      systemDescription: "LOCK-MATRIX",
      validFrom: addDays(now, -60),
      validTo: addDays(now, 300),
      maintenanceFrequency: "MONTHLY",
      contractValue: "1200.000",
      billingBasis: "CONTRACT_VALUE",
    });
    const visits = await visitsOf(id);
    scheduled = visits[4]!.id;
    completedUnpaid = visits[1]!.id;
    paid = visits[0]!.id;
    await complete(completedUnpaid);
    await complete(paid);
    expect((await save(paid, { reportNumber: "SR-P" }, operations)).status).toBe(200);
    expect((await setInvoiceNo(paid, "LOCK-INV-1")).status).toBe(200);
    process.env.SERVICE_REPORT_NO_LOCK_ENABLED = "true";
  });
  afterEach(() => {
    process.env.SERVICE_REPORT_NO_LOCK_ENABLED = "true";
  });

  it("Scheduled and Completed-but-Unpaid services stay editable without a reason", async () => {
    expect((await get(`/amc/service-status/${scheduled}`)).body.data).toMatchObject({ paid: false, reportNumberLocked: false });
    expect((await save(scheduled, { reportNumber: "SR-S" }, operations)).status).toBe(200);
    expect((await save(completedUnpaid, { reportNumber: "SR-C" }, operations)).status).toBe(200);
    expect((await lastLog(completedUnpaid)).action).toBe("amc_visit.service_report_changed");
  });

  it("a Paid service is locked; re-saving the same number is allowed and logs nothing", async () => {
    expect((await get(`/amc/service-status/${paid}`)).body.data).toMatchObject({ paid: true, reportNumberLocked: true, reportNumber: "SR-P" });
    const logs = (await pool.query("SELECT count(*)::int AS n FROM activity_logs")).rows[0].n;
    expect((await save(paid, { reportNumber: "SR-P" }, operations)).status).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM activity_logs")).rows[0].n).toBe(logs);
  });

  it("a change without a reason is refused for every role, administrators included", async () => {
    for (const session of [admin, administrator, operations]) {
      const response = await save(paid, { reportNumber: "SR-X" }, session);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REPORT_NUMBER_LOCKED");
    }
    expect(await reportNo(paid)).toBe("SR-P");
  });

  it("refuses a missing, blank, too short or too long reason", async () => {
    for (const reason of ["", "     ", "abcd", "x".repeat(501)]) {
      expect((await save(paid, { reportNumber: "SR-X", reportNumberOverrideReason: reason }, admin)).status).toBe(400);
    }
    expect(await reportNo(paid)).toBe("SR-P");
  });

  it("refuses an override by every role except Super Admin and Admin (six-role model)", async () => {
    // AMC Operations Executive may edit execution but not override the lock.
    expect((await save(paid, { reportNumber: "SR-X", reportNumberOverrideReason: "Corrected number" }, operations)).status).toBe(403);
    // Finance, Master Data and Viewer cannot save Service Status at all.
    for (const session of [finance, masterData, viewer]) {
      expect((await save(paid, { reportNumber: "SR-X", reportNumberOverrideReason: "Corrected number" }, session)).status).toBe(403);
    }
    expect(await reportNo(paid)).toBe("SR-P");
  });

  it("Admin and Super Admin override with a reason, each written to the Audit Log", async () => {
    expect((await save(paid, { reportNumber: "SR-A", reportNumberOverrideReason: "Admin corrected the number" }, administrator)).status).toBe(200);
    expect(await lastLog(paid)).toMatchObject({
      action: "amc_visit.service_report_no_override",
      user_id: administrator.id,
      metadata: { override: true, reason: "Admin corrected the number", changes: { serviceReportNo: { from: "SR-P", to: "SR-A" } } },
    });

    expect((await save(paid, { reportNumber: "SR-SA", reportNumberOverrideReason: "Super Admin corrected it" }, admin)).status).toBe(200);
    expect(await lastLog(paid)).toMatchObject({
      action: "amc_visit.service_report_no_override",
      user_id: admin.id,
      metadata: { override: true, reason: "Super Admin corrected it", changes: { serviceReportNo: { from: "SR-A", to: "SR-SA" } } },
    });
    // The override is visible in the Audit Log page's API.
    const audit = (await get("/audit/activity", { search: "override", pageSize: 50 })).body.data;
    expect(audit.items.filter((item: { action: string }) => item.action === "amc_visit.service_report_no_override").length).toBeGreaterThanOrEqual(2);
    // The Paid number is untouched by the override.
    expect((await pool.query("SELECT manual_invoice_no FROM amc_visits_all WHERE id = $1", [paid])).rows[0].manual_invoice_no).toBe("LOCK-INV-1");
  });

  it("clearing the Invoice No. (Unpaid) unlocks the number for a normal edit", async () => {
    expect((await setInvoiceNo(paid, null)).status).toBe(200);
    expect((await get(`/amc/service-status/${paid}`)).body.data).toMatchObject({ paid: false, reportNumberLocked: false });
    expect((await save(paid, { reportNumber: "SR-AFTER" }, operations)).status).toBe(200);
    expect((await lastLog(paid)).action).toBe("amc_visit.service_report_changed");
  });

  it("with the switch off (current production), Paid services stay editable exactly as before", async () => {
    expect((await setInvoiceNo(paid, "LOCK-INV-2")).status).toBe(200);
    delete process.env.SERVICE_REPORT_NO_LOCK_ENABLED;
    expect((await get("/amc/service-status", { pageSize: 1 })).body.data.reportNumberLockEnabled).toBe(false);
    expect((await get(`/amc/service-status/${paid}`)).body.data).toMatchObject({ paid: true, reportNumberLocked: false });
    expect((await save(paid, { reportNumber: "SR-OFF" }, operations)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 6: historical Paid-but-not-Completed exceptions
// ---------------------------------------------------------------------------------------------

describe("historical Paid-but-not-Completed exceptions", () => {
  const REVIEW_SQL = readFileSync(path.resolve(__dirname, "../../docs/sql/paid-not-completed-review.sql"), "utf8");
  let liveException: string;
  let cancelledException: string;
  let liveContract: string;

  beforeAll(async () => {
    const now = await today();
    const terms = (name: string, validTo: string) => ({
      systemDescription: name,
      validFrom: addDays(now, -200),
      validTo,
      maintenanceFrequency: "MONTHLY",
      contractValue: "1200.000",
      billingBasis: "CONTRACT_VALUE",
    });
    // On a contract that has ended (so expiry will act on it).
    liveContract = await activeContract(admin, clientId, terms("EXCEPTION-LIVE", addDays(await businessToday(), -1)));
    liveException = (await visitsOf(liveContract))[2]!.id;
    await legacyInvoiceNo(liveException, "HIST-1");
    // On a contract that is then cancelled with its open visits.
    const cancelled = await activeContract(admin, clientId, terms("EXCEPTION-CANCELLED", addDays(now, 200)));
    cancelledException = (await visitsOf(cancelled))[3]!.id;
    await legacyInvoiceNo(cancelledException, "HIST-2");
    expect((await post(`/amc/contracts/${cancelled}/status`, { status: "CANCELLED", reason: "Closed", cancelOpenVisits: true })).status).toBe(200);
  });

  const row = async (id: string) =>
    (await pool.query("SELECT status, manual_invoice_no, visit_amount, completed_date, updated_at FROM amc_visits_all WHERE id = $1", [id])).rows[0];

  it("the review query is a single read-only SELECT and finds both exceptions", async () => {
    const statement = REVIEW_SQL.replace(/--.*$/gm, "").trim();
    expect(statement).toMatch(/^SELECT\b/i);
    expect(statement).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT)\b/i);
    expect(statement).not.toContain(";");

    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      const result = await client.query(statement);
      await client.query("ROLLBACK");
      const found = new Map(result.rows.map((r) => [String(r.visit_id), r]));
      expect(found.get(liveException)).toMatchObject({ invoice_no: "HIST-1", visit_status: "SCHEDULED", exception: "Paid service not yet completed" });
      expect(found.get(cancelledException)).toMatchObject({ invoice_no: "HIST-2", visit_status: "SCHEDULED", exception: "Paid service on a cancelled contract" });
      expect(result.rows.every((r) => r.visit_status !== "COMPLETED")).toBe(true);
    } finally {
      client.release();
    }
  });

  it("expiry, cancellation and reloading never complete, cancel or clear an exception", async () => {
    const before = [await row(liveException), await row(cancelledException)];

    expect((await runContractExpiry({ apply: true, enabled: true })).expired).toBeGreaterThanOrEqual(1);
    expect(await contractStatus(liveContract)).toBe("EXPIRED");
    // Reading every page that lists them changes nothing either.
    for (const url of ["/accounts", "/amc/service-status", "/amc/master-status", "/dashboard/operations", "/amc/management/summary"]) {
      expect((await get(url)).status).toBe(200);
    }

    expect([await row(liveException), await row(cancelledException)]).toEqual(before);
    expect(before[0]).toMatchObject({ status: "SCHEDULED", manual_invoice_no: "HIST-1", completed_date: null });
    expect(before[1]).toMatchObject({ status: "SCHEDULED", manual_invoice_no: "HIST-2", completed_date: null });
  });

  it("both exceptions stay visible as Paid in Accounts and in the Paid totals", async () => {
    const response = await get("/accounts", { pageSize: 200 });
    expect(response.body.data.total).toBeLessThanOrEqual(200);
    const items = response.body.data.items as { id: string; paymentStatus: string }[];
    expect(items.find((item) => item.id === liveException)?.paymentStatus).toBe("PAID");
    expect(items.find((item) => item.id === cancelledException)?.paymentStatus).toBe("PAID");

    const dashboard = (await get("/dashboard/operations")).body.data;
    const accounts = (await get("/accounts", { pageSize: 1 })).body.data.kpis;
    expect(dashboard.kpis.payments.paid).toBe(accounts.invoiceFilled);
    expect(dashboard.kpis.payments.paid + dashboard.kpis.payments.unpaid).toBe(dashboard.kpis.services.overall);
  });
});
