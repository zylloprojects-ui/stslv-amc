import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { HEADER_ROW } from "../src/shared/export/excel";
import { activeContract, contractBody, createClient, grant, logsFor, today, visitsOf, type Session, type VisitRecord } from "./amc-helpers";
import { api, closePool, resetData, signedIn } from "./helpers";

// The Service Status page (/api/amc/service-status): one row per scheduled
// visit, read from amc_visits. Every record here is invented.
//
// The report number column comes from migration 0077 (in migrations/ since
// 2026-10-28), so the test schema always has it.

let admin: Session;
let execution: Session; // AMC_SCHEDULE:VIEW, AMC_EXECUTION:VIEW/EDIT, no APPROVE, no EXPORT
let accountant: Session; // AMC_SCHEDULE:VIEW only
let procurement: Session; // no AMC access
let hotelOne: string;
let hotelTwo: string;
let engineerId: string;
let systemTypeId: string;
let fire: string; // hotel one, quarterly, next year, linked to the engineer and system type
let cctv: string; // hotel two, monthly Jan-Jun next year
let ended: string; // hotel one, monthly, ended two years ago: waiting for renewal
let fireVisits: VisitRecord[];
let year: number;

const list = (query: Record<string, unknown> = {}, session: Session = admin) =>
  api().get("/api/amc/service-status").query(query).set(session.headers);
const save = (id: string, body: Record<string, unknown>, session: Session = execution) =>
  api().patch(`/api/amc/service-status/${id}`).set(session.headers).send(body);
const exportAs = (query: Record<string, unknown>, session: Session = admin) =>
  api().get("/api/amc/service-status/export").query(query).responseType("blob").set(session.headers);

/** The row of one visit as the page lists it (every filter off). */
async function rowOf(id: string, session: Session = admin) {
  const response = await list({ pageSize: 200 }, session);

  return (response.body.data.items as { id: string; updatedAt: string; serviceStatus: string; reportNumber: string | null; completedDate: string | null }[]).find(
    (item) => item.id === id
  );
}

async function storedVisits() {
  return (await pool.query("SELECT id, status, completed_date::text AS completed_date, updated_at FROM amc_visits ORDER BY id")).rows;
}

beforeAll(async () => {
  await resetData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  year = Number((await today()).slice(0, 4));
  hotelOne = await createClient(admin, "Service Hotel One");
  hotelTwo = await createClient(admin, "Service Hotel Two");
  engineerId = (await api().post("/api/masters/sales-engineers").set(admin.headers).send({ name: "Sara Sales" })).body.data.id;
  systemTypeId = (await api().post("/api/masters/system-types").set(admin.headers).send({ code: "FA", name: "Fire Alarm" })).body.data.id;

  fire = await activeContract(admin, hotelOne, {
    validFrom: `${year + 1}-01-01`,
    validTo: `${year + 1}-12-31`,
    salesEngineerId: engineerId,
  });
  await api().put(`/api/amc/contracts/${fire}/masters`).set(admin.headers).send({ systemTypeId });
  cctv = await activeContract(admin, hotelTwo, {
    systemDescription: "CCTV",
    validFrom: `${year + 1}-01-01`,
    validTo: `${year + 1}-06-30`,
    maintenanceFrequency: "MONTHLY",
    contractValue: "900.000",
    defaultVisitAmount: "150.000",
  });
  ended = await activeContract(admin, hotelOne, {
    systemDescription: "PUMPS",
    validFrom: `${year - 2}-01-01`,
    validTo: `${year - 2}-03-31`,
    maintenanceFrequency: "MONTHLY",
    contractValue: "300.000",
    defaultVisitAmount: "100.000",
  });
  fireVisits = await visitsOf(fire);
  // One cancelled CCTV visit: it is not a service on this page.
  await pool.query("UPDATE amc_visits SET status = 'CANCELLED' WHERE id = $1", [(await visitsOf(cctv))[5]?.id]);
});
// The schema is left as the migrations built it: service_report_no comes from 0077, and later files (Accounts) need it.
afterAll(closePool);

