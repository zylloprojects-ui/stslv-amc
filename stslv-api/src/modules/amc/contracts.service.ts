import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import {
  CONTRACT_TRANSITIONS,
  MAX_CONTRACT_YEARS,
  type ContractStatus,
  type MaintenanceFrequency,
  type VisitStatus,
} from "./amc.constants";
import {
  addMonths,
  buildSchedulePeriods,
  planSchedule,
  type ExistingVisit,
  type SchedulePeriod,
  type SchedulePlan,
} from "./amc.schedule";
import type {
  ChangeContractStatusInput,
  CreateContractInput,
  ListContractsQuery,
  SchedulePreviewQuery,
  UpdateContractInput,
} from "./amc.schemas";

interface ContractRow {
  id: string;
  client_id: string;
  client_name: string;
  client_is_active: boolean;
  responsible_engineer: string | null;
  valid_from: string;
  valid_to: string;
  system_description: string;
  description: string | null;
  contract_value: string;
  final_credit: string | null;
  maintenance_frequency: MaintenanceFrequency;
  default_visit_amount: string | null;
  status: ContractStatus;
  is_past_validity: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  visit_count: number;
  completed_count: number;
  open_count: number;
  cancelled_count: number;
  amount_missing_count: number;
  scheduled_total: string;
  value_difference: string;
}

export interface Contract {
  id: string;
  client: { id: string; name: string; isActive: boolean };
  responsibleEngineer: string | null;
  validFrom: string;
  validTo: string;
  systemDescription: string;
  description: string | null;
  /** Money values are text with three decimals, for example "1620.000". */
  contractValue: string;
  /** Stored as entered. Its meaning is unconfirmed, so nothing is calculated from it. */
  finalCredit: string | null;
  maintenanceFrequency: MaintenanceFrequency;
  defaultVisitAmount: string | null;
  status: ContractStatus;
  /** The validity period has ended. Information only: the status does not change by itself. */
  isPastValidity: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  schedule: {
    /** Visits that are not cancelled. */
    visitCount: number;
    completedCount: number;
    openCount: number;
    cancelledCount: number;
    /** Non-cancelled visits with no amount set. */
    amountMissingCount: number;
    /** Sum of the visit amounts of the non-cancelled visits. */
    scheduledTotal: string;
    /**
     * contractValue minus scheduledTotal. Shown for information only: no rule
     * says the two must be equal, so a difference is never treated as an error.
     */
    valueDifference: string;
  };
}

export interface ScheduleChange {
  created: number;
  removed: number;
  kept: number;
}

// The lateral join keeps the per-contract visit figures in one place for the
// list and the detail view.
const CONTRACT_SELECT = `
  SELECT c.id, c.client_id, cl.name AS client_name, cl.is_active AS client_is_active,
         c.responsible_engineer, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to,
         c.system_description, c.description, c.contract_value, c.final_credit,
         c.maintenance_frequency, c.default_visit_amount, c.status,
         (c.valid_to < current_date) AS is_past_validity, c.notes, c.created_at, c.updated_at,
         s.visit_count, s.completed_count, s.open_count, s.cancelled_count, s.amount_missing_count,
         s.scheduled_total, (c.contract_value - s.scheduled_total)::numeric(16,3) AS value_difference
  FROM amc_contracts c
  JOIN clients cl ON cl.id = c.client_id
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE v.status <> 'CANCELLED')::int AS visit_count,
           count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed_count,
           count(*) FILTER (WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED'))::int AS open_count,
           count(*) FILTER (WHERE v.status = 'CANCELLED')::int AS cancelled_count,
           count(*) FILTER (WHERE v.status <> 'CANCELLED' AND v.visit_amount IS NULL)::int AS amount_missing_count,
           COALESCE(sum(v.visit_amount) FILTER (WHERE v.status <> 'CANCELLED'), 0)::numeric(16,3) AS scheduled_total
    FROM amc_visits v
    WHERE v.amc_contract_id = c.id
  ) s`;

