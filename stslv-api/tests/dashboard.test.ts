import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { addDays } from "../src/modules/amc/amc.schedule";
import { activeContract, createClient, createContract, today, visitsOf } from "./amc-helpers";
import { api, closePool, signedIn } from "./helpers";
import { categoryId, insertClient, newProject, postExpense, resetProjectData, setStatus, type Session } from "./projects-helpers";

// GET /api/dashboard/summary puts the figures of the Clients, AMC and Projects
// modules side by side. These tests check every figure against the base tables
// with SQL written here, not against the views or services the API reads.

let admin: Session;

const dashboard = (session: Session = admin) => api().get("/api/dashboard/summary").set(session.headers);

const one = async <T extends Record<string, unknown>>(sql: string): Promise<T> => (await pool.query<T>(sql)).rows[0] as T;

/** Creates a role holding exactly the given permissions, and a signed-in user with that role. */
async function userWith(code: string, permissions: string[]): Promise<Session> {
  await pool.query("INSERT INTO roles (code, name) VALUES ($1, $1)", [code]);

  for (const permission of permissions) {
    const [module, action] = permission.split(":");

    await pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, $2, $3 FROM roles WHERE code = $1", [
      code,
      module,
      action,
    ]);
  }

  return signedIn(`${code.toLowerCase()}@example.com`, [code]);
}

beforeAll(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);

  const now = await today();
  const execute = (id: string, body: Record<string, unknown>) =>
    api().patch(`/api/amc/execution/visits/${id}`).set(admin.headers).send(body);
  const setAmount = (id: string, visitAmount: string) =>
    api().patch(`/api/amc/visits/${id}`).set(admin.headers).send({ visitAmount });

  // --- Clients: two active, one inactive.
  const client = await createClient(admin, "Test Hotel One");
  await insertClient("Test Tower Two");
  await insertClient("Closed Client", false);

  // --- AMC.
  // W: monthly around today. Visits about 40 and 10 days ago, and 20, 50 and 80 days ahead.
  const w = await activeContract(admin, client, {
    systemDescription: "W",
    validFrom: addDays(now, -40),
    validTo: addDays(now, 100),
    maintenanceFrequency: "MONTHLY",
    defaultVisitAmount: "100.125",
  });
  const [w1, w2, w3, w4, w5] = await visitsOf(w);
  void w2; // left scheduled in the past: due
  await execute(w1?.id as string, { status: "COMPLETED", completedDate: now }); // ready for invoice, 100.125
  await execute(w3?.id as string, { status: "IN_PROGRESS" }); // planned ahead: not due
  await setAmount(w4?.id as string, "250.5");
  await execute(w4?.id as string, { status: "COMPLETED", completedDate: now }); // ready for invoice, 250.500
  await setAmount(w5?.id as string, "0");
  await execute(w5?.id as string, { status: "COMPLETED", completedDate: now }); // zero value: nothing to invoice

  // X: a draft. Not active, no visits.
  await createContract(admin, client, { systemDescription: "X" });

  // Y: active, no default amount. Its one visit is completed without an amount: not invoiceable yet.
  const y = await activeContract(admin, client, {
    systemDescription: "Y",
    validFrom: "2024-01-01",
    validTo: "2024-12-31",
    maintenanceFrequency: "ANNUALLY",
    defaultVisitAmount: null,
  });
  await execute((await visitsOf(y))[0]?.id as string, { status: "COMPLETED", completedDate: "2024-01-15" });

  // Z: cancelled, its four past visits left scheduled. They are not due and the contract is not active.
  const z = await activeContract(admin, client, { systemDescription: "Z", validFrom: "2025-01-01", validTo: "2025-12-31" });
  await api().post(`/api/amc/contracts/${z}/status`).set(admin.headers).send({ status: "CANCELLED" });

  // --- Projects and expenses.
  const open = await newProject(admin, client, { jobValue: "1000" });
  const started = await newProject(admin, client, { jobValue: "500.5" });
  const done = await newProject(admin, client, { jobValue: "2000.250" });
  const zero = await newProject(admin, client, { jobValue: "0" });
  const cancelled = await newProject(admin, client, { jobValue: "9999" });
  const materials = await categoryId("MATERIALS");
  const expense = (projectId: string, amount: string) =>
    postExpense(admin, { projectId, categoryId: materials, expenseDate: "2026-09-02", description: "Cost", amount });

  await expense(open.id, "100.125");
  await expense(done.id, "250");
  await expense(cancelled.id, "40");
  const mistake = await expense(open.id, "77.777");
  await api().post(`/api/expenses/${mistake.body.data.id}/void`).set(admin.headers).send({ reason: "Entered twice" });

  await setStatus(admin, started.id, { status: "IN_PROGRESS" });
  await setStatus(admin, done.id, { status: "COMPLETED" }); // ready for invoice, 2000.250 excluding VAT
  await setStatus(admin, zero.id, { status: "COMPLETED" }); // zero value: nothing to invoice
  await setStatus(admin, cancelled.id, { status: "CANCELLED" });
});
afterAll(closePool);

