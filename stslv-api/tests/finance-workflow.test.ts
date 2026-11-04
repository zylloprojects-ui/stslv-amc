import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, createContract, logsFor, referenceOf, today, visitsOf, withServiceReport, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { invoiceBody, newInvoice } from "./invoices-helpers";

// The approved financial workflow: Billing Basis amounts, explicit Regenerate,
// manual Invoice No. = Paid, and every page reading the same status.

let admin: Session;
let finance: Session;
let viewer: Session;
let clientId: string;

const get = (url: string, query: Record<string, unknown> = {}, session: Session = admin) => api().get(`/api${url}`).query(query).set(session.headers);
const patch = (url: string, body: Record<string, unknown>, session: Session = admin) => api().patch(`/api${url}`).set(session.headers).send(body);
const post = (url: string, body: Record<string, unknown> = {}, session: Session = admin) => api().post(`/api${url}`).set(session.headers).send(body);
const terms = (name: string, overrides: Record<string, unknown> = {}) => ({
  clientId,
  systemDescription: name,
  validFrom: "2027-01-01",
  validTo: "2027-12-31",
  maintenanceFrequency: "HALF_YEARLY",
  contractValue: "500.000",
  ...overrides,
});
const amounts = async (id: string) => (await visitsOf(id)).map((visit) => visit.visit_amount);
const updatedAt = async (id: string) => (await get(`/amc/visits/${id}`)).body.data.updatedAt as string;
const setInvoiceNo = async (id: string, invoiceNo: string | null, session: Session = admin) =>
  patch(`/amc/visits/${id}/manual-invoice`, { invoiceNo, expectedUpdatedAt: await updatedAt(id) }, session);
const complete = async (id: string) => {
  await withServiceReport(id);
  expect((await patch(`/amc/execution/visits/${id}`, { status: "COMPLETED", completedDate: await today() })).status).toBe(200);
};
const accountsRow = async (id: string, reference: string) =>
  ((await get("/accounts", { search: reference, pageSize: 200 })).body.data.items as { id: string; manualInvoiceNo: string | null; paymentStatus: string; colour: string; invoiceNumbers: string[] }[]).find((item) => item.id === id);
const reference = (contractId: string) => referenceOf(contractId);
/**
 * A number entered before the 2026-11-04 completion rule, on a service that is still not completed.
 * The API no longer accepts this, but such records exist and must keep working, so it is written
 * straight into the test schema the way the API wrote it then.
 */
const legacyInvoiceNo = async (id: string, invoiceNo: string) => {
  const by = (await pool.query("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0].id;
  await pool.query("UPDATE amc_visits_all SET manual_invoice_no = $1, manual_invoice_at = now(), manual_invoice_by = $2, updated_at = now() WHERE id = $3", [invoiceNo, by, id]);
};

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  finance = await signedIn("finance@example.com", ["FINANCE_EXECUTIVE"]);
  viewer = await signedIn("viewer@example.com", ["VIEWER"]);
  clientId = await createClient(admin, "Finance Tower");
  // Bi-Monthly starts inactive; the worked examples of the reference use it.
  await pool.query("UPDATE maintenance_frequencies SET is_active = true WHERE code = 'BI_MONTHLY'");
});
afterAll(async () => {
  await pool.query("UPDATE maintenance_frequencies SET is_active = false WHERE code = 'BI_MONTHLY'");
  await closePool();
});

