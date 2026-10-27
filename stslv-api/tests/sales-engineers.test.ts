import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { activeContract, createClient, createContract, grant, logsFor, today, visitsOf } from "./amc-helpers";
import { api, closePool, insertUser, signedIn } from "./helpers";
import { resetProjectData } from "./projects-helpers";

// The Sales Engineers module: list filters and code, account links, status
// changes, Engineer 360 figures and the list export (migration 0070). Every
// record is invented.

type Session = Awaited<ReturnType<typeof signedIn>>;

let admin: Session;
let execution: Session;
let procurement: Session;

const list = (query: Record<string, string | number> = {}, session: Session = admin) => api().get("/api/masters/sales-engineers").query(query).set(session.headers);
const create = (body: Record<string, unknown>, session: Session = admin) => api().post("/api/masters/sales-engineers").set(session.headers).send(body);
const setActive = (id: string, isActive: boolean) => api().post(`/api/masters/sales-engineers/${id}/status`).set(admin.headers).send({ isActive });
const names = (response: { body: { data: { items: { name: string }[] } } }) => response.body.data.items.map((item) => item.name);

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  execution = await signedIn("execution@example.com", ["EXECUTION"]);
  procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
});
afterAll(closePool);

describe("an empty list", () => {
  it("answers with no engineers rather than an error", async () => {
    const response = await list({ status: "all" });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });
});

describe("create and edit", () => {
  it("requires a name and validates the optional fields", async () => {
    expect((await create({})).status).toBe(400);
    expect((await create({ name: "   " })).status).toBe(400);

    const badEmail = await create({ name: "Email Check", email: "not-an-email" });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.error.details).toEqual([{ field: "email", message: "Enter a valid email address." }]);

    expect((await create({ name: "Extra", unknownField: 1 })).status).toBe(400);
    expect((await create({ name: "Bad Department", departmentId: "abc" })).status).toBe(400);
  });

  it("derives an SE- code from the id that stays the same after an edit", async () => {
    const created = await create({ name: "Code Engineer", employeeNo: "EMP-100", email: "code.engineer@example.com", phone: "+968 1111" });

    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect(created.body.data.code).toBe(`SE-${id.padStart(4, "0")}`);
    expect(created.body.data).toMatchObject({ activeContractCount: 0, contractCount: 0, isActive: true, user: null, department: null });

    const edited = await api().patch(`/api/masters/sales-engineers/${id}`).set(admin.headers).send({ phone: "+968 2222" });
    expect(edited.body.data.code).toBe(created.body.data.code);
    expect(edited.body.data.phone).toBe("+968 2222");

    const logs = await logsFor("sales_engineers", id);
    expect(logs.map((log) => log.action)).toEqual(["sales_engineer.created", "sales_engineer.updated"]);
  });

  it("refuses a duplicate name or employee number in any letter case", async () => {
    expect((await create({ name: "code engineer" })).status).toBe(409);

    const duplicate = await create({ name: "Another", employeeNo: "emp-100" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details[0].field).toBe("employeeNo");
  });

  it("needs Settings create or edit permission", async () => {
    expect((await create({ name: "Not Allowed" }, execution)).status).toBe(403);
  });
});

