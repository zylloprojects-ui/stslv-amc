import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { HEADER_ROW } from "../src/shared/export/excel";
import { logsFor } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// The Departments module: list, form validation, status, linked engineers, the
// absence of delete, the export and permissions, through the application as
// app.ts mounts it. Every record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let procurement: Session;

const PATH = "/api/masters/departments";
const ENGINEERS = "/api/masters/sales-engineers";
const create = (body: Record<string, unknown>, session: Session = admin) => api().post(PATH).set(session.headers).send(body);
const list = (query: Record<string, string> = {}, session: Session = admin) => api().get(PATH).query(query).set(session.headers);
const setStatus = (id: string, isActive: boolean, session: Session = admin) => api().post(`${PATH}/${id}/status`).set(session.headers).send({ isActive });
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
  const sheet = workbook.getWorksheet("Departments") as ExcelJS.Worksheet;
  const rows: string[][] = [];

  sheet.eachRow((row, number) => {
    if (number > HEADER_ROW) rows.push((row.values as unknown[]).slice(1).map((value) => String(value ?? "")));
  });

  // Data rows only: the table's closing note ("2 departments.") is a merged row.
  return rows.filter((row) => !/^\d+ departments?\.$/.test(row[0] ?? ""));
}

// The reference departments, as test fixtures only. Nothing is seeded.
const REFERENCE = [
  { code: "AMC", name: "AMC", description: "Annual Maintenance Contract operations" },
  { code: "FIN", name: "Finance", description: "Finance and invoicing team" },
  { code: "SALES", name: "Sales", description: "Sales and commercial team" },
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

  it("creates departments and lists them by name, then code", async () => {
    for (const row of [...REFERENCE].reverse()) {
      const created = await create(row);
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({ ...row, isActive: true, engineerCount: 0 });
      ids.set(row.code, created.body.data.id as string);
    }

    expect(codes(await list())).toEqual(["AMC", "FIN", "SALES"]);

    // A tie on name falls back to the code, so the order never depends on chance.
    const tie = await create({ code: "FIN2", name: "finance" });
    ids.set("FIN2", tie.body.data.id as string);
    expect(codes(await list())).toEqual(["AMC", "FIN", "FIN2", "SALES"]);
  });

  it("validates the fields and refuses a duplicate code in any letter case", async () => {
    const duplicate = await create({ code: "fin ", name: "Another finance" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details).toEqual([{ field: "code", message: 'A department with code "fin" already exists.' }]);

    expect((await create({ code: "", name: "No code" })).status).toBe(400);
    expect((await create({ code: "X1", name: "  " })).status).toBe(400);
    expect((await create({ code: "BAD<code>", name: "Bad" })).status).toBe(400);
    expect((await create({ code: "X".repeat(21), name: "Too long" })).status).toBe(400);
    expect((await create({ code: "X2", name: "N".repeat(101) })).status).toBe(400);
    expect((await create({ code: "X3", name: "Long text", description: "D".repeat(501) })).status).toBe(400);
    // No hierarchy and no sort order.
    expect((await create({ code: "X4", name: "Child", parentId: ids.get("AMC") })).status).toBe(400);
    expect((await create({ code: "X5", name: "Ordered", sortOrder: 1 })).status).toBe(400);

    // Editing a department to another one's code is refused the same way.
    const clash = await api().patch(`${PATH}/${ids.get("FIN2")}`).set(admin.headers).send({ code: "Sales" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.details[0].field).toBe("code");

    expect((await pool.query("SELECT count(*)::int AS count FROM departments")).rows[0].count).toBe(4);
  });

  it("edits a department and records the change", async () => {
    const id = ids.get("FIN2") as string;
    const edited = await api().patch(`${PATH}/${id}`).set(admin.headers).send({ name: "Finance Projects", description: "Project invoicing" });

    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ code: "FIN2", name: "Finance Projects", description: "Project invoicing" });

    const logs = await logsFor("departments", id);
    expect(logs.map((log) => log.action)).toEqual(["department.created", "department.updated"]);
    expect(logs[1]).toMatchObject({ user_id: admin.id, module: "DEPARTMENTS", metadata: { changes: { name: { from: "finance", to: "Finance Projects" } } } });
  });

  it("searches by code, name or description, filters by status and sorts on request", async () => {
    expect(codes(await list({ search: "invoic" }))).toEqual(["FIN", "FIN2"]);
    expect(codes(await list({ search: "commercial" }))).toEqual(["SALES"]);
    expect(codes(await list({ search: "amc" }))).toEqual(["AMC"]);
    expect(codes(await list({ sort: "code", direction: "desc" }))).toEqual(["SALES", "FIN2", "FIN", "AMC"]);
    expect(codes(await list({ sort: "name", direction: "desc" }))[0]).toBe("SALES");
    // Search treats % and _ as plain characters.
    expect((await list({ search: "%" })).body.data.total).toBe(0);
    expect((await list({ sort: "sortOrder" })).status).toBe(400);
    expect((await list({ status: "archived" })).status).toBe(400);
  });

  it("pages the list", async () => {
    const first = await list({ page: "1", pageSize: "2" });
    const second = await list({ page: "2", pageSize: "2" });

    expect(first.body.data).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect([...codes(first), ...codes(second)]).toEqual(["AMC", "FIN", "FIN2", "SALES"]);
  });
});

