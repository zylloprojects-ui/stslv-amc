import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { HEADER_ROW } from "../src/shared/export/excel";
import { activeContract, createClient, logsFor } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// The System Types module: list, form validation, status, the contracts that
// use a type, deletion of an unused type and the export. Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let procurement: Session;

const PATH = "/api/masters/system-types";
const create = (body: Record<string, unknown>, session: Session = admin) => api().post(PATH).set(session.headers).send(body);
const list = (query: Record<string, string> = {}, session: Session = admin) => api().get(PATH).query(query).set(session.headers);
const codes = (response: { body: { data: { items: { code: string }[] } } }) => response.body.data.items.map((item) => item.code);

function download(query: Record<string, string>, session: Session = admin) {
  return api()
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
  const sheet = workbook.getWorksheet("System Types") as ExcelJS.Worksheet;
  const rows: string[][] = [];

  sheet.eachRow((row, number) => {
    if (number > HEADER_ROW) rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? "")));
  });

  // The note under the table ("4 system types.") is a row of one cell.
  return rows.filter((row) => row.filter(Boolean).length > 1);
}

// The reference categories, as test fixtures only.
const REFERENCE = [
  { code: "FIRE", name: "FIRE", sortOrder: 10 },
  { code: "CCTV", name: "CCTV", sortOrder: 20 },
  { code: "AUTO", name: "Automation", sortOrder: 30 },
  { code: "FA", name: "Fire Alarm", sortOrder: 40, description: "Addressable and conventional fire alarm panels" },
  { code: "FR", name: "Fire Related", sortOrder: 50 },
  { code: "FE", name: "Fire Extinguisher", sortOrder: 60 },
  { code: "FM200", name: "FM200 Suppression", sortOrder: 70 },
];

const ids = new Map<string, string>();