describe("dashboard figures", () => {
  it("counts clients from the clients table", async () => {
    const expected = await one<{ active: number; inactive: number }>(
      "SELECT count(*) FILTER (WHERE is_active)::int AS active, count(*) FILTER (WHERE NOT is_active)::int AS inactive FROM clients"
    );
    const response = await dashboard();

    expect(response.status).toBe(200);
    expect(response.body.data.clients).toEqual(expected);
    expect(response.body.data.clients).toEqual({ active: 2, inactive: 1 });
  });

  it("counts active contracts: draft and cancelled contracts are left out", async () => {
    const expected = await one<{ n: number }>("SELECT count(*)::int AS n FROM amc_contracts WHERE status = 'ACTIVE'");
    const { contracts } = (await dashboard()).body.data.amc;

    expect(contracts.active).toBe(expected.n);
    expect(contracts).toMatchObject({ active: 2, activePastValidity: 1, draft: 1, cancelled: 1 });
  });

  it("counts visits due: outstanding, planned today or earlier, on a contract that is not cancelled", async () => {
    const expected = await one<{ due: number; overdue: number }>(
      `SELECT count(*)::int AS due,
              count(*) FILTER (WHERE v.status <> 'IN_PROGRESS' AND v.scheduled_date < current_date)::int AS overdue
       FROM amc_visits v
       JOIN amc_contracts c ON c.id = v.amc_contract_id
       WHERE v.status NOT IN ('COMPLETED', 'CANCELLED') AND c.status <> 'CANCELLED' AND v.scheduled_date <= current_date`
    );
    const { visits } = (await dashboard()).body.data.amc;

    expect(visits.due).toBe(expected.due);
    expect(visits.overdue).toBe(expected.overdue);
    // Only W's second visit. The four past visits of the cancelled contract are not due.
    expect(visits).toMatchObject({ due: 1, overdue: 1 });
  });

  it("reports AMC visits ready for invoice and their amount, without zero-value or unpriced visits", async () => {
    const expected = await one<{ n: number; amount: string }>(
      `SELECT count(*)::int AS n, COALESCE(sum(visit_amount), 0)::numeric(16,3)::text AS amount
       FROM amc_visits WHERE status = 'COMPLETED' AND visit_amount > 0`
    );
    const { invoicing } = (await dashboard()).body.data.amc;

    expect(invoicing.readyForInvoice).toEqual({ count: expected.n, amount: expected.amount });
    expect(invoicing).toEqual({
      readyForInvoice: { count: 2, amount: "350.625" },
      amountRequired: { count: 1 },
      noInvoiceRequired: { count: 1 },
    });
  });

  it("counts active projects: new or in progress", async () => {
    const expected = await one<{ n: number }>("SELECT count(*)::int AS n FROM projects WHERE status IN ('NEW', 'IN_PROGRESS')");
    const { counts } = (await dashboard()).body.data.projects;

    expect(counts.active).toBe(expected.n);
    expect(counts).toMatchObject({ active: 2, new: 1, inProgress: 1, completed: 2, cancelled: 1 });
  });

  it("reports projects ready for invoice and their job value excluding VAT, without zero-value projects", async () => {
    const expected = await one<{ n: number; job_value: string; grand_value: string }>(
      `SELECT count(*)::int AS n,
              COALESCE(sum(job_value), 0)::numeric(18,3)::text AS job_value,
              COALESCE(sum(grand_value), 0)::numeric(18,3)::text AS grand_value
       FROM projects WHERE status = 'COMPLETED' AND job_value > 0`
    );
    const { counts, values } = (await dashboard()).body.data.projects;

    expect(counts.readyForInvoice).toBe(expected.n);
    expect(counts).toMatchObject({ readyForInvoice: 1, noInvoiceRequired: 1 });
    expect(values.readyForInvoiceValue).toBe(expected.job_value);
    expect(values.readyForInvoiceValue).toBe("2000.250");
    // The figure is the job value: VAT is not part of it.
    expect(expected.grand_value).toBe("2100.263");
    expect(values.readyForInvoiceValue).not.toBe(expected.grand_value);
  });

  it("reports tracked expenses without voided expenses, and those of cancelled projects apart", async () => {
    const expected = await one<{ tracked: string; on_cancelled: string }>(
      `SELECT COALESCE(sum(e.amount) FILTER (WHERE p.status <> 'CANCELLED'), 0)::numeric(18,3)::text AS tracked,
              COALESCE(sum(e.amount) FILTER (WHERE p.status = 'CANCELLED'), 0)::numeric(18,3)::text AS on_cancelled
       FROM project_expenses e
       JOIN projects p ON p.id = e.project_id
       WHERE e.voided_at IS NULL`
    );
    const { costs } = (await dashboard()).body.data.projects;

    expect(costs.trackedExpenses).toBe(expected.tracked);
    expect(costs.trackedExpensesOnCancelledProjects).toBe(expected.on_cancelled);
    // 100.125 + 250.000. The voided 77.777 and the cancelled project's 40.000 are not in it.
    expect(costs).toMatchObject({ trackedExpenses: "350.125", trackedExpensesOnCancelledProjects: "40.000" });
  });

  it("returns every amount as a three-decimal string, never as a number", async () => {
    const { amc, projects } = (await dashboard()).body.data;
    const amounts = [
      amc.invoicing.readyForInvoice.amount,
      projects.values.readyForInvoiceValue,
      projects.values.totalJobValue,
      projects.values.totalGrandValue,
      projects.costs.trackedExpenses,
      projects.costs.operationalJobMargin,
      projects.costs.trackedExpensesOnCancelledProjects,
    ];

    for (const amount of amounts) {
      expect(amount).toEqual(expect.stringMatching(/^-?\d+\.\d{3}$/));
    }
  });

  it("keeps the AMC and project ready-for-invoice amounts apart: no combined total is returned", async () => {
    const body = JSON.stringify((await dashboard()).body.data);

    // 350.625 (AMC, as entered) + 2000.250 (projects, excluding VAT) would be 2350.875.
    expect(body).toContain('"350.625"');
    expect(body).toContain('"2000.250"');
    expect(body).not.toContain("2350.875");
    expect(Object.keys((await dashboard()).body.data).sort()).toEqual(["amc", "clients", "projects"]);
  });

  it("returns exactly what the AMC and Projects modules report themselves", async () => {
    const data = (await dashboard()).body.data;

    expect(data.amc).toEqual((await api().get("/api/amc/summary").set(admin.headers)).body.data);
    expect(data.projects).toEqual((await api().get("/api/projects/summary").set(admin.headers)).body.data);
  });
});

