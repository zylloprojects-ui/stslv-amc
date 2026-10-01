import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import {
  activeContract,
  contractBody,
  createClient,
  createContract,
  grant,
  logsFor,
  visitsOf,
  type Session,
} from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

let admin: Session;
let accountant: Session;
let execution: Session;
let procurement: Session;
let hotelOne: string;
let hotelTwo: string;

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  hotelOne = await createClient(admin, "Test Hotel One");
  hotelTwo = await createClient(admin, "Test Hotel Two");
});
afterAll(closePool);

const get = (id: string, session: Session = admin) => api().get(`/api/amc/contracts/${id}`).set(session.headers);
const patch = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().patch(`/api/amc/contracts/${id}`).set(session.headers).send(body);
const setStatus = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().post(`/api/amc/contracts/${id}/status`).set(session.headers).send(body);
const complete = (visitId: string) =>
  api().patch(`/api/amc/execution/visits/${visitId}`).set(admin.headers).send({ status: "COMPLETED", completedDate: "2026-01-05" });

describe("create contract", () => {
  it("saves a draft contract against an existing client and records who created it", async () => {
    const response = await createContract(admin, hotelOne, { description: "  Fire alarm and fire fighting  ", notes: "" });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      client: { id: hotelOne, name: "Test Hotel One", isActive: true },
      responsibleEngineer: "Test Engineer",
      validFrom: "2027-01-01",
      validTo: "2027-12-31",
      systemDescription: "FIRE",
      description: "Fire alarm and fire fighting",
      contractValue: "1620.000",
      finalCredit: null,
      maintenanceFrequency: "QUARTERLY",
      defaultVisitAmount: "405.000",
      status: "DRAFT",
      notes: null,
      scheduleChange: null,
    });
    // No contract number and no client code are invented.
    expect(response.body.data).not.toHaveProperty("contractNumber");

    const id = response.body.data.id;
    const stored = await pool.query(
      "SELECT client_id, status, created_by, updated_by, valid_from::text AS valid_from FROM amc_contracts WHERE id = $1",
      [id]
    );
    expect(stored.rows[0]).toEqual({ client_id: hotelOne, status: "DRAFT", created_by: admin.id, updated_by: admin.id, valid_from: "2027-01-01" });

    // A draft has no schedule.
    expect(await visitsOf(id)).toEqual([]);
    expect(await logsFor("amc_contracts", id)).toMatchObject([
      { action: "amc_contract.created", user_id: admin.id, module: "AMC_CONTRACTS" },
    ]);
  });

  it("requires only the client, validity, system, contract value and frequency", async () => {
    const response = await api().post("/api/amc/contracts").set(admin.headers).send({
      clientId: hotelOne,
      validFrom: "2027-01-01",
      validTo: "2027-12-31",
      systemDescription: "CCTV",
      contractValue: "600",
      maintenanceFrequency: "QUARTERLY",
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      responsibleEngineer: null,
      description: null,
      finalCredit: null,
      defaultVisitAmount: null,
      contractValue: "600.000",
    });
  });

  it("does not copy client details onto the contract", async () => {
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'amc_contracts'"
    );
    const names = columns.rows.map((row) => row.column_name);

    expect(names).toContain("client_id");
    expect(names.filter((name) => name.includes("client") && name !== "client_id")).toEqual([]);
    expect(names).not.toContain("contract_number");
  });
});

