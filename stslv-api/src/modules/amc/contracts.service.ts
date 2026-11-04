import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { listEntityHistory, type HistoryEntry } from "../../shared/entity-history";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, forbidden, notFound, validationError } from "../../shared/errors";
import { isSuperAdmin } from "../../shared/role-model";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import { featureUnavailable } from "../../middleware/require-schema";
import { schemaHas } from "../../shared/schema-features";
import { assertContractNotInvoiced } from "../invoices/invoice-locks";
import { attachStoredDocument, discardStoredFile, prepareContractDocument, storePreparedDocument } from "../attachments/attachments.service";
import { clientCode } from "../clients/clients.service";
import { hasStoredReference, referenceOfIdSql, referenceSql, rethrowDuplicateReference } from "./contract-reference";
import { contractParents, restoreBlockers } from "../recycle-bin/contract-parents";
import { amountForService, expectedTermTotal, serviceAmounts, servicesPerCycle, subtractMoney } from "./amc.billing";
import { applyContractMasters } from "./contract-masters.service";
import { CONTRACT_TRANSITIONS, MAX_CONTRACT_YEARS, type ContractStatus, type VisitStatus } from "./amc.constants";
import {
  addMonths,
  buildSchedulePeriods,
  planSchedule,
  type ExistingVisit,
  type ScheduleRule,
  type SchedulePeriod,
  type SchedulePlan,
  type ServiceLabel,
} from "./amc.schedule";
import { findContractFrequency, hasFrequencyRules, monthsKey, monthsOf, resolveTerms, type ResolvedTerms } from "./contract-frequency.service";
import type {
  ChangeContractStatusInput,
  ContractHistoryQuery,
  CreateContractInput,
  CreateNewContractInput,
  ListContractsQuery,
  SchedulePreviewQuery,
  UpdateContractInput,
  BillingBasis,
} from "./amc.schemas";

interface ContractRow {
  id: string;
  amc_reference: string;
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
  billing_basis: BillingBasis | null;
  custom_billing_value: string | null;
  maintenance_frequency: string;
  custom_months: number[] | null;
  default_visit_amount: string | null;
  status: ContractStatus;
  is_past_validity: boolean;
  schedule_cutover_date: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  created_by_id: string | null;
  created_by_name: string | null;
  updated_by_id: string | null;
  updated_by_name: string | null;
  first_service_date: string | null;
  visit_count: number;
  completed_count: number;
  open_count: number;
  historical_count: number;
  cancelled_count: number;
  amount_missing_count: number;
  scheduled_total: string;
  generated_total: string;
  frequency_interval_months: number | null;
}

export interface Contract {
  id: string;
  /** The AMC Reference Number: typed at creation (migration 0105), read-only afterwards. Older contracts keep their "AMC-0007" reference. */
  amcReference: string;
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
  /** Which amount the contract is billed on (migration 0093). A record only: visit amounts do not read it. */
  billingBasis: BillingBasis | null;
  /** Entered by hand when the basis is CUSTOM. */
  customBillingValue: string | null;
  /** The stored amount the chosen basis names; null when no basis is set or the amount is empty. Nothing is calculated. */
  selectedBillingAmount: string | null;
  /** A maintenance frequency code (migration 0076: the frequency master; before it, one of the four built-in codes). */
  maintenanceFrequency: string;
  /** The selected months (1 = January) of a contract on a custom frequency; empty otherwise. PROVISIONAL rule. */
  customMonths: number[];
  defaultVisitAmount: string | null;
  status: ContractStatus;
  /** The validity period has ended. Information only: the status does not change by itself. */
  isPastValidity: boolean;
  /**
   * Set only on a contract imported from an earlier register: the date of that
   * import. Visits are generated only for periods that start on or after it.
   * It cannot be set or changed through the API.
   */
  scheduleCutoverDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Null on a record with no signed-in author, such as an imported contract. */
  createdBy: { id: string; fullName: string } | null;
  updatedBy: { id: string; fullName: string } | null;
  schedule: {
    /** The earliest planned date of a visit that is neither cancelled nor historical. */
    firstServiceDate: string | null;
    /** Months between services; null for a custom frequency, which runs on selected months. */
    intervalMonths: number | null;
    /** Visits that are not cancelled. */
    visitCount: number;
    completedCount: number;
    openCount: number;
    /** Imported period rows whose execution is not recorded. Never outstanding work. */
    historicalCount: number;
    cancelledCount: number;
    /** Non-cancelled visits with no amount set. */
    amountMissingCount: number;
    /** Sum of the visit amounts of the non-cancelled visits. */
    scheduledTotal: string;
    /** The selected annual Billing Basis amount; null when no basis is selected. */
    annualAmount: string | null;
    /** Services in one annual cycle, from the maintenance frequency; null when the rule is unknown. */
    servicesPerCycle: number | null;
    /** The standard amount per service; null when no basis is selected. */
    perServiceAmount: string | null;
    /** What the generated visits of the whole term should add up to: annual amounts, partial years not prorated. Null when no basis is selected. */
    expectedTermTotal: string | null;
    /** Sum of the amounts of the visits that count against expectedTermTotal: not cancelled, not historical. */
    generatedTotal: string;
    /**
     * expectedTermTotal minus generatedTotal. Null when no basis is selected: whether
     * a legacy contract value is annual or for the whole term is not recorded, so it is
     * never compared. Shown for information; a difference is never treated as an error.
     */
    valueDifference: string | null;
  };
}

export interface ScheduleChange {
  created: number;
  removed: number;
  kept: number;
}

