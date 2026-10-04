import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, signedIn } from "./helpers";
import { insertHistoricalProject } from "./historical-helpers";
import {
  categoryId,
  insertClient,
  newProject,
  postExpense,
  postProcurement,
  postProject,
  resetProjectData,
  setStatus,
  type Session,
} from "./projects-helpers";

// A historical project is a job imported from an earlier register. It keeps
// what the register said and is not operational work.

let admin: Session;
let clientId: string;

beforeEach(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await insertClient("Test Hotel One");
});
afterAll(closePool);

const get = (path: string, session: Session = admin) => api().get(path).set(session.headers);
const patch = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().patch(`/api/projects/${id}`).set(session.headers).send(body);
const summary = async (session: Session = admin) => (await get("/api/projects/summary", session)).body.data;

/** Raw insert, for rows the constraints must refuse. */
const insertRaw = (columns: Record<string, unknown>) => {
  const row = { job_number: "GPSA9000", client_id: clientId, description: "Job", job_date: "2025-02-01", job_value: "100", vat_rate: 5, ...columns };
  const names = Object.keys(row);

  return pool.query(
    `INSERT INTO projects (${names.join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(row)
  );
};

describe("historical project: what is stored", () => {
  it("keeps the source status and the month, with no completion date", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901", legacyStatus: "Completed", jobDate: "2025-02-01", jobValue: "500" });
    const stored = await pool.query(
      `SELECT job_number, status, legacy_status, job_date::text AS job_date, job_date_precision,
              completed_date, job_value, vat_amount, grand_value, created_by
       FROM projects WHERE id = $1`,
      [id]
    );

    expect(stored.rows[0]).toEqual({
      job_number: "GPSA0901",
      status: "HISTORICAL",
      legacy_status: "Completed",
      job_date: "2025-02-01",
      job_date_precision: "MONTH",
      completed_date: null,
      job_value: "500.000",
      vat_amount: "25.000",
      grand_value: "525.000",
      // Not created by a signed-in user.
      created_by: null,
    });
  });

  it("returns the source status and the date precision through the API", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0903", legacyStatus: "Not Completed", jobDate: "2025-10-01" });
    const response = await get(`/api/projects/${id}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      jobNumber: "GPSA0903",
      status: "HISTORICAL",
      legacyStatus: "Not Completed",
      jobDate: "2025-10-01",
      jobDatePrecision: "MONTH",
      completedDate: null,
      allowedStatuses: [],
      invoiceState: "HISTORICAL",
      readyForInvoice: false,
    });
  });

  it("gives an operational project no source status and a full date", async () => {
    const project = await newProject(admin, clientId);

    expect(project).toMatchObject({ status: "NEW", legacyStatus: null, jobDatePrecision: "DAY" });
  });
});

describe("historical project: database rules", () => {
  it("refuses a historical project without a source status", async () => {
    await expect(insertRaw({ status: "HISTORICAL" })).rejects.toMatchObject({ code: "23514", constraint: "projects_historical_ck" });
  });

  it("refuses a source status on an operational project", async () => {
    await expect(insertRaw({ status: "NEW", legacy_status: "Completed" })).rejects.toMatchObject({
      code: "23514",
      constraint: "projects_historical_ck",
    });
  });

  it("refuses a blank or padded source status", async () => {
    await expect(insertRaw({ status: "HISTORICAL", legacy_status: " " })).rejects.toMatchObject({ code: "23514" });
    await expect(insertRaw({ status: "HISTORICAL", legacy_status: "Completed " })).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a month-only date on an operational project", async () => {
    await expect(insertRaw({ status: "NEW", job_date_precision: "MONTH" })).rejects.toMatchObject({
      code: "23514",
      constraint: "projects_job_date_month_ck",
    });
  });

  it("refuses a month-only date that is not the first of the month", async () => {
    await expect(
      insertRaw({ status: "HISTORICAL", legacy_status: "Completed", job_date: "2025-02-15", job_date_precision: "MONTH" })
    ).rejects.toMatchObject({ code: "23514", constraint: "projects_job_date_month_ck" });
  });

  it("refuses an unknown date precision", async () => {
    await expect(insertRaw({ job_date_precision: "YEAR" })).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a completion date on a historical project, and a completed project without one", async () => {
    await expect(
      insertRaw({ status: "HISTORICAL", legacy_status: "Completed", completed_date: "2025-02-20" })
    ).rejects.toMatchObject({ code: "23514", constraint: "projects_completed_date_ck" });
    await expect(insertRaw({ status: "COMPLETED" })).rejects.toMatchObject({ code: "23514", constraint: "projects_completed_date_ck" });
  });

  it("cannot be turned operational, or an operational project historical, by a direct update", async () => {
    const historical = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    const operational = await newProject(admin, clientId);

    await expect(pool.query("UPDATE projects SET status = 'NEW' WHERE id = $1", [historical])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE projects SET status = 'HISTORICAL' WHERE id = $1", [operational.id])).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("keeps the job number unique across historical and operational projects", async () => {
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });

    await expect(insertHistoricalProject(clientId, { jobNumber: "GPSA0901" })).rejects.toMatchObject({
      code: "23505",
      constraint: "projects_job_number_uq",
    });
  });
});