describe("visit amounts from the Billing Basis", () => {
  it("a new contract with AMC Value / Year divides it across each year, last service settling the remainder", async () => {
    const id = await activeContract(admin, clientId, terms("BASIS-YEARLY", { maintenanceFrequency: "BI_MONTHLY", validTo: "2028-12-31", billingBasis: "CONTRACT_VALUE" }));
    const rows = await amounts(id);

    expect(rows).toHaveLength(12);
    expect(rows.filter((amount) => amount === "83.335")).toHaveLength(2);
    expect(rows[5]).toBe("83.335");
    expect(rows[11]).toBe("83.335");

    const { schedule } = (await get(`/amc/contracts/${id}`)).body.data;
    expect(schedule).toMatchObject({ annualAmount: "500.000", servicesPerCycle: 6, perServiceAmount: "83.333", expectedTermTotal: "1000.000", generatedTotal: "1000.000", valueDifference: "0.000" });
  });

  it("Final Credit Value and Custom Billing Value are annual too", async () => {
    const credit = await activeContract(admin, clientId, terms("BASIS-CREDIT", { finalCredit: "800.000", billingBasis: "FINAL_CREDIT" }));
    expect(await amounts(credit)).toEqual(["400.000", "400.000"]);

    const custom = await activeContract(admin, clientId, terms("BASIS-CUSTOM", { billingBasis: "CUSTOM", customBillingValue: "300.000", validTo: "2028-12-31" }));
    expect(await amounts(custom)).toEqual(["150.000", "150.000", "150.000", "150.000"]);
  });

  it("a partial year keeps the standard amount and is not prorated", async () => {
    const id = await activeContract(admin, clientId, terms("BASIS-PARTIAL", { validTo: "2028-06-30", billingBasis: "CONTRACT_VALUE" }));

    expect(await amounts(id)).toEqual(["250.000", "250.000", "250.000"]);
    expect((await get(`/amc/contracts/${id}`)).body.data.schedule.expectedTermTotal).toBe("750.000");
  });

  it("a contract with no basis keeps its manually entered Cost per Visit, and is never compared", async () => {
    const id = await activeContract(admin, clientId, terms("LEGACY", { defaultVisitAmount: "123.456" }));

    expect(await amounts(id)).toEqual(["123.456", "123.456"]);
    expect((await get(`/amc/contracts/${id}`)).body.data.schedule).toMatchObject({ annualAmount: null, expectedTermTotal: null, valueDifference: null });
  });

  it("selecting a basis later changes no existing visit until Regenerate", async () => {
    const id = await activeContract(admin, clientId, terms("LATER", { defaultVisitAmount: "100.000" }));

    expect((await patch(`/amc/contracts/${id}`, { billingBasis: "CONTRACT_VALUE" })).status).toBe(200);
    expect(await amounts(id)).toEqual(["100.000", "100.000"]);
    expect((await get(`/amc/contracts/${id}`)).body.data.schedule.valueDifference).toBe("300.000");
  });

  it("editing the value after that does not touch visits either", async () => {
    const id = await activeContract(admin, clientId, terms("EDIT-VALUE", { billingBasis: "CONTRACT_VALUE" }));

    expect((await patch(`/amc/contracts/${id}`, { contractValue: "900.000" })).status).toBe(200);
    expect(await amounts(id)).toEqual(["250.000", "250.000"]);
  });
});

