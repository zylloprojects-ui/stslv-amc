import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, isUniqueViolation, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { generateJobNumber, previewNextJobNumber } from "./job-number";
import type {
  ChangeProjectStatusInput,
  CreateProjectInput,
  InvoiceState,
  JobDatePrecision,
  ListProjectsQuery,
  ProjectStatus,
  UpdateProjectInput,
} from "./projects.schemas";

interface ProjectRow {
  id: string;
  job_number: string;
  client_id: string;
  client_name: string;
  description: string;
  job_date: string;
  job_date_precision: JobDatePrecision;
  legacy_status: string | null;
  lpo_number: string | null;
  lpo_date: string | null;
  job_value: string;
  vat_rate: string;
  vat_amount: string;
  grand_value: string;
  budget_amount: string | null;
  status: ProjectStatus;
  completed_date: string | null;
  notes: string | null;
  tracked_expenses: string;
  operational_job_margin: string;
  budget_remaining: string | null;
  invoice_state: InvoiceState;
  created_at: Date;
  updated_at: Date;
}

/** Money and rates are decimal strings with three decimals, exactly as PostgreSQL holds them. */
export interface Project {
  id: string;
  jobNumber: string;
  clientId: string;
  clientName: string;
  description: string;
  /** YYYY-MM-DD */
  jobDate: string;
  /** MONTH: only the month and year are known, and jobDate is the first of that month as a placeholder. */
  jobDatePrecision: JobDatePrecision;
  /** The status as written in the source register. Present on a historical project only. */
  legacyStatus: string | null;
  lpoNumber: string | null;
  lpoDate: string | null;
  /** Excluding VAT. */
  jobValue: string;
  vatRate: string;
  vatAmount: string;
  grandValue: string;
  budgetAmount: string | null;
  status: ProjectStatus;
  completedDate: string | null;
  notes: string | null;
  /** Statuses this project may move to next. */
  allowedStatuses: ProjectStatus[];
  invoiceState: InvoiceState;
  readyForInvoice: boolean;
  /**
   * Figures derived from expense rows. Null when the signed-in user does not
   * hold EXPENSES:VIEW: recorded costs are not disclosed through Projects.
   */
  trackedExpenses: string | null;
  operationalJobMargin: string | null;
  budgetRemaining: string | null;
  createdAt: string;
  updatedAt: string;
}

// The date columns are read as text so a calendar day is never shifted by a time zone.
const SELECT_PROJECT = `
  SELECT p.id, p.job_number, p.client_id, c.name AS client_name, p.description,
         p.job_date::text AS job_date, p.job_date_precision, p.legacy_status,
         p.lpo_number, p.lpo_date::text AS lpo_date,
         p.job_value, p.vat_rate, p.vat_amount, p.grand_value, p.budget_amount,
         p.status, p.completed_date::text AS completed_date, p.notes,
         f.tracked_expenses, f.operational_job_margin, f.budget_remaining, f.invoice_state,
         p.created_at, p.updated_at
  FROM projects p
  JOIN clients c ON c.id = p.client_id
  JOIN v_project_financials f ON f.project_id = p.id`;

// PROVISIONAL workflow (open question Q7). A small job may go straight from
// NEW to COMPLETED. A completed or cancelled project can be reopened, so a
// mistake can be corrected; every change is written to the activity log.
// Nothing leads into or out of HISTORICAL: it is written only by the
// controlled import.
const STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  NEW: ["IN_PROGRESS", "COMPLETED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["IN_PROGRESS"],
  CANCELLED: ["NEW"],
  HISTORICAL: [],
};

const HISTORICAL_READ_ONLY =
  "is a historical record imported from an earlier job register. It cannot be changed here.";

const EDITABLE_FIELDS = [
  "clientId",
  "description",
  "jobDate",
  "lpoNumber",
  "lpoDate",
  "jobValue",
  "vatRate",
  "budgetAmount",
  "notes",
] as const;

const DEFAULT_VAT_RATE_KEY = "projects.default_vat_rate";

export const canSeeCosts = (auth: AuthContext) => auth.permissions.has("EXPENSES:VIEW");

