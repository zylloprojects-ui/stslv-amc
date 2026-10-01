import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { requireOpenProject } from "../projects/projects.service";
import type { CreateExpenseInput, ListExpensesQuery, UpdateExpenseInput, VoidExpenseInput } from "./expenses.schemas";

interface ExpenseRow {
  id: string;
  project_id: string;
  job_number: string;
  project_description: string;
  client_name: string;
  category_id: string;
  category_code: string;
  category_name: string;
  expense_date: string;
  description: string;
  payee_name: string | null;
  amount: string;
  payment_reference: string | null;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Expense {
  id: string;
  projectId: string;
  jobNumber: string;
  projectDescription: string;
  clientName: string;
  categoryId: string;
  categoryCode: string;
  categoryName: string;
  /** YYYY-MM-DD */
  expenseDate: string;
  description: string;
  payeeName: string | null;
  /** Decimal string with three decimals, as entered. */
  amount: string;
  paymentReference: string | null;
  notes: string | null;
  isVoided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseCategory {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

const FROM_EXPENSES = `
  FROM project_expenses e
  JOIN projects p ON p.id = e.project_id
  JOIN clients c ON c.id = p.client_id
  JOIN expense_categories k ON k.id = e.expense_category_id`;

const SELECT_EXPENSE = `
  SELECT e.id, e.project_id, p.job_number, p.description AS project_description, c.name AS client_name,
         e.expense_category_id AS category_id, k.code AS category_code, k.name AS category_name,
         e.expense_date::text AS expense_date, e.description, e.payee_name, e.amount,
         e.payment_reference, e.notes, e.voided_at, e.void_reason, e.created_at, e.updated_at
  ${FROM_EXPENSES}`;

const EDITABLE_FIELDS = [
  "projectId",
  "categoryId",
  "expenseDate",
  "description",
  "payeeName",
  "amount",
  "paymentReference",
  "notes",
] as const;

function toExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    projectId: row.project_id,
    jobNumber: row.job_number,
    projectDescription: row.project_description,
    clientName: row.client_name,
    categoryId: row.category_id,
    categoryCode: row.category_code,
    categoryName: row.category_name,
    expenseDate: row.expense_date,
    description: row.description,
    payeeName: row.payee_name,
    amount: row.amount,
    paymentReference: row.payment_reference,
    notes: row.notes,
    isVoided: row.voided_at !== null,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidReason: row.void_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function findExpense(db: Queryable, id: string, lock = false): Promise<Expense> {
  const result = await db.query<ExpenseRow>(`${SELECT_EXPENSE} WHERE e.id = $1${lock ? " FOR UPDATE OF e" : ""}`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("Expense not found.");
  }

  return toExpense(row);
}

/** A category chosen for an expense must exist and be active. */
async function requireActiveCategory(db: Queryable, categoryId: string): Promise<void> {
  const result = await db.query<{ is_active: boolean }>("SELECT is_active FROM expense_categories WHERE id = $1", [categoryId]);
  const category = result.rows[0];

  if (!category) {
    throw validationError("Some fields are invalid.", [{ field: "categoryId", message: "The selected category does not exist." }]);
  }
  if (!category.is_active) {
    throw validationError("Some fields are invalid.", [{ field: "categoryId", message: "The selected category is no longer in use." }]);
  }
}

export async function listExpenseCategories(): Promise<ExpenseCategory[]> {
  const result = await pool.query<{ id: string; code: string; name: string; is_active: boolean }>(
    "SELECT id, code, name, is_active FROM expense_categories ORDER BY sort_order, name"
  );

  return result.rows.map((row) => ({ id: row.id, code: row.code, name: row.name, isActive: row.is_active }));
}

export async function listExpenses(query: ListExpensesQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.includeVoided !== "true") {
    conditions.push("e.voided_at IS NULL");
  }
  if (query.projectId) {
    params.push(query.projectId);
    conditions.push(`e.project_id = $${params.length}`);
  }
  if (query.categoryId) {
    params.push(query.categoryId);
    conditions.push(`e.expense_category_id = $${params.length}`);
  }
  if (query.dateFrom) {
    params.push(query.dateFrom);
    conditions.push(`e.expense_date >= $${params.length}`);
  }
  if (query.dateTo) {
    params.push(query.dateTo);
    conditions.push(`e.expense_date <= $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(e.description ILIKE ${p} OR e.payee_name ILIKE ${p} OR e.payment_reference ILIKE ${p} OR p.job_number ILIKE ${p})`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // The total covers every expense that matches the filters, not just the
  // page shown, and never includes a voided expense. Summed by PostgreSQL.
  const totals = await pool.query<{ count: number; total_amount: string }>(
    `SELECT count(*)::int AS count,
            COALESCE(sum(e.amount) FILTER (WHERE e.voided_at IS NULL), 0)::numeric(18,3) AS total_amount
     ${FROM_EXPENSES} ${where}`,
    params
  );

  const rows = await pool.query<ExpenseRow>(
    `${SELECT_EXPENSE} ${where}
     ORDER BY e.expense_date DESC, e.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toExpense),
    total: totals.rows[0]?.count ?? 0,
    totalAmount: totals.rows[0]?.total_amount ?? "0.000",
    page: query.page,
    pageSize: query.pageSize,
  };
}

export function getExpense(id: string): Promise<Expense> {
  return findExpense(pool, id);
}

export function createExpense(auth: AuthContext, input: CreateExpenseInput): Promise<Expense> {
  return withTransaction(async (client) => {
    const project = await requireOpenProject(client, input.projectId);
    await requireActiveCategory(client, input.categoryId);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO project_expenses (project_id, expense_category_id, expense_date, description, payee_name,
                                     amount, payment_reference, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       RETURNING id`,
      [
        input.projectId,
        input.categoryId,
        input.expenseDate,
        input.description,
        input.payeeName ?? null,
        input.amount,
        input.paymentReference ?? null,
        input.notes ?? null,
        auth.user.id,
      ]
    );
    const created = await findExpense(client, (inserted.rows[0] as { id: string }).id);

    await logActivity(client, {
      userId: auth.user.id,
      action: "expense.created",
      module: "EXPENSES",
      entityType: "project_expenses",
      entityId: created.id,
      description: `Expense of ${created.amount} recorded against project ${project.jobNumber}.`,
      metadata: { projectId: project.id, jobNumber: project.jobNumber, amount: created.amount, category: created.categoryCode },
    });

    return created;
  });
}

export function updateExpense(auth: AuthContext, id: string, input: UpdateExpenseInput): Promise<Expense> {
  return withTransaction(async (client) => {
    const before = await findExpense(client, id, true);

    if (before.isVoided) {
      throw conflict("A voided expense cannot be edited.");
    }

    const after: Expense = { ...before };

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
      return before;
    }
    if (changes.projectId) {
      await requireOpenProject(client, after.projectId);
    }
    if (changes.categoryId) {
      await requireActiveCategory(client, after.categoryId);
    }

    await client.query(
      `UPDATE project_expenses
       SET project_id = $1, expense_category_id = $2, expense_date = $3, description = $4, payee_name = $5,
           amount = $6, payment_reference = $7, notes = $8, updated_by = $9
       WHERE id = $10`,
      [
        after.projectId,
        after.categoryId,
        after.expenseDate,
        after.description,
        after.payeeName,
        after.amount,
        after.paymentReference,
        after.notes,
        auth.user.id,
        id,
      ]
    );

    await logActivity(client, {
      userId: auth.user.id,
      action: "expense.updated",
      module: "EXPENSES",
      entityType: "project_expenses",
      entityId: id,
      description: `Expense on project ${before.jobNumber} updated.`,
      metadata: { changes },
    });

    return findExpense(client, id);
  });
}

/** Voiding replaces deletion: the row stays, with who voided it and why, and leaves every total. */
export function voidExpense(auth: AuthContext, id: string, input: VoidExpenseInput): Promise<Expense> {
  return withTransaction(async (client) => {
    const before = await findExpense(client, id, true);

    if (before.isVoided) {
      throw conflict("This expense is already voided.");
    }

    await client.query(
      "UPDATE project_expenses SET voided_at = now(), voided_by = $1, void_reason = $2, updated_by = $1 WHERE id = $3",
      [auth.user.id, input.reason, id]
    );

    await logActivity(client, {
      userId: auth.user.id,
      action: "expense.voided",
      module: "EXPENSES",
      entityType: "project_expenses",
      entityId: id,
      description: `Expense of ${before.amount} on project ${before.jobNumber} voided.`,
      metadata: { amount: before.amount, jobNumber: before.jobNumber, reason: input.reason },
    });

    return findExpense(client, id);
  });
}
