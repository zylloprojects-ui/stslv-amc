import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../src/config/database";
import { api, closePool, signedIn } from "./helpers";
import {
  categoryId,
  insertClient,
  logsFor,
  newProject,
  postExpense,
  postProject,
  resetProjectData,
  setStatus,
  today,
  type Session,
} from "./projects-helpers";

let admin: Session;
let clientId: string;

beforeEach(async () => {
  await resetProjectData();
  admin = await signedIn("admin@example.com", ["ADMIN"]);
  clientId = await insertClient("IBIS");
});
afterAll(closePool);

const get = (path: string, session: Session = admin) => api().get(path).set(session.headers);
const patch = (id: string, body: Record<string, unknown>, session: Session = admin) =>
  api().patch(`/api/projects/${id}`).set(session.headers).send(body);

describe("create project", () => {
  it("saves the project to PostgreSQL with a generated job number and calculated VAT", async () => {
    const response = await postProject(admin, {
      clientId,
      description: "  CCTV camera replacement  ",
      jobDate: "2026-09-15",
      lpoNumber: "LPO-771",
      lpoDate: "2026-09-10",
      jobValue: "1000",
      budgetAmount: "600.5",
      notes: "",
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      jobNumber: "GPSA0001",
      clientId,
      clientName: "IBIS",
      description: "CCTV camera replacement",
      jobDate: "2026-09-15",
      lpoNumber: "LPO-771",
      lpoDate: "2026-09-10",
      jobValue: "1000.000",
      vatRate: "5.000",
      vatAmount: "50.000",
      grandValue: "1050.000",
      budgetAmount: "600.500",
      status: "NEW",
      completedDate: null,
      notes: null,
      invoiceState: "NOT_READY",
      readyForInvoice: false,
      trackedExpenses: "0.000",
      operationalJobMargin: "1000.000",
      budgetRemaining: "600.500",
    });

    const stored = await pool.query(
      "SELECT job_number, job_value, vat_rate, vat_amount, grand_value, created_by, updated_by FROM projects WHERE id = $1",
      [response.body.data.id]
    );
    expect(stored.rows[0]).toEqual({
      job_number: "GPSA0001",
      job_value: "1000.000",
      vat_rate: "5.000",
      vat_amount: "50.000",
      grand_value: "1050.000",
      created_by: admin.id,
      updated_by: admin.id,
    });

    expect(await logsFor("projects", response.body.data.id)).toMatchObject([
      { action: "project.created", user_id: admin.id, module: "PROJECTS", metadata: { jobNumber: "GPSA0001", vatAmount: "50.000" } },
    ]);
  });

  it("rejects invalid data with field-level messages", async () => {
    const missing = await postProject(admin, {});
    const blank = await postProject(admin, { clientId, description: "   ", jobDate: "2026-09-01", jobValue: "10" });
    const badDate = await postProject(admin, { clientId, description: "Job", jobDate: "2026-02-30", jobValue: "10" });
    const unknownField = await postProject(admin, { clientId, description: "Job", jobDate: "2026-09-01", jobValue: "10", status: "COMPLETED" });
    const ownJobNumber = await postProject(admin, { clientId, description: "Job", jobDate: "2026-09-01", jobValue: "10", jobNumber: "GPSA9999" });
    const ownVatAmount = await postProject(admin, { clientId, description: "Job", jobDate: "2026-09-01", jobValue: "10", vatAmount: "0" });

    for (const response of [missing, blank, badDate, unknownField, ownJobNumber, ownVatAmount]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(missing.body.error.details).toEqual(
      expect.arrayContaining([
        { field: "clientId", message: "Client is required." },
        { field: "description", message: "Job description is required." },
        { field: "jobDate", message: "Job date is required." },
        { field: "jobValue", message: "Job value is required." },
      ])
    );
    expect(badDate.body.error.details).toEqual([{ field: "jobDate", message: "Job date must be a valid date (YYYY-MM-DD)." }]);
    expect((await pool.query("SELECT 1 FROM projects")).rowCount).toBe(0);
  });

  it("requires an existing, active client from the Client Master", async () => {
    const inactive = await insertClient("Closed Client", false);
    const unknown = await postProject(admin, { clientId: "999999", description: "Job", jobDate: "2026-09-01", jobValue: "10" });
    const closed = await postProject(admin, { clientId: inactive, description: "Job", jobDate: "2026-09-01", jobValue: "10" });
    const freeText = await postProject(admin, { clientId: "IBIS", description: "Job", jobDate: "2026-09-01", jobValue: "10" });

    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([{ field: "clientId", message: "The selected client does not exist." }]);
    expect(closed.status).toBe(400);
    expect(closed.body.error.details[0].field).toBe("clientId");
    expect(freeText.status).toBe(400);
    expect(freeText.body.error.details).toEqual([{ field: "clientId", message: "Select a client." }]);
  });
});

describe("job number", () => {
  it("issues consecutive, unique numbers", async () => {
    const numbers = [];

    for (let index = 0; index < 3; index += 1) {
      numbers.push((await newProject(admin, clientId)).jobNumber);
    }

    expect(numbers).toEqual(["GPSA0001", "GPSA0002", "GPSA0003"]);
  });

  it("never issues the same number twice when projects are created at the same moment", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        postProject(admin, { clientId, description: `Concurrent job ${index}`, jobDate: "2026-09-01", jobValue: "10" })
      )
    );
    const numbers = responses.map((response) => response.body.data?.jobNumber as string);

    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(new Set(numbers).size).toBe(8);
    expect([...numbers].sort()).toEqual(Array.from({ length: 8 }, (_, index) => `GPSA000${index + 1}`));
  });

  it("skips a number that is already used and never reuses it", async () => {
    // A job number that arrived another way, for example a future import of legacy jobs.
    await pool.query(
      "INSERT INTO projects (job_number, client_id, description, job_date, job_value, vat_rate) VALUES ('GPSA0002', $1, 'Legacy job', '2025-01-01', 10, 5)",
      [clientId]
    );

    const first = await newProject(admin, clientId);
    const second = await newProject(admin, clientId);

    expect([first.jobNumber, second.jobNumber]).toEqual(["GPSA0001", "GPSA0003"]);
  });

  it("does not use up a number when the project is not saved", async () => {
    const refused = await postProject(admin, { clientId: "999999", description: "Job", jobDate: "2026-09-01", jobValue: "10" });
    const saved = await newProject(admin, clientId);

    expect(refused.status).toBe(400);
    expect(saved.jobNumber).toBe("GPSA0001");
  });

  it("takes its format from number_sequences, so the rule is configuration, not code", async () => {
    await pool.query("UPDATE number_sequences SET prefix = 'JOB-', next_number = 120, pad_length = 6 WHERE sequence_key = 'job_number'");
    const configured = await newProject(admin, clientId);

    await pool.query("UPDATE number_sequences SET prefix = 'GPSA', next_number = 12345, pad_length = 4 WHERE sequence_key = 'job_number'");
    const wide = await newProject(admin, clientId);

    expect(configured.jobNumber).toBe("JOB-000120");
    // A number longer than the padding is not truncated.
    expect(wide.jobNumber).toBe("GPSA12345");
  });

  it("is protected by a unique constraint in the database", async () => {
    const project = await newProject(admin, clientId);

    await expect(
      pool.query(
        "INSERT INTO projects (job_number, client_id, description, job_date, job_value, vat_rate) VALUES ($1, $2, 'Duplicate', '2026-01-01', 1, 5)",
        [project.jobNumber, clientId]
      )
    ).rejects.toMatchObject({ code: "23505", constraint: "projects_job_number_uq" });
  });

  it("cannot be changed after the project is created", async () => {
    const project = await newProject(admin, clientId);
    const response = await patch(project.id, { jobNumber: "GPSA7777" });

    expect(response.status).toBe(400);
    expect((await get(`/api/projects/${project.id}`)).body.data.jobNumber).toBe("GPSA0001");
  });

  it("previews the next number and the default VAT rate without reserving anything", async () => {
    const before = await get("/api/projects/defaults");
    const again = await get("/api/projects/defaults");
    const project = await newProject(admin, clientId);

    expect(before.body.data).toEqual({ defaultVatRate: "5.000", nextJobNumber: "GPSA0001" });
    expect(again.body.data.nextJobNumber).toBe("GPSA0001");
    expect(project.jobNumber).toBe("GPSA0001");
  });
});