describe("historical project: read-only in the application", () => {
  it("cannot be created through the API", async () => {
    const withStatus = await postProject(admin, { clientId, description: "Job", jobDate: "2025-02-01", jobValue: "100", status: "HISTORICAL" });
    const withLegacy = await postProject(admin, { clientId, description: "Job", jobDate: "2025-02-01", jobValue: "100", legacyStatus: "Completed" });
    const withPrecision = await postProject(admin, { clientId, description: "Job", jobDate: "2025-02-01", jobValue: "100", jobDatePrecision: "MONTH" });

    expect([withStatus.status, withLegacy.status, withPrecision.status]).toEqual([400, 400, 400]);
    expect((await pool.query("SELECT 1 FROM projects")).rowCount).toBe(0);
  });

  it("cannot be edited", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901", jobValue: "500" });

    for (const body of [{ jobValue: "999" }, { notes: "Changed" }, { jobDate: "2025-02-15" }, { description: "Changed" }]) {
      const response = await patch(id, body);

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/historical record/);
    }

    const stored = await pool.query("SELECT job_value, notes, job_date::text AS job_date, description FROM projects WHERE id = $1", [id]);
    expect(stored.rows[0]).toEqual({ job_value: "500.000", notes: null, job_date: "2025-02-01", description: "Historical job" });
  });

  it("cannot be given the source status or precision fields by an edit of an operational project", async () => {
    const project = await newProject(admin, clientId);

    expect((await patch(project.id, { legacyStatus: "Completed" })).status).toBe(400);
    expect((await patch(project.id, { jobDatePrecision: "MONTH" })).status).toBe(400);
    expect((await patch(project.id, { status: "HISTORICAL" })).status).toBe(400);
  });

  it("cannot be moved to any operational status", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0903", legacyStatus: "Not Completed" });

    for (const status of ["NEW", "IN_PROGRESS", "COMPLETED", "CANCELLED"]) {
      const response = await setStatus(admin, id, { status });

      expect(response.status).toBe(409);
      expect(response.body.error.message).toMatch(/historical record/);
    }

    expect((await pool.query("SELECT status, completed_date FROM projects WHERE id = $1", [id])).rows[0]).toEqual({
      status: "HISTORICAL",
      completed_date: null,
    });
  });

  it("cannot be reached from an operational project: HISTORICAL is not a status a user can set", async () => {
    const project = await newProject(admin, clientId);
    const response = await setStatus(admin, project.id, { status: "HISTORICAL" });

    expect(response.status).toBe(400);
    expect((await get(`/api/projects/${project.id}`)).body.data.status).toBe("NEW");
  });

  it("takes no new expense or procurement request", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    const expense = await postExpense(admin, {
      projectId: id,
      categoryId: await categoryId("MATERIALS"),
      expenseDate: "2026-09-02",
      description: "Cost",
      amount: "10",
    });
    const procurement = await postProcurement(admin, { projectId: id, description: "Item", requestDate: "2026-09-05" });

    expect(expense.status).toBe(400);
    expect(expense.body.error.details).toEqual([expect.objectContaining({ field: "projectId", message: expect.stringMatching(/historical record/) })]);
    expect(procurement.status).toBe(400);
    expect((await pool.query("SELECT 1 FROM project_expenses UNION ALL SELECT 1 FROM procurement_requests")).rowCount).toBe(0);
  });

  it("writes nothing to the activity log when a change is refused", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });

    await patch(id, { notes: "Changed" });
    await setStatus(admin, id, { status: "COMPLETED" });

    expect((await pool.query("SELECT 1 FROM activity_logs WHERE entity_type = 'projects' AND entity_id = $1", [id])).rowCount).toBe(0);
  });
});