beforeAll(async () => {
  await resetProjectData();
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

  it("creates types and lists them by sort order, then code", async () => {
    // Added out of order, to show the list orders them.
    for (const row of [...REFERENCE].reverse()) {
      const created = await create(row);
      expect(created.status).toBe(201);
      ids.set(row.code, created.body.data.id as string);
    }

    expect(codes(await list())).toEqual(REFERENCE.map((row) => row.code));

    // A tie on sort order falls back to the code, so the order never depends on chance.
    const tie = await create({ code: "ACS", name: "Access Control", sortOrder: 20 });
    ids.set("ACS", tie.body.data.id as string);
    expect(codes(await list()).slice(1, 3)).toEqual(["ACS", "CCTV"]);
  });

  it("validates the fields and refuses a duplicate code in any letter case", async () => {
    const duplicate = await create({ code: "cctv ", name: "Another CCTV" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details).toEqual([{ field: "code", message: 'A system type with code "cctv" already exists.' }]);

    expect((await create({ code: "", name: "No code" })).status).toBe(400);
    expect((await create({ code: "X1", name: "" })).status).toBe(400);
    expect((await create({ code: "BAD<code>", name: "Bad" })).status).toBe(400);
    expect((await create({ code: "X2", name: "Bad order", sortOrder: -1 })).status).toBe(400);
    expect((await create({ code: "X3", name: "Bad order", sortOrder: 1.5 })).status).toBe(400);
    expect((await create({ code: "X4", name: "Extra", extra: true })).status).toBe(400);

    // Editing a type to another type's code is refused the same way.
    const clash = await api().patch(`${PATH}/${ids.get("FE")}`).set(admin.headers).send({ code: "FA" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details[0].field).toBe("code");
  });

  it("searches by code, name or description, filters by status and sorts on request", async () => {
    expect(codes(await list({ search: "fire" }))).toEqual(["FIRE", "FA", "FR", "FE"]);
    // Found by its description only.
    expect(codes(await list({ search: "addressable" }))).toEqual(["FA"]);
    expect(codes(await list({ search: "CONVENTIONAL" }))).toEqual(["FA"]);
    expect(codes(await list({ search: "FM2" }))).toEqual(["FM200"]);
    expect(codes(await list({ sort: "name", direction: "desc" }))[0]).toBe("FM200");
    // Search treats % and _ as plain characters.
    expect((await list({ search: "%" })).body.data.total).toBe(0);
    expect((await list({ sort: "unknownColumn" })).status).toBe(400);
  });
});

describe("status and AMC contracts", () => {
  let contractId: string;

  beforeAll(async () => {
    const clientId = await createClient(admin, "System Type Test Client");
    contractId = await activeContract(admin, clientId, { systemDescription: "Typed fire alarm system" });
    const linked = await api().put(`/api/amc/contracts/${contractId}/masters`).set(admin.headers).send({ systemTypeId: ids.get("FA") });
    expect(linked.status).toBe(200);
  });

  it("counts the linked contracts and lists them read-only", async () => {
    const fa = (await list({ search: "FA" })).body.data.items.find((item: { code: string }) => item.code === "FA");
    expect(fa.contractCount).toBe(1);

    const contracts = await api().get(`${PATH}/${ids.get("FA")}/contracts`).set(admin.headers);
    expect(contracts.status).toBe(200);
    expect(contracts.body.data).toMatchObject({
      total: 1,
      items: [{ id: contractId, client: { name: "System Type Test Client" }, systemDescription: "Typed fire alarm system", status: "ACTIVE" }],
    });

    expect((await api().get(`${PATH}/${ids.get("CCTV")}/contracts`).set(admin.headers)).body.data.total).toBe(0);
    expect((await api().get(`${PATH}/999999/contracts`).set(admin.headers)).status).toBe(404);
    expect((await api().get(`${PATH}/abc/contracts`).set(admin.headers)).status).toBe(404);
  });

  it("keeps the contract's link when the code is edited, because contracts refer to the id", async () => {
    const edited = await api().patch(`${PATH}/${ids.get("FA")}`).set(admin.headers).send({ code: "FAL" });
    expect(edited.status).toBe(200);

    const masters = await api().get(`/api/amc/contracts/${contractId}/masters`).set(admin.headers);
    expect(masters.body.data.systemType).toMatchObject({ id: ids.get("FA"), code: "FAL" });

    await api().patch(`${PATH}/${ids.get("FA")}`).set(admin.headers).send({ code: "FA" });
  });

  it("disables a type: existing contracts keep it, new links and pickers do not offer it", async () => {
    const disabled = await api().post(`${PATH}/${ids.get("FA")}/status`).set(admin.headers).send({ isActive: false });
    expect(disabled.body.data.isActive).toBe(false);

    const masters = await api().get(`/api/amc/contracts/${contractId}/masters`).set(admin.headers);
    expect(masters.body.data.systemType).toMatchObject({ id: ids.get("FA"), isActive: false });

    const options = (await api().get(`${PATH}/options`).set(admin.headers)).body.data as { code: string; isActive: boolean }[];
    expect(options.map((option) => option.code)).not.toContain("FA");
    expect(options.every((option) => option.isActive)).toBe(true);

    const clientId = await createClient(admin, "Second System Type Client");
    const other = await activeContract(admin, clientId);
    const refused = await api().put(`/api/amc/contracts/${other}/masters`).set(admin.headers).send({ systemTypeId: ids.get("FA") });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].field).toBe("systemTypeId");

    expect(codes(await list({ status: "inactive" }))).toEqual(["FA"]);
    expect(codes(await list({ status: "active" }))).not.toContain("FA");

    const logs = await logsFor("system_types", ids.get("FA") as string);
    expect(logs.map((log) => log.action)).toEqual(["system_type.created", "system_type.updated", "system_type.updated", "system_type.deactivated"]);
  });
});