describe("search, filters, sort and paging", () => {
  let amcDepartment: string;

  beforeAll(async () => {
    amcDepartment = (await api().post("/api/masters/departments").set(admin.headers).send({ code: "AMC", name: "AMC Operations" })).body.data.id as string;
    await create({ name: "Alpha Field", employeeNo: "EMP-201", email: "alpha@example.com", departmentId: amcDepartment });
    await create({ name: "Bravo Field", employeeNo: "EMP-202", email: "bravo@example.com", departmentId: amcDepartment });
    const charlie = await create({ name: "Charlie Field", employeeNo: "EMP-203", email: "charlie@example.com" });
    await setActive(charlie.body.data.id as string, false);
  });

  it("searches by name, code, employee number and email", async () => {
    expect(names(await list({ search: "bravo" }))).toEqual(["Bravo Field"]);
    expect(names(await list({ search: "EMP-201" }))).toEqual(["Alpha Field"]);
    expect(names(await list({ search: "charlie@example" }))).toEqual(["Charlie Field"]);

    const alpha = (await list({ search: "Alpha" })).body.data.items[0];
    expect(names(await list({ search: alpha.code }))).toEqual(["Alpha Field"]);
    // A LIKE wildcard is searched for as a character.
    expect((await list({ search: "%" })).body.data.total).toBe(0);
  });

  it("filters by status and by department, including engineers without one", async () => {
    expect(names(await list({ status: "inactive" }))).toEqual(["Charlie Field"]);
    expect(names(await list({ status: "active", departmentId: amcDepartment }))).toEqual(["Alpha Field", "Bravo Field"]);
    expect(names(await list({ status: "all", departmentId: "none" }))).toEqual(["Charlie Field", "Code Engineer"]);
    expect((await list({ departmentId: "x" })).status).toBe(400);
  });

  it("sorts by the allowed keys only and pages the result", async () => {
    expect(names(await list({ status: "all", sort: "code", direction: "desc", pageSize: 2 }))).toEqual(["Charlie Field", "Bravo Field"]);

    const second = await list({ status: "all", sort: "name", pageSize: 2, page: 2 });
    expect(second.body.data).toMatchObject({ total: 4, page: 2, pageSize: 2 });
    expect(names(second)).toEqual(["Charlie Field", "Code Engineer"]);

    expect((await list({ sort: "password" })).status).toBe(400);
    expect((await list({ sort: "name;drop" })).status).toBe(400);
  });
});

describe("user account links", () => {
  let linkable: string;
  let disabledUser: string;
  let pendingUser: string;
  let linkedEngineer: string;

  beforeAll(async () => {
    linkable = await insertUser({ email: "linkable@example.com", fullName: "Linkable User" });
    disabledUser = await insertUser({ email: "disabled@example.com", fullName: "Disabled User", isActive: false });
    pendingUser = await insertUser({ email: "pending@example.com", fullName: "Pending User", isActive: false });
    await pool.query("UPDATE users SET approval_status = 'PENDING' WHERE id = $1", [pendingUser]);
  });

  it("links an active, approved account and refuses a disabled, pending or unknown one", async () => {
    const created = await create({ name: "Linked Engineer", userId: linkable });
    expect(created.status).toBe(201);
    expect(created.body.data.user).toMatchObject({ id: linkable, fullName: "Linkable User" });
    linkedEngineer = created.body.data.id as string;

    for (const userId of [disabledUser, pendingUser]) {
      const refused = await create({ name: `Refused ${userId}`, userId });
      expect(refused.status).toBe(400);
      expect(refused.body.error.details).toEqual([{ field: "userId", message: "Select an active, approved user account." }]);
    }
    expect((await create({ name: "Unknown Account", userId: "999999" })).body.error.details[0].message).toBe("Select an existing user account.");
  });

  it("refuses a second engineer for the same account", async () => {
    const duplicate = await create({ name: "Second Link", userId: linkable });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.details[0].field).toBe("userId");
  });

  it("keeps a link when the account is later disabled, and can clear it", async () => {
    await pool.query("UPDATE users SET is_active = false WHERE id = $1", [linkable]);

    const kept = await api().patch(`/api/masters/sales-engineers/${linkedEngineer}`).set(admin.headers).send({ phone: "123" });
    expect(kept.status).toBe(200);
    expect(kept.body.data.user.id).toBe(linkable);

    const cleared = await api().patch(`/api/masters/sales-engineers/${linkedEngineer}`).set(admin.headers).send({ userId: null });
    expect(cleared.body.data.user).toBeNull();
    await pool.query("UPDATE users SET is_active = true WHERE id = $1", [linkable]);
  });

  it("offers only accounts that are active, approved and not linked to another engineer", async () => {
    await api().patch(`/api/masters/sales-engineers/${linkedEngineer}`).set(admin.headers).send({ userId: linkable });

    const forNew = (await api().get("/api/masters/sales-engineers/user-options").set(admin.headers)).body.data as { id: string }[];
    const ids = forNew.map((user) => user.id);
    expect(ids).not.toContain(linkable);
    expect(ids).not.toContain(disabledUser);
    expect(ids).not.toContain(pendingUser);
    expect(ids).toContain(admin.id);

    const forOwner = (await api().get("/api/masters/sales-engineers/user-options").query({ engineerId: linkedEngineer }).set(admin.headers)).body.data as { id: string }[];
    expect(forOwner.map((user) => user.id)).toContain(linkable);
  });

  it("lists accounts only for users who may add or edit engineers", async () => {
    expect((await api().get("/api/masters/sales-engineers/user-options").set(execution.headers)).status).toBe(403);
    expect((await api().get("/api/masters/sales-engineers/user-options")).status).toBe(401);
  });
});