/**
 * A visit is "locked" once anyone has acted on it. Schedule regeneration never
 * changes or removes a locked visit. Expects the amc_visits alias "v".
 */
export const VISIT_LOCKED_SQL = `(
  v.status <> 'SCHEDULED'
  OR v.scheduled_date <> v.original_scheduled_date
  OR v.amount_is_custom
  OR v.assigned_to IS NOT NULL
  OR v.work_performed IS NOT NULL
  OR v.execution_notes IS NOT NULL
  OR v.status_reason IS NOT NULL
  OR v.notes IS NOT NULL
)`;

const EDITABLE_FIELDS = [
  "clientId",
  "responsibleEngineer",
  "validFrom",
  "validTo",
  "systemDescription",
  "description",
  "contractValue",
  "finalCredit",
  "maintenanceFrequency",
  "defaultVisitAmount",
  "notes",
] as const;

const SCHEDULE_FIELDS = ["validFrom", "validTo", "maintenanceFrequency"] as const;

/** The editable values of a contract, flat, as compared and logged on update. */
type ContractValues = { [K in (typeof EDITABLE_FIELDS)[number]]: string | null };

function toContract(row: ContractRow): Contract {
  return {
    id: row.id,
    client: { id: row.client_id, name: row.client_name, isActive: row.client_is_active },
    responsibleEngineer: row.responsible_engineer,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    systemDescription: row.system_description,
    description: row.description,
    contractValue: row.contract_value,
    finalCredit: row.final_credit,
    maintenanceFrequency: row.maintenance_frequency,
    defaultVisitAmount: row.default_visit_amount,
    status: row.status,
    isPastValidity: row.is_past_validity,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    schedule: {
      visitCount: row.visit_count,
      completedCount: row.completed_count,
      openCount: row.open_count,
      cancelledCount: row.cancelled_count,
      amountMissingCount: row.amount_missing_count,
      scheduledTotal: row.scheduled_total,
      valueDifference: row.value_difference,
    },
  };
}

function valuesOf(contract: Contract): ContractValues {
  return {
    clientId: contract.client.id,
    responsibleEngineer: contract.responsibleEngineer,
    validFrom: contract.validFrom,
    validTo: contract.validTo,
    systemDescription: contract.systemDescription,
    description: contract.description,
    contractValue: contract.contractValue,
    finalCredit: contract.finalCredit,
    maintenanceFrequency: contract.maintenanceFrequency,
    defaultVisitAmount: contract.defaultVisitAmount,
    notes: contract.notes,
  };
}

function assertValidity(validFrom: string, validTo: string): void {
  if (validTo < validFrom) {
    throw validationError("The validity period is invalid.", [
      { field: "validTo", message: "Valid to must be on or after Valid from." },
    ]);
  }

  if (validTo >= addMonths(validFrom, MAX_CONTRACT_YEARS * 12)) {
    throw validationError("The validity period is too long.", [
      { field: "validTo", message: `The validity period cannot be longer than ${MAX_CONTRACT_YEARS} years.` },
    ]);
  }
}

/** A contract may only be given a client that exists and is active. */
async function assertSelectableClient(db: Queryable, clientId: string): Promise<void> {
  const result = await db.query<{ is_active: boolean }>("SELECT is_active FROM clients WHERE id = $1", [clientId]);
  const client = result.rows[0];

  if (!client) {
    throw validationError("The selected client does not exist.", [
      { field: "clientId", message: "The selected client does not exist." },
    ]);
  }
  if (!client.is_active) {
    throw validationError("The selected client is inactive.", [
      { field: "clientId", message: "An inactive client cannot be selected. Reactivate the client first." },
    ]);
  }
}