describe("Regenerate", () => {
  it("previews without changing anything, needs a reason, and logs old and new amounts", async () => {
    const id = await activeContract(admin, clientId, terms("REGEN", { defaultVisitAmount: "100.000" }));
    await patch(`/amc/contracts/${id}`, { billingBasis: "CONTRACT_VALUE" });

    const preview = (await get(`/amc/contracts/${id}/schedule/regenerate`)).body.data;
    expect(preview).toMatchObject({ canApply: true, perServiceAmount: "250.000", unchanged: 0 });
    expect(preview.changes.map((change: { from: string; to: string }) => [change.from, change.to])).toEqual([["100.000", "250.000"], ["100.000", "250.000"]]);
    expect(await amounts(id)).toEqual(["100.000", "100.000"]);

    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, {})).status).toBe(400);
    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "x" })).status).toBe(400);

    const done = await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Client moved to annual billing" });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ recalculated: 2, preserved: 0 });
    expect(await amounts(id)).toEqual(["250.000", "250.000"]);
    expect((await get(`/amc/contracts/${id}`)).body.data.schedule.valueDifference).toBe("0.000");

    const log = (await logsFor("amc_contracts", id)).find((entry) => entry.action === "amc_contract.schedule_regenerated");
    expect(log?.metadata).toMatchObject({ reason: "Client moved to annual billing", billingBasis: "CONTRACT_VALUE", annualAmount: "500.000" });
    expect((log?.metadata as { recalculated: unknown[] }).recalculated).toHaveLength(2);
  });

  it("preserves completed, Paid, Zoho-invoiced, hand-set, and cancelled visits and their values", async () => {
    const id = await activeContract(admin, clientId, terms("KEEP", { maintenanceFrequency: "MONTHLY", contractValue: "1200.000", defaultVisitAmount: "50.000" }));
    const visits = await visitsOf(id);
    const [completed, paid, zoho, custom, cancelled] = visits;

    await complete(completed!.id);
    await legacyInvoiceNo(paid!.id, "M-1");
    await complete(zoho!.id);
    await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: zoho!.id, amount: "50.000" }], { invoiceNumber: "ZOHO-KEEP", amountExclVat: "50.000", vatAmount: "2.500" }));
    expect((await patch(`/amc/visits/${custom!.id}`, { visitAmount: "77.000" })).status).toBe(200);
    expect((await patch(`/amc/execution/visits/${cancelled!.id}`, { status: "CANCELLED", statusReason: "Client closed" })).status).toBe(200);
    expect((await patch(`/amc/contracts/${id}`, { billingBasis: "CONTRACT_VALUE" })).status).toBe(200);

    const preview = (await get(`/amc/contracts/${id}/schedule/regenerate`)).body.data;
    expect(Object.fromEntries(preview.preserved.map((visit: { id: string; reason: string }) => [visit.id, visit.reason]))).toEqual({
      [completed!.id]: "Completed",
      [paid!.id]: "Paid",
      [zoho!.id]: "Completed",
      [custom!.id]: "Amount set by hand",
      [cancelled!.id]: "Cancelled",
    });

    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Billing correction" })).status).toBe(200);
    const after = await visitsOf(id);

    expect(after.slice(0, 3).map((visit) => visit.visit_amount)).toEqual(["50.000", "50.000", "50.000"]);
    expect(after[3]!.visit_amount).toBe("77.000");
    expect(after[4]!.visit_amount).toBe("50.000");
    expect(after.slice(5).every((visit) => visit.visit_amount === "100.000")).toBe(true);
    expect((await get(`/amc/visits/${paid!.id}`)).body.data.manualInvoiceNo).toBe("M-1");
    expect((await pool.query("SELECT 1 FROM invoices WHERE invoice_number = 'ZOHO-KEEP' AND status = 'ISSUED'")).rowCount).toBe(1);
  });

  it("a zero-change run keeps visits, and repeating it recalculates nothing", async () => {
    const id = await activeContract(admin, clientId, terms("REPEAT", { billingBasis: "CONTRACT_VALUE" }));

    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Check" })).body.data).toMatchObject({ recalculated: 0, unchanged: 2 });
    expect(await amounts(id)).toEqual(["250.000", "250.000"]);
  });

  it("refuses a contract with no basis and one that is not active, changing nothing", async () => {
    const legacy = await activeContract(admin, clientId, terms("NO-BASIS", { defaultVisitAmount: "10.000" }));
    const refused = await post(`/amc/contracts/${legacy}/schedule/regenerate`, { reason: "Try it" });

    expect(refused.status).toBe(409);
    expect(refused.body.error?.message ?? refused.body.message).toMatch(/Billing Basis/);
    expect(await amounts(legacy)).toEqual(["10.000", "10.000"]);

    const draft = await createContract(admin, clientId, terms("DRAFTED", { billingBasis: "CONTRACT_VALUE", status: "DRAFT" }));
    expect((await post(`/amc/contracts/${draft.body.data.id}/schedule/regenerate`, { reason: "Try it" })).status).toBe(409);
  });

  it("needs AMC_CONTRACTS:EDIT on the server", async () => {
    const id = await activeContract(admin, clientId, terms("REGEN-PERM", { billingBasis: "CONTRACT_VALUE" }));

    expect((await get(`/amc/contracts/${id}/schedule/regenerate`, {}, viewer)).status).toBe(403);
    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Not allowed" }, viewer)).status).toBe(403);
    expect((await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Not allowed" }, finance)).status).toBe(403);
    expect((await api().post(`/api/amc/contracts/${id}/schedule/regenerate`).send({ reason: "Nobody" })).status).toBe(401);
  });

  it("schedule history records the reason and basis, and older entries stay readable", async () => {
    const id = await activeContract(admin, clientId, terms("HISTORY", { billingBasis: "CONTRACT_VALUE" }));
    await post(`/amc/contracts/${id}/schedule/regenerate`, { reason: "Annual review" });

    // An entry as it was written before reasons were recorded.
    await pool.query(
      `INSERT INTO activity_logs (user_id, action, module, entity_type, entity_id, description, metadata)
       VALUES ($1, 'amc_contract.schedule_generated', 'AMC_SCHEDULE', 'amc_contracts', $2, 'Old entry', '{"terms":{},"created":["2027-01-01"],"removed":[]}')`,
      [admin.id, id]
    );

    const history = (await get(`/amc/contracts/${id}/schedule/generations`)).body.data as { reason: string | null; billingBasis: string | null; annualAmount: string | null }[];

    expect(history[0]).toMatchObject({ reason: "Contract created", billingBasis: "CONTRACT_VALUE", annualAmount: "500.000" });
    expect(history[1]).toMatchObject({ reason: "Annual review", billingBasis: "CONTRACT_VALUE" });
    expect(history[2]).toMatchObject({ reason: null, billingBasis: null, annualAmount: null });
  });
});