describe("status and AMC assignment", () => {
  let engineer: string;
  let contract: string;
  let clientId: string;

  beforeAll(async () => {
    engineer = (await create({ name: "Assigned Engineer" })).body.data.id as string;
    clientId = await createClient(admin, "Assignment Client");
    contract = await activeContract(admin, clientId, { salesEngineerId: engineer });
  });

  it("counts active assignments, so the page can warn before disabling", async () => {
    const before = await api().get(`/api/masters/sales-engineers/${engineer}`).set(admin.headers);

    expect(before.body.data).toMatchObject({ activeContractCount: 1, contractCount: 1 });
  });

  it("disables without touching existing contracts, and records the change", async () => {
    const disabled = await setActive(engineer, false);
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.isActive).toBe(false);

    const links = await api().get(`/api/amc/contracts/${contract}/masters`).set(admin.headers);
    expect(links.body.data.salesEngineer).toMatchObject({ id: engineer, isActive: false });

    const logs = await logsFor("sales_engineers", engineer);
    expect(logs.at(-1)?.action).toBe("sales_engineer.deactivated");
  });

  it("refuses a disabled engineer for a new assignment and leaves it out of the picker", async () => {
    const other = await activeContract(admin, clientId);
    const refused = await api().put(`/api/amc/contracts/${other}/masters`).set(admin.headers).send({ salesEngineerId: engineer });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details[0].field).toBe("salesEngineerId");

    expect((await createContract(admin, clientId, { salesEngineerId: engineer })).status).toBe(400);

    const options = (await api().get("/api/masters/sales-engineers/options").set(admin.headers)).body.data as { id: string }[];
    expect(options.map((option) => option.id)).not.toContain(engineer);
  });

  it("offers the engineer again once re-enabled", async () => {
    await setActive(engineer, true);
    const options = (await api().get("/api/masters/sales-engineers/options").set(admin.headers)).body.data as { id: string }[];

    expect(options.map((option) => option.id)).toContain(engineer);
  });

  it("has no delete route", async () => {
    expect((await api().delete(`/api/masters/sales-engineers/${engineer}`).set(admin.headers)).status).toBe(404);
  });
});

