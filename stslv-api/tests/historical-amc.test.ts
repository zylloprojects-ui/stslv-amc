import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays, buildSchedulePeriods } from "../src/modules/amc/amc.schedule";
import { activeContract, createClient, createContract, today, visitsOf, type Session } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";
import { insertHistoricalVisit, insertImportedContract } from "./historical-helpers";

// A historical visit is a period row imported from an earlier schedule. The
// source gives its period and amount; whether and when the visit took place is
// not recorded. Only rows the source lists exist: the system never fills in a
// period from before the import.

let admin: Session;
let clientId: string;
let now: string;

beforeEach(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await createClient(admin, "Test Hotel One");
  now = await today();
});
afterAll(closePool);

const get = (path: string, session: Session = admin) => api().get(path).set(session.headers);
const setContractStatus = (id: string, body: Record<string, unknown>) =>
  api().post(`/api/amc/contracts/${id}/status`).set(admin.headers).send(body);
const generate = (id: string) => api().post(`/api/amc/contracts/${id}/schedule/generate`).set(admin.headers).send({});
const summary = async () => (await get("/api/amc/summary")).body.data;

/**
 * A monthly contract that started 100 days ago and runs 100 days more, imported
 * today. The source lists only its first and third periods; its second and
 * fourth, also before today, are absent from the source.
 */
async function importedContract() {
  const validFrom = addDays(now, -100);
  const validTo = addDays(now, 100);
  // The contract's full period grid, worked out here without any cutover.
  const grid = buildSchedulePeriods(validFrom, validTo, "MONTHLY");
  const before = grid.filter((period) => period.periodStart < now);
  const after = grid.filter((period) => period.periodStart >= now);
  const id = await insertImportedContract(clientId, { validFrom, validTo, frequency: "MONTHLY", cutoverDate: now, defaultVisitAmount: "100.000" });
  const first = before[0] as (typeof grid)[number];
  const third = before[2] as (typeof grid)[number];
  const visit1 = await insertHistoricalVisit(id, { sequenceNo: 1, periodStart: first.periodStart, periodEnd: first.periodEnd, visitAmount: "405.000" });
  const visit3 = await insertHistoricalVisit(id, { sequenceNo: 3, periodStart: third.periodStart, periodEnd: third.periodEnd, visitAmount: "0.000" });

  return { id, grid, before, after, first, third, visit1, visit3 };
}

describe("historical visit: what is stored", () => {
  it("keeps the period and amount of the source row, with no completion date", async () => {
    const { id, first, visit1 } = await importedContract();
    const stored = (await visitsOf(id)).find((visit) => visit.id === visit1);

    expect(stored).toMatchObject({
      sequence_no: 1,
      period_start: first.periodStart,
      period_end: first.periodEnd,
      status: "HISTORICAL",
      visit_amount: "405.000",
      completed_date: null,
      completed_by: null,
    });
  });

  it("is refused a completion date or a completing user by the database", async () => {
    const { visit1 } = await importedContract();

    await expect(pool.query("UPDATE amc_visits SET completed_date = current_date WHERE id = $1", [visit1])).rejects.toMatchObject({
      code: "23514",
      constraint: "amc_visits_completion_ck",
    });
    await expect(pool.query("UPDATE amc_visits SET completed_by = $2 WHERE id = $1", [visit1, admin.id])).rejects.toMatchObject({
      code: "23514",
      constraint: "amc_visits_completed_by_ck",
    });
  });

  it("is refused an unknown status by the database", async () => {
    const { visit1 } = await importedContract();

    await expect(pool.query("UPDATE amc_visits SET status = 'UNKNOWN' WHERE id = $1", [visit1])).rejects.toMatchObject({
      code: "23514",
      constraint: "amc_visits_status_ck",
    });
  });
});