describe("money", () => {
  it("keeps three decimal places exactly, in the database and in the response", async () => {
    const response = await createContract(admin, hotelTwo, {
      contractValue: "1234.567",
      finalCredit: "9876.543",
      defaultVisitAmount: "33.333",
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ contractValue: "1234.567", finalCredit: "9876.543", defaultVisitAmount: "33.333" });

    const stored = await pool.query(
      "SELECT contract_value::text AS contract_value, final_credit::text AS final_credit, default_visit_amount::text AS default_visit_amount FROM amc_contracts WHERE id = $1",
      [response.body.data.id]
    );
    expect(stored.rows[0]).toEqual({ contract_value: "1234.567", final_credit: "9876.543", default_visit_amount: "33.333" });
  });

  it("stores money as numeric(…,3), never as a floating-point type", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string; numeric_scale: number }>(
      `SELECT table_name, column_name, data_type, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN ('amc_contracts', 'amc_visits')
         AND column_name IN ('contract_value', 'final_credit', 'default_visit_amount', 'visit_amount')
       ORDER BY table_name, column_name`
    );

    expect(columns.rows).toHaveLength(4);
    for (const column of columns.rows) {
      expect(column, column.column_name).toMatchObject({ data_type: "numeric", numeric_scale: 3 });
    }
  });

  it("writes whole and short amounts with three decimals", async () => {
    const response = await createContract(admin, hotelTwo, { contractValue: "0012345", finalCredit: "9876.5", defaultVisitAmount: "0" });

    expect(response.body.data).toMatchObject({ contractValue: "12345.000", finalCredit: "9876.500", defaultVisitAmount: "0.000" });
  });

  it("rejects amounts sent as numbers, with more than three decimals, or negative", async () => {
    const asNumber = await createContract(admin, hotelOne, { contractValue: 1620.5 });
    const fourDecimals = await createContract(admin, hotelOne, { contractValue: "1620.1234" });
    const negative = await createContract(admin, hotelOne, { defaultVisitAmount: "-1" });
    const notMoney = await createContract(admin, hotelOne, { finalCredit: "1,620.000" });

    for (const [response, field] of [
      [asNumber, "contractValue"],
      [fourDecimals, "contractValue"],
      [negative, "defaultVisitAmount"],
      [notMoney, "finalCredit"],
    ] as const) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(response.body.error.details[0].field).toBe(field);
    }
  });

  it("treats Final Credit as a neutral value: it changes no figure", async () => {
    const withCredit = await activeContract(admin, hotelOne, { contractValue: "1000.000", finalCredit: "800.000", systemDescription: "Automation A" });
    const withoutCredit = await activeContract(admin, hotelOne, { contractValue: "1000.000", systemDescription: "Automation B" });

    const a = (await get(withCredit)).body.data;
    const b = (await get(withoutCredit)).body.data;

    expect(a.finalCredit).toBe("800.000");
    expect(b.finalCredit).toBeNull();
    expect(a.schedule).toEqual(b.schedule);
    expect((await visitsOf(withCredit)).map((visit) => visit.visit_amount)).toEqual(
      (await visitsOf(withoutCredit)).map((visit) => visit.visit_amount)
    );
  });
});