describe("financial precision and VAT", () => {
  it("keeps three decimals and rounds VAT to three decimals in PostgreSQL", async () => {
    const cases: [string, string, string][] = [
      // job value, VAT at 5%, grand value
      ["1234.567", "61.728", "1296.295"],
      ["8642.013", "432.101", "9074.114"],
      ["33.333", "1.667", "35.000"],
      ["442.5", "22.125", "464.625"],
      ["0.001", "0.000", "0.001"],
      ["99999999999.999", "5000000000.000", "104999999999.999"],
    ];

    for (const [jobValue, vatAmount, grandValue] of cases) {
      const project = await newProject(admin, clientId, { jobValue });

      expect(project, jobValue).toMatchObject({ vatRate: "5.000", vatAmount, grandValue });
    }
  });

  it("returns money as decimal strings, never as JSON numbers", async () => {
    const project = await newProject(admin, clientId, { jobValue: "0.1", budgetAmount: "0.2" });

    for (const field of ["jobValue", "vatRate", "vatAmount", "grandValue", "budgetAmount", "trackedExpenses", "operationalJobMargin"]) {
      expect(typeof project[field], field).toBe("string");
    }
    expect(project.jobValue).toBe("0.100");
  });

  it("adds values exactly where binary floating point would not", async () => {
    await newProject(admin, clientId, { jobValue: "0.1" });
    await newProject(admin, clientId, { jobValue: "0.2" });
    await newProject(admin, clientId, { jobValue: "1234.567" });

    const summary = await get("/api/projects/summary");

    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    expect(summary.body.data.values.totalJobValue).toBe("1234.867");
  });

  it("rejects amounts that are not exact three-decimal strings", async () => {
    const base = { clientId, description: "Job", jobDate: "2026-09-01" };
    const attempts = {
      number: await postProject(admin, { ...base, jobValue: 100.5 }),
      fourDecimals: await postProject(admin, { ...base, jobValue: "10.1234" }),
      negative: await postProject(admin, { ...base, jobValue: "-1" }),
      exponent: await postProject(admin, { ...base, jobValue: "1e3" }),
      comma: await postProject(admin, { ...base, jobValue: "1,000.000" }),
      tooLarge: await postProject(admin, { ...base, jobValue: "100000000000" }),
      negativeBudget: await postProject(admin, { ...base, jobValue: "10", budgetAmount: "-5" }),
    };

    for (const [name, response] of Object.entries(attempts)) {
      expect(response.status, name).toBe(400);
    }
    expect(attempts.fourDecimals.body.error.details).toEqual([
      { field: "jobValue", message: "Job value must be a number with at most 3 decimal places, for example 1250.500." },
    ]);
  });

  it("stores an explicit VAT rate on every project and accepts a different one", async () => {
    const standard = await newProject(admin, clientId, { jobValue: "200" });
    const zeroRated = await newProject(admin, clientId, { jobValue: "200", vatRate: "0" });
    const other = await newProject(admin, clientId, { jobValue: "200", vatRate: "7.5" });

    expect(standard).toMatchObject({ vatRate: "5.000", vatAmount: "10.000", grandValue: "210.000" });
    expect(zeroRated).toMatchObject({ vatRate: "0.000", vatAmount: "0.000", grandValue: "200.000" });
    expect(other).toMatchObject({ vatRate: "7.500", vatAmount: "15.000", grandValue: "215.000" });

    const stored = await pool.query("SELECT count(*)::int AS missing FROM projects WHERE vat_rate IS NULL");
    expect(stored.rows[0]).toEqual({ missing: 0 });
  });

  it("rejects a VAT rate outside 0 to 100", async () => {
    for (const vatRate of ["100.001", "101", "-5", "five", "5.0001"]) {
      const response = await postProject(admin, { clientId, description: "Job", jobDate: "2026-09-01", jobValue: "10", vatRate });

      expect(response.status, vatRate).toBe(400);
      expect(response.body.error.details[0].field).toBe("vatRate");
    }

    expect((await newProject(admin, clientId, { vatRate: "100" })).vatAmount).toBe("1000.000");
  });

  it("takes the default rate from app_settings without changing existing projects", async () => {
    const before = await newProject(admin, clientId, { jobValue: "100" });

    await pool.query("UPDATE app_settings SET value = '10.000' WHERE key = 'projects.default_vat_rate'");
    const after = await newProject(admin, clientId, { jobValue: "100" });
    const reread = await get(`/api/projects/${before.id}`);

    expect(after).toMatchObject({ vatRate: "10.000", vatAmount: "10.000", grandValue: "110.000" });
    expect(reread.body.data).toMatchObject({ vatRate: "5.000", vatAmount: "5.000", grandValue: "105.000" });
  });

  it("does not let the VAT amount or grand value be written directly", async () => {
    const project = await newProject(admin, clientId);

    await expect(pool.query("UPDATE projects SET vat_amount = 1 WHERE id = $1", [project.id])).rejects.toMatchObject({ code: "428C9" });
    await expect(pool.query("UPDATE projects SET grand_value = 1 WHERE id = $1", [project.id])).rejects.toMatchObject({ code: "428C9" });
  });

  it("stores money as numeric with three decimals, with no floating-point column", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string; data_type: string; numeric_scale: number | null }>(
      `SELECT table_name, column_name, data_type, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name IN ('projects', 'procurement_requests', 'project_expenses')
         AND data_type IN ('numeric', 'real', 'double precision', 'money')
       ORDER BY table_name, column_name`
    );

    expect(columns.rows.map((column) => `${column.table_name}.${column.column_name}`)).toEqual([
      "procurement_requests.quotation_amount",
      "project_expenses.amount",
      "projects.budget_amount",
      "projects.grand_value",
      "projects.job_value",
      "projects.vat_amount",
      "projects.vat_rate",
    ]);
    expect(columns.rows.every((column) => column.data_type === "numeric" && column.numeric_scale === 3)).toBe(true);
  });
});