describe("only source rows exist", () => {
  it("has exactly the visits the source lists: an absent period is not created by the import", async () => {
    const { id, before, first, third } = await importedContract();

    // Four periods lie before the import; the source lists two of them.
    expect(before.length).toBeGreaterThanOrEqual(4);
    expect((await visitsOf(id)).map((visit) => [visit.period_start, visit.status])).toEqual([
      [first.periodStart, "HISTORICAL"],
      [third.periodStart, "HISTORICAL"],
    ]);
  });

  it("does not backfill the absent periods when the contract is activated", async () => {
    const { id, before, after, first, third } = await importedContract();
    const response = await setContractStatus(id, { status: "ACTIVE" });

    expect(response.status).toBe(200);
    expect(response.body.data.scheduleChange).toEqual({ created: after.length, removed: 0, kept: 2 });

    const visits = await visitsOf(id);
    const absent = before.filter((period) => period !== first && period !== third).map((period) => period.periodStart);

    // Nothing was manufactured for a period before the import.
    expect(absent.length).toBeGreaterThanOrEqual(2);
    expect(visits.filter((visit) => absent.includes(visit.period_start))).toEqual([]);
    expect(visits.filter((visit) => visit.period_start < now).map((visit) => visit.status)).toEqual(["HISTORICAL", "HISTORICAL"]);
    // The two source rows are exactly as imported.
    expect(visits.filter((visit) => visit.status === "HISTORICAL").map((visit) => [visit.sequence_no, visit.period_start, visit.visit_amount])).toEqual([
      [1, first.periodStart, "405.000"],
      [3, third.periodStart, "0.000"],
    ]);
  });

  it("generates the periods from the import date onwards normally", async () => {
    const { id, after } = await importedContract();
    await setContractStatus(id, { status: "ACTIVE" });

    const generated = (await visitsOf(id)).filter((visit) => visit.status !== "HISTORICAL");

    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(generated.map((visit) => [visit.period_start, visit.period_end, visit.scheduled_date, visit.status, visit.visit_amount])).toEqual(
      after.map((period) => [period.periodStart, period.periodEnd, period.periodStart, "SCHEDULED", "100.000"])
    );
    // Numbered after the imported rows.
    expect(generated.map((visit) => visit.sequence_no)).toEqual(after.map((_, index) => 4 + index));
    // None of them is in the past, so none is overdue.
    expect(generated.every((visit) => visit.scheduled_date >= now)).toBe(true);
  });

  it("stays the same when the schedule is generated again and again", async () => {
    const { id } = await importedContract();
    await setContractStatus(id, { status: "ACTIVE" });
    const first = await visitsOf(id);

    for (let run = 0; run < 3; run += 1) {
      const response = await generate(id);

      expect(response.status).toBe(200);
      expect(response.body.data.scheduleChange).toEqual({ created: 0, removed: 0, kept: first.length });
    }

    expect(await visitsOf(id)).toEqual(first);
  });

  it("shows the same in the schedule preview, before anything is generated", async () => {
    const { id, after } = await importedContract();
    const preview = (await get(`/api/amc/contracts/${id}/schedule/preview`)).body.data;

    expect(preview.toCreate.map((period: { periodStart: string }) => period.periodStart)).toEqual(after.map((period) => period.periodStart));
    expect(preview.toRemove).toEqual([]);
    expect(preview.keptCount).toBe(2);
  });

  it("generates a period that starts exactly on the import date", async () => {
    const id = await insertImportedContract(clientId, { validFrom: now, validTo: addDays(now, 100), frequency: "MONTHLY", cutoverDate: now });
    await setContractStatus(id, { status: "ACTIVE" });

    expect((await visitsOf(id))[0]).toMatchObject({ period_start: now, status: "SCHEDULED" });
  });

  it("does not backfill when the validity of an active imported contract is extended", async () => {
    const { id, before, after } = await importedContract();
    await setContractStatus(id, { status: "ACTIVE" });

    const response = await api().patch(`/api/amc/contracts/${id}`).set(admin.headers).send({ validTo: addDays(now, 200) });
    const visits = await visitsOf(id);

    expect(response.status).toBe(200);
    expect(response.body.data.scheduleChange.created).toBeGreaterThan(0);
    expect(visits.filter((visit) => visit.period_start < now)).toHaveLength(2);
    expect(visits.length).toBeGreaterThan(2 + after.length);
    expect(visits.length).toBeLessThan(before.length + after.length + response.body.data.scheduleChange.created);
  });

  it("still generates every period, past ones included, for a contract entered in the application", async () => {
    const validFrom = addDays(now, -100);
    const validTo = addDays(now, 100);
    const id = await activeContract(admin, clientId, { validFrom, validTo, maintenanceFrequency: "MONTHLY", systemDescription: "CCTV" });
    const grid = buildSchedulePeriods(validFrom, validTo, "MONTHLY");
    const visits = await visitsOf(id);

    expect((await get(`/api/amc/contracts/${id}`)).body.data.scheduleCutoverDate).toBeNull();
    expect(visits.map((visit) => visit.period_start)).toEqual(grid.map((period) => period.periodStart));
    expect(visits.every((visit) => visit.status === "SCHEDULED")).toBe(true);
    expect(visits.filter((visit) => visit.period_start < now).length).toBeGreaterThanOrEqual(4);
  });

  it("cannot hold two visits for one period of a contract", async () => {
    const { id, first } = await importedContract();

    await expect(
      insertHistoricalVisit(id, { sequenceNo: 9, periodStart: first.periodStart, periodEnd: first.periodEnd })
    ).rejects.toMatchObject({ code: "23505", constraint: "amc_visits_period_uq" });
  });
});

