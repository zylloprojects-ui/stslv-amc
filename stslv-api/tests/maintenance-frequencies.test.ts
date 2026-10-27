import ExcelJS from "exceljs";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { loadMigrationFiles } from "../src/db/migrate";
import { maintenanceFrequenciesRouter } from "../src/modules/masters/maintenance-frequencies.routes";
import { HEADER_ROW } from "../src/shared/export/excel";
import { errorHandler, notFoundHandler } from "../src/shared/errors";
import { activeContract, createClient, createContract, logsFor, visitsOf } from "./amc-helpers";
import { closePool, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// The Maintenance Frequencies module (migration 0076): list, form, rule lock,
// status, linked contracts, export and permissions. Every record is invented.
//
// Skipped until 0076 is in migrations/ (tests/global-setup.ts rebuilds the test
// schema from that folder, so it is then in the test schema too). It is staged
// in migrations-pending/ for review. The router is mounted on its own app here,
// because adding it to app.ts is a separate, approved integration step.

// The validation harness (migrations-pending/validation) applies 0076 to its own database and sets STSLV_0076_VALIDATION.
const migrated = loadMigrationFiles().some((migration) => migration.name === "maintenance_frequency_rules") || process.env.STSLV_0076_VALIDATION === "1";

const app = express();
app.use(express.json());
app.use("/api/masters/maintenance-frequencies", maintenanceFrequenciesRouter);
app.use(notFoundHandler);
app.use(errorHandler);

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let procurement: Session;

const PATH = "/api/masters/maintenance-frequencies";
const call = () => request(app);
const create = (body: Record<string, unknown>, session: Session = admin) => call().post(PATH).set(session.headers).send(body);
const edit = (id: string, body: Record<string, unknown>, session: Session = admin) => call().patch(`${PATH}/${id}`).set(session.headers).send(body);
const setStatus = (id: string, body: Record<string, unknown>, session: Session = admin) => call().post(`${PATH}/${id}/status`).set(session.headers).send(body);
const list = (query: Record<string, string> = {}, session: Session = admin) => call().get(PATH).query(query).set(session.headers);
const codes = (response: { body: { data: { items: { code: string }[] } } }) => response.body.data.items.map((item) => item.code);

function download(query: Record<string, string>, session: Session = admin) {
  return call()
    .get(`${PATH}/export`)
    .query(query)
    .set(session.headers)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
}

async function sheetRows(response: { body: Buffer }): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Maintenance Frequencies") as ExcelJS.Worksheet;
  const rows: string[][] = [];

  sheet.eachRow((row, number) => {
    if (number > HEADER_ROW) rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? "")));
  });

  return rows.filter((row) => row.filter(Boolean).length > 1);
}

// The seven reference definitions, as test fixtures. The three the engine cannot generate yet are added disabled.
const REFERENCE = [
  { code: "MONTHLY", name: "Monthly", serviceCount: 12, intervalMonths: 1, codePrefix: "M", sortOrder: 1 },
  { code: "QUARTERLY", name: "Quarterly", serviceCount: 4, intervalMonths: 3, codePrefix: "Q", sortOrder: 2 },
  { code: "HALF_YEARLY", name: "Half Yearly", serviceCount: 2, intervalMonths: 6, codePrefix: "H", sortOrder: 3 },
  { code: "ANNUALLY", name: "Annually", serviceCount: 1, intervalMonths: 12, codePrefix: "A", sortOrder: 4 },
  { code: "BI_MONTHLY", name: "Bi-Monthly / Every 2 Months", serviceCount: 6, intervalMonths: 2, codePrefix: "BM", sortOrder: 5, status: "disabled" },
  { code: "EVERY_4_MONTHS", name: "Every 4 Months", serviceCount: 3, intervalMonths: 4, codePrefix: "T", sortOrder: 6, status: "disabled" },
  { code: "CUSTOM", name: "Custom", isCustom: true, codePrefix: "C", sortOrder: 7, status: "disabled" },
];

const ids = new Map<string, string>();
const id = (code: string) => ids.get(code) as string;

let clientId: string;
let quarterlyContract: string;