describe("Engineer 360", () => {
  let engineer: string;
  let active: string;

  beforeAll(async () => {
    engineer = (await create({ name: "Summary Engineer" })).body.data.id as string;
    const clientId = await createClient(admin, "Summary Client");
    const now = await today();
    const year = Number(now.slice(0, 4));

    // Active since well before today, so some visits are already past their date.
    active = await activeContract(admin, clientId, { salesEngineerId: engineer, validFrom: `${year - 1}-01-01`, validTo: `${year + 1}-12-31`, contractValue: "3000.000", maintenanceFrequency: "QUARTERLY", defaultVisitAmount: "250.000" });
    await activeContract(admin, clientId, { salesEngineerId: engineer, contractValue: "1620.000" });
    // A draft: counted, but not in the active value.
    expect((await createContract(admin, clientId, { salesEngineerId: engineer, contractValue: "999.000" })).status).toBe(201);
    // Not linked to the engineer: never counted.
    await activeContract(admin, clientId, { contractValue: "5000.000" });
  });

  it("counts the linked contracts by status and sums the active value by the dashboard's rule", async () => {
    const summary = (await api().get(`/api/masters/sales-engineers/${engineer}/summary`).set(admin.headers)).body.data;

    expect(summary.contracts).toEqual({ total: 3, active: 2, draft: 1, expired: 0, cancelled: 0, activeValue: "4620.000" });
  });

  it("counts upcoming and overdue visits from the stored schedule", async () => {
    const now = await today();
    const visits = [...(await visitsOf(active)), ...(await visitsOf((await pool.query<{ id: string }>("SELECT id FROM amc_contracts WHERE sales_engineer_id = $1 AND status = 'ACTIVE' AND id <> $2", [engineer, active])).rows[0]!.id))];
    const open = visits.filter((visit) => ["SCHEDULED", "IN_PROGRESS", "POSTPONED"].includes(visit.status));
    const upcoming = open.filter((visit) => visit.scheduled_date >= now).map((visit) => visit.scheduled_date).sort();
    const overdue = open.filter((visit) => visit.scheduled_date < now);

    const summary = (await api().get(`/api/masters/sales-engineers/${engineer}/summary`).set(admin.headers)).body.data;

    expect(overdue.length).toBeGreaterThan(0);
    expect(summary.visits).toEqual({ upcoming: upcoming.length, overdue: overdue.length, nextVisitDate: upcoming[0] ?? null });
    expect(summary.upcoming.total).toBe(upcoming.length);
    expect(summary.upcoming.items.map((item: { scheduledDate: string }) => item.scheduledDate)).toEqual(upcoming.slice(0, 10));
    expect(summary.upcoming.items[0].contract.clientName).toBe("Summary Client");
    expect(summary.asOf).toBe(now);
  });

  it("answers zeros for an engineer with no contracts, and 404 for an unknown one", async () => {
    const lone = (await create({ name: "No Contracts Engineer" })).body.data.id as string;
    const summary = (await api().get(`/api/masters/sales-engineers/${lone}/summary`).set(admin.headers)).body.data;

    expect(summary.contracts).toEqual({ total: 0, active: 0, draft: 0, expired: 0, cancelled: 0, activeValue: "0.000" });
    expect(summary.visits).toEqual({ upcoming: 0, overdue: 0, nextVisitDate: null });
    expect(summary.upcoming).toEqual({ total: 0, items: [] });
    expect((await api().get("/api/masters/sales-engineers/999999/summary").set(admin.headers)).status).toBe(404);
  });

  it("leaves out each section the viewer's role cannot see", async () => {
    // Procurement may not read engineers at all until given Settings view.
    expect((await api().get(`/api/masters/sales-engineers/${engineer}/summary`).set(procurement.headers)).status).toBe(403);
    await grant("PROCUREMENT", [["SETTINGS", "VIEW"]]);

    const summary = (await api().get(`/api/masters/sales-engineers/${engineer}/summary`).set(procurement.headers)).body.data;
    expect(summary).toMatchObject({ contracts: null, visits: null, upcoming: null });

    const forExecution = (await api().get(`/api/masters/sales-engineers/${engineer}/summary`).set(execution.headers)).body.data;
    expect(forExecution.contracts.total).toBe(3);
    expect(forExecution.visits).not.toBeNull();
  });
});

describe("export", () => {
  it("exports the filtered list as Excel and PDF and records each export", async () => {
    const excel = await api().get("/api/masters/sales-engineers/export").query({ format: "xlsx", status: "all", search: "Field" }).set(admin.headers);
    expect(excel.status).toBe(200);
    expect(excel.headers["content-type"]).toContain("spreadsheetml");
    expect(excel.headers["content-disposition"]).toContain("sales-engineers");

    const pdf = await api().get("/api/masters/sales-engineers/export").query({ format: "pdf" }).set(admin.headers);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");

    const logs = await pool.query<{ metadata: { format: string; rowCount: number } }>(
      "SELECT metadata FROM activity_logs WHERE action = 'sales_engineers.exported' ORDER BY id"
    );
    expect(logs.rows.map((row) => [row.metadata.format, row.metadata.rowCount])).toEqual([
      ["xlsx", 3],
      ["pdf", (await list({ status: "all", pageSize: 100 })).body.data.total],
    ]);
  });

  it("needs Settings export permission and a known format", async () => {
    expect((await api().get("/api/masters/sales-engineers/export").query({ format: "xlsx" }).set(execution.headers)).status).toBe(403);
    expect((await api().get("/api/masters/sales-engineers/export").query({ format: "csv" }).set(admin.headers)).status).toBe(400);
  });
});

// Last, so the extra record does not change the list figures above.
describe("status on create", () => {
  it("may add an engineer already disabled, and takes the status on create only", async () => {
    const created = await create({ name: "Starts Disabled", isActive: false });

    expect(created.status).toBe(201);
    expect(created.body.data.isActive).toBe(false);
    expect((await create({ name: "Bad Status", isActive: "no" })).status).toBe(400);

    const id = created.body.data.id as string;
    expect((await api().patch(`/api/masters/sales-engineers/${id}`).set(admin.headers).send({ isActive: true })).status).toBe(400);
  });
});