describe("import cutover date", () => {
  it("is returned with the contract, with the count of historical visits", async () => {
    const { id } = await importedContract();
    const contract = (await get(`/api/amc/contracts/${id}`)).body.data;

    expect(contract.scheduleCutoverDate).toBe(now);
    expect(contract.status).toBe("DRAFT");
    expect(contract.schedule).toMatchObject({ visitCount: 2, historicalCount: 2, openCount: 0, completedCount: 0, scheduledTotal: "405.000" });
  });

  it("cannot be set when a contract is created through the API", async () => {
    const response = await createContract(admin, clientId, { scheduleCutoverDate: now });

    expect(response.status).toBe(400);
    expect((await pool.query("SELECT 1 FROM amc_contracts")).rowCount).toBe(0);
  });

  it("cannot be set, changed or cleared by editing a contract", async () => {
    const { id } = await importedContract();
    const normal = (await createContract(admin, clientId, { systemDescription: "CCTV" })).body.data.id as string;
    const edit = (contractId: string, body: Record<string, unknown>) =>
      api().patch(`/api/amc/contracts/${contractId}`).set(admin.headers).send(body);

    expect((await edit(id, { scheduleCutoverDate: null })).status).toBe(400);
    expect((await edit(id, { scheduleCutoverDate: "2020-01-01" })).status).toBe(400);
    expect((await edit(normal, { scheduleCutoverDate: now })).status).toBe(400);

    // An ordinary edit leaves it as it was.
    expect((await edit(id, { notes: "Checked" })).status).toBe(200);
    const stored = await pool.query<{ id: string; cutover: string | null }>(
      "SELECT id, schedule_cutover_date::text AS cutover FROM amc_contracts ORDER BY id"
    );
    expect(stored.rows).toEqual([
      { id, cutover: now },
      { id: normal, cutover: null },
    ]);
  });

  it("is not a schedule term: the preview ignores a proposed one", async () => {
    const { id, after } = await importedContract();
    const preview = (await get(`/api/amc/contracts/${id}/schedule/preview?scheduleCutoverDate=2000-01-01`)).body.data;

    expect(preview.toCreate).toHaveLength(after.length);
  });
});