describe.skipIf(!migrated)("maintenance frequencies (migration 0076)", () => {
  beforeAll(async () => {
    await resetProjectData();
    // resetData() empties maintenance_frequencies (it cascades from users); the tests add their own.
    await pool.query("DELETE FROM maintenance_frequencies");
    admin = await signedIn("admin@example.com", ["ADMIN"]);
    execution = await signedIn("execution@example.com", ["EXECUTION"]);
    procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
  });
  afterAll(closePool);

  describe("list and form", () => {
    it("starts empty", async () => {
      const response = await list();

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ items: [], total: 0 });
    });

    it("creates the reference frequencies and lists them by sort order", async () => {
      for (const row of [...REFERENCE].reverse()) {
        const created = await create(row);
        expect(created.status, row.code).toBe(201);
        ids.set(row.code, created.body.data.id as string);
      }

      expect(codes(await list())).toEqual(REFERENCE.map((row) => row.code));

      const custom = (await call().get(`${PATH}/${id("CUSTOM")}`).set(admin.headers)).body.data;
      expect(custom).toMatchObject({ isCustom: true, serviceCount: null, intervalMonths: null, codePrefix: "C", status: "disabled", engineSupported: true });
    });

    it("normalises the code and prefix", async () => {
      const created = await create({ name: "Every Quarter (alt)", code: "every quarter alt", codePrefix: "eq", serviceCount: 4, intervalMonths: 3 });

      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ code: "EVERY_QUARTER_ALT", codePrefix: "EQ", status: "active" });
      ids.set("EVERY_QUARTER_ALT", created.body.data.id as string);
    });

    it("rejects inconsistent rules with field errors", async () => {
      const response = await create({ name: "Odd", code: "ODD", codePrefix: "O", serviceCount: 3, intervalMonths: 3 });

      expect(response.status).toBe(400);
      expect(response.body.error.details.map((detail: { field: string }) => detail.field)).toEqual(["serviceCount"]);
      expect((await create({ name: "Odd", code: "ODD", codePrefix: "O", serviceCount: 2, intervalMonths: 5 })).status).toBe(400);
      expect((await create({ name: "Odd", code: "ODD", codePrefix: "O", isCustom: true, serviceCount: 4, intervalMonths: 3 })).status).toBe(400);
    });

    it("refuses duplicate codes, names and prefixes", async () => {
      const code = await create({ name: "Another", code: "quarterly", codePrefix: "QX", serviceCount: 4, intervalMonths: 3 });
      expect(code.status).toBe(409);
      expect(code.body.error.details[0].field).toBe("code");

      const name = await create({ name: "  quarterly ", code: "QTR", codePrefix: "QX", serviceCount: 4, intervalMonths: 3 });
      expect(name.status).toBe(409);
      expect(name.body.error.details[0].field).toBe("name");

      // "t" is Every 4 Months' prefix: prefixes are unique, case-insensitively, archived frequencies included.
      const prefix = await create({ name: "Four-monthly", code: "FOUR_MONTHLY", codePrefix: "t", serviceCount: 3, intervalMonths: 4, status: "disabled" });
      expect(prefix.status).toBe(409);
      expect(prefix.body.error.details[0].field).toBe("codePrefix");
    });

    it("creates an active frequency on a new interval, now that the schedule engine generates it", async () => {
      const response = await create({ name: "Every two", code: "EVERY_TWO", codePrefix: "ET", serviceCount: 6, intervalMonths: 2 });

      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ status: "active", engineSupported: true, sortOrder: 9 });
      ids.set("EVERY_TWO", response.body.data.id as string);
    });

    it("searches name, code and prefix", async () => {
      expect(codes(await list({ search: "every 4" }))).toEqual(["EVERY_4_MONTHS"]);
      expect(codes(await list({ search: "half_y" }))).toEqual(["HALF_YEARLY"]);
      expect(codes(await list({ search: "BM" }))).toEqual(["BI_MONTHLY"]);
    });

    it("filters by status, sorts and pages", async () => {
      expect(codes(await list({ status: "disabled" }))).toEqual(["BI_MONTHLY", "EVERY_4_MONTHS", "CUSTOM"]);
      expect(codes(await list({ status: "active" }))).toEqual(["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUALLY", "EVERY_QUARTER_ALT", "EVERY_TWO"]);
      expect(codes(await list({ status: "archived" }))).toEqual([]);

      // Custom has no interval: NULLS LAST in either direction.
      expect(codes(await list({ sort: "intervalMonths", direction: "desc" })).slice(0, 2)).toEqual(["ANNUALLY", "HALF_YEARLY"]);
      expect(codes(await list({ sort: "intervalMonths", direction: "desc" })).at(-1)).toBe("CUSTOM");

      const page2 = await list({ page: "2", pageSize: "3" });
      expect(page2.body.data).toMatchObject({ page: 2, pageSize: 3, total: 9 });
      expect(codes(page2)).toEqual(["ANNUALLY", "BI_MONTHLY", "EVERY_4_MONTHS"]);

      expect((await list({ sort: "nonsense" })).status).toBe(400);
      expect((await list({ status: "deleted" })).status).toBe(400);
    });
  });

  describe("linked contracts and the rule lock", () => {
    it("counts total and active contracts per frequency", async () => {
      clientId = await createClient(admin, "Frequency Test Client");
      quarterlyContract = await activeContract(admin, clientId);
      const draft = await createContract(admin, clientId, { maintenanceFrequency: "MONTHLY" });
      expect(draft.status).toBe(201);

      const items = (await list()).body.data.items as { code: string; contractCount: number; activeContractCount: number; ruleLocked: boolean }[];
      const byCode = Object.fromEntries(items.map((item) => [item.code, item]));

      expect(byCode.QUARTERLY).toMatchObject({ contractCount: 1, activeContractCount: 1, ruleLocked: true });
      expect(byCode.MONTHLY).toMatchObject({ contractCount: 1, activeContractCount: 0, ruleLocked: true });
      expect(byCode.ANNUALLY).toMatchObject({ contractCount: 0, activeContractCount: 0, ruleLocked: false });
    });

    it("lists the linked contracts for a user who may view contracts", async () => {
      const response = await call().get(`${PATH}/${id("QUARTERLY")}/contracts`).set(execution.headers);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ total: 1, activeTotal: 1 });
      expect(response.body.data.items[0]).toMatchObject({ id: quarterlyContract, client: { name: "Frequency Test Client" }, status: "ACTIVE", frequency: { code: "QUARTERLY" } });
    });

    it("locks the code and scheduling rule once a contract uses the frequency, and logs the refusal", async () => {
      const before = await visitsOf(quarterlyContract);

      for (const change of [{ intervalMonths: 6, serviceCount: 2 }, { codePrefix: "QQ" }, { code: "QTR" }, { isCustom: true }]) {
        const response = await edit(id("QUARTERLY"), change);
        expect(response.status, JSON.stringify(change)).toBe(409);
      }

      const logs = (await logsFor("maintenance_frequencies", id("QUARTERLY"))).map((log) => log.action);
      expect(logs.filter((action) => action === "maintenance_frequency.rule_change_rejected")).toHaveLength(4);
      expect((await call().get(`${PATH}/${id("QUARTERLY")}`).set(admin.headers)).body.data).toMatchObject({ code: "QUARTERLY", intervalMonths: 3, codePrefix: "Q" });
      expect(await visitsOf(quarterlyContract)).toEqual(before);
    });

    it("still allows the name and sort order to change, without touching any visit", async () => {
      const before = await visitsOf(quarterlyContract);
      const response = await edit(id("QUARTERLY"), { name: "Quarterly service", sortOrder: 20 });

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ name: "Quarterly service", label: "Quarterly service", sortOrder: 20 });
      expect(await visitsOf(quarterlyContract)).toEqual(before);

      const updated = (await logsFor("maintenance_frequencies", id("QUARTERLY"))).find((log) => log.action === "maintenance_frequency.updated");
      expect(updated?.metadata).toMatchObject({ changes: { name: { from: "Quarterly", to: "Quarterly service" } } });
    });

    it("lets an unused frequency change its rule, clearing the numbers when it becomes custom", async () => {
      const toCustom = await edit(id("BI_MONTHLY"), { isCustom: true });
      expect(toCustom.status).toBe(200);
      expect(toCustom.body.data).toMatchObject({ isCustom: true, serviceCount: null, intervalMonths: null });

      const stale = await edit(id("BI_MONTHLY"), { isCustom: false });
      expect(stale.status).toBe(400);

      const back = await edit(id("BI_MONTHLY"), { isCustom: false, serviceCount: 6, intervalMonths: 2 });
      expect(back.status).toBe(200);
      expect(back.body.data).toMatchObject({ isCustom: false, serviceCount: 6, intervalMonths: 2 });
    });

    it("lets an unused active frequency change to another valid rule, and refuses an inconsistent one", async () => {
      const changed = await edit(id("EVERY_QUARTER_ALT"), { serviceCount: 6, intervalMonths: 2 });
      expect(changed.status).toBe(200);
      expect(changed.body.data).toMatchObject({ serviceCount: 6, intervalMonths: 2, status: "active" });

      expect((await edit(id("EVERY_QUARTER_ALT"), { serviceCount: 4 })).status).toBe(400);
    });
  });

  describe("status", () => {
    it("needs confirmation before disabling a frequency active contracts use, and changes no contract or visit", async () => {
      const before = await visitsOf(quarterlyContract);

      const unconfirmed = await setStatus(id("QUARTERLY"), { status: "disabled" });
      expect(unconfirmed.status).toBe(409);
      expect(unconfirmed.body.error.details[0].field).toBe("confirm");
      expect(unconfirmed.body.error.message).toContain("1 active AMC contract");

      const confirmed = await setStatus(id("QUARTERLY"), { status: "disabled", confirm: true });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.data).toMatchObject({ status: "disabled", isActive: false, archivedAt: null });

      const contract = await pool.query("SELECT maintenance_frequency, status FROM amc_contracts WHERE id = $1", [quarterlyContract]);
      expect(contract.rows[0]).toEqual({ maintenance_frequency: "QUARTERLY", status: "ACTIVE" });
      expect(await visitsOf(quarterlyContract)).toEqual(before);
    });

    it("disables an unused frequency without confirmation", async () => {
      const response = await setStatus(id("ANNUALLY"), { status: "disabled" });

      expect(response.status).toBe(200);
    });

    it("archives, hides archived frequencies from the default list, and restores them", async () => {
      const archived = await setStatus(id("ANNUALLY"), { status: "archived" });
      expect(archived.status).toBe(200);
      expect(archived.body.data.status).toBe("archived");
      expect(archived.body.data.archivedAt).not.toBeNull();

      expect(codes(await list())).not.toContain("ANNUALLY");
      expect(codes(await list({ status: "archived" }))).toEqual(["ANNUALLY"]);
      expect(codes(await list({ status: "all" }))).toContain("ANNUALLY");

      const restored = await setStatus(id("ANNUALLY"), { status: "active" });
      expect(restored.body.data).toMatchObject({ status: "active", archivedAt: null });

      const actions = (await logsFor("maintenance_frequencies", id("ANNUALLY"))).map((log) => log.action);
      expect(actions).toEqual(["maintenance_frequency.created", "maintenance_frequency.disabled", "maintenance_frequency.archived", "maintenance_frequency.activated"]);
    });

    it("can activate the custom frequency now that the engine supports it, and disable it again", async () => {
      // The seeded custom frequency stays inactive until an administrator activates it.
      expect((await setStatus(id("CUSTOM"), { status: "active" })).body.data.status).toBe("active");
      expect((await setStatus(id("CUSTOM"), { status: "disabled" })).body.data.status).toBe("disabled");
    });

    it("offers only active frequencies for a contract", async () => {
      const options = await call().get(`${PATH}/options`).set(execution.headers);

      expect(options.status).toBe(200);
      expect(options.body.data.map((item: { code: string }) => item.code)).toEqual(["MONTHLY", "HALF_YEARLY", "ANNUALLY", "EVERY_QUARTER_ALT", "EVERY_TWO"]);
    });

    it("has no delete: the request is refused and the record stays", async () => {
      const response = await call().delete(`${PATH}/${id("EVERY_4_MONTHS")}`).set(admin.headers);

      expect(response.status).toBe(405);
      expect((await call().get(`${PATH}/${id("EVERY_4_MONTHS")}`).set(admin.headers)).status).toBe(200);
    });

    it("shows the change history", async () => {
      const response = await call().get(`${PATH}/${id("QUARTERLY")}/history`).set(admin.headers);

      expect(response.status).toBe(200);
      expect(response.body.data.total).toBeGreaterThanOrEqual(3);
    });
  });

  describe("export", () => {
    it("exports the filtered list to Excel and records the export", async () => {
      const response = await download({ format: "xlsx", status: "disabled" });

      expect(response.status).toBe(200);
      const rows = await sheetRows(response);
      // Disabled now: the two unsupported references, Custom, and Quarterly (sort order 20).
      expect(rows.map((row) => row[1])).toEqual(["BI_MONTHLY", "EVERY_4_MONTHS", "CUSTOM", "QUARTERLY"]);

      const logged = await pool.query("SELECT metadata FROM activity_logs WHERE action = 'maintenance_frequencies.exported' ORDER BY id DESC LIMIT 1");
      expect(logged.rows[0]?.metadata).toMatchObject({ format: "xlsx", rowCount: 4 });
    });

    it("exports a PDF", async () => {
      const response = await download({ format: "pdf" });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("application/pdf");
      expect(response.body.subarray(0, 4).toString()).toBe("%PDF");
    });
  });

  describe("permissions", () => {
    it("lets a contract viewer read but not change or export", async () => {
      expect((await list({}, execution)).status).toBe(200);
      expect((await create({ name: "X", code: "XX", codePrefix: "X", serviceCount: 1, intervalMonths: 12 }, execution)).status).toBe(403);
      expect((await edit(id("MONTHLY"), { name: "Monthly!" }, execution)).status).toBe(403);
      expect((await setStatus(id("MONTHLY"), { status: "disabled" }, execution)).status).toBe(403);
      expect((await download({ format: "xlsx" }, execution)).status).toBe(403);
    });

    it("refuses a user with neither settings nor contract access", async () => {
      expect((await list({}, procurement)).status).toBe(403);
      expect((await call().get(`${PATH}/${id("QUARTERLY")}/contracts`).set(procurement.headers)).status).toBe(403);
    });

    it("requires sign-in", async () => {
      expect((await call().get(PATH)).status).toBe(401);
    });
  });
});

describe.skipIf(migrated)("maintenance frequencies before migration 0076", () => {
  it("is not run: 0076 is staged in migrations-pending/, not in migrations/", () => {
    expect(migrated).toBe(false);
  });
});
