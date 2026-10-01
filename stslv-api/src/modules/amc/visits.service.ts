import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import type {
  ContractStatus,
  InvoiceEligibility,
  MaintenanceFrequency,
  VisitStatus,
} from "./amc.constants";
import type {
  ListExecutionQuery,
  ListVisitsQuery,
  UpdateExecutionInput,
  UpdateVisitInput,
} from "./amc.schemas";

interface VisitRow {
  id: string;
  amc_contract_id: string;
  contract_status: ContractStatus;
  system_description: string;
  maintenance_frequency: MaintenanceFrequency;
  client_id: string;
  client_name: string;
  sequence_no: number;
  period_start: string;
  period_end: string;
  original_scheduled_date: string;
  scheduled_date: string;
  is_overdue: boolean;
  assigned_to: string | null;
  responsible_engineer: string | null;
  status: VisitStatus;
  visit_amount: string | null;
  amount_is_custom: boolean;
  completed_date: string | null;
  completed_by: string | null;
  completed_by_name: string | null;
  work_performed: string | null;
  execution_notes: string | null;
  status_reason: string | null;
  notes: string | null;
  invoice_eligibility: InvoiceEligibility;
  created_at: Date;
  updated_at: Date;
}

/** A visit as the execution screens see it: no amounts and no invoicing state. */
export interface ExecutionVisit {
  id: string;
  contract: { id: string; status: ContractStatus; systemDescription: string; maintenanceFrequency: MaintenanceFrequency };
  client: { id: string; name: string };
  sequenceNo: number;
  periodStart: string;
  periodEnd: string;
  originalScheduledDate: string;
  scheduledDate: string;
  isRescheduled: boolean;
  /** Derived: still scheduled or postponed, and the planned date has passed. */
  isOverdue: boolean;
  /** The person assigned to the visit, or the contract's responsible engineer when nobody is. */
  assignedTo: string | null;
  /** The assignment made on this visit alone; null when it follows the contract. */
  assignedToOverride: string | null;
  status: VisitStatus;
  completedDate: string | null;
  completedBy: { id: string; fullName: string } | null;
  workPerformed: string | null;
  executionNotes: string | null;
  statusReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A visit as the schedule sees it: the same record plus its amount and invoice eligibility. */
export interface ScheduleVisit extends ExecutionVisit {
  /** Text with three decimals, or null when no amount has been set. */
  visitAmount: string | null;
  amountIsCustom: boolean;
  /** Derived by v_amc_visit_billing. */
  invoiceEligibility: InvoiceEligibility;
}

const OVERDUE_SQL = "(v.status IN ('SCHEDULED', 'POSTPONED') AND v.scheduled_date < current_date)";

const VISIT_SELECT = `
  SELECT v.id, v.amc_contract_id, c.status AS contract_status, c.system_description, c.maintenance_frequency,
         c.client_id, cl.name AS client_name, v.sequence_no,
         v.period_start::text AS period_start, v.period_end::text AS period_end,
         v.original_scheduled_date::text AS original_scheduled_date, v.scheduled_date::text AS scheduled_date,
         ${OVERDUE_SQL} AS is_overdue,
         v.assigned_to, c.responsible_engineer, v.status, v.visit_amount, v.amount_is_custom,
         v.completed_date::text AS completed_date, v.completed_by, u.full_name AS completed_by_name,
         v.work_performed, v.execution_notes, v.status_reason, v.notes,
         b.invoice_eligibility, v.created_at, v.updated_at`;

const VISIT_FROM = `
  FROM amc_visits v
  JOIN amc_contracts c ON c.id = v.amc_contract_id
  JOIN clients cl ON cl.id = c.client_id
  JOIN v_amc_visit_billing b ON b.amc_visit_id = v.id
  LEFT JOIN users u ON u.id = v.completed_by`;

function toExecutionVisit(row: VisitRow): ExecutionVisit {
  return {
    id: row.id,
    contract: {
      id: row.amc_contract_id,
      status: row.contract_status,
      systemDescription: row.system_description,
      maintenanceFrequency: row.maintenance_frequency,
    },
    client: { id: row.client_id, name: row.client_name },
    sequenceNo: row.sequence_no,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    originalScheduledDate: row.original_scheduled_date,
    scheduledDate: row.scheduled_date,
    isRescheduled: row.scheduled_date !== row.original_scheduled_date,
    isOverdue: row.is_overdue,
    assignedTo: row.assigned_to ?? row.responsible_engineer,
    assignedToOverride: row.assigned_to,
    status: row.status,
    completedDate: row.completed_date,
    completedBy: row.completed_by && row.completed_by_name ? { id: row.completed_by, fullName: row.completed_by_name } : null,
    workPerformed: row.work_performed,
    executionNotes: row.execution_notes,
    statusReason: row.status_reason,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toScheduleVisit(row: VisitRow): ScheduleVisit {
  return {
    ...toExecutionVisit(row),
    visitAmount: row.visit_amount,
    amountIsCustom: row.amount_is_custom,
    invoiceEligibility: row.invoice_eligibility,
  };
}

async function findVisitRow(db: Queryable, id: string, lock = false): Promise<VisitRow> {
  if (lock) {
    await db.query("SELECT id FROM amc_visits WHERE id = $1 FOR UPDATE", [id]);
  }

  const result = await db.query<VisitRow>(`${VISIT_SELECT} ${VISIT_FROM} WHERE v.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("AMC visit not found.");
  }

  return row;
}

/**
 * A historical visit was imported from an earlier schedule. It records what
 * that schedule said and nothing more, so no application route may change it
 * or give it an operational status.
 */
function assertNotHistorical(row: VisitRow): void {
  if (row.status === "HISTORICAL") {
    throw conflict("This visit is a historical record imported from an earlier schedule. It cannot be changed.");
  }
}

export async function getScheduleVisit(id: string): Promise<ScheduleVisit> {
  return toScheduleVisit(await findVisitRow(pool, id));
}

export async function getExecutionVisit(id: string): Promise<ExecutionVisit> {
  return toExecutionVisit(await findVisitRow(pool, id));
}

function searchCondition(params: unknown[], search: string): string {
  params.push(`%${escapeLike(search)}%`);
  const p = `$${params.length}`;

  return `(cl.name ILIKE ${p} OR c.system_description ILIKE ${p} OR COALESCE(v.assigned_to, c.responsible_engineer) ILIKE ${p})`;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export async function listVisits(query: ListVisitsQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.from) {
    params.push(query.from);
    conditions.push(`v.scheduled_date >= $${params.length}`);
  }
  if (query.to) {
    params.push(query.to);
    conditions.push(`v.scheduled_date <= $${params.length}`);
  }
  if (query.clientId) {
    params.push(query.clientId);
    conditions.push(`c.client_id = $${params.length}`);
  }
  if (query.contractId) {
    params.push(query.contractId);
    conditions.push(`v.amc_contract_id = $${params.length}`);
  }
  if (query.status && query.status.length > 0) {
    params.push(query.status);
    conditions.push(`v.status = ANY($${params.length}::text[])`);
  }
  if (query.system) {
    params.push(query.system);
    conditions.push(`lower(btrim(c.system_description)) = lower(btrim($${params.length}))`);
  }
  if (query.invoiceEligibility) {
    params.push(query.invoiceEligibility);
    conditions.push(`b.invoice_eligibility = $${params.length}`);
  }
  if (query.overdue) {
    conditions.push(query.overdue === "true" ? OVERDUE_SQL : `NOT ${OVERDUE_SQL}`);
  }
  if (query.search) {
    conditions.push(searchCondition(params, query.search));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Totals cover every visit that matches the filters, not only the page shown.
  const totals = await pool.query<{ count: number; amount_total: string; amount_missing_count: number }>(
    `SELECT count(*)::int AS count,
            COALESCE(sum(v.visit_amount) FILTER (WHERE v.status <> 'CANCELLED'), 0)::numeric(16,3) AS amount_total,
            count(*) FILTER (WHERE v.status <> 'CANCELLED' AND v.visit_amount IS NULL)::int AS amount_missing_count
     ${VISIT_FROM} ${where}`,
    params
  );
  const rows = await pool.query<VisitRow>(
    `${VISIT_SELECT} ${VISIT_FROM} ${where}
     ORDER BY v.scheduled_date, lower(cl.name), v.id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toScheduleVisit),
    total: totals.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    totals: {
      /** Sum of the amounts of the matching visits, cancelled visits excluded. */
      visitAmount: totals.rows[0]?.amount_total ?? "0.000",
      amountMissingCount: totals.rows[0]?.amount_missing_count ?? 0,
    },
  };
}

/** Planning changes to one visit: amount, planned date, assignment and office notes. */
export function updateVisit(auth: AuthContext, id: string, input: UpdateVisitInput): Promise<ScheduleVisit> {
  return withTransaction(async (client) => {
    const row = await findVisitRow(client, id, true);

    assertNotHistorical(row);

    const before = {
      visitAmount: row.visit_amount,
      scheduledDate: row.scheduled_date,
      assignedTo: row.assigned_to,
      notes: row.notes,
    };
    const after = { ...before };

    if (input.visitAmount !== undefined) after.visitAmount = input.visitAmount;
    if (input.scheduledDate !== undefined) after.scheduledDate = input.scheduledDate;
    if (input.assignedTo !== undefined) after.assignedTo = input.assignedTo;
    if (input.notes !== undefined) after.notes = input.notes;

    const changes = diffFields(before, after, ["visitAmount", "scheduledDate", "assignedTo", "notes"]);

    if (Object.keys(changes).length === 0) {
      return toScheduleVisit(row);
    }
    if ("scheduledDate" in changes && (row.status === "COMPLETED" || row.status === "CANCELLED")) {
      throw validationError(`A ${row.status.toLowerCase()} visit cannot be rescheduled.`, [
        { field: "scheduledDate", message: `A ${row.status.toLowerCase()} visit cannot be rescheduled.` },
      ]);
    }

    await client.query(
      `UPDATE amc_visits
       SET visit_amount = $1, amount_is_custom = amount_is_custom OR $2, scheduled_date = $3, assigned_to = $4,
           notes = $5, updated_by = $6
       WHERE id = $7`,
      [after.visitAmount, "visitAmount" in changes, after.scheduledDate, after.assignedTo, after.notes, auth.user.id, id]
    );

    await logActivity(client, {
      userId: auth.user.id,
      action: "visitAmount" in changes ? "amc_visit.amount_changed" : "amc_visit.updated",
      module: "AMC_SCHEDULE",
      entityType: "amc_visits",
      entityId: id,
      description: `AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) updated.`,
      metadata: { changes },
    });

    return toScheduleVisit(await findVisitRow(client, id));
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export async function listExecutionVisits(query: ListExecutionQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  // Outstanding work of a cancelled contract is not put in front of the execution team.
  const outstanding = "v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED') AND c.status <> 'CANCELLED'";
  let order = "v.scheduled_date, lower(cl.name), v.id";

  if (query.scope === "due") {
    conditions.push(`${outstanding} AND v.scheduled_date <= current_date`);
  } else if (query.scope === "upcoming") {
    params.push(query.days);
    conditions.push(
      `${outstanding} AND v.scheduled_date > current_date AND v.scheduled_date <= current_date + $${params.length}::int`
    );
  } else if (query.scope === "open") {
    conditions.push(outstanding);
  } else if (query.scope === "completed") {
    conditions.push("v.status = 'COMPLETED'");
    order = "v.completed_date DESC, lower(cl.name), v.id";
  }

  if (query.clientId) {
    params.push(query.clientId);
    conditions.push(`c.client_id = $${params.length}`);
  }
  if (query.search) {
    conditions.push(searchCondition(params, query.search));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count ${VISIT_FROM} ${where}`, params);
  const rows = await pool.query<VisitRow>(
    `${VISIT_SELECT} ${VISIT_FROM} ${where}
     ORDER BY ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toExecutionVisit),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

const fieldError = (field: string, message: string) => validationError(message, [{ field, message }]);

/** Execution changes to one visit: status, completion, planned date and work notes. */
export function updateExecution(auth: AuthContext, id: string, input: UpdateExecutionInput): Promise<ExecutionVisit> {
  return withTransaction(async (client) => {
    const row = await findVisitRow(client, id, true);

    assertNotHistorical(row);

    const status = input.status ?? row.status;
    const statusChanged = status !== row.status;

    // Reopening completed work changes what is ready for invoice, so it needs
    // the APPROVE permission. PROVISIONAL: who may reopen is unconfirmed.
    if (row.status === "COMPLETED" && statusChanged && !auth.permissions.has("AMC_EXECUTION:APPROVE")) {
      throw forbidden("A completed visit can only be reopened by a user with approval permission for AMC Execution.");
    }

    let completedDate = row.completed_date;
    let completedBy = row.completed_by;

    if (status === "COMPLETED") {
      if (input.completedDate !== undefined) {
        completedDate = input.completedDate;
      }
      if (!completedDate) {
        throw fieldError("completedDate", "Enter the date the visit was completed.");
      }

      // One day of tolerance, because the server's date can be behind the user's.
      const allowed = await client.query<{ ok: boolean }>("SELECT $1::date <= current_date + 1 AS ok", [completedDate]);

      if (!allowed.rows[0]?.ok) {
        throw fieldError("completedDate", "The completion date cannot be in the future.");
      }
      if (statusChanged) {
        completedBy = auth.user.id;
      }
    } else {
      if (input.completedDate) {
        throw fieldError("completedDate", "A completion date can only be recorded on a completed visit.");
      }
      completedDate = null;
      completedBy = null;
    }

    if (input.scheduledDate !== undefined && input.scheduledDate !== row.scheduled_date) {
      if (status === "COMPLETED" || status === "CANCELLED") {
        throw fieldError("scheduledDate", `A ${status.toLowerCase()} visit cannot be rescheduled.`);
      }
    }

    // A reason belongs to a postponement or cancellation and is dropped when the visit moves on.
    const keepsReason = status === "POSTPONED" || status === "CANCELLED";
    const before = {
      status: row.status,
      completedDate: row.completed_date,
      scheduledDate: row.scheduled_date,
      workPerformed: row.work_performed,
      executionNotes: row.execution_notes,
      statusReason: row.status_reason,
    };
    const after = {
      status,
      completedDate,
      scheduledDate: input.scheduledDate ?? row.scheduled_date,
      workPerformed: input.workPerformed !== undefined ? input.workPerformed : row.work_performed,
      executionNotes: input.executionNotes !== undefined ? input.executionNotes : row.execution_notes,
      statusReason: !keepsReason ? null : input.statusReason !== undefined ? input.statusReason : statusChanged ? null : row.status_reason,
    };
    const changes = diffFields(before, after, [
      "status",
      "completedDate",
      "scheduledDate",
      "workPerformed",
      "executionNotes",
      "statusReason",
    ]);

    if (Object.keys(changes).length === 0) {
      return toExecutionVisit(row);
    }

    await client.query(
      `UPDATE amc_visits
       SET status = $1, completed_date = $2, completed_by = $3, scheduled_date = $4, work_performed = $5,
           execution_notes = $6, status_reason = $7, updated_by = $8
       WHERE id = $9`,
      [
        after.status,
        after.completedDate,
        completedBy,
        after.scheduledDate,
        after.workPerformed,
        after.executionNotes,
        after.statusReason,
        auth.user.id,
        id,
      ]
    );

    const label = `AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description})`;

    await logActivity(client, {
      userId: auth.user.id,
      action: !statusChanged ? "amc_visit.execution_updated" : status === "COMPLETED" ? "amc_visit.completed" : "amc_visit.status_changed",
      module: "AMC_EXECUTION",
      entityType: "amc_visits",
      entityId: id,
      description: statusChanged ? `${label} changed from ${row.status} to ${status}.` : `${label} execution details updated.`,
      metadata: { changes },
    });

    return toExecutionVisit(await findVisitRow(client, id));
  });
}