async function findContract(db: Queryable, id: string, lock = false): Promise<Contract> {
  if (lock) {
    // Every change to a contract or its schedule starts by locking the contract
    // row, so two schedule generations for one contract cannot run together.
    await db.query("SELECT id FROM amc_contracts WHERE id = $1 FOR UPDATE", [id]);
  }

  const result = await db.query<ContractRow>(`${CONTRACT_SELECT} WHERE c.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("AMC contract not found.");
  }

  return toContract(row);
}

export function getContract(id: string): Promise<Contract> {
  return findContract(pool, id);
}

export async function listContracts(query: ListContractsQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status !== "all") {
    params.push(query.status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (query.clientId) {
    params.push(query.clientId);
    conditions.push(`c.client_id = $${params.length}`);
  }
  if (query.frequency) {
    params.push(query.frequency);
    conditions.push(`c.maintenance_frequency = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(cl.name ILIKE ${p} OR c.system_description ILIKE ${p} OR c.description ILIKE ${p} OR c.responsible_engineer ILIKE ${p})`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id ${where}`,
    params
  );
  const rows = await pool.query<ContractRow>(
    `${CONTRACT_SELECT} ${where}
     ORDER BY lower(cl.name), c.valid_from DESC, c.id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toContract),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** The distinct system descriptions already in use, to suggest consistent wording. */
export async function listSystems(): Promise<string[]> {
  const result = await pool.query<{ system_description: string }>(
    `SELECT min(system_description) AS system_description
     FROM amc_contracts
     GROUP BY lower(btrim(system_description))
     ORDER BY lower(btrim(system_description))`
  );

  return result.rows.map((row) => row.system_description);
}

// ---------------------------------------------------------------------------
// Schedule generation
// ---------------------------------------------------------------------------

interface ExistingVisitRow {
  id: string;
  sequence_no: number;
  period_start: string;
  period_end: string;
  scheduled_date: string;
  status: VisitStatus;
  locked: boolean;
}

async function loadExistingVisits(db: Queryable, contractId: string, lock: boolean): Promise<ExistingVisit[]> {
  const result = await db.query<ExistingVisitRow>(
    `SELECT v.id, v.sequence_no, v.period_start::text AS period_start, v.period_end::text AS period_end,
            v.scheduled_date::text AS scheduled_date, v.status, ${VISIT_LOCKED_SQL} AS locked
     FROM amc_visits v
     WHERE v.amc_contract_id = $1
     ORDER BY v.period_start${lock ? " FOR UPDATE" : ""}`,
    [contractId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    sequenceNo: row.sequence_no,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    scheduledDate: row.scheduled_date,
    status: row.status,
    locked: row.locked,
  }));
}

interface Terms {
  validFrom: string;
  validTo: string;
  maintenanceFrequency: MaintenanceFrequency;
}

interface TermsPlan extends SchedulePlan {
  /** Why the terms cannot be applied, or null when they can. */
  blockedReason: string | null;
}

/** The schedule plan for a contract under the given terms, including the reasons a change is refused. */
function planForTerms(current: Terms, proposed: Terms, existing: ExistingVisit[]): TermsPlan {
  const periods = buildSchedulePeriods(proposed.validFrom, proposed.validTo, proposed.maintenanceFrequency);
  const plan = planSchedule(periods, existing, proposed.validFrom, proposed.validTo);
  const acted = existing.filter((visit) => visit.locked && visit.status !== "CANCELLED");
  let blockedReason: string | null = null;

  if (proposed.validFrom !== current.validFrom && acted.length > 0) {
    // Every period is counted from the start date. Moving it would shift all
    // periods under visits that have already been worked on.
    blockedReason =
      `Valid from cannot be changed: ${acted.length} visit(s) have already been worked on, edited or rescheduled. ` +
      "Record a new contract for different terms.";
  } else if (plan.blocking.length > 0) {
    blockedReason =
      `${plan.blocking.length} visit(s) that have been worked on, edited or rescheduled fall outside the new validity period ` +
      `(${plan.blocking.map((visit) => visit.periodStart).join(", ")}). Cancel those visits first, or keep them inside the validity period.`;
  }

  return { ...plan, blockedReason };
}

/** Removes the untouched visits and inserts the missing ones. The contract row must already be locked. */
async function applyPlan(
  db: Queryable,
  auth: AuthContext,
  contract: Contract,
  plan: SchedulePlan
): Promise<ScheduleChange> {
  if (plan.toRemove.length > 0) {
    // The locked condition is checked again in SQL: only a visit that is still
    // untouched at this moment is ever deleted.
    const removed = await db.query(
      `DELETE FROM amc_visits v
       WHERE v.amc_contract_id = $1 AND v.id = ANY($2::bigint[]) AND NOT ${VISIT_LOCKED_SQL}`,
      [contract.id, plan.toRemove.map((visit) => visit.id)]
    );

    if (removed.rowCount !== plan.toRemove.length) {
      throw conflict("The schedule changed while it was being updated. Please try again.");
    }
  }

  if (plan.toCreate.length > 0) {
    const last = await db.query<{ last: number }>(
      "SELECT COALESCE(max(sequence_no), 0)::int AS last FROM amc_visits WHERE amc_contract_id = $1",
      [contract.id]
    );
    const first = (last.rows[0]?.last ?? 0) + 1;

    await db.query(
      `INSERT INTO amc_visits
         (amc_contract_id, sequence_no, period_start, period_end, original_scheduled_date, scheduled_date,
          visit_amount, created_by, updated_by)
       SELECT $1, $2 + p.ordinality - 1, p.period_start, p.period_end, p.scheduled_date, p.scheduled_date,
              $3::numeric(14,3), $4, $4
       FROM unnest($5::date[], $6::date[], $7::date[]) WITH ORDINALITY AS p (period_start, period_end, scheduled_date, ordinality)`,
      [
        contract.id,
        first,
        contract.defaultVisitAmount,
        auth.user.id,
        plan.toCreate.map((period) => period.periodStart),
        plan.toCreate.map((period) => period.periodEnd),
        plan.toCreate.map((period) => period.scheduledDate),
      ]
    );
  }

  const change = { created: plan.toCreate.length, removed: plan.toRemove.length, kept: plan.kept.length };

  if (change.created > 0 || change.removed > 0) {
    await logActivity(db, {
      userId: auth.user.id,
      action: "amc_contract.schedule_generated",
      module: "AMC_SCHEDULE",
      entityType: "amc_contracts",
      entityId: contract.id,
      description: `Schedule updated: ${change.created} visit(s) added, ${change.removed} untouched visit(s) removed, ${change.kept} kept.`,
      metadata: {
        terms: {
          validFrom: contract.validFrom,
          validTo: contract.validTo,
          maintenanceFrequency: contract.maintenanceFrequency,
        },
        created: plan.toCreate.map((period) => period.periodStart),
        removed: plan.toRemove.map((visit) => ({ id: visit.id, sequenceNo: visit.sequenceNo, periodStart: visit.periodStart })),
      },
    });
  }

  return change;
}

/** Brings an ACTIVE contract's visits in line with its stored terms. */
async function syncSchedule(db: Queryable, auth: AuthContext, contract: Contract): Promise<ScheduleChange> {
  const existing = await loadExistingVisits(db, contract.id, true);
  const plan = planForTerms(contract, contract, existing);

  if (plan.blockedReason) {
    throw conflict(plan.blockedReason);
  }

  return applyPlan(db, auth, contract, plan);
}

export interface SchedulePreview {
  validFrom: string;
  validTo: string;
  maintenanceFrequency: MaintenanceFrequency;
  canApply: boolean;
  blockedReason: string | null;
  toCreate: (SchedulePeriod & { visitAmount: string | null })[];
  toRemove: ExistingVisit[];
  keptCount: number;
  blocking: ExistingVisit[];
}

/** What generating the schedule would do, for the stored terms or for proposed ones. Changes nothing. */
export async function previewSchedule(id: string, query: SchedulePreviewQuery): Promise<SchedulePreview> {
  const contract = await findContract(pool, id);
  const proposed: Terms = {
    validFrom: query.validFrom ?? contract.validFrom,
    validTo: query.validTo ?? contract.validTo,
    maintenanceFrequency: query.maintenanceFrequency ?? contract.maintenanceFrequency,
  };

  assertValidity(proposed.validFrom, proposed.validTo);

  const plan = planForTerms(contract, proposed, await loadExistingVisits(pool, id, false));

  return {
    ...proposed,
    canApply: plan.blockedReason === null,
    blockedReason: plan.blockedReason,
    toCreate: plan.toCreate.map((period) => ({ ...period, visitAmount: contract.defaultVisitAmount })),
    toRemove: plan.toRemove,
    keptCount: plan.kept.length,
    blocking: plan.blocking,
  };
}

/** Adds any missing visits to an ACTIVE contract. Safe to repeat. */
export function generateSchedule(
  auth: AuthContext,
  id: string
): Promise<{ contract: Contract; scheduleChange: ScheduleChange }> {
  return withTransaction(async (client) => {
    const contract = await findContract(client, id, true);

    if (contract.status !== "ACTIVE") {
      throw conflict("A schedule is generated only for an active contract. Activate the contract first.");
    }

    const scheduleChange = await syncSchedule(client, auth, contract);

    return { contract: await findContract(client, id), scheduleChange };
  });
}

// ---------------------------------------------------------------------------
// Create, update, status
// ---------------------------------------------------------------------------

export function createContract(
  auth: AuthContext,
  input: CreateContractInput
): Promise<Contract & { scheduleChange: ScheduleChange | null }> {
  assertValidity(input.validFrom, input.validTo);

  return withTransaction(async (client) => {
    await assertSelectableClient(client, input.clientId);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO amc_contracts
         (client_id, responsible_engineer, valid_from, valid_to, system_description, description,
          contract_value, final_credit, maintenance_frequency, default_visit_amount, status, notes,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
       RETURNING id`,
      [
        input.clientId,
        input.responsibleEngineer ?? null,
        input.validFrom,
        input.validTo,
        input.systemDescription,
        input.description ?? null,
        input.contractValue,
        input.finalCredit ?? null,
        input.maintenanceFrequency,
        input.defaultVisitAmount ?? null,
        input.status,
        input.notes ?? null,
        auth.user.id,
      ]
    );
    const id = (inserted.rows[0] as { id: string }).id;
    const created = await findContract(client, id, true);

    await logActivity(client, {
      userId: auth.user.id,
      action: "amc_contract.created",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: id,
      description: `AMC contract for "${created.client.name}" (${created.systemDescription}) created as ${created.status}.`,
    });

    const scheduleChange = created.status === "ACTIVE" ? await syncSchedule(client, auth, created) : null;

    return { ...(await findContract(client, id)), scheduleChange };
  });
}