describe("linked engineers and status", () => {
  let engineerId = "";

  it("counts linked engineers, active and in total", async () => {
    const amc = ids.get("AMC") as string;
    engineerId = (await api().post(ENGINEERS).set(admin.headers).send({ name: "Alpha Field", employeeNo: "EMP-1", departmentId: amc })).body.data.id as string;
    await api().post(ENGINEERS).set(admin.headers).send({ name: "Bravo Field", departmentId: amc, isActive: false });

    const amcRow = (await list({ search: "AMC" })).body.data.items[0];
    expect(amcRow).toMatchObject({ engineerCount: 2, activeEngineerCount: 1 });

    // The linked list itself is the Sales Engineers list, filtered by department.
    const linked = await api().get(ENGINEERS).query({ departmentId: amc, status: "all" }).set(admin.headers);
    expect(linked.body.data.items.map((item: { name: string; code: string; employeeNo: string | null; isActive: boolean }) => [item.name, item.code, item.employeeNo, item.isActive])).toEqual([
      ["Alpha Field", `SE-${engineerId.padStart(4, "0")}`, "EMP-1", true],
      ["Bravo Field", expect.stringMatching(/^SE-\d{4,}$/), null, false],
    ]);
  });

  it("disables a linked department without touching its engineers, and records it", async () => {
    const amc = ids.get("AMC") as string;
    const disabled = await setStatus(amc, false);

    expect(disabled.status).toBe(200);
    expect(disabled.body.data).toMatchObject({ isActive: false, engineerCount: 2 });
    expect((await pool.query("SELECT count(*)::int AS count FROM sales_engineers WHERE department_id = $1", [amc])).rows[0].count).toBe(2);
    expect((await logsFor("departments", amc)).at(-1)).toMatchObject({
      action: "department.deactivated",
      user_id: admin.id,
      metadata: { changes: { isActive: { from: true, to: false } } },
    });

    expect(codes(await list({ status: "inactive" }))).toEqual(["AMC"]);
    expect(codes(await list({ status: "active" }))).toEqual(["FIN", "FIN2", "SALES"]);
  });

  it("offers only active departments, and refuses a new engineer assignment to a disabled one", async () => {
    const amc = ids.get("AMC") as string;
    const options = await api().get(`${PATH}/options`).set(admin.headers);
    expect(options.body.data.map((item: { code: string }) => item.code)).not.toContain("AMC");

    const refused = await api().post(ENGINEERS).set(admin.headers).send({ name: "Charlie Field", departmentId: amc });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ field: "departmentId", message: "Select an active department." }]);

    // An engineer already in it keeps it when edited.
    const kept = await api().patch(`${ENGINEERS}/${engineerId}`).set(admin.headers).send({ phone: "+971 50 000 0000", departmentId: amc });
    expect(kept.status).toBe(200);
    expect(kept.body.data.department).toMatchObject({ id: amc, code: "AMC" });
  });

  it("reactivates a department", async () => {
    const amc = ids.get("AMC") as string;
    const reactivated = await setStatus(amc, true);

    expect(reactivated.body.data.isActive).toBe(true);
    expect((await logsFor("departments", amc)).at(-1)?.action).toBe("department.reactivated");
  });

  it("changes a code without touching linked engineers, which refer to the department by id", async () => {
    const amc = ids.get("AMC") as string;
    const renamed = await api().patch(`${PATH}/${amc}`).set(admin.headers).send({ code: "AMC-OPS" });

    expect(renamed.status).toBe(200);
    const engineer = await api().get(`${ENGINEERS}/${engineerId}`).set(admin.headers);
    expect(engineer.body.data.department).toMatchObject({ id: amc, code: "AMC-OPS" });

    await api().patch(`${PATH}/${amc}`).set(admin.headers).send({ code: "AMC" });
  });
});