// The lateral join keeps the per-contract visit figures in one place for the
// list and the detail view. The custom months come from migration 0076; on a
// database without it they are empty.
const contractSelect = (withMonths: boolean, storedReference: boolean) => `
  SELECT c.id, ${referenceSql("c", storedReference)} AS amc_reference, c.client_id, cl.name AS client_name, cl.is_active AS client_is_active,
         c.responsible_engineer, c.valid_from::text AS valid_from, c.valid_to::text AS valid_to,
         c.system_description, c.description, c.contract_value, c.final_credit, c.billing_basis, c.custom_billing_value,
         c.maintenance_frequency,
         ${withMonths ? "(SELECT array_agg(m.month::int ORDER BY m.month) FROM amc_contract_custom_months m WHERE m.amc_contract_id = c.id)" : "NULL::int[]"} AS custom_months,
         c.default_visit_amount, c.status,
         (c.valid_to < current_date) AS is_past_validity, c.schedule_cutover_date::text AS schedule_cutover_date,
         c.notes, c.created_at, c.updated_at,
         c.created_by AS created_by_id, cb.full_name AS created_by_name, c.updated_by AS updated_by_id, ub.full_name AS updated_by_name,
         s.first_service_date, s.visit_count, s.completed_count, s.open_count, s.historical_count, s.cancelled_count, s.amount_missing_count,
         s.scheduled_total, s.generated_total,
         (SELECT mf.interval_months FROM maintenance_frequencies mf WHERE mf.code = c.maintenance_frequency) AS frequency_interval_months
  FROM amc_contracts c
  JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN users cb ON cb.id = c.created_by
  LEFT JOIN users ub ON ub.id = c.updated_by
  CROSS JOIN LATERAL (
    SELECT count(*) FILTER (WHERE v.status <> 'CANCELLED')::int AS visit_count,
           (min(v.scheduled_date) FILTER (WHERE v.status NOT IN ('CANCELLED', 'HISTORICAL')))::text AS first_service_date,
           count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed_count,
           count(*) FILTER (WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED'))::int AS open_count,
           count(*) FILTER (WHERE v.status = 'HISTORICAL')::int AS historical_count,
           count(*) FILTER (WHERE v.status = 'CANCELLED')::int AS cancelled_count,
           count(*) FILTER (WHERE v.status <> 'CANCELLED' AND v.visit_amount IS NULL)::int AS amount_missing_count,
           COALESCE(sum(v.visit_amount) FILTER (WHERE v.status <> 'CANCELLED'), 0)::numeric(16,3) AS scheduled_total,
           COALESCE(sum(v.visit_amount) FILTER (WHERE v.status NOT IN ('CANCELLED', 'HISTORICAL')), 0)::numeric(16,3) AS generated_total
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
  OR v.manual_invoice_no IS NOT NULL
  OR v.service_report_no IS NOT NULL
  OR v.quotation_no IS NOT NULL
  OR v.color_override IS NOT NULL
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
  "billingBasis",
  "customBillingValue",
  "maintenanceFrequency",
  "customMonths",
  "defaultVisitAmount",
  "notes",
] as const;

const SCHEDULE_FIELDS = ["validFrom", "validTo", "maintenanceFrequency", "customMonths"] as const;

/** The editable values of a contract, flat, as compared and logged on update. Custom months as "2,5,8,11". */
type ContractValues = { [K in (typeof EDITABLE_FIELDS)[number]]: string | null };

function selectedAmount(row: ContractRow): string | null {
  return row.billing_basis === "CONTRACT_VALUE" ? row.contract_value : row.billing_basis === "FINAL_CREDIT" ? row.final_credit : row.billing_basis === "CUSTOM" ? row.custom_billing_value : null;
}

/** The contract's schedule rule from its own row, without a further query. Null when the rule is not known. */
function ruleOf(row: ContractRow): ScheduleRule | null {
  if (row.custom_months && row.custom_months.length > 0) return { kind: "months", months: row.custom_months };

  return row.frequency_interval_months ? { kind: "interval", intervalMonths: row.frequency_interval_months } : null;
}

function billingFigures(row: ContractRow) {
  const annualAmount = selectedAmount(row);
  const rule = ruleOf(row);

  if (annualAmount === null || rule === null) {
    return { annualAmount, servicesPerCycle: rule ? servicesPerCycle(rule) : null, perServiceAmount: null, expectedTermTotal: null, valueDifference: null };
  }

  const expected = expectedTermTotal(annualAmount, row.valid_from, row.valid_to, rule, row.schedule_cutover_date);

  return {
    annualAmount,
    servicesPerCycle: servicesPerCycle(rule),
    perServiceAmount: serviceAmounts(annualAmount, servicesPerCycle(rule)).standard,
    expectedTermTotal: expected,
    valueDifference: subtractMoney(expected, row.generated_total),
  };
}

function toContract(row: ContractRow): Contract {
  return {
    id: row.id,
    amcReference: row.amc_reference,
    client: { id: row.client_id, name: row.client_name, isActive: row.client_is_active },
    responsibleEngineer: row.responsible_engineer,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    systemDescription: row.system_description,
    description: row.description,
    contractValue: row.contract_value,
    finalCredit: row.final_credit,
    billingBasis: row.billing_basis,
    customBillingValue: row.custom_billing_value,
    selectedBillingAmount: selectedAmount(row),
    maintenanceFrequency: row.maintenance_frequency,
    customMonths: row.custom_months ?? [],
    defaultVisitAmount: row.default_visit_amount,
    status: row.status,
    isPastValidity: row.is_past_validity,
    scheduleCutoverDate: row.schedule_cutover_date,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by_id && row.created_by_name ? { id: row.created_by_id, fullName: row.created_by_name } : null,
    updatedBy: row.updated_by_id && row.updated_by_name ? { id: row.updated_by_id, fullName: row.updated_by_name } : null,
    schedule: {
      firstServiceDate: row.first_service_date,
      intervalMonths: row.custom_months && row.custom_months.length > 0 ? null : row.frequency_interval_months,
      visitCount: row.visit_count,
      completedCount: row.completed_count,
      openCount: row.open_count,
      historicalCount: row.historical_count,
      cancelledCount: row.cancelled_count,
      amountMissingCount: row.amount_missing_count,
      scheduledTotal: row.scheduled_total,
      generatedTotal: row.generated_total,
      ...billingFigures(row),
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
    billingBasis: contract.billingBasis,
    customBillingValue: contract.customBillingValue,
    maintenanceFrequency: contract.maintenanceFrequency,
    customMonths: monthsKey(contract.customMonths),
    defaultVisitAmount: contract.defaultVisitAmount,
    notes: contract.notes,
  };
}

function assertBillingBasis(basis: BillingBasis | null, finalCredit: string | null, customValue: string | null): void {
  if (basis === "CUSTOM" && customValue === null) {
    throw validationError("Enter the custom billing value, or choose another billing basis.", [{ field: "customBillingValue", message: "This basis needs a custom billing value." }]);
  }
  if (basis === "FINAL_CREDIT" && finalCredit === null) {
    throw validationError("Enter the final credit, or choose another billing basis.", [{ field: "billingBasis", message: "This basis needs a final credit amount." }]);
  }
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

  const result = await db.query<ContractRow>(`${contractSelect(await hasFrequencyRules(), await hasStoredReference())} WHERE c.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound("AMC contract not found.");
  }

  return toContract(row);
}

export function getContract(id: string): Promise<Contract> {
  return findContract(pool, id);
}

export type ContractHistoryEntry = HistoryEntry;