describe("listing", () => {
  it("lists one row per scheduled visit, never one per contract", async () => {
    const response = await list({ pageSize: 200 });

    expect(response.status).toBe(200);
    // 4 quarterly + 5 monthly (one cancelled, left out) + 3 ended monthly.
    expect(response.body.data.total).toBe(12);
    expect(response.body.data.items).toHaveLength(12);
    expect(new Set(response.body.data.items.map((item: { id: string }) => item.id)).size).toBe(12);
    expect(response.body.data.reportNumberAvailable).toBe(true);

    const first = response.body.data.items.find((item: { id: string }) => item.id === fireVisits[0]?.id);
    expect(first).toMatchObject({
      reference: `AMC-${fire.padStart(4, "0")}`,
      client: { id: hotelOne, name: "Service Hotel One" },
      system: { description: "FIRE", typeId: systemTypeId, typeName: "Fire Alarm" },
      frequency: { code: "QUARTERLY", label: "Quarterly" },
      service: { sequenceNo: 1 },
      scheduledDate: fireVisits[0]?.scheduled_date,
      serviceStatus: "NOT_COMPLETED",
      salesEngineer: { id: engineerId, name: "Sara Sales" },
      reportNumber: null,
    });
  });

  it("counts the cards from the visit records, and they add up", async () => {
    const { kpis } = (await list()).body.data;

    expect(kpis).toEqual({ total: 12, completed: 0, notCompleted: 9, waitingForRenewal: 3 });
  });

  it("derives waiting for renewal from an ended contract without a renewal", async () => {
    const response = await list({ serviceStatus: "WAITING_FOR_RENEWAL" });

    expect(response.body.data.total).toBe(3);
    expect(response.body.data.items.every((item: { contract: { id: string } }) => item.contract.id === ended)).toBe(true);
    // The card figures still show every status of the other filters.
    expect(response.body.data.kpis.total).toBe(12);
  });

  it("combines every filter", async () => {
    const byClientAndMonth = await list({ clientId: hotelTwo, month: 2, year: year + 1 });
    expect(byClientAndMonth.body.data.total).toBe(1);
    expect(byClientAndMonth.body.data.items[0].scheduledDate.slice(0, 7)).toBe(`${year + 1}-02`);

    expect((await list({ frequency: "MONTHLY" })).body.data.total).toBe(8);
    expect((await list({ frequency: "MONTHLY", year: year + 1 })).body.data.total).toBe(5);
    expect((await list({ year: year - 2 })).body.data.total).toBe(3);
    expect((await list({ month: 1 })).body.data.total).toBe(3); // January in any year: FIRE Q1, CCTV, PUMPS
    expect((await list({ salesEngineerId: engineerId })).body.data.total).toBe(4);
    expect((await list({ systemTypeId, clientId: hotelOne })).body.data.total).toBe(4);
    expect((await list({ systemTypeId, clientId: hotelTwo })).body.data.total).toBe(0);
    expect((await list({ clientId: hotelOne, serviceStatus: "NOT_COMPLETED" })).body.data.total).toBe(4);
  });

  it("searches the AMC reference, client, system and service", async () => {
    expect((await list({ search: `AMC-${cctv.padStart(4, "0")}` })).body.data.total).toBe(5);
    // A bare number names the contract, and also matches service codes such as "Q2".
    const byNumber = (await list({ search: cctv, pageSize: 200 })).body.data.items.map((item: { contract: { id: string } }) => item.contract.id);
    expect(byNumber.filter((id: string) => id === cctv)).toHaveLength(5);
    expect((await list({ search: "hotel two" })).body.data.total).toBe(5);
    expect((await list({ search: "pumps" })).body.data.total).toBe(3);
    expect((await list({ search: "fire alarm" })).body.data.total).toBe(4);
    expect((await list({ search: "100%_" })).body.data.total).toBe(0);
  });

  it("pages without losing rows", async () => {
    const one = (await list({ pageSize: 5, page: 1 })).body.data;
    const three = (await list({ pageSize: 5, page: 3 })).body.data;

    expect(one.items).toHaveLength(5);
    expect(three.items).toHaveLength(2);
    expect(one.total).toBe(12);
  });

  it("rejects invalid filters", async () => {
    expect((await list({ month: 13 })).status).toBe(400);
    expect((await list({ year: 1990 })).status).toBe(400);
    expect((await list({ serviceStatus: "DONE" })).status).toBe(400);
  });

  it("offers filter options from the contracts that have services", async () => {
    const response = await api().get("/api/amc/service-status/options").set(accountant.headers);

    expect(response.status).toBe(200);
    expect(response.body.data.clients.map((client: { name: string }) => client.name)).toEqual(["Service Hotel One", "Service Hotel Two"]);
    expect(response.body.data.salesEngineers).toEqual([{ id: engineerId, name: "Sara Sales" }]);
    expect(response.body.data.systemTypes).toEqual([{ id: systemTypeId, name: "Fire Alarm" }]);
    expect(response.body.data.frequencies.map((frequency: { code: string }) => frequency.code).sort()).toEqual(["MONTHLY", "QUARTERLY"]);
    expect(response.body.data.years).toEqual([year - 2, year + 1]);
  });
});