describe("no delete", () => {
  it("has no delete route, and the database keeps a department that engineers use", async () => {
    const amc = ids.get("AMC") as string;

    expect((await api().delete(`${PATH}/${amc}`).set(admin.headers)).status).toBe(404);
    expect((await api().delete(`${PATH}/${ids.get("SALES")}`).set(admin.headers)).status).toBe(404);
    expect((await pool.query("SELECT count(*)::int AS count FROM departments")).rows[0].count).toBe(4);

    // Should a delete ever be attempted directly, the foreign key still keeps the engineers' department.
    await expect(pool.query("DELETE FROM departments WHERE id = $1", [amc])).rejects.toMatchObject({ code: "23503" });
  });
});

describe("export", () => {
  it("exports the list with the page's filters and order as Excel", async () => {
    const response = await download({ format: "xlsx", status: "all", search: "fin" });

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toMatch(/departments/);
    const rows = await sheetRows(response);
    expect(rows.map((row) => row[0])).toEqual(["FIN", "FIN2"]);
    expect(rows[0]?.slice(0, 6)).toEqual(["FIN", "Finance", "Finance and invoicing team", "Active", "0", "0"]);

    const amc = await sheetRows(await download({ format: "xlsx", search: "AMC" }));
    expect(amc[0]?.slice(3, 6)).toEqual(["Active", "2", "1"]);

    const ordered = await sheetRows(await download({ format: "xlsx", sort: "engineers", direction: "desc" }));
    expect(ordered[0]?.[0]).toBe("AMC");
  });

  it("exports a PDF, refuses an unknown format and records each export", async () => {
    const pdf = await download({ format: "pdf" });

    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await download({ format: "csv" })).status).toBe(400);

    const logged = await pool.query<{ metadata: { format: string; rowCount: number } }>(
      "SELECT metadata FROM activity_logs WHERE action = 'departments.exported' AND user_id = $1 ORDER BY id",
      [admin.id]
    );
    expect(logged.rows.map((row) => row.metadata.format)).toEqual(["xlsx", "xlsx", "xlsx", "pdf"]);
    expect(logged.rows.at(-1)?.metadata.rowCount).toBe(4);
  });
});

describe("permissions", () => {
  it("lets contract viewers read, but only Settings users export or change departments", async () => {
    const sales = ids.get("SALES") as string;

    expect((await list({}, execution)).status).toBe(200);
    expect((await download({ format: "xlsx" }, execution)).status).toBe(403);
    expect((await create({ code: "NEW", name: "New" }, execution)).status).toBe(403);
    expect((await api().patch(`${PATH}/${sales}`).set(execution.headers).send({ name: "x" })).status).toBe(403);
    expect((await setStatus(sales, false, execution)).status).toBe(403);

    expect((await list({}, procurement)).status).toBe(403);
    expect((await download({ format: "xlsx" }, procurement)).status).toBe(403);
    expect((await api().get(PATH)).status).toBe(401);
    expect((await api().get(`${PATH}/export?format=xlsx`)).status).toBe(401);

    const unchanged = await pool.query("SELECT name, is_active FROM departments WHERE id = $1", [sales]);
    expect(unchanged.rows[0]).toEqual({ name: "Sales", is_active: true });
  });

  it("never returns internal database details in an error", async () => {
    const response = await create({ code: "fin", name: "Duplicate" });

    expect(JSON.stringify(response.body)).not.toMatch(/departments_code_uq|stack|duplicate key/i);
  });
});