describe("dashboard permissions", () => {
  it("requires a signed-in user who may view the dashboard", async () => {
    expect((await api().get("/api/dashboard/summary")).status).toBe(401);
    expect((await dashboard(await userWith("NO_DASHBOARD", ["CLIENTS:VIEW", "PROJECTS:VIEW"]))).status).toBe(403);
  });

  it("returns no figure at all to a user who may view only the dashboard", async () => {
    const response = await dashboard(await userWith("DASHBOARD_ONLY", ["DASHBOARD:VIEW"]));

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ clients: null, amc: null, projects: null });
  });

  it("does not open any operational figure to the Invoice Tracking permission", async () => {
    const response = await dashboard(await userWith("INVOICES_ONLY", ["DASHBOARD:VIEW", "INVOICES:VIEW", "INVOICES:EDIT", "REPORTS:VIEW"]));

    expect(response.body.data).toEqual({ clients: null, amc: null, projects: null });
  });

  it("returns client counts only with CLIENTS:VIEW", async () => {
    const withClients = await dashboard(await userWith("CLIENTS_ONLY", ["DASHBOARD:VIEW", "CLIENTS:VIEW"]));
    const withoutClients = await dashboard(
      await userWith("NO_CLIENTS", ["DASHBOARD:VIEW", "AMC_CONTRACTS:VIEW", "AMC_SCHEDULE:VIEW", "PROJECTS:VIEW", "EXPENSES:VIEW"])
    );

    expect(withClients.body.data).toEqual({ clients: { active: 2, inactive: 1 }, amc: null, projects: null });
    expect(withoutClients.body.data.clients).toBeNull();
    expect(withoutClients.body.data.amc).not.toBeNull();
    expect(withoutClients.body.data.projects).not.toBeNull();
  });

  it("returns only the contract counts with AMC_CONTRACTS:VIEW", async () => {
    const { amc, projects, clients } = (await dashboard(await userWith("CONTRACTS_ONLY", ["DASHBOARD:VIEW", "AMC_CONTRACTS:VIEW"]))).body.data;

    expect(amc.contracts).toMatchObject({ active: 2 });
    expect(amc.visits).toBeNull();
    expect(amc.invoicing).toBeNull();
    expect(projects).toBeNull();
    expect(clients).toBeNull();
  });

  it("returns visits due with AMC_EXECUTION:VIEW alone, but no amounts and no contract counts", async () => {
    const response = await dashboard(await userWith("EXECUTION_ONLY", ["DASHBOARD:VIEW", "AMC_EXECUTION:VIEW"]));
    const { amc } = response.body.data;

    expect(amc.visits).toMatchObject({ due: 1, overdue: 1 });
    expect(amc.contracts).toBeNull();
    expect(amc.invoicing).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain("350.625");
  });

  it("returns visits due and the ready-for-invoice figures with AMC_SCHEDULE:VIEW alone", async () => {
    const { amc } = (await dashboard(await userWith("SCHEDULE_ONLY", ["DASHBOARD:VIEW", "AMC_SCHEDULE:VIEW"]))).body.data;

    expect(amc.visits).toMatchObject({ due: 1 });
    expect(amc.invoicing.readyForInvoice).toEqual({ count: 2, amount: "350.625" });
    expect(amc.contracts).toBeNull();
  });

  it("returns no AMC figure to a user with project permissions only", async () => {
    const response = await dashboard(await userWith("PROJECTS_ONLY", ["DASHBOARD:VIEW", "PROJECTS:VIEW"]));
    const { amc, projects } = response.body.data;

    expect(amc).toBeNull();
    expect(projects.counts).toMatchObject({ active: 2, readyForInvoice: 1 });
    expect(projects.values.readyForInvoiceValue).toBe("2000.250");
    // Costs need EXPENSES:VIEW as well.
    expect(projects.costs).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain("350.125");
  });

  it("returns no project figure, costs included, to a user with EXPENSES:VIEW but not PROJECTS:VIEW", async () => {
    const response = await dashboard(await userWith("EXPENSES_ONLY", ["DASHBOARD:VIEW", "EXPENSES:VIEW"]));

    expect(response.body.data.projects).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain("350.125");
  });

  it("returns tracked expenses to a user with both PROJECTS:VIEW and EXPENSES:VIEW", async () => {
    const { projects } = (await dashboard(await userWith("PROJECT_COSTS", ["DASHBOARD:VIEW", "PROJECTS:VIEW", "EXPENSES:VIEW"]))).body.data;

    expect(projects.costs).toMatchObject({ trackedExpenses: "350.125" });
  });

  it("gives each seeded role the figures of the modules it may view", async () => {
    const invoicing = (await dashboard(await signedIn("invoicing@example.com", ["INVOICING"]))).body.data;
    const procurement = (await dashboard(await signedIn("procurement@example.com", ["PROCUREMENT"]))).body.data;
    const execution = (await dashboard(await signedIn("execution@example.com", ["EXECUTION"]))).body.data;

    // Invoicing: AMC contracts and schedule, projects without costs.
    expect(invoicing.amc.invoicing.readyForInvoice).toEqual({ count: 2, amount: "350.625" });
    expect(invoicing.projects.values.readyForInvoiceValue).toBe("2000.250");
    expect(invoicing.projects.costs).toBeNull();

    // Procurement: no AMC, projects with costs.
    expect(procurement.amc).toBeNull();
    expect(procurement.projects.costs).toMatchObject({ trackedExpenses: "350.125" });

    // Execution: AMC, projects without costs.
    expect(execution.amc.visits).toMatchObject({ due: 1 });
    expect(execution.projects.costs).toBeNull();
  });
});

describe("dashboard with no records", () => {
  it("returns real zeros, as numbers and three-decimal strings", async () => {
    await resetProjectData();
    const freshAdmin = await signedIn("admin@example.com", ["ADMIN"]);
    const { clients, amc, projects } = (await dashboard(freshAdmin)).body.data;

    expect(clients).toEqual({ active: 0, inactive: 0 });
    expect(amc.contracts).toMatchObject({ active: 0 });
    expect(amc.visits).toMatchObject({ due: 0, overdue: 0 });
    expect(amc.invoicing.readyForInvoice).toEqual({ count: 0, amount: "0.000" });
    expect(projects.counts).toMatchObject({ active: 0, readyForInvoice: 0 });
    expect(projects.values.readyForInvoiceValue).toBe("0.000");
    expect(projects.costs.trackedExpenses).toBe("0.000");
  });
});