export function updateContract(
  auth: AuthContext,
  id: string,
  input: UpdateContractInput
): Promise<Contract & { scheduleChange: ScheduleChange | null }> {
  return withTransaction(async (client) => {
    const before = await findContract(client, id, true);
    const beforeValues = valuesOf(before);
    const afterValues: ContractValues = { ...beforeValues };

    for (const field of EDITABLE_FIELDS) {
      const value = input[field];
      if (value !== undefined) {
        afterValues[field] = value;
      }
    }

    const changes = diffFields(beforeValues, afterValues, EDITABLE_FIELDS);

    if (Object.keys(changes).length === 0) {
      return { ...before, scheduleChange: null };
    }

    const validFrom = afterValues.validFrom as string;
    const validTo = afterValues.validTo as string;
    const termsChanged = SCHEDULE_FIELDS.some((field) => field in changes);

    if ("clientId" in changes) {
      await assertSelectableClient(client, afterValues.clientId as string);
    }
    if (termsChanged) {
      assertValidity(validFrom, validTo);

      if (before.status !== "DRAFT" && before.status !== "ACTIVE") {
        throw conflict(
          `The validity period and frequency of a ${before.status.toLowerCase()} contract cannot be changed. Reactivate the contract first.`
        );
      }
    }

    await client.query(
      `UPDATE amc_contracts
       SET client_id = $1, responsible_engineer = $2, valid_from = $3, valid_to = $4, system_description = $5,
           description = $6, contract_value = $7, final_credit = $8, maintenance_frequency = $9,
           default_visit_amount = $10, notes = $11, updated_by = $12
       WHERE id = $13`,
      [
        afterValues.clientId,
        afterValues.responsibleEngineer,
        validFrom,
        validTo,
        afterValues.systemDescription,
        afterValues.description,
        afterValues.contractValue,
        afterValues.finalCredit,
        afterValues.maintenanceFrequency,
        afterValues.defaultVisitAmount,
        afterValues.notes,
        auth.user.id,
        id,
      ]
    );

    const updated = await findContract(client, id);
    let scheduleChange: ScheduleChange | null = null;

    // Only the terms drive the schedule. A new default visit amount applies to
    // visits generated from now on; existing visits keep their amounts.
    if (termsChanged && updated.status === "ACTIVE") {
      const plan = planForTerms(before, updated, await loadExistingVisits(client, id, true));

      if (plan.blockedReason) {
        throw conflict(plan.blockedReason);
      }

      scheduleChange = await applyPlan(client, auth, updated, plan);
    }

    await logActivity(client, {
      userId: auth.user.id,
      action: "amc_contract.updated",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: id,
      description: `AMC contract for "${updated.client.name}" (${updated.systemDescription}) updated.`,
      metadata: { changes },
    });

    return { ...(await findContract(client, id)), scheduleChange };
  });
}