function toProject(row: ProjectRow, showCosts: boolean): Project {
  return {
    id: row.id,
    jobNumber: row.job_number,
    clientId: row.client_id,
    clientName: row.client_name,
    description: row.description,
    jobDate: row.job_date,
    jobDatePrecision: row.job_date_precision,
    legacyStatus: row.legacy_status,
    lpoNumber: row.lpo_number,
    lpoDate: row.lpo_date,
    jobValue: row.job_value,
    vatRate: row.vat_rate,
    vatAmount: row.vat_amount,
    grandValue: row.grand_value,
    budgetAmount: row.budget_amount,
    status: row.status,
    completedDate: row.completed_date,
    notes: row.notes,
    allowedStatuses: STATUS_TRANSITIONS[row.status],
    invoiceState: row.invoice_state,
    readyForInvoice: row.invoice_state === "READY_FOR_INVOICE",
    trackedExpenses: showCosts ? row.tracked_expenses : null,
    operationalJobMargin: showCosts ? row.operational_job_margin : null,
    budgetRemaining: showCosts ? row.budget_remaining : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findProject(db: Queryable, id: string, showCosts: boolean): Promise<Project> {
  const result = await db.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Project not found.");
  }

  return toProject(row, showCosts);
}

/** Locks the project row for the rest of the transaction, then reads it. */
async function lockProject(db: Queryable, id: string, showCosts: boolean): Promise<Project> {
  const locked = await db.query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE", [id]);

  if (locked.rowCount === 0) {
    throw notFound("Project not found.");
  }

  return findProject(db, id, showCosts);
}

/** New work can only be recorded for a client that exists and is active. */
async function requireActiveClient(db: Queryable, clientId: string): Promise<void> {
  const result = await db.query<{ is_active: boolean }>("SELECT is_active FROM clients WHERE id = $1", [clientId]);
  const client = result.rows[0];

  if (!client) {
    throw validationError("Some fields are invalid.", [{ field: "clientId", message: "The selected client does not exist." }]);
  }
  if (!client.is_active) {
    throw validationError("Some fields are invalid.", [
      { field: "clientId", message: "The selected client is inactive. Reactivate it or choose another client." },
    ]);
  }
}

async function readDefaultVatRate(db: Queryable): Promise<string> {
  const result = await db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = $1", [DEFAULT_VAT_RATE_KEY]);
  const value = result.rows[0]?.value;

  if (value === undefined) {
    throw new Error(`The "${DEFAULT_VAT_RATE_KEY}" row is missing from app_settings.`);
  }

  return value;
}

export async function listProjects(auth: AuthContext, query: ListProjectsQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status) {
    params.push(query.status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (query.invoiceState) {
    params.push(query.invoiceState);
    conditions.push(`f.invoice_state = $${params.length}`);
  }
  if (query.clientId) {
    params.push(query.clientId);
    conditions.push(`p.client_id = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(`(p.job_number ILIKE ${p} OR p.description ILIKE ${p} OR c.name ILIKE ${p} OR p.lpo_number ILIKE ${p})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM projects p
     JOIN clients c ON c.id = p.client_id
     JOIN v_project_financials f ON f.project_id = p.id
     ${where}`,
    params
  );

  const rows = await pool.query<ProjectRow>(
    `${SELECT_PROJECT} ${where}
     ORDER BY p.job_date DESC, p.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );
  const showCosts = canSeeCosts(auth);

  return {
    items: rows.rows.map((row) => toProject(row, showCosts)),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export function getProject(auth: AuthContext, id: string): Promise<Project> {
  return findProject(pool, id, canSeeCosts(auth));
}

export interface ProjectOption {
  id: string;
  jobNumber: string;
  description: string;
  clientName: string;
  status: ProjectStatus;
}

/** Every project, newest first, with just enough to pick one on a procurement or expense form. */
export async function listProjectOptions(): Promise<ProjectOption[]> {
  const result = await pool.query<{ id: string; job_number: string; description: string; client_name: string; status: ProjectStatus }>(
    `SELECT p.id, p.job_number, p.description, c.name AS client_name, p.status
     FROM projects p
     JOIN clients c ON c.id = p.client_id
     ORDER BY p.job_date DESC, p.id DESC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    jobNumber: row.job_number,
    description: row.description,
    clientName: row.client_name,
    status: row.status,
  }));
}

/** What a new project starts with. The job number is a preview; nothing is reserved. */
export async function getProjectDefaults() {
  return {
    defaultVatRate: await readDefaultVatRate(pool),
    nextJobNumber: await previewNextJobNumber(pool),
  };
}

export async function createProject(auth: AuthContext, input: CreateProjectInput): Promise<Project> {
  try {
    return await withTransaction(async (client) => {
      await requireActiveClient(client, input.clientId);

      const vatRate = input.vatRate ?? (await readDefaultVatRate(client));
      const jobNumber = await generateJobNumber(client);

      // vat_amount and grand_value are generated by PostgreSQL from job_value and vat_rate.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO projects (job_number, client_id, description, job_date, lpo_number, lpo_date,
                               job_value, vat_rate, budget_amount, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING id`,
        [
          jobNumber,
          input.clientId,
          input.description,
          input.jobDate,
          input.lpoNumber ?? null,
          input.lpoDate ?? null,
          input.jobValue,
          vatRate,
          input.budgetAmount ?? null,
          input.notes ?? null,
          auth.user.id,
        ]
      );
      const id = (inserted.rows[0] as { id: string }).id;
      const created = await findProject(client, id, true);

      await logActivity(client, {
        userId: auth.user.id,
        action: "project.created",
        module: "PROJECTS",
        entityType: "projects",
        entityId: id,
        description: `Project ${created.jobNumber} created for ${created.clientName}.`,
        metadata: {
          jobNumber: created.jobNumber,
          jobValue: created.jobValue,
          vatRate: created.vatRate,
          vatAmount: created.vatAmount,
          grandValue: created.grandValue,
        },
      });

      return canSeeCosts(auth) ? created : findProject(client, id, false);
    });
  } catch (error) {
    if (isUniqueViolation(error, "projects_job_number_uq")) {
      throw conflict("The generated job number is already in use. Please try again.");
    }
    throw error;
  }
}

export function updateProject(auth: AuthContext, id: string, input: UpdateProjectInput): Promise<Project> {
  return withTransaction(async (client) => {
    const before = await lockProject(client, id, true);

    if (before.status === "HISTORICAL") {
      throw conflict(`Project ${before.jobNumber} ${HISTORICAL_READ_ONLY}`);
    }
    if (before.status === "CANCELLED") {
      throw conflict("A cancelled project cannot be edited. Reopen it first.");
    }

    const after: Project = { ...before };

    for (const field of EDITABLE_FIELDS) {
      const value = input[field];
      if (value !== undefined) {
        (after[field] as string | null) = value;
      }
    }

    const changes = diffFields(
      before as unknown as Record<string, unknown>,
      after as unknown as Record<string, unknown>,
      EDITABLE_FIELDS
    );

    if (Object.keys(changes).length === 0) {
      return canSeeCosts(auth) ? before : findProject(client, id, false);
    }
    if (changes.clientId) {
      await requireActiveClient(client, after.clientId);
    }
    if (before.completedDate !== null && after.jobDate > before.completedDate) {
      throw validationError("Some fields are invalid.", [
        { field: "jobDate", message: "Job date cannot be after the completion date." },
      ]);
    }

    await client.query(
      `UPDATE projects
       SET client_id = $1, description = $2, job_date = $3, lpo_number = $4, lpo_date = $5,
           job_value = $6, vat_rate = $7, budget_amount = $8, notes = $9, updated_by = $10
       WHERE id = $11`,
      [
        after.clientId,
        after.description,
        after.jobDate,
        after.lpoNumber,
        after.lpoDate,
        after.jobValue,
        after.vatRate,
        after.budgetAmount,
        after.notes,
        auth.user.id,
        id,
      ]
    );

    await logActivity(client, {
      userId: auth.user.id,
      action: "project.updated",
      module: "PROJECTS",
      entityType: "projects",
      entityId: id,
      description: `Project ${before.jobNumber} updated.`,
      metadata: { changes },
    });

    return findProject(client, id, canSeeCosts(auth));
  });
}

export function changeProjectStatus(auth: AuthContext, id: string, input: ChangeProjectStatusInput): Promise<Project> {
  return withTransaction(async (client) => {
    const before = await lockProject(client, id, canSeeCosts(auth));

    if (before.status === "HISTORICAL") {
      throw conflict(`Project ${before.jobNumber} ${HISTORICAL_READ_ONLY}`);
    }
    if (input.completedDate && input.status !== "COMPLETED") {
      throw validationError("Some fields are invalid.", [
        { field: "completedDate", message: "A completion date can only be given when completing a project." },
      ]);
    }
    if (before.status === input.status) {
      return before;
    }
    if (!STATUS_TRANSITIONS[before.status].includes(input.status)) {
      throw conflict(`A project that is ${before.status} cannot be changed to ${input.status}.`);
    }

    let completedDate: string | null = null;

    if (input.status === "COMPLETED") {
      const today = await client.query<{ today: string }>("SELECT CURRENT_DATE::text AS today");
      completedDate = input.completedDate ?? (today.rows[0] as { today: string }).today;

      // Both are YYYY-MM-DD, so text order is date order.
      if (completedDate < before.jobDate) {
        throw validationError("Some fields are invalid.", [
          { field: "completedDate", message: "Completion date cannot be before the job date." },
        ]);
      }
    }

    await client.query("UPDATE projects SET status = $1, completed_date = $2, updated_by = $3 WHERE id = $4", [
      input.status,
      completedDate,
      auth.user.id,
      id,
    ]);

    await logActivity(client, {
      userId: auth.user.id,
      action: "project.status_changed",
      module: "PROJECTS",
      entityType: "projects",
      entityId: id,
      description: `Project ${before.jobNumber} changed from ${before.status} to ${input.status}.`,
      metadata: { from: before.status, to: input.status, completedDate },
    });

    return findProject(client, id, canSeeCosts(auth));
  });
}

interface SummaryRow {
  total: number;
  new: number;
  in_progress: number;
  completed: number;
  cancelled: number;
  historical: number;
  ready_for_invoice: number;
  no_invoice_required: number;
  total_job_value: string;
  total_grand_value: string;
  ready_for_invoice_value: string;
  historical_job_value: string;
  historical_grand_value: string;
  tracked_expenses: string;
  operational_job_margin: string;
  cancelled_tracked_expenses: string;
  historical_tracked_expenses: string;
}

/**
 * Real figures for the dashboard and reports. Every value is calculated on
 * read from projects and v_project_financials; nothing is stored or estimated.
 * Value and cost totals leave cancelled projects out; what was spent on
 * cancelled projects is reported separately so it is not lost.
 * Historical projects are not operational work: they are in none of the
 * operational counts and totals, and are reported apart in the same way.
 */
export async function getProjectSummary(auth: AuthContext) {
  const result = await pool.query<SummaryRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE p.status = 'NEW')::int AS new,
       count(*) FILTER (WHERE p.status = 'IN_PROGRESS')::int AS in_progress,
       count(*) FILTER (WHERE p.status = 'COMPLETED')::int AS completed,
       count(*) FILTER (WHERE p.status = 'CANCELLED')::int AS cancelled,
       count(*) FILTER (WHERE p.status = 'HISTORICAL')::int AS historical,
       count(*) FILTER (WHERE f.invoice_state = 'READY_FOR_INVOICE')::int AS ready_for_invoice,
       count(*) FILTER (WHERE f.invoice_state = 'NO_INVOICE_REQUIRED')::int AS no_invoice_required,
       COALESCE(sum(p.job_value) FILTER (WHERE p.status NOT IN ('CANCELLED', 'HISTORICAL')), 0)::numeric(18,3) AS total_job_value,
       COALESCE(sum(p.grand_value) FILTER (WHERE p.status NOT IN ('CANCELLED', 'HISTORICAL')), 0)::numeric(18,3) AS total_grand_value,
       COALESCE(sum(p.job_value) FILTER (WHERE f.invoice_state = 'READY_FOR_INVOICE'), 0)::numeric(18,3) AS ready_for_invoice_value,
       COALESCE(sum(p.job_value) FILTER (WHERE p.status = 'HISTORICAL'), 0)::numeric(18,3) AS historical_job_value,
       COALESCE(sum(p.grand_value) FILTER (WHERE p.status = 'HISTORICAL'), 0)::numeric(18,3) AS historical_grand_value,
       COALESCE(sum(f.tracked_expenses) FILTER (WHERE p.status NOT IN ('CANCELLED', 'HISTORICAL')), 0)::numeric(18,3) AS tracked_expenses,
       COALESCE(sum(f.operational_job_margin) FILTER (WHERE p.status NOT IN ('CANCELLED', 'HISTORICAL')), 0)::numeric(18,3) AS operational_job_margin,
       COALESCE(sum(f.tracked_expenses) FILTER (WHERE p.status = 'CANCELLED'), 0)::numeric(18,3) AS cancelled_tracked_expenses,
       COALESCE(sum(f.tracked_expenses) FILTER (WHERE p.status = 'HISTORICAL'), 0)::numeric(18,3) AS historical_tracked_expenses
     FROM projects p
     JOIN v_project_financials f ON f.project_id = p.id`
  );
  const row = result.rows[0] as SummaryRow;

  return {
    counts: {
      total: row.total,
      // NEW or IN_PROGRESS.
      active: row.new + row.in_progress,
      new: row.new,
      inProgress: row.in_progress,
      completed: row.completed,
      cancelled: row.cancelled,
      // Imported from an earlier register; in none of the counts above except total.
      historical: row.historical,
      readyForInvoice: row.ready_for_invoice,
      noInvoiceRequired: row.no_invoice_required,
    },
    values: {
      // Excluding VAT, cancelled and historical projects left out.
      totalJobValue: row.total_job_value,
      // Including VAT, cancelled and historical projects left out.
      totalGrandValue: row.total_grand_value,
      // Job value excluding VAT of the projects that are ready for invoice.
      readyForInvoiceValue: row.ready_for_invoice_value,
      // The historical projects on their own, excluding and including VAT.
      historicalJobValue: row.historical_job_value,
      historicalGrandValue: row.historical_grand_value,
    },
    // Null when the signed-in user does not hold EXPENSES:VIEW.
    costs: canSeeCosts(auth)
      ? {
          trackedExpenses: row.tracked_expenses,
          // Total job value excluding VAT minus tracked expenses. Not accounting profit.
          operationalJobMargin: row.operational_job_margin,
          trackedExpensesOnCancelledProjects: row.cancelled_tracked_expenses,
          trackedExpensesOnHistoricalProjects: row.historical_tracked_expenses,
        }
      : null,
  };
}

/**
 * Used by Procurement and Expenses: the project a new record is attached to
 * must exist and must be neither cancelled nor historical. Locks the row so
 * the project cannot be cancelled while the record is being saved.
 */
export async function requireOpenProject(db: Queryable, projectId: string): Promise<{ id: string; jobNumber: string }> {
  const result = await db.query<{ job_number: string; status: ProjectStatus }>(
    "SELECT job_number, status FROM projects WHERE id = $1 FOR SHARE",
    [projectId]
  );
  const project = result.rows[0];

  if (!project) {
    throw validationError("Some fields are invalid.", [{ field: "projectId", message: "The selected project does not exist." }]);
  }
  if (project.status === "CANCELLED") {
    throw validationError("Some fields are invalid.", [
      { field: "projectId", message: `Project ${project.job_number} is cancelled. Nothing new can be recorded against it.` },
    ]);
  }
  if (project.status === "HISTORICAL") {
    throw validationError("Some fields are invalid.", [
      { field: "projectId", message: `Project ${project.job_number} is a historical record. Nothing new can be recorded against it.` },
    ]);
  }

  return { id: projectId, jobNumber: project.job_number };
}