describe("renewal", () => {
  it("stops counting an ended contract as waiting once it has a renewal", async () => {
    const renewal = await api()
      .post(`/api/amc/contracts/${ended}/renewals`)
      .set(admin.headers)
      .send(contractBody(hotelOne, { systemDescription: "PUMPS", validFrom: `${year + 2}-01-01`, validTo: `${year + 2}-12-31`, status: "DRAFT" }));

    expect(renewal.status).toBe(201);
    expect((await list()).body.data.kpis).toMatchObject({ notCompleted: 12, waitingForRenewal: 0 });

    // A cancelled renewal does not count.
    await pool.query("UPDATE amc_contracts SET status = 'CANCELLED' WHERE id = $1", [renewal.body.data.id]);
    expect((await list()).body.data.kpis).toMatchObject({ notCompleted: 9, waitingForRenewal: 3 });
  });
});

describe("saving one service", () => {
  it("completes exactly the chosen visit and nothing else", async () => {
    const target = fireVisits[0]?.id as string;
    const before = await storedVisits();
    const row = await rowOf(target);
    const response = await save(target, { status: "COMPLETED", completedDate: `${year}-10-01`, expectedUpdatedAt: row?.updatedAt });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: target, serviceStatus: "COMPLETED", visitStatus: "COMPLETED", completedDate: `${year}-10-01` });

    const after = await storedVisits();
    for (const visit of after) {
      const old = before.find((item) => item.id === visit.id);
      if (visit.id === target) {
        expect(visit.status).toBe("COMPLETED");
      } else {
        expect(visit).toEqual(old);
      }
    }
    // Visible after reloading, and on the schedule, which reads the same record.
    expect((await rowOf(target))?.serviceStatus).toBe("COMPLETED");
    const schedule = await api().get(`/api/amc/visits/${target}`).set(admin.headers);
    expect(schedule.body.data).toMatchObject({ status: "COMPLETED", completedDate: `${year}-10-01`, invoiceEligibility: "READY_FOR_INVOICE" });
    expect((await logsFor("amc_visits", target)).map((log) => log.action)).toContain("amc_visit.completed");
    expect((await list()).body.data.kpis).toMatchObject({ completed: 1, notCompleted: 8 });
  });

  it("needs a completion date, not in the future", async () => {
    const target = fireVisits[1]?.id as string;
    const row = await rowOf(target);

    const missing = await save(target, { status: "COMPLETED", expectedUpdatedAt: row?.updatedAt });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toContainEqual({ field: "completedDate", message: "Enter the date the visit was completed." });

    const future = await save(target, { status: "COMPLETED", completedDate: `${year + 3}-01-01`, expectedUpdatedAt: row?.updatedAt });
    expect(future.status).toBe(400);

    expect((await rowOf(target))?.serviceStatus).toBe("NOT_COMPLETED");
  });

  it("refuses Waiting for Renewal as a choice, and other bad input", async () => {
    const target = fireVisits[1]?.id as string;
    const row = await rowOf(target);

    expect((await save(target, { status: "WAITING_FOR_RENEWAL", expectedUpdatedAt: row?.updatedAt })).status).toBe(400);
    expect((await save(target, { status: "NOT_COMPLETED", completedDate: `${year}-10-01`, expectedUpdatedAt: row?.updatedAt })).status).toBe(400);
    expect((await save(target, { status: "COMPLETED", completedDate: `${year}-10-01` })).status).toBe(400);
    expect((await save(target, { expectedUpdatedAt: row?.updatedAt })).status).toBe(400);
    expect((await save(target, { status: "COMPLETED", completedDate: `${year}-10-01`, expectedUpdatedAt: row?.updatedAt, notes: "x" })).status).toBe(400);
  });

  it("refuses a save over a newer change, without changing anything", async () => {
    const target = fireVisits[1]?.id as string;
    const stale = (await rowOf(target))?.updatedAt;

    // Someone else changes the visit after the page loaded.
    await api().patch(`/api/amc/visits/${target}`).set(admin.headers).send({ notes: "Changed elsewhere" });

    const response = await save(target, { status: "COMPLETED", completedDate: `${year}-10-02`, expectedUpdatedAt: stale });
    expect(response.status).toBe(409);
    expect((await rowOf(target))?.serviceStatus).toBe("NOT_COMPLETED");
  });

  it("reopens completed work only with approval, back to scheduled", async () => {
    const target = fireVisits[0]?.id as string;
    let row = await rowOf(target);

    const refused = await save(target, { status: "NOT_COMPLETED", expectedUpdatedAt: row?.updatedAt });
    expect(refused.status).toBe(403);

    row = await rowOf(target);
    const reopened = await save(target, { status: "NOT_COMPLETED", expectedUpdatedAt: row?.updatedAt }, admin);
    expect(reopened.status).toBe(200);
    expect(reopened.body.data).toMatchObject({ serviceStatus: "NOT_COMPLETED", visitStatus: "SCHEDULED", completedDate: null });
  });

  it("does not manage cancelled visits", async () => {
    const cancelled = (await visitsOf(cctv))[5] as VisitRecord;
    const updatedAt = (await pool.query("SELECT updated_at FROM amc_visits WHERE id = $1", [cancelled.id])).rows[0].updated_at.toISOString();

    expect((await save(cancelled.id, { status: "COMPLETED", completedDate: `${year}-10-01`, expectedUpdatedAt: updatedAt })).status).toBe(409);
    expect((await save("999999", { status: "COMPLETED", completedDate: `${year}-10-01`, expectedUpdatedAt: updatedAt })).status).toBe(404);
  });
});