describe("read projects", () => {
  it("lists projects newest first, with search, filters and paging", async () => {
    const other = await insertClient("MERCURE");
    await newProject(admin, clientId, { description: "Fire pump repair", jobDate: "2026-07-01" });
    await newProject(admin, other, { description: "CCTV upgrade", jobDate: "2026-08-01", lpoNumber: "LPO-55" });
    const third = await newProject(admin, clientId, { description: "Access control", jobDate: "2026-09-01" });
    await setStatus(admin, third.id, { status: "IN_PROGRESS" });

    const all = await get("/api/projects");
    const byText = await get("/api/projects?search=cctv");
    const byClientName = await get("/api/projects?search=mercure");
    const byJobNumber = await get("/api/projects?search=GPSA0001");
    const byLpo = await get("/api/projects?search=lpo-55");
    const wildcard = await get("/api/projects?search=%25");
    const byStatus = await get("/api/projects?status=IN_PROGRESS");
    const byClient = await get(`/api/projects?clientId=${clientId}`);
    const paged = await get("/api/projects?page=2&pageSize=2");

    expect(all.status).toBe(200);
    expect(all.body.data.items.map((project: { jobNumber: string }) => project.jobNumber)).toEqual(["GPSA0003", "GPSA0002", "GPSA0001"]);
    expect(all.body.data).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(byText.body.data.items.map((project: { jobNumber: string }) => project.jobNumber)).toEqual(["GPSA0002"]);
    expect(byClientName.body.data.total).toBe(1);
    expect(byJobNumber.body.data.total).toBe(1);
    expect(byLpo.body.data.total).toBe(1);
    expect(wildcard.body.data.total).toBe(0);
    expect(byStatus.body.data.items.map((project: { jobNumber: string }) => project.jobNumber)).toEqual(["GPSA0003"]);
    expect(byClient.body.data.total).toBe(2);
    expect(paged.body.data.items.map((project: { jobNumber: string }) => project.jobNumber)).toEqual(["GPSA0001"]);
    expect((await get("/api/projects?status=DONE")).status).toBe(400);
  });

  it("returns one project, and 404 for a missing or malformed id", async () => {
    const project = await newProject(admin, clientId);

    expect((await get(`/api/projects/${project.id}`)).body.data.jobNumber).toBe("GPSA0001");
    expect((await get("/api/projects/999999")).status).toBe(404);
    expect((await get("/api/projects/abc")).status).toBe(404);
  });

  it("offers a project picker with no financial information", async () => {
    const project = await newProject(admin, clientId, { description: "Picker job" });
    const response = await get("/api/projects/options");

    expect(response.body.data).toEqual([
      { id: project.id, jobNumber: "GPSA0001", description: "Picker job", clientName: "IBIS", status: "NEW" },
    ]);
  });
});