describe("historical project: never ready for invoice", () => {
  it("has the HISTORICAL invoice state whatever its source status or value", async () => {
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0901", legacyStatus: "Completed", jobValue: "500" });
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0902", legacyStatus: "Completed", jobValue: "0" });
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0903", legacyStatus: "Not Completed", jobValue: "18000" });

    const states = await pool.query<{ job_number: string; invoice_state: string }>(
      "SELECT p.job_number, f.invoice_state FROM projects p JOIN v_project_financials f ON f.project_id = p.id ORDER BY p.job_number"
    );

    expect(states.rows).toEqual([
      { job_number: "GPSA0901", invoice_state: "HISTORICAL" },
      { job_number: "GPSA0902", invoice_state: "HISTORICAL" },
      { job_number: "GPSA0903", invoice_state: "HISTORICAL" },
    ]);
  });

  it("is left out of the ready-for-invoice and no-invoice-required lists, and found by its own filters", async () => {
    const done = await newProject(admin, clientId, { jobValue: "2000" });
    await setStatus(admin, done.id, { status: "COMPLETED" });
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0901", jobValue: "500" });
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0902", jobValue: "0" });

    const numbers = async (query: string) =>
      ((await get(`/api/projects?${query}`)).body.data.items as { jobNumber: string }[]).map((item) => item.jobNumber).sort();

    expect(await numbers("invoiceState=READY_FOR_INVOICE")).toEqual([done.jobNumber]);
    expect(await numbers("invoiceState=NO_INVOICE_REQUIRED")).toEqual([]);
    expect(await numbers("status=COMPLETED")).toEqual([done.jobNumber]);
    expect(await numbers("status=HISTORICAL")).toEqual(["GPSA0901", "GPSA0902"]);
    expect(await numbers("invoiceState=HISTORICAL")).toEqual(["GPSA0901", "GPSA0902"]);
    // Still visible in the unfiltered list.
    expect(await numbers("")).toEqual(["GPSA0901", "GPSA0902", done.jobNumber].sort());
  });
});

describe("historical project: summary figures", () => {
  it("leaves every operational count and total exactly as it was", async () => {
    const open = await newProject(admin, clientId, { jobValue: "1000" });
    const done = await newProject(admin, clientId, { jobValue: "2000.250" });
    await postExpense(admin, { projectId: open.id, categoryId: await categoryId("MATERIALS"), expenseDate: "2026-09-02", description: "Cost", amount: "100.125" });
    await setStatus(admin, done.id, { status: "COMPLETED" });

    const before = await summary();

    await insertHistoricalProject(clientId, { jobNumber: "GPSA0901", legacyStatus: "Completed", jobValue: "500" });
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0903", legacyStatus: "Not Completed", jobValue: "18000" });

    const after = await summary();

    expect(after.counts).toEqual({ ...before.counts, total: before.counts.total + 2, historical: 2 });
    expect(after.values).toEqual({ ...before.values, historicalJobValue: "18500.000", historicalGrandValue: "19425.000" });
    expect(after.costs).toEqual(before.costs);

    // The operational figures, stated outright.
    expect(after.counts).toMatchObject({ active: 1, new: 1, inProgress: 0, completed: 1, readyForInvoice: 1, noInvoiceRequired: 0 });
    expect(after.values).toMatchObject({ totalJobValue: "3000.250", readyForInvoiceValue: "2000.250" });
    expect(after.costs).toMatchObject({
      trackedExpenses: "100.125",
      operationalJobMargin: "2900.125",
      trackedExpensesOnHistoricalProjects: "0.000",
    });
  });

  it("reports zero historical figures when there are none", async () => {
    const data = await summary();

    expect(data.counts.historical).toBe(0);
    expect(data.values).toMatchObject({ historicalJobValue: "0.000", historicalGrandValue: "0.000" });
  });

  it("does not disclose costs of historical projects without EXPENSES:VIEW", async () => {
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);
    const data = await summary(execution);

    expect(data.counts.historical).toBe(1);
    expect(data.costs).toBeNull();
  });
});