describe("manual Invoice No.", () => {
  it("entered = Paid, cleared = Unpaid; no date, amount or VAT asked for, and no invoice generated", async () => {
    const id = await activeContract(admin, clientId, terms("PAID-RULE", { billingBasis: "CONTRACT_VALUE" }));
    const [visit] = await visitsOf(id);
    await complete(visit!.id);
    const invoices = (await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n;

    const entered = await setInvoiceNo(visit!.id, " INV-100 ");
    expect(entered.status).toBe(200);
    expect(entered.body.data).toMatchObject({ manualInvoiceNo: "INV-100", paymentStatus: "PAID" });
    expect(entered.body.data.paidAt).toBeTruthy();
    expect((await get(`/amc/visits/${visit!.id}`)).body.data).toMatchObject({ paymentStatus: "PAID", colorState: "FIRST_SERVICE" });

    const cleared = await setInvoiceNo(visit!.id, "");
    expect(cleared.body.data).toMatchObject({ manualInvoiceNo: null, paymentStatus: "UNPAID", paidAt: null });
    expect((await get(`/amc/visits/${visit!.id}`)).body.data.colorState).toBe("INVOICE_PENDING");

    expect((await pool.query("SELECT count(*)::int AS n FROM invoices")).rows[0].n).toBe(invoices);
    const actions = (await logsFor("amc_visits", visit!.id)).filter((entry) => entry.action === "amc_visit.manual_invoice_changed");
    expect(actions).toHaveLength(2);
    expect(actions.map((entry) => (entry.metadata as { changes: { manualInvoiceNo: unknown } }).changes.manualInvoiceNo)).toEqual([{ from: null, to: "INV-100" }, { from: "INV-100", to: null }]);
  });

  it("can be entered only on a completed service; completing never makes a service Paid", async () => {
    const id = await activeContract(admin, clientId, terms("COMPLETE-FIRST", { maintenanceFrequency: "QUARTERLY", billingBasis: "CONTRACT_VALUE" }));
    const [open, doneNotPaid, postponed, inProgress] = await visitsOf(id);
    const ref = await reference(id);

    // A direct request for a service that is not completed is refused, whatever the client claims.
    const refused = await patch(`/amc/visits/${open!.id}/manual-invoice`, { invoiceNo: "EARLY-1", expectedUpdatedAt: await updatedAt(open!.id) });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ success: false, error: { code: "CONFLICT", message: "Complete the service before entering an invoice number." } });
    expect((await patch(`/amc/visits/${open!.id}/manual-invoice`, { invoiceNo: "EARLY-1", completed: true, expectedUpdatedAt: await updatedAt(open!.id) })).status).toBe(400);
    expect((await get(`/amc/visits/${open!.id}`)).body.data).toMatchObject({ manualInvoiceNo: null, paymentStatus: "UNPAID", status: "SCHEDULED" });
    expect((await logsFor("amc_visits", open!.id)).filter((entry) => entry.action === "amc_visit.manual_invoice_changed")).toHaveLength(0);

    // Postponed and in-progress services are not completed either.
    expect((await patch(`/amc/execution/visits/${postponed!.id}`, { status: "POSTPONED", statusReason: "Site closed" })).status).toBe(200);
    expect((await setInvoiceNo(postponed!.id, "EARLY-2")).status).toBe(409);
    expect((await patch(`/amc/execution/visits/${inProgress!.id}`, { status: "IN_PROGRESS" })).status).toBe(200);
    expect((await setInvoiceNo(inProgress!.id, "EARLY-3")).status).toBe(409);

    // Completing does not make a service Paid; once completed, the number is accepted.
    await complete(doneNotPaid!.id);
    expect(await accountsRow(doneNotPaid!.id, ref)).toMatchObject({ paymentStatus: "UNPAID", colour: "BLUE" });
    expect((await setInvoiceNo(doneNotPaid!.id, "DONE-1")).status).toBe(200);
    expect(await accountsRow(doneNotPaid!.id, ref)).toMatchObject({ paymentStatus: "PAID", colour: "GREEN" });

    // Each service is judged on its own: the completed one did not open the others of the same contract.
    expect((await setInvoiceNo(open!.id, "DONE-1")).status).toBe(409);
    await complete(open!.id);
    expect((await setInvoiceNo(open!.id, "DONE-1")).status).toBe(200);
  });

  it("a number entered before the rule on a service not completed stays, may be cleared, but not changed", async () => {
    const id = await activeContract(admin, clientId, terms("LEGACY-NO", { billingBasis: "CONTRACT_VALUE" }));
    const [visit] = await visitsOf(id);
    await legacyInvoiceNo(visit!.id, "OLD-1");
    const ref = await reference(id);

    expect(await accountsRow(visit!.id, ref)).toMatchObject({ manualInvoiceNo: "OLD-1", paymentStatus: "PAID", colour: "RED" });
    // Saving the same number again changes nothing and is not refused.
    const same = await setInvoiceNo(visit!.id, "OLD-1");
    expect(same.status).toBe(200);
    expect(same.body.data.manualInvoiceNo).toBe("OLD-1");
    // A different number is a new entry and needs completion.
    expect((await setInvoiceNo(visit!.id, "OLD-2")).status).toBe(409);
    expect((await get(`/amc/visits/${visit!.id}`)).body.data.manualInvoiceNo).toBe("OLD-1");
    // Clearing returns the service to Unpaid at any status, and is logged.
    const cleared = await setInvoiceNo(visit!.id, null);
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ manualInvoiceNo: null, paymentStatus: "UNPAID" });
    const actions = (await logsFor("amc_visits", visit!.id)).filter((entry) => entry.action === "amc_visit.manual_invoice_changed");
    expect(actions.map((entry) => (entry.metadata as { changes: { manualInvoiceNo: unknown } }).changes.manualInvoiceNo)).toEqual([{ from: "OLD-1", to: null }]);
  });

  it("the same number may cover several services", async () => {
    const id = await activeContract(admin, clientId, terms("SAME-NO", { billingBasis: "CONTRACT_VALUE" }));
    const [one, two] = await visitsOf(id);
    await complete(one!.id);
    await complete(two!.id);

    expect((await setInvoiceNo(one!.id, "SHARED-1")).status).toBe(200);
    expect((await setInvoiceNo(two!.id, "SHARED-1")).status).toBe(200);
  });

  it("a Zoho record alone does not make a service Paid, and leaves Invoice Tracking as it was", async () => {
    const id = await activeContract(admin, clientId, terms("ZOHO-ONLY", { billingBasis: "CONTRACT_VALUE" }));
    const [visit] = await visitsOf(id);
    await complete(visit!.id);

    const zoho = (await newInvoice(admin, invoiceBody(clientId, [{ amcVisitId: visit!.id, amount: "250.000" }], { amountExclVat: "250.000", vatAmount: "12.500" }))).id as string;
    const row = await accountsRow(visit!.id, await reference(id));

    expect(row).toMatchObject({ paymentStatus: "UNPAID", manualInvoiceNo: null, colour: "BLUE" });
    expect(row?.invoiceNumbers).toHaveLength(1);
    expect((await get(`/invoices/${zoho}`)).status).toBe(200);
    // Entering a manual number leaves the Zoho record untouched.
    await setInvoiceNo(visit!.id, "M-77");
    expect((await pool.query("SELECT status FROM invoices WHERE id = $1", [zoho])).rows[0].status).toBe("ISSUED");
    expect((await get(`/amc/visits/${visit!.id}`)).body.data.invoiceEligibility).toBe("INVOICED");
  });

  it("a Paid visit keeps its amount and survives contract cancellation of open visits", async () => {
    const id = await activeContract(admin, clientId, terms("PAID-LOCK", { billingBasis: "CONTRACT_VALUE" }));
    const [paid, open] = await visitsOf(id);
    await legacyInvoiceNo(paid!.id, "LOCK-1");

    const refused = await patch(`/amc/visits/${paid!.id}`, { visitAmount: "1.000" });
    expect(refused.status).toBe(409);

    expect((await post(`/amc/contracts/${id}/status`, { status: "CANCELLED", reason: "Closed", cancelOpenVisits: true })).status).toBe(200);
    const after = await visitsOf(id);
    expect(after.find((visit) => visit.id === paid!.id)?.status).toBe("SCHEDULED");
    expect(after.find((visit) => visit.id === open!.id)?.status).toBe("CANCELLED");
  });

  it("a term change never removes a visit with a number on it", async () => {
    const id = await activeContract(admin, clientId, terms("TERM-KEEP", { billingBasis: "CONTRACT_VALUE", validTo: "2028-12-31" }));
    const visits = await visitsOf(id);
    await legacyInvoiceNo(visits[3]!.id, "TERM-1");

    // The paid visit falls outside the shorter validity: the change is refused, not silently applied.
    expect((await patch(`/amc/contracts/${id}`, { validTo: "2027-12-31" })).status).toBe(409);
    expect(await visitsOf(id)).toHaveLength(4);
  });

  it("refuses historical and cancelled visits, a stale page, and an overlong number", async () => {
    const id = await activeContract(admin, clientId, terms("REFUSE", { billingBasis: "CONTRACT_VALUE" }));
    const [visit, other] = await visitsOf(id);
    await complete(visit!.id);
    const stale = await updatedAt(visit!.id);

    expect((await setInvoiceNo(visit!.id, "FIRST")).status).toBe(200);
    expect((await patch(`/amc/visits/${visit!.id}/manual-invoice`, { invoiceNo: "SECOND", expectedUpdatedAt: stale })).status).toBe(409);
    expect((await get(`/amc/visits/${visit!.id}`)).body.data.manualInvoiceNo).toBe("FIRST");
    expect((await setInvoiceNo(visit!.id, "X".repeat(51))).status).toBe(400);
    expect((await patch(`/amc/visits/${visit!.id}/manual-invoice`, { invoiceNo: "A" })).status).toBe(400);
    expect((await patch(`/amc/visits/999999/manual-invoice`, { invoiceNo: "A", expectedUpdatedAt: stale })).status).toBe(404);

    expect((await patch(`/amc/execution/visits/${other!.id}`, { status: "CANCELLED", statusReason: "Gone" })).status).toBe(200);
    expect((await setInvoiceNo(other!.id, "NOPE")).status).toBe(409);
  });

  it("needs INVOICES:EDIT on the server", async () => {
    const id = await activeContract(admin, clientId, terms("INV-PERM", { billingBasis: "CONTRACT_VALUE" }));
    const [visit] = await visitsOf(id);
    await complete(visit!.id);

    expect((await setInvoiceNo(visit!.id, "NO", viewer)).status).toBe(403);
    expect((await patch(`/amc/visits/${visit!.id}/manual-invoice`, { invoiceNo: "YES", expectedUpdatedAt: await updatedAt(visit!.id) }, finance)).status).toBe(200);
    expect((await api().patch(`/api/amc/visits/${visit!.id}/manual-invoice`).send({ invoiceNo: "X", expectedUpdatedAt: new Date().toISOString() })).status).toBe(401);
  });
});