export function changeContractStatus(
  auth: AuthContext,
  id: string,
  input: ChangeContractStatusInput
): Promise<Contract & { scheduleChange: ScheduleChange | null; cancelledVisits: number }> {
  // Contracts are never deleted, so the DELETE permission governs cancellation
  // (the same convention as deactivating a client).
  if (input.status === "CANCELLED" && !auth.permissions.has("AMC_CONTRACTS:DELETE")) {
    throw forbidden();
  }

  return withTransaction(async (client) => {
    const before = await findContract(client, id, true);

    if (before.status === input.status) {
      return { ...before, scheduleChange: null, cancelledVisits: 0 };
    }
    if (!CONTRACT_TRANSITIONS[before.status].includes(input.status)) {
      throw conflict(`A ${before.status.toLowerCase()} contract cannot be changed to ${input.status.toLowerCase()}.`);
    }

    await client.query("UPDATE amc_contracts SET status = $1, updated_by = $2 WHERE id = $3", [
      input.status,
      auth.user.id,
      id,
    ]);

    let scheduleChange: ScheduleChange | null = null;
    let cancelledVisits = 0;

    if (input.status === "ACTIVE") {
      // Activation is what creates the schedule.
      scheduleChange = await syncSchedule(client, auth, { ...before, status: "ACTIVE" });
    } else if (input.cancelOpenVisits) {
      // Only on the user's explicit request. Visits in progress are left for a person to decide.
      const cancelled = await client.query(
        `UPDATE amc_visits
         SET status = 'CANCELLED', status_reason = $1, updated_by = $2
         WHERE amc_contract_id = $3 AND status IN ('SCHEDULED', 'POSTPONED')`,
        [input.reason ?? `Contract ${input.status.toLowerCase()}.`, auth.user.id, id]
      );
      cancelledVisits = cancelled.rowCount ?? 0;
    }

    await logActivity(client, {
      userId: auth.user.id,
      action: "amc_contract.status_changed",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: id,
      description: `AMC contract for "${before.client.name}" (${before.systemDescription}) changed from ${before.status} to ${input.status}.`,
      metadata: {
        changes: { status: { from: before.status, to: input.status } },
        ...(input.reason ? { reason: input.reason } : {}),
        ...(cancelledVisits > 0 ? { cancelledVisits } : {}),
      },
    });

    return { ...(await findContract(client, id)), scheduleChange, cancelledVisits };
  });
}