describe("historical project: job margin", () => {
  it("calculates the margin of a historical project the same way: job value minus recorded expenses", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901", jobValue: "500" });
    const project = (await get(`/api/projects/${id}`)).body.data;

    expect(project).toMatchObject({ jobValue: "500.000", trackedExpenses: "0.000", operationalJobMargin: "500.000" });
  });

  it("leaves the margin of an operational project unchanged", async () => {
    const project = await newProject(admin, clientId, { jobValue: "1000" });
    await postExpense(admin, { projectId: project.id, categoryId: await categoryId("MATERIALS"), expenseDate: "2026-09-02", description: "Cost", amount: "300.5" });
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });

    expect((await get(`/api/projects/${project.id}`)).body.data).toMatchObject({ trackedExpenses: "300.500", operationalJobMargin: "699.500" });
  });
});

describe("operational projects are unchanged", () => {
  it("creates, edits, completes and reopens a project as before", async () => {
    const project = await newProject(admin, clientId, { jobValue: "1000" });

    expect(project).toMatchObject({ jobNumber: "GPSA0001", status: "NEW", invoiceState: "NOT_READY" });
    expect((await patch(project.id, { jobValue: "1200", notes: "Revised" })).body.data).toMatchObject({ jobValue: "1200.000", notes: "Revised" });

    const completed = await setStatus(admin, project.id, { status: "COMPLETED", completedDate: "2026-09-20" });
    expect(completed.body.data).toMatchObject({
      status: "COMPLETED",
      completedDate: "2026-09-20",
      invoiceState: "READY_FOR_INVOICE",
      readyForInvoice: true,
      allowedStatuses: ["IN_PROGRESS"],
    });

    const reopened = await setStatus(admin, project.id, { status: "IN_PROGRESS" });
    expect(reopened.body.data).toMatchObject({ status: "IN_PROGRESS", completedDate: null, invoiceState: "NOT_READY" });
  });

  it("never issues a job number that a historical project already holds", async () => {
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0001" });
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0002" });

    expect((await newProject(admin, clientId)).jobNumber).toBe("GPSA0003");
  });

  it("offers a historical project in the job picker data with its status, so the form can leave it out", async () => {
    await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    const options = (await get("/api/projects/options")).body.data as { jobNumber: string; status: string }[];

    expect(options).toEqual([expect.objectContaining({ jobNumber: "GPSA0901", status: "HISTORICAL" })]);
  });
});

describe("historical project: permissions", () => {
  it("is visible to every role that may view projects, and to no one else", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);

    await pool.query("INSERT INTO roles (code, name) VALUES ('NO_PROJECTS', 'No projects')");
    const outsider = await signedIn("outsider@example.com", ["NO_PROJECTS"]);

    expect((await get(`/api/projects/${id}`, execution)).status).toBe(200);
    expect((await get(`/api/projects/${id}`, outsider)).status).toBe(403);
    expect((await api().get(`/api/projects/${id}`)).status).toBe(401);
  });

  it("is refused to a user without edit permission before the historical rule is reached, and to an admin by that rule", async () => {
    const id = await insertHistoricalProject(clientId, { jobNumber: "GPSA0901" });
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);

    expect((await patch(id, { notes: "Changed" }, execution)).status).toBe(403);
    expect((await setStatus(execution, id, { status: "COMPLETED" })).status).toBe(403);
    expect((await patch(id, { notes: "Changed" })).status).toBe(409);
  });
});