/** The activity log entries recorded against one contract, newest first (only field changes and reason from the details). */
export async function listContractHistory(id: string, query: ContractHistoryQuery) {
  await findContract(pool, id);

  return listEntityHistory("amc_contracts", id, query.page, query.pageSize);
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
  if (query.salesEngineerId) {
    await assertEngineerLinksAvailable();
    params.push(query.salesEngineerId);
    conditions.push(`c.sales_engineer_id = $${params.length}`);
  }
  if (query.system) {
    params.push(query.system);
    conditions.push(`lower(btrim(c.system_description)) = lower(btrim($${params.length}))`);
  }
  if (query.year) {
    // The validity period overlaps the calendar year.
    params.push(query.year);
    const p = `$${params.length}::int`;
    conditions.push(`c.valid_from <= make_date(${p}, 12, 31) AND c.valid_to >= make_date(${p}, 1, 1)`);
  }
  const storedReference = await hasStoredReference();
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    const p = `$${params.length}`;
    conditions.push(
      `(${referenceSql("c", storedReference)} ILIKE ${p} OR cl.name ILIKE ${p} OR c.system_description ILIKE ${p} OR c.description ILIKE ${p} OR c.responsible_engineer ILIKE ${p})`
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  // The Filtered Total covers every contract the filters select, not only the page shown. PostgreSQL adds the amounts.
  const total = await pool.query<{ count: number; contract_value: string; final_credit: string }>(
    `SELECT count(*)::int AS count,
            COALESCE(sum(c.contract_value), 0)::numeric(16,3) AS contract_value,
            COALESCE(sum(c.final_credit), 0)::numeric(16,3) AS final_credit
     FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id ${where}`,
    params
  );
  const rows = await pool.query<ContractRow>(
    `${contractSelect(await hasFrequencyRules(), storedReference)} ${where}
     ORDER BY lower(cl.name), c.valid_from DESC, c.id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return {
    items: rows.rows.map(toContract),
    total: total.rows[0]?.count ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    totals: { contractValue: total.rows[0]?.contract_value ?? "0.000", finalCredit: total.rows[0]?.final_credit ?? "0.000" },
  };
}

export interface ContractKpis {
  /** Every contract that is not in the Recycle Bin, whatever its status. */
  total: number;
  /** Sum of AMC Value / Year over those contracts, OMR excluding VAT, as text with 3 decimals. */
  contractValue: string;
  /** Sum of Final Credit over those contracts (a contract without one adds nothing), OMR excluding VAT. */
  finalCredit: string;
  /** How many of those contracts have no Final Credit recorded (contracts added before it was required). */
  finalCreditMissing: number;
  /**
   * Contracts whose validity has ended: status Expired, or Active with an end date before today (the rule of AMC
   * Management's "not renewed / expired" figure). Each contract counts once.
   */
  expired: number;
}

/** The AMC Contracts page's figures. The amc_contracts view already leaves out the Recycle Bin (migration 0101). */
export async function getContractKpis(): Promise<ContractKpis> {
  const result = await pool.query<{ total: number; contract_value: string; final_credit: string; final_credit_missing: number; expired: number }>(
    `SELECT count(*)::int AS total,
            COALESCE(sum(c.contract_value), 0)::numeric(16,3) AS contract_value,
            COALESCE(sum(c.final_credit), 0)::numeric(16,3) AS final_credit,
            count(*) FILTER (WHERE c.final_credit IS NULL)::int AS final_credit_missing,
            count(*) FILTER (WHERE c.status = 'EXPIRED' OR (c.status = 'ACTIVE' AND c.valid_to < current_date))::int AS expired
     FROM amc_contracts c`
  );
  const row = result.rows[0];

  return {
    total: row?.total ?? 0,
    contractValue: row?.contract_value ?? "0.000",
    finalCredit: row?.final_credit ?? "0.000",
    finalCreditMissing: row?.final_credit_missing ?? 0,
    expired: row?.expired ?? 0,
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

/** Names of the four built-in frequencies, for a database without the frequency master. */
const BUILT_IN_FREQUENCY_LABELS: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  HALF_YEARLY: "Half-yearly",
  ANNUALLY: "Annually",
};

/** The lists for the contract register's filters: the values present on contracts. */
export async function listContractFilterOptions() {
  const [masters, frequencyMaster] = await Promise.all([
    schemaHas(["amc_contracts.sales_engineer_id", "sales_engineers"]),
    schemaHas(["maintenance_frequencies"]),
  ]);
  const frequencyColumns = frequencyMaster
    ? "(SELECT mf.label FROM maintenance_frequencies mf WHERE mf.code = c.maintenance_frequency) AS label, (SELECT mf.sort_order FROM maintenance_frequencies mf WHERE mf.code = c.maintenance_frequency) AS sort_order"
    : "NULL::text AS label, 0 AS sort_order";
  const [clients, systems, frequencies, years, engineers] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      "SELECT cl.id, cl.name FROM clients cl WHERE cl.id IN (SELECT c.client_id FROM amc_contracts c) ORDER BY lower(cl.name), cl.id"
    ),
    listSystems(),
    pool.query<{ code: string; label: string | null }>(
      `SELECT DISTINCT c.maintenance_frequency AS code, ${frequencyColumns} FROM amc_contracts c ORDER BY sort_order, code`
    ),
    // Every calendar year a validity period covers, as the year filter matches them.
    pool.query<{ year: number }>(
      `SELECT DISTINCT y.year
       FROM amc_contracts c
       CROSS JOIN LATERAL generate_series(extract(year FROM c.valid_from)::int, extract(year FROM c.valid_to)::int) AS y(year)
       ORDER BY y.year`
    ),
    masters
      ? pool.query<{ id: string; name: string }>(
          "SELECT e.id, e.name FROM sales_engineers e WHERE e.id IN (SELECT c.sales_engineer_id FROM amc_contracts c) ORDER BY lower(e.name), e.id"
        )
      : null,
  ]);

  return {
    clients: clients.rows,
    systems,
    // Null when this database has no Sales Engineer link (migration 0070): the filter is then not offered.
    salesEngineers: engineers ? engineers.rows : null,
    frequencies: frequencies.rows.map((row) => ({ code: row.code, label: row.label ?? BUILT_IN_FREQUENCY_LABELS[row.code] ?? row.code })),
    years: years.rows.map((row) => row.year),
  };
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
  maintenanceFrequency: string;
  customMonths: number[];
}

interface TermsPlan extends SchedulePlan {
  /** Why the terms cannot be applied, or null when they can. */
  blockedReason: string | null;
}

/**
 * The schedule plan for a contract under the given terms, including the reasons a change is refused.
 * The cutover date is the contract's own (null unless it was imported): it is
 * not one of the terms and cannot be proposed.
 */
function planForTerms(current: Terms, proposed: Terms, existing: ExistingVisit[], cutoverDate: string | null, rule: ScheduleRule): TermsPlan {
  const periods = buildSchedulePeriods(proposed.validFrom, proposed.validTo, rule, cutoverDate);
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

/**
 * The amount a NEW visit gets. With a Billing Basis: calculated from the annual
 * amount. Without one: the manually entered Cost per Visit, unchanged. Existing
 * visits are never touched here; only an explicit Regenerate recalculates them.
 */
function newVisitAmount(contract: Contract, rule: ScheduleRule, periodStart: string): string | null {
  return contract.selectedBillingAmount === null
    ? contract.defaultVisitAmount
    : amountForService(contract.selectedBillingAmount, contract.validFrom, rule, periodStart);
}

function termsSnapshot(contract: Contract) {
  return {
    validFrom: contract.validFrom,
    validTo: contract.validTo,
    maintenanceFrequency: contract.maintenanceFrequency,
    ...(contract.customMonths.length > 0 ? { customMonths: contract.customMonths } : {}),
  };
}

function billingSnapshot(contract: Contract) {
  return { billingBasis: contract.billingBasis, annualAmount: contract.selectedBillingAmount, defaultVisitAmount: contract.defaultVisitAmount };
}

/** Removes the untouched visits and inserts the missing ones. The contract row must already be locked. */
async function applyPlan(
  db: Queryable,
  auth: AuthContext,
  contract: Contract,
  plan: SchedulePlan,
  terms: Pick<ResolvedTerms, "label" | "rule">,
  /** Why the schedule is being updated, for its history. Null when the caller logs the change itself. */
  reason: string | null
): Promise<ScheduleChange> {
  const { label } = terms;
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

    // From migration 0076 each new visit also gets its label ("Year 2 · Q3"),
    // taken now and never recalculated. Visits already stored keep theirs.
    const labels: ServiceLabel[] | null = label ? plan.toCreate.map((period) => label(contract.validFrom, period.periodStart)) : null;

    await db.query(
      `INSERT INTO amc_visits
         (amc_contract_id, sequence_no, period_start, period_end, original_scheduled_date, scheduled_date,
          visit_amount, created_by, updated_by${labels ? ", cycle_no, service_code" : ""})
       SELECT $1, $2 + p.ordinality - 1, p.period_start, p.period_end, p.scheduled_date, p.scheduled_date,
              p.visit_amount, $3, $3${labels ? ", p.cycle_no, p.service_code" : ""}
       FROM unnest($4::date[], $5::date[], $6::date[], $7::numeric(14,3)[]${labels ? ", $8::int[], $9::text[]" : ""})
         WITH ORDINALITY AS p (period_start, period_end, scheduled_date, visit_amount${labels ? ", cycle_no, service_code" : ""}, ordinality)`,
      [
        contract.id,
        first,
        auth.user.id,
        plan.toCreate.map((period) => period.periodStart),
        plan.toCreate.map((period) => period.periodEnd),
        plan.toCreate.map((period) => period.scheduledDate),
        plan.toCreate.map((period) => newVisitAmount(contract, terms.rule, period.periodStart)),
        ...(labels ? [labels.map((item) => item.cycleNo), labels.map((item) => item.serviceCode)] : []),
      ]
    );
  }

  const change = { created: plan.toCreate.length, removed: plan.toRemove.length, kept: plan.kept.length };

  if (reason !== null && (change.created > 0 || change.removed > 0)) {
    await logActivity(db, {
      userId: auth.user.id,
      action: "amc_contract.schedule_generated",
      module: "AMC_SCHEDULE",
      entityType: "amc_contracts",
      entityId: contract.id,
      description: `Schedule updated: ${change.created} visit(s) added, ${change.removed} untouched visit(s) removed, ${change.kept} kept.`,
      metadata: {
        reason,
        ...billingSnapshot(contract),
        terms: termsSnapshot(contract),
        created: plan.toCreate.map((period) => period.periodStart),
        removed: plan.toRemove.map((visit) => ({ id: visit.id, sequenceNo: visit.sequenceNo, periodStart: visit.periodStart })),
      },
    });
  }

  return change;
}

/** Brings an ACTIVE contract's visits in line with its stored terms. */
async function syncSchedule(db: Queryable, auth: AuthContext, contract: Contract, reason: string): Promise<ScheduleChange> {
  // The contract keeps its frequency even when it has since been disabled or archived.
  const terms = await resolveTerms(db, contract.maintenanceFrequency, contract.customMonths, false);
  const existing = await loadExistingVisits(db, contract.id, true);
  const plan = planForTerms(contract, contract, existing, contract.scheduleCutoverDate, terms.rule);

  if (plan.blockedReason) {
    throw conflict(plan.blockedReason);
  }

  return applyPlan(db, auth, contract, plan, terms, reason);
}

export interface SchedulePreview {
  validFrom: string;
  validTo: string;
  maintenanceFrequency: string;
  customMonths: number[];
  canApply: boolean;
  blockedReason: string | null;
  toCreate: (SchedulePeriod & { visitAmount: string | null; cycleNo: number | null; serviceCode: string | null })[];
  toRemove: ExistingVisit[];
  keptCount: number;
  blocking: ExistingVisit[];
}

/** What generating the schedule would do, for the stored terms or for proposed ones. Changes nothing. */
export async function previewSchedule(id: string, query: SchedulePreviewQuery): Promise<SchedulePreview> {
  const contract = await findContract(pool, id);
  const frequencyChanged = query.maintenanceFrequency !== undefined && query.maintenanceFrequency !== contract.maintenanceFrequency;
  const proposed: Terms = {
    validFrom: query.validFrom ?? contract.validFrom,
    validTo: query.validTo ?? contract.validTo,
    maintenanceFrequency: query.maintenanceFrequency ?? contract.maintenanceFrequency,
    // A new frequency starts without the months of the one it replaces.
    customMonths: query.customMonths ?? (frequencyChanged ? [] : contract.customMonths),
  };

  assertValidity(proposed.validFrom, proposed.validTo);

  const terms = await resolveTerms(pool, proposed.maintenanceFrequency, proposed.customMonths, frequencyChanged);
  const plan = planForTerms(contract, proposed, await loadExistingVisits(pool, id, false), contract.scheduleCutoverDate, terms.rule);

  return {
    ...proposed,
    canApply: plan.blockedReason === null,
    blockedReason: plan.blockedReason,
    toCreate: plan.toCreate.map((period) => {
      const label = terms.label?.(proposed.validFrom, period.periodStart) ?? null;

      // The proposed terms decide where the annual cycles fall.
      const visitAmount = newVisitAmount({ ...contract, validFrom: proposed.validFrom }, terms.rule, period.periodStart);

      return { ...period, visitAmount, cycleNo: label?.cycleNo ?? null, serviceCode: label?.serviceCode ?? null };
    }),
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

    const scheduleChange = await syncSchedule(client, auth, contract, "Missing visits generated");

    return { contract: await findContract(client, id), scheduleChange };
  });
}

// ---------------------------------------------------------------------------
// Regenerate: the only way existing visit amounts are recalculated
// ---------------------------------------------------------------------------

/** Why a visit keeps its amount. The first that applies is shown. */
const PRESERVED_REASON_SQL = `CASE
    WHEN v.status = 'COMPLETED' THEN 'Completed'
    WHEN v.status = 'HISTORICAL' THEN 'Historical'
    WHEN v.status = 'CANCELLED' THEN 'Cancelled'
    WHEN v.manual_invoice_no IS NOT NULL THEN 'Paid'
    WHEN EXISTS (SELECT 1 FROM invoice_allocations al JOIN invoices i ON i.id = al.invoice_id
                 WHERE al.amc_visit_id = v.id AND i.status <> 'CANCELLED') THEN 'Zoho invoice recorded'
    WHEN v.amount_is_custom THEN 'Amount set by hand'
  END`;

interface RegenerateRow {
  id: string;
  sequence_no: number;
  period_start: string;
  scheduled_date: string;
  service_code: string | null;
  visit_amount: string | null;
  preserved_reason: string | null;
}

export interface RegeneratePreview {
  canApply: boolean;
  /** Why it cannot be applied; null when it can. */
  blockedReason: string | null;
  billingBasis: BillingBasis | null;
  annualAmount: string | null;
  servicesPerCycle: number | null;
  perServiceAmount: string | null;
  lastServiceAmount: string | null;
  toCreate: number;
  toRemove: number;
  /** Visits whose amount would change. */
  changes: { id: string; sequenceNo: number; serviceCode: string | null; scheduledDate: string; from: string | null; to: string }[];
  /** Visits that keep their amount, and why. */
  preserved: { id: string; sequenceNo: number; serviceCode: string | null; scheduledDate: string; amount: string | null; reason: string }[];
  /** Visits already at the calculated amount. */
  unchanged: number;
}

async function regenerationPlan(db: Queryable, contract: Contract, lock: boolean): Promise<{ preview: RegeneratePreview; terms: ResolvedTerms; plan: TermsPlan }> {
  const terms = await resolveTerms(db, contract.maintenanceFrequency, contract.customMonths, false);
  const plan = planForTerms(contract, contract, await loadExistingVisits(db, contract.id, lock), contract.scheduleCutoverDate, terms.rule);
  const rows = await db.query<RegenerateRow>(
    `SELECT v.id, v.sequence_no, v.period_start::text AS period_start, v.scheduled_date::text AS scheduled_date,
            v.service_code, v.visit_amount, ${PRESERVED_REASON_SQL} AS preserved_reason
     FROM amc_visits v
     WHERE v.amc_contract_id = $1 AND NOT (v.id = ANY($2::bigint[]))
     ORDER BY v.sequence_no`,
    [contract.id, plan.toRemove.map((visit) => visit.id)]
  );
  const annual = contract.selectedBillingAmount;
  const changes: RegeneratePreview["changes"] = [];
  const preserved: RegeneratePreview["preserved"] = [];
  let unchanged = 0;

  for (const row of rows.rows) {
    if (row.preserved_reason !== null) {
      preserved.push({ id: row.id, sequenceNo: row.sequence_no, serviceCode: row.service_code, scheduledDate: row.scheduled_date, amount: row.visit_amount, reason: row.preserved_reason });
    } else if (annual !== null) {
      const to = amountForService(annual, contract.validFrom, terms.rule, row.period_start);

      if (row.visit_amount === to) {
        unchanged += 1;
      } else {
        changes.push({ id: row.id, sequenceNo: row.sequence_no, serviceCode: row.service_code, scheduledDate: row.scheduled_date, from: row.visit_amount, to });
      }
    }
  }

  const amounts = annual === null ? null : serviceAmounts(annual, servicesPerCycle(terms.rule));
  let blockedReason = plan.blockedReason;

  if (contract.status !== "ACTIVE") blockedReason = "A schedule is regenerated only for an active contract.";
  else if (annual === null) blockedReason = "Select a Billing Basis first. A contract without one keeps its manually entered Cost per Visit.";

  return {
    terms,
    plan,
    preview: {
      canApply: blockedReason === null,
      blockedReason,
      billingBasis: contract.billingBasis,
      annualAmount: annual,
      servicesPerCycle: servicesPerCycle(terms.rule),
      perServiceAmount: amounts?.standard ?? null,
      lastServiceAmount: amounts?.last ?? null,
      toCreate: plan.toCreate.length,
      toRemove: plan.toRemove.length,
      changes,
      preserved,
      unchanged,
    },
  };
}

/** What Regenerate would do now. Changes nothing. */
export async function previewRegeneration(id: string): Promise<RegeneratePreview> {
  return (await regenerationPlan(pool, await findContract(pool, id), false)).preview;
}

/**
 * Explicit, audited recalculation. Completed, Paid, Zoho-invoiced, historical,
 * cancelled and hand-set visits keep their amounts. The old and new amount of
 * every changed visit stay in the activity log.
 */
export function regenerateSchedule(auth: AuthContext, id: string, reason: string): Promise<{ contract: Contract; scheduleChange: ScheduleChange; recalculated: number; preserved: number; unchanged: number }> {
  return withTransaction(async (client) => {
    const contract = await findContract(client, id, true);
    const { preview, terms, plan } = await regenerationPlan(client, contract, true);

    if (preview.blockedReason) {
      throw conflict(preview.blockedReason);
    }

    const scheduleChange = await applyPlan(client, auth, contract, plan, terms, null);

    if (preview.changes.length > 0) {
      await client.query(
        `UPDATE amc_visits v SET visit_amount = c.amount, updated_by = $1
         FROM unnest($2::bigint[], $3::numeric(14,3)[]) AS c (id, amount)
         WHERE v.id = c.id`,
        [auth.user.id, preview.changes.map((change) => change.id), preview.changes.map((change) => change.to)]
      );
    }

    await logActivity(client, {
      userId: auth.user.id,
      action: "amc_contract.schedule_regenerated",
      module: "AMC_SCHEDULE",
      entityType: "amc_contracts",
      entityId: contract.id,
      description: `Schedule regenerated: ${preview.changes.length} visit amount(s) recalculated, ${preview.preserved.length} preserved, ${scheduleChange.created} visit(s) added, ${scheduleChange.removed} untouched visit(s) removed. Reason: ${reason}`,
      metadata: {
        reason,
        ...billingSnapshot(contract),
        servicesPerCycle: preview.servicesPerCycle,
        terms: termsSnapshot(contract),
        created: plan.toCreate.map((period) => period.periodStart),
        removed: plan.toRemove.map((visit) => ({ id: visit.id, sequenceNo: visit.sequenceNo, periodStart: visit.periodStart })),
        recalculated: preview.changes.map((change) => ({ id: change.id, sequenceNo: change.sequenceNo, from: change.from, to: change.to })),
        preserved: preview.preserved.map((visit) => ({ id: visit.id, sequenceNo: visit.sequenceNo, amount: visit.amount, reason: visit.reason })),
      },
    });

    return { contract: await findContract(client, id), scheduleChange, recalculated: preview.changes.length, preserved: preview.preserved.length, unchanged: preview.unchanged };
  });
}

// ---------------------------------------------------------------------------
// Create, update, status
// ---------------------------------------------------------------------------

/** The Sales Engineer link needs migration 0070 on this database. */
async function assertEngineerLinksAvailable(): Promise<void> {
  if (!(await schemaHas(["amc_contracts.sales_engineer_id", "sales_engineers"]))) {
    throw featureUnavailable();
  }
}

/** The source of a renewal must exist, be for the same client and have no renewal that is still open. */
async function assertRenewable(db: Queryable, sourceId: string, clientId: string): Promise<Contract> {
  const source = await findContract(db, sourceId, true);

  if (source.client.id !== clientId) {
    throw validationError("A renewal is for the same client as the contract it renews.", [
      { field: "clientId", message: `Select ${source.client.name}, the client of the contract being renewed.` },
    ]);
  }

  const open = await db.query<{ id: string }>(
    "SELECT id FROM amc_contracts WHERE renewed_from_id = $1 AND status <> 'CANCELLED' LIMIT 1",
    [sourceId]
  );

  if (open.rows[0]) {
    throw conflict("This contract already has a renewal. Open that renewal instead, or cancel it first.");
  }

  return source;
}

/**
 * Every renewal names an active sales engineer, chosen by the user: it is never saved "not linked", and a renewed
 * contract's engineer who is no longer active is never replaced by someone the user did not choose. Whether the
 * chosen engineer is active is checked when the link is written (applyContractMasters).
 */
async function assertRenewalEngineerChosen(db: Queryable, sourceId: string): Promise<void> {
  if (!(await schemaHas(["amc_contracts.sales_engineer_id", "sales_engineers"]))) {
    return;
  }

  const result = await db.query<{ name: string; is_active: boolean }>(
    "SELECT e.name, e.is_active FROM amc_contracts c JOIN sales_engineers e ON e.id = c.sales_engineer_id WHERE c.id = $1",
    [sourceId]
  );
  const previous = result.rows[0];
  const message =
    previous && !previous.is_active
      ? `${previous.name}, the sales engineer of the contract being renewed, is no longer active. Select an active sales engineer.`
      : "Select an active sales engineer for the renewal.";

  throw validationError("Select an active sales engineer for the renewal.", [{ field: "salesEngineerId", message }]);
}

async function linkRenewal(db: Queryable, auth: AuthContext, source: Contract, renewal: Contract, notes: string | null): Promise<void> {
  await db.query("UPDATE amc_contracts SET renewed_from_id = $1 WHERE id = $2", [source.id, renewal.id]);
  await logActivity(db, {
    userId: auth.user.id,
    action: "amc_contract.renewal_created",
    module: "AMC_CONTRACTS",
    entityType: "amc_contracts",
    entityId: source.id,
    description: `Renewal created: a new contract (${renewal.validFrom} to ${renewal.validTo}) as ${renewal.status}. This contract is unchanged.`,
    metadata: { renewalId: renewal.id },
  });
  await logActivity(db, {
    userId: auth.user.id,
    action: "amc_contract.renewal_of",
    module: "AMC_CONTRACTS",
    entityType: "amc_contracts",
    entityId: renewal.id,
    description: `Created as the renewal of the contract valid ${source.validFrom} to ${source.validTo}.${notes ? ` Renewal notes: ${notes}` : ""}`,
    metadata: { renewedFromId: source.id, ...(notes ? { renewalNotes: notes } : {}) },
  });
}

/** Stores a contract's custom months (migration 0076). Nothing to store for a fixed frequency. */
async function writeCustomMonths(db: Queryable, auth: AuthContext, contractId: string, months: number[]): Promise<void> {
  if (months.length === 0) {
    return;
  }

  await db.query(
    "INSERT INTO amc_contract_custom_months (amc_contract_id, month, created_by) SELECT $1, unnest($2::smallint[]), $3",
    [contractId, months, auth.user.id]
  );
}

/**
 * A system type a contract may be saved with: it must exist and be active, unless it is the type the contract is
 * already linked to (kept even after it was disabled). Locked for the transaction, so it cannot be deleted meanwhile.
 */
async function resolveSystemType(db: Queryable, id: string, currentId: string | null = null): Promise<{ id: string; name: string }> {
  if (!(await schemaHas(["amc_contracts.system_type_id", "system_types"]))) {
    throw featureUnavailable();
  }

  const result = await db.query<{ id: string; name: string; is_active: boolean }>("SELECT id, name, is_active FROM system_types WHERE id = $1 FOR SHARE", [id]);
  const row = result.rows[0];

  if (!row || (!row.is_active && row.id !== currentId)) {
    throw validationError("Select an active system.", [{ field: "systemTypeId", message: "Select an active system from the System Types list." }]);
  }

  return { id: row.id, name: row.name };
}

/** The contract's current master links, or none on a database without migration 0070. */
async function currentLinks(db: Queryable, id: string): Promise<{ salesEngineerId: string | null; systemTypeId: string | null }> {
  if (!(await schemaHas(["amc_contracts.sales_engineer_id", "amc_contracts.system_type_id"]))) {
    return { salesEngineerId: null, systemTypeId: null };
  }

  const result = await db.query<{ sales_engineer_id: string | null; system_type_id: string | null }>("SELECT sales_engineer_id, system_type_id FROM amc_contracts WHERE id = $1", [id]);

  return { salesEngineerId: result.rows[0]?.sales_engineer_id ?? null, systemTypeId: result.rows[0]?.system_type_id ?? null };
}

/**
 * Add AMC Contract (approved 2026-11-03): a new contract with its mandatory sales engineer, system type, Final
 * Credit and contract document. The document is checked first, then stored, and recorded in the same transaction
 * as the contract: if anything fails, no contract is created and the stored file is removed again. A contract is
 * never created without its document, and no document row exists without its contract.
 */
export async function createNewContract(auth: AuthContext, input: CreateNewContractInput): Promise<Contract & { scheduleChange: ScheduleChange | null }> {
  const { contractDocument, ...fields } = input;
  // Checked before anything is stored: name, size, and content (PDF or Word).
  const prepared = prepareContractDocument(contractDocument.fileName, Buffer.from(contractDocument.contentBase64, "base64"));
  // A plain date mistake is reported before the file is written, so it leaves nothing behind.
  assertValidity(fields.validFrom, fields.validTo);
  const stored = await storePreparedDocument(prepared);

  try {
    // The system is the chosen type's name (createContract sets it from systemTypeId, which is required here).
    return await createContract(auth, { ...fields, systemDescription: fields.systemDescription ?? "" }, {
      attach: async (db, contractId) => {
        await attachStoredDocument(db, auth, contractId, stored);
      },
    });
  } catch (error) {
    await discardStoredFile(stored.key);
    throw error;
  }
}

export async function createContract(
  auth: AuthContext,
  input: CreateContractInput,
  options: {
    renewedFromId?: string;
    renewalNotes?: string | null;
    /** Runs inside the contract's transaction once it exists, before its schedule is generated (the contract document). */
    attach?: (db: Queryable, contractId: string) => Promise<void>;
  } = {}
): Promise<Contract & { scheduleChange: ScheduleChange | null }> {
  assertValidity(input.validFrom, input.validTo);

  // The typed reference must be stored as entered (migration 0105); without the column it would be lost.
  if (!(await hasStoredReference())) {
    throw featureUnavailable();
  }

  try {
    return await insertContract(auth, input, options);
  } catch (error) {
    // The unique index decides, so two simultaneous requests with one reference cannot both succeed.
    rethrowDuplicateReference(error);
  }
}

function insertContract(
  auth: AuthContext,
  input: CreateContractInput,
  options: { renewedFromId?: string; renewalNotes?: string | null; attach?: (db: Queryable, contractId: string) => Promise<void> }
): Promise<Contract & { scheduleChange: ScheduleChange | null }> {
  return withTransaction(async (client) => {
    if (input.salesEngineerId) {
      await assertEngineerLinksAvailable();
    }
    // A chosen system type sets the contract's system to its name, so the two always agree.
    const systemType = input.systemTypeId ? await resolveSystemType(client, input.systemTypeId) : null;
    const systemDescription = systemType ? systemType.name : input.systemDescription;
    await assertSelectableClient(client, input.clientId);

    // A renewal (migration 0072): the source is locked and checked before the new contract is added.
    const source = options.renewedFromId ? await assertRenewable(client, options.renewedFromId, input.clientId) : null;
    if (source && !input.salesEngineerId) {
      await assertRenewalEngineerChosen(client, source.id);
    }
    assertBillingBasis(input.billingBasis ?? null, input.finalCredit ?? null, input.customBillingValue ?? null);
    // A new contract or renewal may only choose an active frequency; custom months only for a custom one.
    const months = monthsOf(monthsKey(input.customMonths));
    await resolveTerms(client, input.maintenanceFrequency, months, true);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO amc_contracts
         (client_id, responsible_engineer, valid_from, valid_to, system_description, description,
          contract_value, final_credit, maintenance_frequency, default_visit_amount, status, notes,
          created_by, updated_by, billing_basis, custom_billing_value, amc_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $15, $16)
       RETURNING id`,
      [
        input.clientId,
        input.responsibleEngineer ?? null,
        input.validFrom,
        input.validTo,
        systemDescription,
        input.description ?? null,
        input.contractValue,
        input.finalCredit ?? null,
        input.maintenanceFrequency,
        input.defaultVisitAmount ?? null,
        input.status,
        input.notes ?? null,
        auth.user.id,
        input.billingBasis ?? null,
        input.billingBasis === "CUSTOM" ? (input.customBillingValue ?? null) : null,
        input.amcReference,
      ]
    );
    const id = (inserted.rows[0] as { id: string }).id;

    await writeCustomMonths(client, auth, id, months);

    const created = await findContract(client, id, true);

    await logActivity(client, {
      userId: auth.user.id,
      action: "amc_contract.created",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: id,
      description: `AMC contract ${created.amcReference} for "${created.client.name}" (${created.systemDescription}) created as ${created.status}.`,
      metadata: { amcReference: created.amcReference },
    });

    if (source) {
      await linkRenewal(client, auth, source, created, options.renewalNotes ?? null);
    }
    if (input.salesEngineerId || systemType) {
      await applyContractMasters(client, auth, id, {
        ...(input.salesEngineerId ? { salesEngineerId: input.salesEngineerId } : {}),
        ...(systemType ? { systemTypeId: systemType.id } : {}),
      });
    }
    if (options.attach) {
      await options.attach(client, id);
    }

    const scheduleChange = created.status === "ACTIVE" ? await syncSchedule(client, auth, created, "Contract created") : null;

    return { ...(await findContract(client, id)), scheduleChange };
  });
}