describe("every page reads the same status", () => {
  it("Accounts, Master AMC Status, Dashboard, AMC Management and Reports agree with the database", async () => {
    const other = await createClient(admin, "Reconcile Plaza");
    const id = await activeContract(admin, other, terms("RECON", { clientId: other, maintenanceFrequency: "BI_MONTHLY", billingBasis: "CONTRACT_VALUE" }));
    const visits = await visitsOf(id);
    await complete(visits[0]!.id);
    expect((await setInvoiceNo(visits[0]!.id, "RC-1")).status).toBe(200);
    // A pre-rule number on a service not completed still counts as Paid everywhere.
    await legacyInvoiceNo(visits[5]!.id, "RC-2");

    const accounts = (await get("/accounts", { clientId: other })).body.data;
    expect(accounts.kpis).toMatchObject({ rows: 6, invoiceFilled: 2, totalValue: "500.000", green: 1, red: 5 });
    expect((await get("/accounts", { clientId: other, invoiceStatus: "RECORDED" })).body.data.total).toBe(2);
    expect((await get("/accounts", { clientId: other, invoiceStatus: "NOT_RECORDED" })).body.data.total).toBe(4);
    expect((await get("/accounts", { search: "RC-2" })).body.data.total).toBe(1);

    const master = (await get("/amc/master-status", { clientId: other })).body.data;
    expect(master.items.find((item: { id: string }) => item.id === visits[0]!.id)).toMatchObject({ manualInvoiceNo: "RC-1", paymentStatus: "PAID", colour: "BLUE" });
    expect((await get("/amc/master-status", { clientId: other, invoiceStatus: "RECORDED" })).body.data.total).toBe(2);

    const { rows } = await pool.query<{ paid: number; paid_value: string; unpaid: number; unpaid_value: string }>(
      `SELECT count(*) FILTER (WHERE v.manual_invoice_no IS NOT NULL)::int AS paid,
              COALESCE(sum(v.visit_amount) FILTER (WHERE v.manual_invoice_no IS NOT NULL), 0)::numeric(16,3)::text AS paid_value,
              count(*) FILTER (WHERE v.manual_invoice_no IS NULL)::int AS unpaid,
              COALESCE(sum(v.visit_amount) FILTER (WHERE v.manual_invoice_no IS NULL), 0)::numeric(16,3)::text AS unpaid_value
       FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED', 'COMPLETED') AND (v.status = 'COMPLETED' OR c.status <> 'CANCELLED')`
    );
    const expected = rows[0]!;

    const dashboard = (await get("/dashboard/operations")).body.data;
    expect(dashboard.kpis.payments).toMatchObject({ paid: expected.paid, paidValue: expected.paid_value, unpaid: expected.unpaid, unpaidValue: expected.unpaid_value });
    expect(dashboard.paymentTrend.months).toHaveLength(6);
    expect(Number(dashboard.kpis.payments.paidThisMonth)).toBe(expected.paid);
    expect(dashboard.paymentTrend.months.at(-1).count).toBe(expected.paid);

    const management = (await get("/amc/management/summary")).body.data.invoices;
    expect(management).toMatchObject({ paid: { count: expected.paid }, unpaid: { count: expected.unpaid, amount: expected.unpaid_value }, paidTotal: { amount: expected.paid_value } });

    const report = (await get("/reports/accounts", { clientId: other })).body.data;
    expect(report.rows).toEqual(expect.arrayContaining([expect.objectContaining({ service_state: "Completed", invoice_state: "Paid", services: 1 })]));
    expect(report.notes.join(" ")).toMatch(/does not verify/);

    const calendar = (await get("/amc/visits/year-summary", { year: 2027, clientId: other })).body.data;
    expect(calendar.totals).toMatchObject({ services: 6, paid: 2, unpaid: 4 });
    expect((await get("/amc/visits", { clientId: other, paymentStatus: "PAID" })).body.data.total).toBe(2);
  });

  it("the accounts export says what Paid means", async () => {
    const response = await get("/reports/scheduled-services/export", { format: "pdf" });
    expect(response.status).toBe(200);
  });
});