describe("validation", () => {
  it("rejects missing and malformed fields with field-level messages", async () => {
    const response = await api().post("/api/amc/contracts").set(admin.headers).send({ clientId: hotelOne });

    expect(response.status).toBe(400);
    expect(response.body.error.details.map((detail: { field: string }) => detail.field).sort()).toEqual([
      "contractValue",
      "maintenanceFrequency",
      "systemDescription",
      "validFrom",
      "validTo",
    ]);
  });

  it.each([
    ["an unknown client", { clientId: "999999" }, "clientId"],
    ["an impossible date", { validFrom: "2027-02-30" }, "validFrom"],
    ["an end before the start", { validFrom: "2027-06-01", validTo: "2027-05-31" }, "validTo"],
    ["a validity longer than the safety limit", { validFrom: "2027-01-01", validTo: "2037-01-01" }, "validTo"],
    ["an unknown frequency", { maintenanceFrequency: "WEEKLY" }, "maintenanceFrequency"],
    ["a blank system", { systemDescription: "   " }, "systemDescription"],
    ["a status that cannot be set at creation", { status: "EXPIRED" }, "status"],
  ])("rejects %s", async (_label, overrides, field) => {
    const response = await createContract(admin, hotelOne, overrides);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe(field);
  });

  it("rejects unknown fields, such as a client name typed onto the contract", async () => {
    const response = await createContract(admin, hotelOne, { clientName: "Test Hotel One" });

    expect(response.status).toBe(400);
  });

  it("refuses an inactive client", async () => {
    const inactive = await createClient(admin, "Closed Hotel");
    await api().post(`/api/clients/${inactive}/deactivate`).set(admin.headers);

    const response = await createContract(admin, inactive);

    expect(response.status).toBe(400);
    expect(response.body.error.details).toEqual([
      { field: "clientId", message: "An inactive client cannot be selected. Reactivate the client first." },
    ]);
  });

  it("is also enforced by the database", async () => {
    const insert = (values: string) =>
      pool.query(
        `INSERT INTO amc_contracts (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency)
         VALUES ($1, ${values})`,
        [hotelOne]
      );

    await expect(insert("'2027-06-01', '2027-05-31', 'FIRE', 100, 'QUARTERLY'")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("'2027-01-01', '2027-12-31', 'FIRE', -1, 'QUARTERLY'")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("'2027-01-01', '2027-12-31', 'FIRE', 100, 'WEEKLY'")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("'2027-01-01', '2027-12-31', '  ', 100, 'QUARTERLY'")).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "INSERT INTO amc_contracts (client_id, valid_from, valid_to, system_description, contract_value, maintenance_frequency) VALUES (999999, '2027-01-01', '2027-12-31', 'FIRE', 100, 'QUARTERLY')"
      )
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("schedule generation", () => {
  it.each([
    ["MONTHLY", 12, "2027-02-01"],
    ["QUARTERLY", 4, "2027-04-01"],
    ["HALF_YEARLY", 2, "2027-07-01"],
    ["ANNUALLY", 1, undefined],
  ] as const)("generates one dated visit row per %s period", async (frequency, count, second) => {
    const id = await activeContract(admin, hotelOne, { maintenanceFrequency: frequency, systemDescription: `GEN ${frequency}` });
    const visits = await visitsOf(id);

    expect(visits).toHaveLength(count);
    expect(visits[0]).toMatchObject({
      sequence_no: 1,
      period_start: "2027-01-01",
      scheduled_date: "2027-01-01",
      original_scheduled_date: "2027-01-01",
      status: "SCHEDULED",
      visit_amount: "405.000",
      amount_is_custom: false,
    });
    expect(visits[1]?.period_start).toBe(second);
    expect(visits.at(-1)?.period_end).toBe("2027-12-31");
    expect(visits.map((visit) => visit.sequence_no)).toEqual(visits.map((_visit, index) => index + 1));
  });

  it("supports a five-year contract", async () => {
    const id = await activeContract(admin, hotelOne, { validTo: "2031-12-31", systemDescription: "FIVE YEAR" });
    const visits = await visitsOf(id);

    expect(visits).toHaveLength(20);
    expect(visits.at(-1)).toMatchObject({ period_start: "2031-10-01", period_end: "2031-12-31" });
  });

  it("creates no visit after the validity ends", async () => {
    const id = await activeContract(admin, hotelOne, { validFrom: "2027-01-15", validTo: "2027-08-10", systemDescription: "BOUNDARY" });
    const visits = await visitsOf(id);

    expect(visits.map((visit) => [visit.period_start, visit.period_end])).toEqual([
      ["2027-01-15", "2027-04-14"],
      ["2027-04-15", "2027-07-14"],
      ["2027-07-15", "2027-08-10"],
    ]);
    expect(visits.every((visit) => visit.scheduled_date <= "2027-08-10" && visit.scheduled_date >= "2027-01-15")).toBe(true);
  });

  it("generates visits without an amount when the contract has no default", async () => {
    const id = await activeContract(admin, hotelOne, { defaultVisitAmount: null, systemDescription: "NO DEFAULT" });
    const contract = (await get(id)).body.data;

    expect((await visitsOf(id)).map((visit) => visit.visit_amount)).toEqual([null, null, null, null]);
    expect(contract.schedule).toMatchObject({ visitCount: 4, amountMissingCount: 4, scheduledTotal: "0.000" });
  });

  it("does not force contract value to equal the visit total", async () => {
    // 1000 is not 4 x 405: the contract is accepted and the difference is reported, not corrected.
    const id = await activeContract(admin, hotelOne, { contractValue: "1000.000", systemDescription: "UNEVEN" });
    const contract = (await get(id)).body.data;

    expect(contract.contractValue).toBe("1000.000");
    expect(contract.schedule).toMatchObject({ scheduledTotal: "1620.000", valueDifference: "-620.000" });
  });

  it("generates the schedule when a draft is activated, and logs it", async () => {
    const draft = await createContract(admin, hotelTwo, { systemDescription: "ACTIVATE" });
    const id = draft.body.data.id;

    const activated = await setStatus(id, { status: "ACTIVE" });

    expect(activated.status).toBe(200);
    expect(activated.body.data).toMatchObject({ status: "ACTIVE", scheduleChange: { created: 4, removed: 0, kept: 0 } });
    expect(await visitsOf(id)).toHaveLength(4);
    expect((await logsFor("amc_contracts", id)).map((log) => log.action)).toEqual([
      "amc_contract.created",
      "amc_contract.schedule_generated",
      "amc_contract.status_changed",
    ]);
  });

  it("never duplicates visits when generation is repeated", async () => {
    const id = await activeContract(admin, hotelTwo, { systemDescription: "REPEAT" });
    const before = await visitsOf(id);

    const first = await api().post(`/api/amc/contracts/${id}/schedule/generate`).set(admin.headers);
    const [second, third] = await Promise.all([
      api().post(`/api/amc/contracts/${id}/schedule/generate`).set(admin.headers),
      api().post(`/api/amc/contracts/${id}/schedule/generate`).set(admin.headers),
    ]);

    expect(first.body.data.scheduleChange).toEqual({ created: 0, removed: 0, kept: 4 });
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(await visitsOf(id)).toEqual(before);
  });

  it("refuses a duplicate period at the database level", async () => {
    const id = await activeContract(admin, hotelTwo, { systemDescription: "DB GUARD" });

    await expect(
      pool.query(
        "INSERT INTO amc_visits (amc_contract_id, sequence_no, period_start, period_end, original_scheduled_date, scheduled_date) VALUES ($1, 99, '2027-01-01', '2027-03-31', '2027-01-01', '2027-01-01')",
        [id]
      )
    ).rejects.toMatchObject({ code: "23505", constraint: "amc_visits_period_uq" });
  });

  it("generates no schedule for a contract that is not active", async () => {
    const draft = await createContract(admin, hotelTwo, { systemDescription: "DRAFT ONLY" });
    const response = await api().post(`/api/amc/contracts/${draft.body.data.id}/schedule/generate`).set(admin.headers);

    expect(response.status).toBe(409);
    expect(await visitsOf(draft.body.data.id)).toEqual([]);
  });

  it("previews the schedule without changing anything", async () => {
    const draft = await createContract(admin, hotelTwo, { systemDescription: "PREVIEW" });
    const id = draft.body.data.id;

    const stored = await api().get(`/api/amc/contracts/${id}/schedule/preview`).set(admin.headers);
    const proposed = await api()
      .get(`/api/amc/contracts/${id}/schedule/preview`)
      .query({ maintenanceFrequency: "MONTHLY", validTo: "2027-06-30" })
      .set(admin.headers);

    expect(stored.body.data).toMatchObject({ canApply: true, maintenanceFrequency: "QUARTERLY", keptCount: 0, toRemove: [] });
    expect(stored.body.data.toCreate).toHaveLength(4);
    expect(stored.body.data.toCreate[0]).toEqual({
      periodStart: "2027-01-01",
      periodEnd: "2027-03-31",
      scheduledDate: "2027-01-01",
      visitAmount: "405.000",
    });
    expect(proposed.body.data.toCreate).toHaveLength(6);
    expect(await visitsOf(id)).toEqual([]);
  });
});

describe("regenerating a schedule safely", () => {
  it("adds visits when the validity is extended and keeps the existing ones", async () => {
    const id = await activeContract(admin, hotelOne, { systemDescription: "EXTEND" });
    const before = await visitsOf(id);

    const response = await patch(id, { validTo: "2028-06-30" });

    expect(response.status).toBe(200);
    expect(response.body.data.scheduleChange).toEqual({ created: 2, removed: 0, kept: 4 });

    const after = await visitsOf(id);
    expect(after.slice(0, 4)).toEqual(before);
    expect(after.slice(4).map((visit) => [visit.sequence_no, visit.period_start])).toEqual([
      [5, "2028-01-01"],
      [6, "2028-04-01"],
    ]);
  });

  it("removes only untouched visits when the validity is shortened", async () => {
    const id = await activeContract(admin, hotelOne, { systemDescription: "SHORTEN" });

    const response = await patch(id, { validTo: "2027-06-30" });

    expect(response.body.data.scheduleChange).toEqual({ created: 0, removed: 2, kept: 2 });
    expect((await visitsOf(id)).map((visit) => visit.period_start)).toEqual(["2027-01-01", "2027-04-01"]);

    const log = (await logsFor("amc_contracts", id)).find((entry) => entry.action === "amc_contract.schedule_generated" && (entry.metadata?.removed as unknown[]).length > 0);
    expect(log?.metadata?.removed).toMatchObject([{ periodStart: "2027-07-01" }, { periodStart: "2027-10-01" }]);
  });

  it("refuses to shorten the validity past a completed visit, and changes nothing", async () => {
    const id = await activeContract(admin, hotelOne, { validFrom: "2025-01-01", validTo: "2025-12-31", systemDescription: "BLOCK" });
    const visits = await visitsOf(id);
    await complete(visits[3]?.id as string);

    const response = await patch(id, { validTo: "2025-06-30" });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("2025-10-01");
    // Rolled back as a whole: neither the contract nor any visit changed.
    expect((await get(id)).body.data.validTo).toBe("2025-12-31");
    expect(await visitsOf(id)).toHaveLength(4);
  });

  it("keeps completed, in-progress, edited and cancelled visits when the frequency changes", async () => {
    const id = await activeContract(admin, hotelOne, { validFrom: "2025-01-01", validTo: "2025-12-31", systemDescription: "FREQUENCY" });
    const [first, second, third, fourth] = await visitsOf(id);

    await complete(first?.id as string);
    await api().patch(`/api/amc/visits/${second?.id}`).set(admin.headers).send({ visitAmount: "999.000" });
    await api().patch(`/api/amc/execution/visits/${third?.id}`).set(admin.headers).send({ status: "CANCELLED", statusReason: "Site closed" });

    const response = await patch(id, { maintenanceFrequency: "HALF_YEARLY" });

    expect(response.status).toBe(200);
    // Only the untouched fourth visit is removed; no half-year period is scheduled twice.
    expect(response.body.data.scheduleChange).toEqual({ created: 0, removed: 1, kept: 3 });

    const after = await visitsOf(id);
    expect(after.map((visit) => visit.id)).toEqual([first?.id, second?.id, third?.id]);
    expect(after.map((visit) => visit.id)).not.toContain(fourth?.id);
    expect(after[0]).toMatchObject({ status: "COMPLETED", completed_date: "2026-01-05", visit_amount: "405.000" });
    expect(after[1]).toMatchObject({ status: "SCHEDULED", visit_amount: "999.000", amount_is_custom: true });
    expect(after[2]).toMatchObject({ status: "CANCELLED" });
  });

  it("refuses to move the start date once a visit has been worked on", async () => {
    const id = await activeContract(admin, hotelOne, { validFrom: "2025-01-01", validTo: "2025-12-31", systemDescription: "START" });
    await complete((await visitsOf(id))[0]?.id as string);

    const response = await patch(id, { validFrom: "2025-02-01" });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain("Valid from cannot be changed");
    expect((await visitsOf(id)).map((visit) => visit.period_start)).toEqual(["2025-01-01", "2025-04-01", "2025-07-01", "2025-10-01"]);
  });

  it("regenerates everything when the start date moves and nothing has been worked on", async () => {
    const id = await activeContract(admin, hotelOne, { systemDescription: "MOVE START" });

    const response = await patch(id, { validFrom: "2027-02-01", validTo: "2028-01-31" });

    expect(response.body.data.scheduleChange).toEqual({ created: 4, removed: 4, kept: 0 });
    const visits = await visitsOf(id);
    expect(visits.map((visit) => visit.period_start)).toEqual(["2027-02-01", "2027-05-01", "2027-08-01", "2027-11-01"]);
    // The removed visits were untouched, so their numbers are simply issued again.
    expect(visits.map((visit) => visit.sequence_no)).toEqual([1, 2, 3, 4]);
  });

  it("does not change existing visit amounts when the default visit amount changes", async () => {
    const id = await activeContract(admin, hotelOne, { systemDescription: "DEFAULT CHANGE" });

    const response = await patch(id, { defaultVisitAmount: "500.000", validTo: "2028-03-31" });

    expect(response.status).toBe(200);
    expect((await visitsOf(id)).map((visit) => visit.visit_amount)).toEqual(["405.000", "405.000", "405.000", "405.000", "500.000"]);
  });
});

describe("update contract", () => {
  it("changes only the supplied fields and logs what changed", async () => {
    const created = await createContract(admin, hotelOne, { systemDescription: "UPDATE ME", notes: "keep" });
    const id = created.body.data.id;

    const response = await patch(id, { responsibleEngineer: "New Engineer", contractValue: "2000", finalCredit: "1800.5" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      responsibleEngineer: "New Engineer",
      contractValue: "2000.000",
      finalCredit: "1800.500",
      notes: "keep",
      systemDescription: "UPDATE ME",
    });

    const logs = await logsFor("amc_contracts", id);
    expect(logs.map((log) => log.action)).toEqual(["amc_contract.created", "amc_contract.updated"]);
    expect(logs[1]?.metadata).toEqual({
      changes: {
        responsibleEngineer: { from: "Test Engineer", to: "New Engineer" },
        contractValue: { from: "1620.000", to: "2000.000" },
        finalCredit: { from: null, to: "1800.500" },
      },
    });
  });

  it("does not log when nothing changed, including the same amount written differently", async () => {
    const created = await createContract(admin, hotelOne, { systemDescription: "NO CHANGE" });
    const id = created.body.data.id;

    await patch(id, { contractValue: "1620", systemDescription: "NO CHANGE" });

    expect((await logsFor("amc_contracts", id)).map((log) => log.action)).toEqual(["amc_contract.created"]);
  });

  it("can move a contract to another active client, and clears optional fields", async () => {
    const created = await createContract(admin, hotelOne, { systemDescription: "MOVE CLIENT", finalCredit: "100" });
    const response = await patch(created.body.data.id, { clientId: hotelTwo, finalCredit: "", responsibleEngineer: null });

    expect(response.body.data).toMatchObject({ client: { id: hotelTwo, name: "Test Hotel Two" }, finalCredit: null, responsibleEngineer: null });
  });

  it("rejects an empty update, an invalid value, a status change and an unknown contract", async () => {
    const created = await createContract(admin, hotelOne, { systemDescription: "REJECT" });
    const id = created.body.data.id;

    expect((await patch(id, {})).status).toBe(400);
    expect((await patch(id, { validTo: "2026-01-01" })).status).toBe(400);
    expect((await patch(id, { status: "ACTIVE" })).status).toBe(400);
    expect((await patch("999999", { notes: "x" })).status).toBe(404);
    expect((await get("abc")).status).toBe(404);
  });
});

describe("contract status", () => {
  it("follows the allowed transitions and refuses the others", async () => {
    const created = await createContract(admin, hotelTwo, { systemDescription: "STATUS" });
    const id = created.body.data.id;

    expect((await setStatus(id, { status: "EXPIRED" })).status).toBe(409);
    expect((await setStatus(id, { status: "ACTIVE" })).body.data.status).toBe("ACTIVE");
    expect((await setStatus(id, { status: "DRAFT" })).status).toBe(409);
    expect((await setStatus(id, { status: "EXPIRED" })).body.data.status).toBe("EXPIRED");
    expect((await setStatus(id, { status: "CANCELLED" })).status).toBe(409);
    expect((await setStatus(id, { status: "ACTIVE" })).body.data).toMatchObject({ status: "ACTIVE", scheduleChange: { created: 0, removed: 0, kept: 4 } });
    expect((await setStatus(id, { status: "PAUSED" })).status).toBe(400);
  });

  it("leaves the visits alone when a contract expires or is cancelled, unless asked", async () => {
    const id = await activeContract(admin, hotelTwo, { systemDescription: "EXPIRE" });

    const response = await setStatus(id, { status: "EXPIRED" });

    expect(response.body.data).toMatchObject({ status: "EXPIRED", cancelledVisits: 0 });
    expect((await visitsOf(id)).map((visit) => visit.status)).toEqual(["SCHEDULED", "SCHEDULED", "SCHEDULED", "SCHEDULED"]);
  });

  it("cancels the open visits on request, but never completed or in-progress work", async () => {
    const id = await activeContract(admin, hotelTwo, { validFrom: "2025-01-01", validTo: "2025-12-31", systemDescription: "CANCEL" });
    const [first, second] = await visitsOf(id);
    await complete(first?.id as string);
    await api().patch(`/api/amc/execution/visits/${second?.id}`).set(admin.headers).send({ status: "IN_PROGRESS" });

    const response = await setStatus(id, { status: "CANCELLED", cancelOpenVisits: true, reason: "Client ended the agreement" });

    expect(response.body.data).toMatchObject({ status: "CANCELLED", cancelledVisits: 2 });
    expect((await visitsOf(id)).map((visit) => visit.status)).toEqual(["COMPLETED", "IN_PROGRESS", "CANCELLED", "CANCELLED"]);

    const reasons = await pool.query<{ status_reason: string }>(
      "SELECT status_reason FROM amc_visits WHERE amc_contract_id = $1 AND status = 'CANCELLED'",
      [id]
    );
    expect(reasons.rows.map((row) => row.status_reason)).toEqual(["Client ended the agreement", "Client ended the agreement"]);
  });

  it("does not allow the terms of an expired contract to be edited", async () => {
    const id = await activeContract(admin, hotelTwo, { systemDescription: "EXPIRED EDIT" });
    await setStatus(id, { status: "EXPIRED" });

    expect((await patch(id, { validTo: "2028-12-31" })).status).toBe(409);
    expect((await patch(id, { notes: "Still editable" })).status).toBe(200);
  });

  it("reports that the validity has ended without changing the status", async () => {
    const id = await activeContract(admin, hotelTwo, { validFrom: "2024-01-01", validTo: "2024-12-31", systemDescription: "PAST" });
    const contract = (await get(id)).body.data;

    expect(contract).toMatchObject({ status: "ACTIVE", isPastValidity: true });
  });
});

describe("read contracts", () => {
  it("lists contracts with client, search, filters and paging", async () => {
    const all = await api().get("/api/amc/contracts").query({ pageSize: 100 }).set(admin.headers);
    const byClient = await api().get("/api/amc/contracts").query({ clientId: hotelTwo, pageSize: 100 }).set(admin.headers);
    const drafts = await api().get("/api/amc/contracts").query({ status: "DRAFT", pageSize: 100 }).set(admin.headers);
    const monthly = await api().get("/api/amc/contracts").query({ frequency: "MONTHLY" }).set(admin.headers);
    const search = await api().get("/api/amc/contracts").query({ search: "five year" }).set(admin.headers);
    const wildcard = await api().get("/api/amc/contracts").query({ search: "%" }).set(admin.headers);
    const paged = await api().get("/api/amc/contracts").query({ page: 2, pageSize: 5 }).set(admin.headers);

    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(all.body.data.items.length);
    expect(byClient.body.data.items.every((item: { client: { name: string } }) => item.client.name === "Test Hotel Two")).toBe(true);
    expect(byClient.body.data.total).toBeGreaterThan(0);
    expect(drafts.body.data.items.every((item: { status: string }) => item.status === "DRAFT")).toBe(true);
    expect(monthly.body.data.items.map((item: { systemDescription: string }) => item.systemDescription)).toEqual(["GEN MONTHLY"]);
    expect(search.body.data.items.map((item: { systemDescription: string }) => item.systemDescription)).toEqual(["FIVE YEAR"]);
    expect(wildcard.body.data.total).toBe(0);
    expect(paged.body.data).toMatchObject({ page: 2, pageSize: 5, total: all.body.data.total });
    expect(paged.body.data.items).toHaveLength(5);
    expect((await api().get("/api/amc/contracts").query({ status: "OPEN" }).set(admin.headers)).status).toBe(400);
  });

  it("includes the schedule figures of each contract", async () => {
    const response = await api().get("/api/amc/contracts").query({ search: "FIVE YEAR" }).set(admin.headers);

    expect(response.body.data.items[0].schedule).toEqual({
      visitCount: 20,
      completedCount: 0,
      openCount: 20,
      historicalCount: 0,
      cancelledCount: 0,
      amountMissingCount: 0,
      scheduledTotal: "8100.000",
      valueDifference: "-6480.000",
    });
  });

  it("suggests the systems already in use, once each", async () => {
    await createContract(admin, hotelOne, { systemDescription: "cctv" });
    const response = await api().get("/api/amc/contracts/systems").set(admin.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.filter((system: string) => system.toLowerCase() === "cctv")).toHaveLength(1);
    expect(response.body.data).toContain("FIRE");
  });
});

describe("contract permissions", () => {
  it("requires a signed-in user", async () => {
    expect((await api().get("/api/amc/contracts")).status).toBe(401);
    expect((await api().post("/api/amc/contracts").send(contractBody(hotelOne))).status).toBe(401);
  });

  it("lets view-only roles read contracts but change nothing", async () => {
    const created = await createContract(admin, hotelOne, { systemDescription: "PERMISSIONS" });
    const id = created.body.data.id;

    for (const session of [accountant, execution]) {
      expect((await api().get("/api/amc/contracts").set(session.headers)).status).toBe(200);
      expect((await get(id, session)).status).toBe(200);
      expect((await api().get(`/api/amc/contracts/${id}/schedule/preview`).set(session.headers)).status).toBe(200);

      const attempts = [
        await createContract(session, hotelOne),
        await patch(id, { notes: "Not allowed" }, session),
        await setStatus(id, { status: "ACTIVE" }, session),
        await api().post(`/api/amc/contracts/${id}/schedule/generate`).set(session.headers),
      ];

      for (const response of attempts) {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("FORBIDDEN");
      }
    }

    expect((await get(id)).body.data).toMatchObject({ status: "DRAFT", notes: null });
  });

  it("gives a role without AMC access nothing", async () => {
    for (const path of ["/api/amc/contracts", "/api/amc/contracts/systems", "/api/amc/visits", "/api/amc/execution/visits", "/api/amc/summary"]) {
      expect((await api().get(path).set(procurement.headers)).status, path).toBe(403);
    }
  });

  it("checks each action separately: EDIT does not allow creating or cancelling", async () => {
    await grant("ACCOUNTANT", [["AMC_CONTRACTS", "EDIT"]]);
    const id = await activeContract(admin, hotelOne, { systemDescription: "EDIT ONLY" });

    expect((await patch(id, { notes: "Edited" }, accountant)).status).toBe(200);
    expect((await createContract(accountant, hotelOne)).status).toBe(403);
    expect((await setStatus(id, { status: "CANCELLED" }, accountant)).status).toBe(403);
    expect((await setStatus(id, { status: "EXPIRED" }, accountant)).status).toBe(200);
    expect((await get(id)).body.data.status).toBe("EXPIRED");
  });
});