describe("permissions", () => {
  it("needs a session and AMC Schedule view to list", async () => {
    expect((await api().get("/api/amc/service-status")).status).toBe(401);
    expect((await list({}, procurement)).status).toBe(403);
    expect((await api().get("/api/amc/service-status/options").set(procurement.headers)).status).toBe(403);
    expect((await list({}, accountant)).status).toBe(200);
  });

  it("needs AMC Execution edit to save", async () => {
    const target = fireVisits[2]?.id as string;
    const row = await rowOf(target);
    const response = await save(target, { status: "COMPLETED", completedDate: `${year}-10-01`, expectedUpdatedAt: row?.updatedAt }, accountant);

    expect(response.status).toBe(403);
    expect((await rowOf(target))?.serviceStatus).toBe("NOT_COMPLETED");
  });

  it("needs AMC Schedule export to export", async () => {
    expect((await exportAs({ format: "xlsx" }, execution)).status).toBe(403);
    expect((await exportAs({ format: "xlsx" }, accountant)).status).toBe(403);
  });
});

describe("exports", () => {
  async function sheetOf(response: { body: Buffer }) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    return workbook.getWorksheet("Service Status") as ExcelJS.Worksheet;
  }

  it("exports every matching row across all pages to Excel", async () => {
    await grant("ADMIN", [["AMC_SCHEDULE", "EXPORT"]]);
    const response = await exportAs({ format: "xlsx", frequency: "MONTHLY" });

    expect(response.status).toBe(200);
    const sheet = await sheetOf(response);
    const header = sheet.getRow(HEADER_ROW).values as ExcelJS.CellValue[];
    expect(header).toContain("AMC Reference");
    expect(header).toContain("Service status");
    expect(header).toContain("Service report no.");

    // 8 monthly services, one row each, whatever the page size of the screen.
    const references: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
      references.push(String(sheet.getRow(HEADER_ROW + index).getCell(2).value));
    }
    expect(references.filter((value) => value.startsWith("AMC-"))).toHaveLength(8);
  });

  it("exports the same filters to PDF", async () => {
    const response = await exportAs({ format: "pdf", serviceStatus: "WAITING_FOR_RENEWAL" });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect((response.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("report number (migration 0077)", () => {
  it("saves, shows, searches and clears the report number of one visit", async () => {
    const target = fireVisits[2]?.id as string;
    let row = await rowOf(target);

    const saved = await save(target, { status: "COMPLETED", completedDate: `${year}-10-03`, reportNumber: "  SR-2027/014 ", expectedUpdatedAt: row?.updatedAt });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ serviceStatus: "COMPLETED", reportNumber: "SR-2027/014" });

    const others = (await pool.query("SELECT count(*)::int AS count FROM amc_visits WHERE service_report_no IS NOT NULL")).rows[0].count;
    expect(others).toBe(1);
    expect((await list({ search: "2027/014" })).body.data.items.map((item: { id: string }) => item.id)).toEqual([target]);
    expect((await list()).body.data.reportNumberAvailable).toBe(true);
    expect((await logsFor("amc_visits", target)).map((log) => log.action)).toContain("amc_visit.service_report_changed");

    row = await rowOf(target);
    const tooLong = await save(target, { reportNumber: "X".repeat(51), expectedUpdatedAt: row?.updatedAt });
    expect(tooLong.status).toBe(400);
    expect((await save(target, { reportNumber: "SR\n1", expectedUpdatedAt: row?.updatedAt })).status).toBe(400);

    const cleared = await save(target, { reportNumber: "", expectedUpdatedAt: row?.updatedAt });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.reportNumber).toBeNull();
  });

  it("lets a report number be saved on its own", async () => {
    const target = fireVisits[3]?.id as string;
    const row = await rowOf(target);
    const response = await save(target, { reportNumber: "SR-9", expectedUpdatedAt: row?.updatedAt });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ reportNumber: "SR-9", serviceStatus: "NOT_COMPLETED" });
  });

  it("adds the report number column to the export", async () => {
    const response = await exportAs({ format: "xlsx" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
    const header = (workbook.getWorksheet("Service Status") as ExcelJS.Worksheet).getRow(HEADER_ROW).values as ExcelJS.CellValue[];

    expect(header).toContain("Service report no.");
  });
});