export function updateContract(
  auth: AuthContext,
  id: string,
  input: UpdateContractInput
): Promise<Contract & { scheduleChange: ScheduleChange | null }> {
  return withTransaction(async (client) => {
    if (input.salesEngineerId !== undefined) {
      await assertEngineerLinksAvailable();
    }

    const before = await findContract(client, id, true);
    const beforeValues = valuesOf(before);
    const afterValues: ContractValues = { ...beforeValues };
    const links = await currentLinks(client, id);

    // Required on new contracts since 2026-11-03. An older contract without it stays valid and editable, but a
    // value that is recorded cannot be removed again. (A recorded sales engineer or system type link is kept the
    // same way, by applyContractMasters, for every route that changes links.)
    if (input.finalCredit === null && before.finalCredit !== null) {
      throw validationError("Final credit is required.", [{ field: "finalCredit", message: "Final credit is required. Enter 0 when there is none." }]);
    }
    // The system follows the chosen system type. A contract linked to a type cannot be given other free text.
    let systemType: { id: string; name: string } | null = null;
    if (input.systemTypeId !== undefined && input.systemTypeId !== links.systemTypeId) {
      systemType = await resolveSystemType(client, input.systemTypeId, links.systemTypeId);
    } else if (input.systemTypeId === undefined && links.systemTypeId !== null && input.systemDescription !== undefined && input.systemDescription !== before.systemDescription) {
      throw validationError("Select a system.", [{ field: "systemTypeId", message: "This contract's system comes from the System Types list. Select a system there instead of typing one." }]);
    }

    for (const field of EDITABLE_FIELDS) {
      if (field === "customMonths") {
        if (input.customMonths !== undefined) afterValues.customMonths = monthsKey(input.customMonths);
        continue;
      }
      const value = input[field];
      if (value !== undefined) {
        afterValues[field] = value;
      }
    }

    if (systemType) afterValues.systemDescription = systemType.name;
    // A custom amount belongs to the custom basis only.
    if (afterValues.billingBasis !== "CUSTOM") afterValues.customBillingValue = null;
    assertBillingBasis(afterValues.billingBasis as BillingBasis | null, afterValues.finalCredit as string | null, afterValues.customBillingValue as string | null);

    // A change to a fixed frequency drops the months of the custom one it replaces.
    if (afterValues.maintenanceFrequency !== beforeValues.maintenanceFrequency && input.customMonths === undefined) {
      const next = await findContractFrequency(client, afterValues.maintenanceFrequency as string);
      if (next && !next.isCustom) afterValues.customMonths = null;
    }

    const changes = diffFields(beforeValues, afterValues, EDITABLE_FIELDS);

    // The links are recorded on their own (amc_contract.masters_linked); they never touch the schedule.
    if (input.salesEngineerId !== undefined || systemType) {
      await applyContractMasters(client, auth, id, {
        ...(input.salesEngineerId !== undefined ? { salesEngineerId: input.salesEngineerId } : {}),
        ...(systemType ? { systemTypeId: systemType.id } : {}),
      });
    }

    if (Object.keys(changes).length === 0) {
      return { ...(await findContract(client, id)), scheduleChange: null };
    }

    const validFrom = afterValues.validFrom as string;
    const validTo = afterValues.validTo as string;
    const termsChanged = SCHEDULE_FIELDS.some((field) => field in changes);

    if ("clientId" in changes) {
      await assertSelectableClient(client, afterValues.clientId as string);
      // An invoice is issued to the client of the work it covers.
      await assertContractNotInvoiced(client, id);
    }
    let terms: ResolvedTerms | null = null;

    if (termsChanged) {
      assertValidity(validFrom, validTo);
      // A newly chosen frequency must be active; an unchanged one is kept even if it has been disabled since.
      terms = await resolveTerms(client, afterValues.maintenanceFrequency as string, monthsOf(afterValues.customMonths), "maintenanceFrequency" in changes);

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
           default_visit_amount = $10, notes = $11, updated_by = $12, billing_basis = $14, custom_billing_value = $15
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
        afterValues.billingBasis,
        afterValues.customBillingValue,
      ]
    );

    if ("customMonths" in changes) {
      await client.query("DELETE FROM amc_contract_custom_months WHERE amc_contract_id = $1", [id]);
      await writeCustomMonths(client, auth, id, monthsOf(afterValues.customMonths));
    }

    const updated = await findContract(client, id);
    let scheduleChange: ScheduleChange | null = null;

    // Only the terms drive the schedule. A new default visit amount applies to
    // visits generated from now on; existing visits keep their amounts.
    if (termsChanged && terms && updated.status === "ACTIVE") {
      const plan = planForTerms(before, updated, await loadExistingVisits(client, id, true), updated.scheduleCutoverDate, terms.rule);

      if (plan.blockedReason) {
        throw conflict(plan.blockedReason);
      }

      scheduleChange = await applyPlan(client, auth, updated, plan, terms, "Contract terms changed");
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

/**
 * A cancelled renewal may be reactivated only while its source has no other
 * renewal that is not cancelled (the rule of 0072's unique index). The source is
 * locked first, as when a renewal is created, so two requests cannot both pass.
 */
async function assertNoOtherOpenRenewal(db: Queryable, id: string): Promise<void> {
  const own = await db.query<{ renewed_from_id: string | null }>("SELECT renewed_from_id FROM amc_contracts WHERE id = $1", [id]);
  const sourceId = own.rows[0]?.renewed_from_id;

  if (!sourceId) return;
  await db.query("SELECT id FROM amc_contracts WHERE id = $1 FOR UPDATE", [sourceId]);
  const other = await db.query(
    "SELECT id FROM amc_contracts WHERE renewed_from_id = $1 AND id <> $2 AND status <> 'CANCELLED' LIMIT 1",
    [sourceId, id]
  );

  if (other.rows[0]) {
    throw conflict("The contract this renews already has another renewal. Cancel that renewal first, or keep this one cancelled.");
  }
}

// ---------------------------------------------------------------------------
// AMC Recycle Bin (approved 2026-11-03, migration 0101). Super Admin only.
// Deleting never removes rows: the contract is marked deleted (deleted_at, deleted_by)
// and the amc_contracts / amc_visits views stop showing it and its services, so every
// list, schedule, KPI and endpoint treats it as not found. Its services, invoices,
// documents and history are untouched, and restoring brings back the same contract
// (same id, so the same AMC number) with the same services.
// ---------------------------------------------------------------------------

const SUPER_ADMIN_ONLY = "Only Super Admin can move AMC contracts to the Recycle Bin or restore them.";

function assertSuperAdmin(auth: AuthContext): void {
  if (!isSuperAdmin(auth.roles)) {
    throw forbidden(SUPER_ADMIN_ONLY);
  }
}

const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === "23505";

/** Moves a contract to the Recycle Bin. Refused while a renewal of it exists, which would lose its source. */
export async function deleteContract(auth: AuthContext, id: string): Promise<void> {
  assertSuperAdmin(auth);

  await withTransaction(async (db) => {
    // Locked, so nothing can change the contract or its services until this transaction ends.
    const contract = await findContract(db, id, true);
    const label = `The contract for "${contract.client.name}" (${contract.systemDescription})`;

    const renewal = await db.query<{ id: string; reference: string }>(
      `SELECT c.id, ${referenceSql("c", await hasStoredReference())} AS reference FROM amc_contracts c WHERE c.renewed_from_id = $1 ORDER BY c.id LIMIT 1`,
      [id]
    );
    if (renewal.rows[0]) {
      throw conflict(
        `${label} cannot be moved to the Recycle Bin: it was renewed as ${renewal.rows[0].reference}. Move the renewal to the Recycle Bin first, or cancel this contract instead.`
      );
    }

    const kept = await db.query<{ services: number; invoices: number }>(
      `SELECT (SELECT count(*)::int FROM amc_visits WHERE amc_contract_id = $1) AS services,
              (SELECT count(DISTINCT al.invoice_id)::int FROM invoice_allocations al JOIN amc_visits v ON v.id = al.amc_visit_id
               WHERE v.amc_contract_id = $1) AS invoices`,
      [id]
    );
    const { services, invoices } = kept.rows[0] ?? { services: 0, invoices: 0 };

    await db.query("UPDATE amc_contracts_all SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL", [id, auth.user.id]);
    await logActivity(db, {
      userId: auth.user.id,
      action: "amc_contract.deleted",
      module: "AMC_CONTRACTS",
      entityType: "amc_contracts",
      entityId: id,
      description: `AMC contract for "${contract.client.name}" (${contract.systemDescription}) moved to the Recycle Bin with its ${services} service${services === 1 ? "" : "s"}; nothing was removed.`,
      metadata: {
        recycleBin: true,
        deleted: { client: contract.client.name, systemDescription: contract.systemDescription, validFrom: contract.validFrom, validTo: contract.validTo, status: contract.status, contractValue: contract.contractValue, services, invoices },
      },
    });
  });
}

/** Restores a contract from the Recycle Bin with the same id and services. */
export async function restoreContract(auth: AuthContext, id: string): Promise<Contract> {
  assertSuperAdmin(auth);

  try {
    return await withTransaction(async (db) => {
      const found = await db.query<{ renewed_from_id: string | null; status: string }>(
        "SELECT renewed_from_id, status FROM amc_contracts_all WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE",
        [id]
      );
      const row = found.rows[0];

      if (!row) {
        throw notFound("No AMC contract with this id is in the Recycle Bin.");
      }
      if (row.renewed_from_id !== null && row.status !== "CANCELLED") {
        const stored = await hasStoredReference();
        const other = await db.query<{ id: string; reference: string; source_reference: string }>(
          `SELECT c.id, ${referenceSql("c", stored)} AS reference, ${referenceOfIdSql("$1::bigint", stored)} AS source_reference
           FROM amc_contracts c WHERE c.renewed_from_id = $1 AND c.status <> 'CANCELLED' AND c.id <> $2 LIMIT 1`,
          [row.renewed_from_id, id]
        );
        if (other.rows[0]) {
          throw conflict(
            `This contract cannot be restored: ${other.rows[0].source_reference} has since been renewed as ${other.rows[0].reference}. Cancel or delete that renewal first.`
          );
        }
      }

      // A client, system type or sales engineer in the Recycle Bin (migration 0106) must be restored first.
      const blockers = restoreBlockers(await contractParents(db, id));
      if (blockers.length > 0) {
        throw conflict(`This contract cannot be restored. ${blockers.join(" ")}`);
      }

      await db.query("UPDATE amc_contracts_all SET deleted_at = NULL, deleted_by = NULL WHERE id = $1", [id]);
      const contract = await findContract(db, id);
      await logActivity(db, {
        userId: auth.user.id,
        action: "amc_contract.restored",
        module: "AMC_CONTRACTS",
        entityType: "amc_contracts",
        entityId: id,
        description: `AMC contract for "${contract.client.name}" (${contract.systemDescription}) restored from the Recycle Bin.`,
        metadata: { recycleBin: true },
      });

      return contract;
    });
  } catch (error) {
    // The open-renewal index refuses it again should a renewal be created meanwhile.
    if (isUniqueViolation(error)) {
      throw conflict("This contract cannot be restored: its source contract now has another open renewal.");
    }
    // Migration 0106 refuses it again should a parent be moved to the Recycle Bin meanwhile.
    if ((error as { code?: unknown } | null)?.code === "RB001") {
      throw conflict("This contract cannot be restored: its client, system type or sales engineer is in the Recycle Bin. Restore that record first.");
    }
    throw error;
  }
}

export interface DeletedContract {
  id: string;
  amcReference: string;
  client: { id: string; name: string };
  systemDescription: string;
  validFrom: string;
  validTo: string;
  status: string;
  contractValue: string | null;
  services: number;
  invoices: number;
  documents: number;
  deletedAt: string;
  deletedBy: string | null;
}

/** The contracts in the Recycle Bin, most recently deleted first. */
export async function listDeletedContracts(auth: AuthContext): Promise<DeletedContract[]> {
  assertSuperAdmin(auth);

  const documents = (await schemaHas(["attachments"]))
    ? "(SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'amc_contracts' AND a.entity_id = c.id AND a.is_current)"
    : "0";
  const result = await pool.query<{
    id: string; amc_reference: string; client_id: string; client_name: string; system_description: string; valid_from: string; valid_to: string;
    status: string; contract_value: string | null; services: number; invoices: number; documents: number; deleted_at: Date; deleted_by: string | null;
  }>(
    `SELECT c.id, ${referenceSql("c", await hasStoredReference())} AS amc_reference, c.client_id, cl.name AS client_name, c.system_description,
            c.valid_from::text AS valid_from, c.valid_to::text AS valid_to, c.status, c.contract_value, c.deleted_at, u.full_name AS deleted_by,
            (SELECT count(*)::int FROM amc_visits_all v WHERE v.amc_contract_id = c.id) AS services,
            (SELECT count(DISTINCT al.invoice_id)::int FROM invoice_allocations al JOIN amc_visits_all v ON v.id = al.amc_visit_id
             WHERE v.amc_contract_id = c.id) AS invoices,
            ${documents} AS documents
     FROM amc_contracts_all c
     -- clients_all: a contract stays listed when its client is in the Recycle Bin too (migration 0106).
     JOIN clients_all cl ON cl.id = c.client_id
     LEFT JOIN users u ON u.id = c.deleted_by
     WHERE c.deleted_at IS NOT NULL
     ORDER BY c.deleted_at DESC, c.id DESC
     LIMIT 500`
  );

  return result.rows.map((row) => ({
    id: row.id,
    amcReference: row.amc_reference,
    client: { id: row.client_id, name: row.client_name },
    systemDescription: row.system_description,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    contractValue: row.contract_value,
    services: row.services,
    invoices: row.invoices,
    documents: row.documents,
    deletedAt: row.deleted_at.toISOString(),
    deletedBy: row.deleted_by,
  }));
}

export function changeContractStatus(
  auth: AuthContext,
  id: string,
  input: ChangeContractStatusInput
): Promise<Contract & { scheduleChange: ScheduleChange | null; cancelledVisits: number }> {
  // The DELETE permission governs cancellation (the same convention as deactivating a client).
  // Moving a contract to the Recycle Bin is Super Admin only (deleteContract).
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
    // Cancellation is audited: the reason stays in the contract's history.
    if (input.status === "CANCELLED" && !input.reason) {
      throw validationError("Enter the reason for cancelling this contract.", [{ field: "reason", message: "Enter the reason for cancelling this contract." }]);
    }
    // Reactivating a cancelled renewal (0072): its source may have been renewed again since.
    if (before.status === "CANCELLED" && (await schemaHas(["amc_contracts.renewed_from_id"]))) {
      await assertNoOtherOpenRenewal(client, id);
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
      scheduleChange = await syncSchedule(client, auth, { ...before, status: "ACTIVE" }, "Contract activated");
    } else if (input.cancelOpenVisits) {
      // Only on the user's explicit request. Visits in progress are left for a person to decide.
      const cancelled = await client.query(
        `UPDATE amc_visits
         SET status = 'CANCELLED', status_reason = $1, updated_by = $2
         WHERE amc_contract_id = $3 AND status IN ('SCHEDULED', 'POSTPONED') AND manual_invoice_no IS NULL`,
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

/** Active clients, id, code and name only, for the contract form. The code is derived from the id. */
export async function listContractClientOptions(): Promise<{ id: string; code: string; name: string }[]> {
  const result = await pool.query<{ id: string; name: string }>("SELECT id, name FROM clients WHERE is_active ORDER BY lower(name), id");

  return result.rows.map((row) => ({ id: row.id, code: clientCode(row.id), name: row.name }));
}
