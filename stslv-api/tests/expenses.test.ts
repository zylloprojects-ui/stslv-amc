import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, signedIn } from "./helpers";
import {
  categoryId,
  insertClient,
  logsFor,
  newProject,
  postExpense,
  resetProjectData,
  setStatus,
  type Session,
} from "./projects-helpers";

let admin: Session;
let clientId: string;
let project: Awaited<ReturnType<typeof newProject>>;
let materials: string;
let labour: string;

beforeEach(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await insertClient("IBIS");
  project = await newProject(admin, clientId, { jobValue: "1000", budgetAmount: "600" });
  materials = await categoryId("MATERIALS");
  labour = await categoryId("LABOUR");
});
afterAll(closePool);

const get = (path: string, session: Session = admin) => api().get(path).set(session.headers);
const patch = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().patch(`/api/expenses/${id}`).set(session.headers).send(body);
const voidExpense = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().post(`/api/expenses/${id}/void`).set(session.headers).send(body);
const financials = async (projectId: string = project.id) => (await get(`/api/projects/${projectId}`)).body.data;

async function newExpense(overrides: Record<string, unknown> = {}, session: Session = admin) {
  const response = await postExpense(session, {
    projectId: project.id,
    categoryId: materials,
    expenseDate: "2026-09-10",
    description: "Cable and conduit",
    amount: "100",
    ...overrides,
  });

  if (response.status !== 201) {
    throw new Error(`Expense was not created: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return response.body.data as Record<string, string | null> & { id: string };
}

describe("expense categories", () => {
  it("lists the seeded categories in order", async () => {
    const response = await get("/api/expenses/categories");

    expect(response.status).toBe(200);
    expect(response.body.data.map((category: { code: string }) => category.code)).toEqual([
      "MATERIALS",
      "TRANSPORT",
      "INSPECTION",
      "LABOUR",
      "SUPPLIER_PAYMENT",
      "BILLS",
      "OTHER",
    ]);
    expect(response.body.data[0]).toMatchObject({ name: "Materials", isActive: true });
  });
});

describe("create expense", () => {
  it("saves the expense against its project and records who entered it", async () => {
    const response = await postExpense(admin, {
      projectId: project.id,
      categoryId: materials,
      expenseDate: "2026-09-10",
      description: "  Cable and conduit  ",
      payeeName: "Test Supplier LLC",
      amount: "1234.567",
      paymentReference: "TRF-88120",
      notes: "",
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      projectId: project.id,
      jobNumber: "GPSA0001",
      clientName: "IBIS",
      categoryId: materials,
      categoryCode: "MATERIALS",
      categoryName: "Materials",
      expenseDate: "2026-09-10",
      description: "Cable and conduit",
      payeeName: "Test Supplier LLC",
      amount: "1234.567",
      paymentReference: "TRF-88120",
      notes: null,
      isVoided: false,
      voidReason: null,
    });

    const stored = await pool.query("SELECT project_id, amount, created_by, updated_by FROM project_expenses WHERE id = $1", [
      response.body.data.id,
    ]);
    expect(stored.rows[0]).toEqual({ project_id: project.id, amount: "1234.567", created_by: admin.id, updated_by: admin.id });

    expect(await logsFor("project_expenses", response.body.data.id)).toMatchObject([
      { action: "expense.created", user_id: admin.id, module: "EXPENSES", metadata: { jobNumber: "GPSA0001", amount: "1234.567" } },
    ]);
  });

  it("rejects invalid data with field-level messages", async () => {
    const base = { projectId: project.id, categoryId: materials, expenseDate: "2026-09-10", description: "Item" };
    const attempts = {
      missing: await postExpense(admin, {}),
      zero: await postExpense(admin, { ...base, amount: "0.000" }),
      negative: await postExpense(admin, { ...base, amount: "-5" }),
      fourDecimals: await postExpense(admin, { ...base, amount: "1.0005" }),
      number: await postExpense(admin, { ...base, amount: 12.5 }),
      badDate: await postExpense(admin, { ...base, expenseDate: "2026-13-01", amount: "5" }),
      voided: await postExpense(admin, { ...base, amount: "5", isVoided: true }),
    };

    for (const [name, response] of Object.entries(attempts)) {
      expect(response.status, name).toBe(400);
      expect(response.body.error.code, name).toBe("VALIDATION_ERROR");
    }
    expect(attempts.missing.body.error.details).toEqual(
      expect.arrayContaining([
        { field: "projectId", message: "Project is required." },
        { field: "categoryId", message: "Category is required." },
        { field: "expenseDate", message: "Expense date is required." },
        { field: "description", message: "Description is required." },
        { field: "amount", message: "Amount is required." },
      ])
    );
    expect(attempts.zero.body.error.details).toEqual([{ field: "amount", message: "Amount must be greater than zero." }]);
    expect((await pool.query("SELECT 1 FROM project_expenses")).rowCount).toBe(0);
  });

  it("must belong to an existing project that is not cancelled, and to a category in use", async () => {
    const cancelled = await newProject(admin, clientId);
    await setStatus(admin, cancelled.id, { status: "CANCELLED" });
    await pool.query("UPDATE expense_categories SET is_active = false WHERE code = 'BILLS'");
    const base = { categoryId: materials, expenseDate: "2026-09-10", description: "Item", amount: "5" };

    const unknownProject = await postExpense(admin, { ...base, projectId: "999999" });
    const cancelledProject = await postExpense(admin, { ...base, projectId: cancelled.id });
    const unknownCategory = await postExpense(admin, { ...base, projectId: project.id, categoryId: "999999" });
    const retiredCategory = await postExpense(admin, { ...base, projectId: project.id, categoryId: await categoryId("BILLS") });

    expect(unknownProject.body.error.details).toEqual([{ field: "projectId", message: "The selected project does not exist." }]);
    expect(cancelledProject.body.error.details[0].field).toBe("projectId");
    expect(unknownCategory.body.error.details).toEqual([{ field: "categoryId", message: "The selected category does not exist." }]);
    expect(retiredCategory.body.error.details[0].field).toBe("categoryId");

    for (const response of [unknownProject, cancelledProject, unknownCategory, retiredCategory]) {
      expect(response.status).toBe(400);
    }
  });

  it("can be recorded against a completed project, because bills arrive late", async () => {
    await setStatus(admin, project.id, { status: "COMPLETED" });

    const expense = await newExpense({ amount: "75.5" });

    expect(expense.amount).toBe("75.500");
    expect(await financials()).toMatchObject({ status: "COMPLETED", trackedExpenses: "75.500", operationalJobMargin: "924.500" });
  });

  it("is tied to its project by the database", async () => {
    await newExpense();

    await expect(
      pool.query(
        "INSERT INTO project_expenses (expense_category_id, expense_date, description, amount) VALUES ($1, '2026-01-01', 'No job', 5)",
        [materials]
      )
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      pool.query(
        "INSERT INTO project_expenses (project_id, expense_category_id, expense_date, description, amount) VALUES (999999, $1, '2026-01-01', 'Orphan', 5)",
        [materials]
      )
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "INSERT INTO project_expenses (project_id, expense_category_id, expense_date, description, amount) VALUES ($1, $2, '2026-01-01', 'Zero', 0)",
        [project.id, materials]
      )
    ).rejects.toMatchObject({ code: "23514", constraint: "project_expenses_amount_ck" });
    await expect(pool.query("DELETE FROM projects WHERE id = $1", [project.id])).rejects.toMatchObject({ code: "23503" });
  });

  it("allows the same payment reference on two projects: no split-payment rule is assumed", async () => {
    const other = await newProject(admin, clientId);

    const first = await newExpense({ paymentReference: "TRF-1", amount: "60" });
    const second = await newExpense({ projectId: other.id, paymentReference: "TRF-1", amount: "40" });

    expect(first.paymentReference).toBe("TRF-1");
    expect(second.paymentReference).toBe("TRF-1");
  });
});

describe("tracked expenses and operational job margin", () => {
  it("derives tracked expenses from the expense rows with exact three-decimal arithmetic", async () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    await newExpense({ amount: "0.1" });
    await newExpense({ amount: "0.2" });
    expect((await financials()).trackedExpenses).toBe("0.300");

    await newExpense({ amount: "1234.567" });
    await newExpense({ amount: "33.333", categoryId: labour });
    await newExpense({ amount: "0.001" });

    expect((await financials()).trackedExpenses).toBe("1268.201");
  });

  it("calculates Operational Job Margin as job value excluding VAT minus tracked expenses", async () => {
    await newExpense({ amount: "250.125" });
    await newExpense({ amount: "99.875" });

    const summary = await financials();

    expect(summary).toMatchObject({
      jobValue: "1000.000",
      vatAmount: "50.000",
      grandValue: "1050.000",
      trackedExpenses: "350.000",
      // 1000.000 - 350.000. VAT (50.000) is not part of the margin.
      operationalJobMargin: "650.000",
      // Budget 600.000 - 350.000.
      budgetRemaining: "250.000",
    });
    expect(summary).not.toHaveProperty("profit");
  });

  it("reports a negative margin and an overspent budget when costs exceed the job value", async () => {
    await newExpense({ amount: "1200.5" });

    expect(await financials()).toMatchObject({ operationalJobMargin: "-200.500", budgetRemaining: "-600.500" });
  });

  it("follows the job value when it is edited", async () => {
    await newExpense({ amount: "300" });
    await api().patch(`/api/projects/${project.id}`).set(admin.headers).send({ jobValue: "800.5" });

    expect(await financials()).toMatchObject({ trackedExpenses: "300.000", operationalJobMargin: "500.500" });
  });

  it("stores no total on the project: every figure comes from the expense rows", async () => {
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'projects'"
    );
    const names = columns.rows.map((column) => column.column_name);

    for (const derived of ["tracked_expenses", "total_expenses", "operational_job_margin", "margin", "profit", "budget_remaining"]) {
      expect(names).not.toContain(derived);
    }

    // Changing a row directly is reflected at once, with nothing to keep in step.
    const expense = await newExpense({ amount: "10" });
    await pool.query("UPDATE project_expenses SET amount = 25.5 WHERE id = $1", [expense.id]);
    expect((await financials()).trackedExpenses).toBe("25.500");
  });

  it("keeps each project's costs separate", async () => {
    const other = await newProject(admin, clientId, { jobValue: "500" });
    await newExpense({ amount: "100" });
    await newExpense({ projectId: other.id, amount: "40.25" });

    expect((await financials()).trackedExpenses).toBe("100.000");
    expect(await financials(other.id)).toMatchObject({ trackedExpenses: "40.250", operationalJobMargin: "459.750" });
  });
});

describe("read expenses", () => {
  it("lists expenses newest first with a total for the whole filtered set", async () => {
    const other = await newProject(admin, clientId, { description: "Second job" });
    await newExpense({ amount: "10.5", expenseDate: "2026-09-01", description: "Conduit", payeeName: "Alpha Traders" });
    await newExpense({ amount: "20.25", expenseDate: "2026-09-15", description: "Site labour", categoryId: labour, paymentReference: "CHQ-5" });
    await newExpense({ projectId: other.id, amount: "5", expenseDate: "2026-09-10", description: "Transport" });

    const all = await get("/api/expenses");
    const byProject = await get(`/api/expenses?projectId=${project.id}`);
    const byCategory = await get(`/api/expenses?categoryId=${labour}`);
    const byDates = await get("/api/expenses?dateFrom=2026-09-05&dateTo=2026-09-12");
    const byPayee = await get("/api/expenses?search=alpha");
    const byReference = await get("/api/expenses?search=chq-5");
    const byJob = await get("/api/expenses?search=GPSA0002");
    const paged = await get("/api/expenses?page=2&pageSize=2");

    expect(all.body.data.items.map((item: { description: string }) => item.description)).toEqual(["Site labour", "Transport", "Conduit"]);
    expect(all.body.data).toMatchObject({ total: 3, totalAmount: "35.750", page: 1, pageSize: 25 });
    expect(byProject.body.data).toMatchObject({ total: 2, totalAmount: "30.750" });
    expect(byCategory.body.data).toMatchObject({ total: 1, totalAmount: "20.250" });
    expect(byDates.body.data).toMatchObject({ total: 1, totalAmount: "5.000" });
    expect(byPayee.body.data.total).toBe(1);
    expect(byReference.body.data.total).toBe(1);
    expect(byJob.body.data.items.map((item: { description: string }) => item.description)).toEqual(["Transport"]);
    // The total is for every matching expense, not just the page shown.
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.totalAmount).toBe("35.750");
    expect((await get("/api/expenses?dateFrom=yesterday")).status).toBe(400);
  });

  it("returns one expense, and 404 for a missing or malformed id", async () => {
    const expense = await newExpense();

    expect((await get(`/api/expenses/${expense.id}`)).body.data.description).toBe("Cable and conduit");
    expect((await get("/api/expenses/999999")).status).toBe(404);
    expect((await get("/api/expenses/abc")).status).toBe(404);
  });
});

describe("update expense", () => {
  it("changes only the supplied fields, updates the project total and logs what changed", async () => {
    const expense = await newExpense({ amount: "100", notes: "keep" });

    const response = await patch(expense.id, { amount: "133.333", categoryId: labour, payeeName: "Site crew" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      amount: "133.333",
      categoryCode: "LABOUR",
      payeeName: "Site crew",
      description: "Cable and conduit",
      notes: "keep",
    });
    expect((await financials()).trackedExpenses).toBe("133.333");

    const logs = await logsFor("project_expenses", expense.id);
    expect(logs.map((log) => log.action)).toEqual(["expense.created", "expense.updated"]);
    expect(logs[1]?.metadata).toEqual({
      changes: {
        amount: { from: "100.000", to: "133.333" },
        categoryId: { from: materials, to: labour },
        payeeName: { from: null, to: "Site crew" },
      },
    });
  });

  it("can move an expense recorded against the wrong job, and both totals follow", async () => {
    const other = await newProject(admin, clientId, { jobValue: "500" });
    const expense = await newExpense({ amount: "80" });

    const moved = await patch(expense.id, { projectId: other.id });

    expect(moved.body.data).toMatchObject({ projectId: other.id, jobNumber: "GPSA0002" });
    expect((await financials()).trackedExpenses).toBe("0.000");
    expect((await financials(other.id)).trackedExpenses).toBe("80.000");
  });

  it("rejects an empty update, invalid values, a cancelled target project and an unknown expense", async () => {
    const cancelled = await newProject(admin, clientId);
    await setStatus(admin, cancelled.id, { status: "CANCELLED" });
    const expense = await newExpense({ amount: "10" });

    expect((await patch(expense.id, {})).status).toBe(400);
    expect((await patch(expense.id, { amount: "0" })).status).toBe(400);
    expect((await patch(expense.id, { description: "" })).status).toBe(400);
    expect((await patch(expense.id, { projectId: cancelled.id })).status).toBe(400);
    expect((await patch(expense.id, { voidReason: "x" })).status).toBe(400);
    expect((await patch("999999", { amount: "5" })).status).toBe(404);

    await patch(expense.id, { amount: "10.000" });
    expect((await logsFor("project_expenses", expense.id)).map((log) => log.action)).toEqual(["expense.created"]);
  });
});

describe("void expense", () => {
  it("voids instead of deleting, with a reason, and removes the amount from every total", async () => {
    const kept = await newExpense({ amount: "60" });
    const wrong = await newExpense({ amount: "40" });

    const response = await voidExpense(wrong.id, { reason: "Entered twice" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ isVoided: true, voidReason: "Entered twice", amount: "40.000" });
    expect(response.body.data.voidedAt).not.toBeNull();

    // The row still exists.
    const stored = await pool.query("SELECT voided_by, void_reason FROM project_expenses WHERE id = $1", [wrong.id]);
    expect(stored.rows[0]).toEqual({ voided_by: admin.id, void_reason: "Entered twice" });

    expect(await financials()).toMatchObject({ trackedExpenses: "60.000", operationalJobMargin: "940.000", budgetRemaining: "540.000" });

    const visible = await get("/api/expenses");
    const withVoided = await get("/api/expenses?includeVoided=true");
    expect(visible.body.data.items.map((item: { id: string }) => item.id)).toEqual([kept.id]);
    expect(withVoided.body.data.total).toBe(2);
    // A voided expense is shown on request but never counted.
    expect(withVoided.body.data.totalAmount).toBe("60.000");

    expect((await logsFor("project_expenses", wrong.id)).map((log) => log.action)).toEqual(["expense.created", "expense.voided"]);
  });

  it("requires a reason, and a voided expense cannot be voided again or edited", async () => {
    const expense = await newExpense();

    expect((await voidExpense(expense.id, {})).status).toBe(400);
    expect((await voidExpense(expense.id, { reason: "   " })).status).toBe(400);
    expect((await voidExpense("999999", { reason: "x" })).status).toBe(404);

    await voidExpense(expense.id, { reason: "Wrong job" });

    expect((await voidExpense(expense.id, { reason: "Again" })).status).toBe(409);
    expect((await patch(expense.id, { amount: "1" })).status).toBe(409);
  });

  it("offers no route that deletes an expense", async () => {
    const expense = await newExpense();

    expect((await api().delete(`/api/expenses/${expense.id}`).set(admin.headers)).status).toBe(404);
    expect((await pool.query("SELECT 1 FROM project_expenses WHERE id = $1", [expense.id])).rowCount).toBe(1);
  });

  it("is guarded by a database constraint: a void always has a user and a reason", async () => {
    const expense = await newExpense();

    await expect(pool.query("UPDATE project_expenses SET voided_at = now() WHERE id = $1", [expense.id])).rejects.toMatchObject({
      code: "23514",
      constraint: "project_expenses_voided_ck",
    });
  });
});

describe("expense permissions", () => {
  it("lets the Accountant record and edit expenses but not void them", async () => {
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);

    const created = await newExpense({ amount: "45" }, accountant);

    expect((await patch(created.id, { amount: "46" }, accountant)).status).toBe(200);
    expect((await get("/api/expenses/categories", accountant)).status).toBe(200);
    expect((await get("/api/projects/options", accountant)).status).toBe(200);

    const refused = await voidExpense(created.id, { reason: "Not allowed" }, accountant);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("FORBIDDEN");
    expect((await financials()).trackedExpenses).toBe("46.000");
  });

  it("lets a view-only role read expenses but not change them", async () => {
    const procurement = await signedIn("procurement@example.com", ["PROCUREMENT"]);
    const expense = await newExpense();

    expect((await get("/api/expenses", procurement)).status).toBe(200);
    expect((await get(`/api/expenses/${expense.id}`, procurement)).status).toBe(200);

    const attempts = [
      await postExpense(procurement, { projectId: project.id, categoryId: materials, expenseDate: "2026-09-10", description: "No", amount: "5" }),
      await patch(expense.id, { amount: "1" }, procurement),
      await voidExpense(expense.id, { reason: "No" }, procurement),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
    }
    expect((await financials()).trackedExpenses).toBe("100.000");
  });

  it("refuses a role without expense access, and anyone not signed in", async () => {
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);

    for (const path of ["/api/expenses", "/api/expenses/categories", "/api/expenses/1"]) {
      expect((await get(path, execution)).status, path).toBe(403);
      expect((await api().get(path)).status, path).toBe(401);
    }
    expect((await api().post("/api/expenses").send({})).status).toBe(401);
  });
});