describe("contract value review", () => {
  it("flags possible whole-term values for a person to check, and changes nothing", async () => {
    const other = await createClient(admin, "Review House");
    // 2 years half-yearly: 4 visits of 100.000. 400.000 equals all the visits: it may be a whole-term amount.
    const term = await activeContract(admin, other, terms("REVIEW-TERM", { clientId: other, validTo: "2028-12-31", contractValue: "400.000", defaultVisitAmount: "100.000" }));
    // 200.000 a year repeated for 2 years equals the visits: it looks annual.
    const annual = await activeContract(admin, other, terms("REVIEW-ANNUAL", { clientId: other, validTo: "2028-12-31", contractValue: "200.000", defaultVisitAmount: "100.000" }));
    const unclear = await activeContract(admin, other, terms("REVIEW-UNCLEAR", { clientId: other, validTo: "2028-12-31", contractValue: "999.000", defaultVisitAmount: "100.000" }));
    await activeContract(admin, other, terms("REVIEW-ONE-YEAR", { clientId: other, contractValue: "200.000", defaultVisitAmount: "100.000" }));
    await activeContract(admin, other, terms("REVIEW-BASIS", { clientId: other, validTo: "2028-12-31", finalCredit: "100.000", billingBasis: "FINAL_CREDIT" }));

    const report = (await get("/reports/contract-value-review", { clientId: other })).body.data;
    const assessed = Object.fromEntries(report.rows.map((row: { system: string; assessment: string; contract_years: number }) => [row.system, row]));

    expect(Object.keys(assessed).sort()).toEqual(["REVIEW-ANNUAL", "REVIEW-TERM", "REVIEW-UNCLEAR"]);
    expect(assessed["REVIEW-TERM"].assessment).toMatch(/May be whole-term/);
    expect(assessed["REVIEW-ANNUAL"].assessment).toMatch(/Looks annual/);
    expect(assessed["REVIEW-UNCLEAR"].assessment).toMatch(/Unclear/);
    expect(assessed["REVIEW-TERM"].contract_years).toBe(2);

    for (const contract of [term, annual, unclear]) {
      expect((await get(`/amc/contracts/${contract}`)).body.data.billingBasis).toBeNull();
    }
    expect((await pool.query("SELECT contract_value FROM amc_contracts WHERE id = $1", [term])).rows[0].contract_value).toBe("400.000");
  });

  it("is not open without the Reports permission", async () => {
    expect((await get("/reports/contract-value-review", {}, viewer)).status).toBe(403);
  });
});