describe("historical visit: read-only in the application", () => {
  it("cannot be changed through the schedule route", async () => {
    const { visit1 } = await importedContract();

    for (const body of [{ visitAmount: "1" }, { notes: "Changed" }, { assignedTo: "Someone" }, { scheduledDate: now }]) {
      const response = await api().patch(`/api/amc/visits/${visit1}`).set(admin.headers).send(body);

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/historical record/);
    }
  });

  it("cannot be completed, started, cancelled or annotated through the execution route", async () => {
    const { id, visit1 } = await importedContract();
    const stored = await visitsOf(id);

    for (const body of [
      { status: "COMPLETED", completedDate: now },
      { status: "SCHEDULED" },
      { status: "IN_PROGRESS" },
      { status: "CANCELLED", statusReason: "No longer needed" },
      { workPerformed: "Serviced" },
    ]) {
      const response = await api().patch(`/api/amc/execution/visits/${visit1}`).set(admin.headers).send(body);

      expect(response.status).toBe(409);
    }

    expect(await visitsOf(id)).toEqual(stored);
    expect((await pool.query("SELECT 1 FROM activity_logs WHERE entity_type = 'amc_visits'")).rowCount).toBe(0);
  });

  it("cannot be reached from an operational visit: HISTORICAL is not a status a user can set", async () => {
    const contractId = await activeContract(admin, clientId, { systemDescription: "CCTV" });
    const [visit] = await visitsOf(contractId);
    const response = await api().patch(`/api/amc/execution/visits/${visit?.id}`).set(admin.headers).send({ status: "HISTORICAL" });

    expect(response.status).toBe(400);
    expect((await visitsOf(contractId))[0]?.status).toBe("SCHEDULED");
  });

  it("is left alone when the contract is expired with its open visits cancelled", async () => {
    const { id, after } = await importedContract();
    await setContractStatus(id, { status: "ACTIVE" });

    const response = await setContractStatus(id, { status: "EXPIRED", cancelOpenVisits: true });
    const visits = await visitsOf(id);

    expect(response.body.data.cancelledVisits).toBe(after.length);
    expect(visits.filter((visit) => visit.status === "HISTORICAL")).toHaveLength(2);
    expect(visits.filter((visit) => visit.status === "CANCELLED")).toHaveLength(after.length);
  });

  it("is refused to a user without the permission first, and to a permitted user by the historical rule", async () => {
    const { visit1 } = await importedContract();
    const procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);

    expect((await api().patch(`/api/amc/execution/visits/${visit1}`).set(procurement.headers).send({ status: "IN_PROGRESS" })).status).toBe(403);
    expect((await api().patch(`/api/amc/execution/visits/${visit1}`).set(execution.headers).send({ status: "IN_PROGRESS" })).status).toBe(409);
    expect((await get(`/api/amc/execution/visits/${visit1}`, execution)).body.data.status).toBe("HISTORICAL");
  });
});