describe("update project", () => {
  it("changes only the supplied fields, recalculates VAT and logs what changed", async () => {
    const project = await newProject(admin, clientId, { jobValue: "1000", notes: "keep" });

    const response = await patch(project.id, { jobValue: "1234.567", description: "Revised scope", lpoNumber: "LPO-9" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      description: "Revised scope",
      lpoNumber: "LPO-9",
      jobValue: "1234.567",
      vatAmount: "61.728",
      grandValue: "1296.295",
      notes: "keep",
      jobNumber: "GPSA0001",
    });

    // Read back through a separate request: the data comes from PostgreSQL.
    expect((await get(`/api/projects/${project.id}`)).body.data).toMatchObject({ jobValue: "1234.567", grandValue: "1296.295" });

    const logs = await logsFor("projects", project.id);
    expect(logs.map((log) => log.action)).toEqual(["project.created", "project.updated"]);
    expect(logs[1]?.metadata).toEqual({
      changes: {
        description: { from: "Fire alarm panel replacement", to: "Revised scope" },
        lpoNumber: { from: null, to: "LPO-9" },
        jobValue: { from: "1000.000", to: "1234.567" },
      },
    });
  });

  it("does not write a log entry when nothing changed", async () => {
    const project = await newProject(admin, clientId, { jobValue: "100" });

    // "100" and "100.000" are the same amount.
    await patch(project.id, { jobValue: "100", vatRate: "5" });

    expect((await logsFor("projects", project.id)).map((log) => log.action)).toEqual(["project.created"]);
  });

  it("can change the client, the VAT rate and the budget, and clear optional fields", async () => {
    const other = await insertClient("MERCURE");
    const project = await newProject(admin, clientId, { jobValue: "200", budgetAmount: "50", lpoNumber: "LPO-1" });

    const response = await patch(project.id, { clientId: other, vatRate: "0", budgetAmount: "", lpoNumber: "" });

    expect(response.body.data).toMatchObject({
      clientName: "MERCURE",
      vatRate: "0.000",
      vatAmount: "0.000",
      grandValue: "200.000",
      budgetAmount: null,
      budgetRemaining: null,
      lpoNumber: null,
    });
  });

  it("rejects an empty update, invalid values, an inactive client and an unknown project", async () => {
    const inactive = await insertClient("Closed Client", false);
    const project = await newProject(admin, clientId);

    expect((await patch(project.id, {})).status).toBe(400);
    expect((await patch(project.id, { description: "" })).status).toBe(400);
    expect((await patch(project.id, { jobValue: "1.2345" })).status).toBe(400);
    expect((await patch(project.id, { status: "COMPLETED" })).status).toBe(400);
    expect((await patch(project.id, { clientId: inactive })).status).toBe(400);
    expect((await patch("999999", { description: "X" })).status).toBe(404);
  });

  it("offers no route that deletes a project", async () => {
    const project = await newProject(admin, clientId);
    const response = await api().delete(`/api/projects/${project.id}`).set(admin.headers);

    expect(response.status).toBe(404);
    expect((await pool.query("SELECT 1 FROM projects WHERE id = $1", [project.id])).rowCount).toBe(1);
  });
});