describe("deletion", () => {
  it("refuses to delete a type that a contract uses, and the database refuses it too", async () => {
    const refused = await api().delete(`${PATH}/${ids.get("FA")}`).set(admin.headers);

    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      '"Fire Alarm" is used by 1 AMC contract and cannot be deleted. Disable it instead: the contracts keep it, and it is no longer offered for new contracts.'
    );
    expect((await pool.query("SELECT 1 FROM system_types WHERE id = $1", [ids.get("FA")])).rowCount).toBe(1);

    // Should the API check be bypassed, the foreign key still keeps the contract's type.
    await expect(pool.query("DELETE FROM system_types WHERE id = $1", [ids.get("FA")])).rejects.toMatchObject({ code: "23503" });
  });

  it("deletes an unused type and records what it was", async () => {
    const id = ids.get("ACS") as string;
    const deleted = await api().delete(`${PATH}/${id}`).set(admin.headers);

    expect(deleted.status).toBe(200);
    expect((await api().get(`${PATH}/${id}`).set(admin.headers)).status).toBe(404);
    expect((await api().delete(`${PATH}/${id}`).set(admin.headers)).status).toBe(404);

    const logs = await logsFor("system_types", id);
    expect(logs.at(-1)).toMatchObject({
      action: "system_type.deleted",
      user_id: admin.id,
      metadata: { deleted: { code: "ACS", name: "Access Control", description: null, sortOrder: 20, isActive: true } },
    });
  });

  it("needs the Settings delete permission", async () => {
    expect((await api().delete(`${PATH}/${ids.get("FE")}`).set(execution.headers)).status).toBe(403);
    expect((await api().delete(`${PATH}/${ids.get("FE")}`)).status).toBe(401);
  });
});

describe("export", () => {
  it("exports the list with the page's filters and order as Excel", async () => {
    const response = await download({ format: "xlsx", status: "all", search: "fire" });

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/system-types/);
    const rows = await sheetRows(response);
    expect(rows.map((row) => row[0])).toEqual(["FIRE", "FA", "FR", "FE"]);
    expect(rows[1]?.slice(0, 6)).toEqual(["FA", "Fire Alarm", "Addressable and conventional fire alarm panels", "40", "Disabled", "1"]);

    const active = await sheetRows(await download({ format: "xlsx", status: "active", sort: "code" }));
    expect(active.map((row) => row[0])).not.toContain("FA");

    // The export searches the description too, as the list does.
    const described = await sheetRows(await download({ format: "xlsx", status: "all", search: "addressable" }));
    expect(described.map((row) => row[0])).toEqual(["FA"]);
  });

  it("exports a PDF, refuses an unknown format and records each export", async () => {
    const pdf = await download({ format: "pdf" });

    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await download({ format: "csv" })).status).toBe(400);

    const logged = await pool.query<{ metadata: { format: string } }>("SELECT metadata FROM activity_logs WHERE action = 'system_types.exported' AND user_id = $1 ORDER BY id", [
      admin.id,
    ]);
    expect(logged.rows.map((row) => row.metadata.format)).toEqual(["xlsx", "xlsx", "xlsx", "pdf"]);
  });

  it("needs Settings view and export permission", async () => {
    // Execution may read the list for contracts, but not export it.
    expect((await list({}, execution)).status).toBe(200);
    expect((await download({ format: "xlsx" }, execution)).status).toBe(403);
    expect((await download({ format: "xlsx" }, procurement)).status).toBe(403);
  });
});

describe("permissions", () => {
  it("lets only Settings editors change types, and only contract viewers see linked contracts", async () => {
    expect((await create({ code: "NEW", name: "New" }, execution)).status).toBe(403);
    expect((await api().patch(`${PATH}/${ids.get("FE")}`).set(execution.headers).send({ name: "x" })).status).toBe(403);
    expect((await api().post(`${PATH}/${ids.get("FE")}/status`).set(execution.headers).send({ isActive: false })).status).toBe(403);
    expect((await api().get(`${PATH}/${ids.get("FA")}/contracts`).set(execution.headers)).status).toBe(200);
    expect((await api().get(`${PATH}/${ids.get("FA")}/contracts`).set(procurement.headers)).status).toBe(403);
    expect((await list({}, procurement)).status).toBe(403);
  });
});