describe("historical visit: not due, not overdue, not ready for invoice", () => {
  /** Operational data whose figures must not move, then historical visits on top. */
  async function withHistory() {
    // An active contract with one overdue visit, one completed (ready for invoice) and future ones.
    const operational = await activeContract(admin, clientId, {
      systemDescription: "CCTV",
      validFrom: addDays(now, -40),
      validTo: addDays(now, 100),
      maintenanceFrequency: "MONTHLY",
      defaultVisitAmount: "100.000",
    });
    const [done] = await visitsOf(operational);
    await api().patch(`/api/amc/execution/visits/${done?.id}`).set(admin.headers).send({ status: "COMPLETED", completedDate: now });

    const before = await summary();
    const imported = await importedContract();
    // Two more rows, to cover every case: one dated today (this month, and "due" if it were outstanding) and one without an amount.
    const todayRow = await insertHistoricalVisit(imported.id, { sequenceNo: 20, periodStart: now, periodEnd: addDays(now, 5), visitAmount: "775.000" });
    const second = imported.before[1] as (typeof imported.grid)[number];
    const noAmount = await insertHistoricalVisit(imported.id, { sequenceNo: 21, periodStart: second.periodStart, periodEnd: second.periodEnd, visitAmount: null });

    return { before, imported, todayRow, noAmount, operational };
  }

  it("leaves every figure of the AMC summary exactly as it was", async () => {
    const { before } = await withHistory();
    const after = await summary();

    expect(before.visits).toMatchObject({ due: 1, overdue: 1, completedTotal: 1, historical: 0 });
    expect(before.invoicing.readyForInvoice).toEqual({ count: 1, amount: "100.000" });

    expect(after.visits).toEqual({ ...before.visits, historical: 4 });
    expect(after.invoicing).toEqual(before.invoicing);
    // The imported contract is a draft: it is not counted as active.
    expect(after.contracts).toEqual({ ...before.contracts, draft: before.contracts.draft + 1 });
  });

  it("has the HISTORICAL invoice eligibility whatever its amount", async () => {
    const { imported } = await withHistory();
    const eligibilities = await pool.query<{ visit_amount: string | null; invoice_eligibility: string }>(
      `SELECT v.visit_amount, b.invoice_eligibility
       FROM amc_visits v JOIN v_amc_visit_billing b ON b.amc_visit_id = v.id
       WHERE v.amc_contract_id = $1 ORDER BY v.sequence_no`,
      [imported.id]
    );

    expect(eligibilities.rows).toEqual([
      { visit_amount: "405.000", invoice_eligibility: "HISTORICAL" },
      { visit_amount: "0.000", invoice_eligibility: "HISTORICAL" },
      { visit_amount: "775.000", invoice_eligibility: "HISTORICAL" },
      { visit_amount: null, invoice_eligibility: "HISTORICAL" },
    ]);
  });

  it("is in none of the execution work lists, and is visible under all visits", async () => {
    await withHistory();
    const statuses = async (scope: string) =>
      ((await get(`/api/amc/execution/visits?scope=${scope}&days=366`)).body.data.items as { status: string }[]).map((item) => item.status);

    for (const scope of ["due", "upcoming", "open", "completed"]) {
      expect(await statuses(scope)).not.toContain("HISTORICAL");
    }
    expect((await statuses("all")).filter((status) => status === "HISTORICAL")).toHaveLength(4);
  });

  it("is listed in the schedule as historical: never overdue, never ready for invoice", async () => {
    const { imported } = await withHistory();
    const list = async (query: string) =>
      (await get(`/api/amc/visits?contractId=${imported.id}&${query}`)).body.data.items as {
        status: string;
        isOverdue: boolean;
        invoiceEligibility: string;
      }[];

    const all = await list("");

    expect(all).toHaveLength(4);
    expect(all.every((visit) => visit.status === "HISTORICAL" && !visit.isOverdue && visit.invoiceEligibility === "HISTORICAL")).toBe(true);
    expect(await list("overdue=true")).toEqual([]);
    expect(await list("invoiceEligibility=READY_FOR_INVOICE")).toEqual([]);
    expect(await list("invoiceEligibility=AMOUNT_REQUIRED")).toEqual([]);
    expect(await list("status=HISTORICAL")).toHaveLength(4);
    expect(await list("invoiceEligibility=HISTORICAL")).toHaveLength(4);
  });

  it("leaves the overdue and ready-for-invoice lists of the whole schedule to the operational visits", async () => {
    const { operational } = await withHistory();
    const contracts = async (query: string) =>
      [...new Set(((await get(`/api/amc/visits?${query}`)).body.data.items as { contract: { id: string } }[]).map((item) => item.contract.id))];

    expect(await contracts("overdue=true")).toEqual([operational]);
    expect(await contracts("invoiceEligibility=READY_FOR_INVOICE")).toEqual([operational]);
  });
});

describe("operational visits are unchanged", () => {
  it("schedules, starts, completes and reopens a visit as before", async () => {
    const contractId = await activeContract(admin, clientId);
    const [visit] = await visitsOf(contractId);
    const execute = (body: Record<string, unknown>) => api().patch(`/api/amc/execution/visits/${visit?.id}`).set(admin.headers).send(body);

    expect(await visitsOf(contractId)).toHaveLength(4);
    expect((await execute({ status: "IN_PROGRESS" })).body.data.status).toBe("IN_PROGRESS");
    expect((await execute({ status: "COMPLETED", completedDate: now })).body.data).toMatchObject({ status: "COMPLETED", completedDate: now });
    expect((await get(`/api/amc/visits/${visit?.id}`)).body.data.invoiceEligibility).toBe("READY_FOR_INVOICE");
    expect((await execute({ status: "SCHEDULED" })).body.data).toMatchObject({ status: "SCHEDULED", completedDate: null });
    expect((await api().patch(`/api/amc/visits/${visit?.id}`).set(admin.headers).send({ visitAmount: "410" })).body.data.visitAmount).toBe("410.000");
  });
});