describe("project status", () => {
  it("moves a project through NEW, IN_PROGRESS and COMPLETED and logs each change", async () => {
    const project = await newProject(admin, clientId);

    expect(project.allowedStatuses).toEqual(["IN_PROGRESS", "COMPLETED", "CANCELLED"]);

    const started = await setStatus(admin, project.id, { status: "IN_PROGRESS" });
    const completed = await setStatus(admin, project.id, { status: "COMPLETED" });

    expect(started.body.data).toMatchObject({ status: "IN_PROGRESS", completedDate: null, invoiceState: "NOT_READY" });
    expect(completed.status).toBe(200);
    expect(completed.body.data).toMatchObject({
      status: "COMPLETED",
      completedDate: await today(),
      invoiceState: "READY_FOR_INVOICE",
      readyForInvoice: true,
      allowedStatuses: ["IN_PROGRESS"],
    });

    const logs = await logsFor("projects", project.id);
    expect(logs.map((log) => log.action)).toEqual(["project.created", "project.status_changed", "project.status_changed"]);
    expect(logs[2]?.metadata).toMatchObject({ from: "IN_PROGRESS", to: "COMPLETED" });
  });

  it("records the completion date that is given, and refuses one before the job date", async () => {
    const project = await newProject(admin, clientId, { jobDate: "2026-09-10" });

    const tooEarly = await setStatus(admin, project.id, { status: "COMPLETED", completedDate: "2026-09-09" });
    const wrongStatus = await setStatus(admin, project.id, { status: "IN_PROGRESS", completedDate: "2026-09-20" });
    const completed = await setStatus(admin, project.id, { status: "COMPLETED", completedDate: "2026-09-20" });

    expect(tooEarly.status).toBe(400);
    expect(tooEarly.body.error.details).toEqual([{ field: "completedDate", message: "Completion date cannot be before the job date." }]);
    expect(wrongStatus.status).toBe(400);
    expect(completed.body.data.completedDate).toBe("2026-09-20");
  });

  it("lets a small job go straight from NEW to COMPLETED", async () => {
    const project = await newProject(admin, clientId);

    expect((await setStatus(admin, project.id, { status: "COMPLETED" })).body.data.status).toBe("COMPLETED");
  });

  it("cancels a project, blocks edits while cancelled, and can reopen it", async () => {
    const project = await newProject(admin, clientId);

    const cancelled = await setStatus(admin, project.id, { status: "CANCELLED" });
    expect(cancelled.body.data).toMatchObject({ status: "CANCELLED", invoiceState: "NOT_APPLICABLE", readyForInvoice: false });

    const edit = await patch(project.id, { description: "Changed" });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("CONFLICT");

    const reopened = await setStatus(admin, project.id, { status: "NEW" });
    expect(reopened.body.data.status).toBe("NEW");
    expect((await patch(project.id, { description: "Changed" })).status).toBe(200);
  });

  it("refuses a move that the workflow does not allow", async () => {
    const project = await newProject(admin, clientId);
    await setStatus(admin, project.id, { status: "COMPLETED" });

    const cancelCompleted = await setStatus(admin, project.id, { status: "CANCELLED" });
    const backToNew = await setStatus(admin, project.id, { status: "NEW" });
    const unknown = await setStatus(admin, project.id, { status: "CLOSED" });

    expect(cancelCompleted.status).toBe(409);
    expect(backToNew.status).toBe(409);
    expect(unknown.status).toBe(400);
    expect((await setStatus(admin, "999999", { status: "COMPLETED" })).status).toBe(404);
  });

  it("clears the completion date when a completed project is reopened", async () => {
    const project = await newProject(admin, clientId);
    await setStatus(admin, project.id, { status: "COMPLETED" });

    const reopened = await setStatus(admin, project.id, { status: "IN_PROGRESS" });

    expect(reopened.body.data).toMatchObject({ status: "IN_PROGRESS", completedDate: null, invoiceState: "NOT_READY" });
  });

  it("does nothing when the project already has the requested status", async () => {
    const project = await newProject(admin, clientId);
    const response = await setStatus(admin, project.id, { status: "NEW" });

    expect(response.status).toBe(200);
    expect((await logsFor("projects", project.id)).map((log) => log.action)).toEqual(["project.created"]);
  });

  it("is guarded by database constraints", async () => {
    const project = await newProject(admin, clientId);

    await expect(pool.query("UPDATE projects SET status = 'COMPLETED' WHERE id = $1", [project.id])).rejects.toMatchObject({
      code: "23514",
      constraint: "projects_completed_date_ck",
    });
    await expect(pool.query("UPDATE projects SET status = 'ON_HOLD' WHERE id = $1", [project.id])).rejects.toMatchObject({
      code: "23514",
      constraint: "projects_status_ck",
    });
    await expect(pool.query("UPDATE projects SET job_value = -1 WHERE id = $1", [project.id])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("ready for invoice", () => {
  it("lists completed projects with a value as ready for invoice", async () => {
    const open = await newProject(admin, clientId, { description: "Still open" });
    const done = await newProject(admin, clientId, { description: "Done", jobValue: "750.250" });
    const cancelled = await newProject(admin, clientId, { description: "Cancelled" });
    await setStatus(admin, done.id, { status: "COMPLETED" });
    await setStatus(admin, cancelled.id, { status: "CANCELLED" });

    const ready = await get("/api/projects?invoiceState=READY_FOR_INVOICE");

    expect(ready.body.data.items.map((project: { id: string }) => project.id)).toEqual([done.id]);
    expect(ready.body.data.items[0]).toMatchObject({ readyForInvoice: true, jobValue: "750.250" });
    expect((await get(`/api/projects/${open.id}`)).body.data.readyForInvoice).toBe(false);
  });

  it("does not create or expose any invoice record", async () => {
    const project = await newProject(admin, clientId);
    const completed = await setStatus(admin, project.id, { status: "COMPLETED" });

    expect(completed.body.data).not.toHaveProperty("invoiceNumber");
    expect(completed.body.data).not.toHaveProperty("invoices");

    const invoiceTables = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'invoice%'"
    );
    const invoiceColumns = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name LIKE '%invoice%'"
    );
    expect(invoiceTables.rowCount).toBe(0);
    expect(invoiceColumns.rowCount).toBe(0);
  });

  it("marks a completed zero-value project as needing no invoice, so it never waits for one", async () => {
    const zero = await newProject(admin, clientId, { description: "Rectification", jobValue: "0" });
    const completed = await setStatus(admin, zero.id, { status: "COMPLETED" });

    expect(completed.status).toBe(200);
    expect(completed.body.data).toMatchObject({
      status: "COMPLETED",
      jobValue: "0.000",
      vatAmount: "0.000",
      grandValue: "0.000",
      invoiceState: "NO_INVOICE_REQUIRED",
      readyForInvoice: false,
    });

    expect((await get("/api/projects?invoiceState=READY_FOR_INVOICE")).body.data.total).toBe(0);
    expect((await get("/api/projects?invoiceState=NO_INVOICE_REQUIRED")).body.data.total).toBe(1);

    // Giving the job a value afterwards makes it invoiceable.
    const valued = await patch(zero.id, { jobValue: "25" });
    expect(valued.body.data).toMatchObject({ invoiceState: "READY_FOR_INVOICE", readyForInvoice: true });
  });
});

describe("project summary for the dashboard", () => {
  it("reports real counts, values, tracked expenses and operational job margin", async () => {
    const active = await newProject(admin, clientId, { jobValue: "1000" });
    const started = await newProject(admin, clientId, { jobValue: "500.5" });
    const done = await newProject(admin, clientId, { jobValue: "2000" });
    const zero = await newProject(admin, clientId, { jobValue: "0" });
    const cancelled = await newProject(admin, clientId, { jobValue: "9999" });
    const materials = await categoryId("MATERIALS");

    for (const [project, amount] of [
      [active, "100.125"],
      [done, "250"],
      [cancelled, "40"],
    ] as const) {
      await postExpense(admin, { projectId: project.id, categoryId: materials, expenseDate: "2026-09-02", description: "Cost", amount });
    }

    await setStatus(admin, started.id, { status: "IN_PROGRESS" });
    await setStatus(admin, done.id, { status: "COMPLETED" });
    await setStatus(admin, zero.id, { status: "COMPLETED" });
    await setStatus(admin, cancelled.id, { status: "CANCELLED" });

    const summary = await get("/api/projects/summary");

    expect(summary.status).toBe(200);
    expect(summary.body.data).toEqual({
      counts: {
        total: 5,
        active: 2,
        new: 1,
        inProgress: 1,
        completed: 2,
        cancelled: 1,
        historical: 0,
        readyForInvoice: 1,
        noInvoiceRequired: 1,
      },
      values: {
        totalJobValue: "3500.500",
        totalGrandValue: "3675.525",
        readyForInvoiceValue: "2000.000",
        historicalJobValue: "0.000",
        historicalGrandValue: "0.000",
      },
      costs: {
        trackedExpenses: "350.125",
        operationalJobMargin: "3150.375",
        trackedExpensesOnCancelledProjects: "40.000",
        trackedExpensesOnHistoricalProjects: "0.000",
      },
    });
  });

  it("returns zeros, not missing values, when there are no projects", async () => {
    const summary = await get("/api/projects/summary");

    expect(summary.body.data.counts).toMatchObject({ total: 0, active: 0, readyForInvoice: 0 });
    expect(summary.body.data.values).toEqual({
      totalJobValue: "0.000",
      totalGrandValue: "0.000",
      readyForInvoiceValue: "0.000",
      historicalJobValue: "0.000",
      historicalGrandValue: "0.000",
    });
    expect(summary.body.data.costs).toEqual({
      trackedExpenses: "0.000",
      operationalJobMargin: "0.000",
      trackedExpensesOnCancelledProjects: "0.000",
      trackedExpensesOnHistoricalProjects: "0.000",
    });
  });
});

describe("project permissions", () => {
  it("requires a signed-in user", async () => {
    for (const path of ["/api/projects", "/api/projects/1", "/api/projects/summary", "/api/projects/options", "/api/projects/defaults"]) {
      expect((await api().get(path)).status, path).toBe(401);
    }
    expect((await api().post("/api/projects").send({})).status).toBe(401);
  });

  it("lets a view-only role read projects but not create, edit or change status", async () => {
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
    const project = await newProject(admin, clientId);

    expect((await get("/api/projects", accountant)).status).toBe(200);
    expect((await get(`/api/projects/${project.id}`, accountant)).status).toBe(200);
    expect((await get("/api/projects/summary", accountant)).status).toBe(200);

    const attempts = [
      await postProject(accountant, { clientId, description: "Not allowed", jobDate: "2026-09-01", jobValue: "10" }),
      await patch(project.id, { description: "Renamed" }, accountant),
      await setStatus(accountant, project.id, { status: "COMPLETED" }),
      await get("/api/projects/defaults", accountant),
    ];

    for (const response of attempts) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }

    const stored = await pool.query("SELECT description, status FROM projects");
    expect(stored.rows).toEqual([{ description: "Fire alarm panel replacement", status: "NEW" }]);
  });

  it("gives a user with no role no access", async () => {
    const nobody = await signedIn("norole@example.com", []);

    for (const path of ["/api/projects", "/api/projects/summary", "/api/projects/options", "/api/projects/defaults"]) {
      expect((await get(path, nobody)).status, path).toBe(403);
    }
  });

  it("checks each action separately: CREATE does not imply EDIT", async () => {
    await pool.query("INSERT INTO role_permissions (role_id, module, action) SELECT id, 'PROJECTS', 'CREATE' FROM roles WHERE code = 'ACCOUNTANT'");
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);

    const created = await postProject(accountant, { clientId, description: "Allowed", jobDate: "2026-09-01", jobValue: "10" });

    expect(created.status).toBe(201);
    expect((await patch(created.body.data.id, { description: "Renamed" }, accountant)).status).toBe(403);
    expect((await setStatus(accountant, created.body.data.id, { status: "COMPLETED" })).status).toBe(403);
  });

  it("shows recorded costs and margin only to roles that may view expenses", async () => {
    const project = await newProject(admin, clientId, { jobValue: "1000", budgetAmount: "400" });
    await postExpense(admin, {
      projectId: project.id,
      categoryId: await categoryId("LABOUR"),
      expenseDate: "2026-09-02",
      description: "Site labour",
      amount: "120.5",
    });
    // The seeded Execution role holds PROJECTS:VIEW but not EXPENSES:VIEW; the Accountant holds both.
    const execution = await signedIn("execution@example.com", ["EXECUTION"]);
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);

    const hidden = await get(`/api/projects/${project.id}`, execution);
    const hiddenList = await get("/api/projects", execution);
    const hiddenSummary = await get("/api/projects/summary", execution);
    const shown = await get(`/api/projects/${project.id}`, accountant);

    expect(hidden.body.data).toMatchObject({
      jobValue: "1000.000",
      trackedExpenses: null,
      operationalJobMargin: null,
      budgetRemaining: null,
    });
    expect(hiddenList.body.data.items[0]).toMatchObject({ trackedExpenses: null, operationalJobMargin: null });
    expect(hiddenSummary.body.data.costs).toBeNull();
    expect(hiddenSummary.body.data.values.totalJobValue).toBe("1000.000");
    expect(shown.body.data).toMatchObject({
      trackedExpenses: "120.500",
      operationalJobMargin: "879.500",
      budgetRemaining: "279.500",
    });
  });

  it("offers the project picker to any role that works with projects, procurement or expenses", async () => {
    await newProject(admin, clientId);
    await pool.query("DELETE FROM role_permissions WHERE module = 'PROJECTS' AND role_id = (SELECT id FROM roles WHERE code = 'ACCOUNTANT')");
    const accountant = await signedIn("accountant@example.com", ["ACCOUNTANT"]);
    const invoicing = await signedIn("invoicing@example.com", ["INVOICING"]);
    await pool.query("DELETE FROM role_permissions WHERE module = 'PROJECTS' AND role_id = (SELECT id FROM roles WHERE code = 'INVOICING')");

    // Expenses access is enough for the picker, but not for the project list.
    expect((await get("/api/projects/options", accountant)).status).toBe(200);
    expect((await get("/api/projects", accountant)).status).toBe(403);
    expect((await get("/api/projects/options", invoicing)).status).toBe(403);
  });
});
