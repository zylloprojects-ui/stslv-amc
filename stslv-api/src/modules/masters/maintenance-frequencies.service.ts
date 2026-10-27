import { pool } from "../../config/database";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { listEntityHistory } from "../../shared/entity-history";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import { conflict, isUniqueViolation, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import type { AuthContext } from "../auth/access";
import {
  describeRule,
  engineSupports,
  ENGINE_UNSUPPORTED_MESSAGE,
  FREQUENCY_STATUS_LABELS,
  LOCKED_FIELD_LABELS,
  lockedChanges,
  ruleProblems,
  statusOf,
  type FrequencyStatus,
} from "./maintenance-frequencies.rules";
import type {
  CreateFrequencyInput,
  ExportFrequenciesQuery,
  ListFrequenciesQuery,
  UpdateFrequencyInput,
} from "./maintenance-frequencies.schemas";

// Maintenance frequencies (migration 0076): the scheduling rules a contract's
// frequency code refers to. A contract keeps its own code
// (amc_contracts.maintenance_frequency, a foreign key to the code), so:
// - a frequency is never deleted; it is disabled or archived instead;
// - once any contract uses a frequency, its code and scheduling rule are
//   locked, so no edit here can change how a contract's visits are planned or
//   labelled; only the name, sort order and status may change;
// - a status change never touches a contract or a visit.

const ENTITY_TYPE = "maintenance_frequencies";
const MODULE = "SETTINGS";

export interface FrequencyItem {
  id: string;
  code: string;
  /** Kept equal to name: older screens read the label. */
  label: string;
  name: string;
  isCustom: boolean;
  serviceCount: number | null;
  intervalMonths: number | null;
  codePrefix: string;
  ruleSummary: string;
  sortOrder: number;
  status: FrequencyStatus;
  isActive: boolean;
  archivedAt: string | null;
  /** True once any contract uses it: the code and the scheduling rule can no longer change. */
  ruleLocked: boolean;
  /** Whether the schedule engine can generate visits for this rule today. */
  engineSupported: boolean;
  contractCount: number;
  activeContractCount: number;
  createdAt: string;
  updatedAt: string;
}

const SELECT = `m.id, m.code, m.label, m.is_custom, m.service_count, m.interval_months, m.code_prefix,
  m.sort_order, m.is_active, m.archived_at, m.created_at, m.updated_at,
  (SELECT count(*)::int FROM amc_contracts c WHERE c.maintenance_frequency = m.code) AS contract_count,
  (SELECT count(*)::int FROM amc_contracts c WHERE c.maintenance_frequency = m.code AND c.status = 'ACTIVE') AS active_contract_count`;

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : (value as string | null));

function toItem(row: Record<string, unknown>): FrequencyItem {
  const rule = {
    isCustom: row.is_custom as boolean,
    serviceCount: row.service_count as number | null,
    intervalMonths: row.interval_months as number | null,
  };
  const archivedAt = iso(row.archived_at);
  const contractCount = row.contract_count as number;

  return {
    id: row.id as string,
    code: row.code as string,
    label: row.label as string,
    name: row.label as string,
    ...rule,
    codePrefix: row.code_prefix as string,
    ruleSummary: describeRule(rule),
    sortOrder: row.sort_order as number,
    status: statusOf({ isActive: row.is_active as boolean, archivedAt }),
    isActive: row.is_active as boolean,
    archivedAt,
    ruleLocked: contractCount > 0,
    engineSupported: engineSupports(rule),
    contractCount,
    activeContractCount: row.active_contract_count as number,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
  };
}

async function findOne(db: Queryable, id: string, lock = false): Promise<FrequencyItem> {
  // FOR UPDATE also waits for, and then blocks, a contract being linked to the
  // code (the foreign key takes a key-share lock on this row).
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${SELECT} FROM maintenance_frequencies m WHERE m.id = $1${lock ? " FOR UPDATE OF m" : ""}`,
    [id]
  );
  const row = result.rows[0];

  if (!row) {
    throw notFound("Maintenance frequency not found.");
  }

  return toItem(row);
}

const UNIQUE: Record<string, { field: string; message: (input: Record<string, unknown>) => string }> = {
  maintenance_frequencies_code_uq: { field: "code", message: (input) => `A maintenance frequency with internal code "${String(input.code)}" already exists.` },
  maintenance_frequencies_label_uq: { field: "name", message: (input) => `A maintenance frequency named "${String(input.name)}" already exists.` },
  maintenance_frequencies_prefix_uq: {
    field: "codePrefix",
    message: (input) => `The service code prefix "${String(input.codePrefix)}" is already used by another frequency (archived ones included). Each frequency needs its own prefix.`,
  },
};

function rethrowUnique(error: unknown, input: Record<string, unknown>): never {
  for (const [constraint, info] of Object.entries(UNIQUE)) {
    if (isUniqueViolation(error, constraint)) {
      const message = info.message(input);

      throw conflict(message, [{ field: info.field, message }]);
    }
  }

  throw error;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

const SORTS: Record<string, string> = {
  sortOrder: "m.sort_order",
  name: "lower(m.label)",
  code: "m.code",
  codePrefix: "m.code_prefix",
  serviceCount: "m.service_count",
  intervalMonths: "m.interval_months",
  activeContracts: "active_contract_count",
  contracts: "contract_count",
  createdAt: "m.created_at",
};

const STATUS_CONDITIONS: Record<ListFrequenciesQuery["status"], string | null> = {
  current: "m.archived_at IS NULL",
  active: "m.is_active",
  disabled: "NOT m.is_active AND m.archived_at IS NULL",
  archived: "m.archived_at IS NOT NULL",
  all: null,
};

type ListFilters = Omit<ListFrequenciesQuery, "page" | "pageSize">;

/** The WHERE and ORDER BY of the list. Sort keys are checked against SORTS; every value is a parameter. */
function listClauses(query: ListFilters) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const status = STATUS_CONDITIONS[query.status];

  if (status) {
    conditions.push(status);
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    conditions.push(`(m.label ILIKE $${params.length} OR m.code ILIKE $${params.length} OR m.code_prefix ILIKE $${params.length})`);
  }

  const sortSql = query.sort === undefined ? undefined : Object.hasOwn(SORTS, query.sort) ? SORTS[query.sort] : null;

  if (sortSql === null) {
    throw validationError("Unknown sort.", [{ field: "sort", message: `Sort by one of: ${Object.keys(SORTS).join(", ")}.` }]);
  }

  const direction = query.direction === "desc" ? "DESC" : "ASC";
  const order = sortSql ? `${sortSql} ${direction} NULLS LAST, m.sort_order, m.id` : "m.sort_order, m.id";

  return { where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "", params, order };
}

export async function listFrequencies(query: ListFrequenciesQuery) {
  const { where, params, order } = listClauses(query);
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM maintenance_frequencies m ${where}`, params);
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT ${SELECT} FROM maintenance_frequencies m ${where}
     ORDER BY ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return { items: rows.rows.map(toItem), total: total.rows[0]?.count ?? 0, page: query.page, pageSize: query.pageSize };
}

/** Every frequency matching the filters, in the list's order. `checkSize` sees the count before any row is read. */
async function listAllFrequencies(query: ListFilters, checkSize: (count: number) => void) {
  const { where, params, order } = listClauses(query);
  const total = (await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM maintenance_frequencies m ${where}`, params)).rows[0]?.count ?? 0;

  checkSize(total);

  const rows = await pool.query<Record<string, unknown>>(`SELECT ${SELECT} FROM maintenance_frequencies m ${where} ORDER BY ${order}`, params);

  return { items: rows.rows.map(toItem), total };
}

export function getFrequency(id: string) {
  return findOne(pool, id);
}

/** Active frequencies, for the contract form's picker. */
export async function frequencyOptions() {
  const rows = await pool.query<Record<string, unknown>>(`SELECT ${SELECT} FROM maintenance_frequencies m WHERE m.is_active ORDER BY m.sort_order, m.id`);

  return rows.rows.map(toItem);
}

export async function listFrequencyHistory(id: string, page: number, pageSize: number) {
  await findOne(pool, id);

  return listEntityHistory(ENTITY_TYPE, id, page, pageSize);
}

// ---------------------------------------------------------------------------
// Create and edit
// ---------------------------------------------------------------------------

export async function createFrequency(auth: AuthContext, input: CreateFrequencyInput): Promise<FrequencyItem> {
  if (input.status === "active" && !engineSupports(input)) {
    throw validationError(ENGINE_UNSUPPORTED_MESSAGE, [{ field: "status", message: ENGINE_UNSUPPORTED_MESSAGE }]);
  }

  try {
    return await withTransaction(async (db) => {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO maintenance_frequencies
           (code, label, is_custom, service_count, interval_months, code_prefix, sort_order, is_active, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6,
                 COALESCE($7, (SELECT COALESCE(max(sort_order), 0) + 1 FROM maintenance_frequencies)),
                 $8, $9, $9)
         RETURNING id`,
        [
          input.code,
          input.name,
          input.isCustom,
          input.serviceCount,
          input.intervalMonths,
          input.codePrefix,
          input.sortOrder ?? null,
          input.status === "active",
          auth.user.id,
        ]
      );
      const id = (inserted.rows[0] as { id: string }).id;
      const created = await findOne(db, id);

      await logActivity(db, {
        userId: auth.user.id,
        action: "maintenance_frequency.created",
        module: MODULE,
        entityType: ENTITY_TYPE,
        entityId: id,
        description: `Maintenance frequency "${created.name}" created${created.isActive ? "" : " as disabled"}.`,
        metadata: { values: ruleValues(created) },
      });

      return created;
    });
  } catch (error) {
    rethrowUnique(error, input);
  }
}

/** The stored values an edit may change, by API field name. */
function ruleValues(item: FrequencyItem) {
  return {
    name: item.name,
    code: item.code,
    codePrefix: item.codePrefix,
    isCustom: item.isCustom,
    serviceCount: item.serviceCount,
    intervalMonths: item.intervalMonths,
    sortOrder: item.sortOrder,
  };
}

const EDITABLE = ["name", "code", "codePrefix", "isCustom", "serviceCount", "intervalMonths", "sortOrder"] as const;

const COLUMNS: Record<(typeof EDITABLE)[number], string> = {
  name: "label",
  code: "code",
  codePrefix: "code_prefix",
  isCustom: "is_custom",
  serviceCount: "service_count",
  intervalMonths: "interval_months",
  sortOrder: "sort_order",
};

interface Rejection {
  name: string;
  contractCount: number;
  fields: string[];
  attempted: Record<string, unknown>;
}

export async function updateFrequency(auth: AuthContext, id: string, input: UpdateFrequencyInput): Promise<FrequencyItem> {
  // Set inside the transaction; declared this way so TypeScript does not narrow it to null.
  let rejection = null as Rejection | null;
  let result: FrequencyItem;

  try {
    result = await withTransaction(async (db) => {
      const before = await findOne(db, id, true);
      const beforeValues = ruleValues(before);
      const provided = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
      const afterValues = { ...beforeValues, ...provided } as typeof beforeValues;

      // Switching to custom clears the stored numbers; numbers sent with it are refused by the rule check below.
      if (afterValues.isCustom && !before.isCustom) {
        if (!("serviceCount" in provided)) afterValues.serviceCount = null;
        if (!("intervalMonths" in provided)) afterValues.intervalMonths = null;
      }

      const changes = diffFields(beforeValues, afterValues, EDITABLE);

      if (Object.keys(changes).length === 0) {
        return before;
      }

      const locked = lockedChanges(beforeValues, afterValues);

      if (before.ruleLocked && locked.length > 0) {
        rejection = {
          name: before.name,
          contractCount: before.contractCount,
          fields: locked,
          attempted: Object.fromEntries(locked.map((field) => [field, changes[field]])),
        };
        // Nothing is written; the rejection is logged after the transaction ends.
        return before;
      }

      const problems = ruleProblems(afterValues);

      if (problems.length > 0) {
        throw validationError("The scheduling rule is not valid.", problems);
      }
      if (before.isActive && !engineSupports(afterValues)) {
        throw validationError(ENGINE_UNSUPPORTED_MESSAGE, [{ field: "intervalMonths", message: ENGINE_UNSUPPORTED_MESSAGE }]);
      }

      const changed = EDITABLE.filter((field) => field in changes);

      await db.query(
        `UPDATE maintenance_frequencies
         SET ${changed.map((field, index) => `${COLUMNS[field]} = $${index + 1}`).join(", ")}, updated_by = $${changed.length + 1}
         WHERE id = $${changed.length + 2}`,
        [...changed.map((field) => afterValues[field]), auth.user.id, id]
      );

      const updated = await findOne(db, id);

      await logActivity(db, {
        userId: auth.user.id,
        action: "maintenance_frequency.updated",
        module: MODULE,
        entityType: ENTITY_TYPE,
        entityId: id,
        description: `Maintenance frequency "${updated.name}" updated.`,
        metadata: { changes },
      });

      return updated;
    });
  } catch (error) {
    rethrowUnique(error, input);
  }

  if (rejection) {
    await rejectLockedChange(auth, id, rejection);
  }

  return result;
}

async function rejectLockedChange(auth: AuthContext, id: string, rejection: Rejection): Promise<never> {
  const { name, contractCount, fields } = rejection;
  const labels = fields.map((field) => LOCKED_FIELD_LABELS[field as keyof typeof LOCKED_FIELD_LABELS]);
  const message =
    `"${name}" is used by ${contractCount} AMC ${contractCount === 1 ? "contract" : "contracts"}, so its scheduling rule is locked ` +
    `(${labels.join(", ")}). Changing it would change how those contracts' visits are planned or labelled. ` +
    "Create a new frequency for a different rule; the name, sort order and status can still be changed.";

  await logActivity(pool, {
    userId: auth.user.id,
    action: "maintenance_frequency.rule_change_rejected",
    module: MODULE,
    entityType: ENTITY_TYPE,
    entityId: id,
    description: `Change to the locked scheduling rule of "${name}" refused (${labels.join(", ")}).`,
    metadata: { contractCount, attempted: rejection.attempted },
  });

  throw conflict(
    message,
    fields.map((field) => ({ field, message: `Locked: used by ${contractCount} AMC ${contractCount === 1 ? "contract" : "contracts"}.` }))
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const STATUS_ACTIONS: Record<FrequencyStatus, string> = { active: "activated", disabled: "disabled", archived: "archived" };

/**
 * Sets Active, Disabled or Archived. Contracts keep the frequency whatever its
 * status, and no visit is touched; only Active frequencies are offered for new
 * contracts. Moving a frequency that active contracts use away from Active
 * needs `confirm`, so the caller has seen the count first.
 */
export async function setFrequencyStatus(auth: AuthContext, id: string, status: FrequencyStatus, confirm: boolean): Promise<FrequencyItem> {
  return withTransaction(async (db) => {
    const before = await findOne(db, id, true);

    if (before.status === status) {
      return before;
    }
    if (status === "active" && !before.engineSupported) {
      throw conflict(ENGINE_UNSUPPORTED_MESSAGE, [{ field: "status", message: ENGINE_UNSUPPORTED_MESSAGE }]);
    }
    if (status !== "active" && before.activeContractCount > 0 && !confirm) {
      const count = before.activeContractCount;
      const message =
        `"${before.name}" is used by ${count} active AMC ${count === 1 ? "contract" : "contracts"}. ` +
        `${status === "archived" ? "Archiving" : "Disabling"} it keeps it on ${count === 1 ? "that contract" : "those contracts"} and their visits, ` +
        "but it will no longer be offered for new contracts or renewals. Confirm to continue.";

      throw conflict(message, [{ field: "confirm", message }]);
    }

    await db.query(
      `UPDATE maintenance_frequencies
       SET is_active = $1,
           archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END,
           updated_by = $3
       WHERE id = $4`,
      [status === "active", status === "archived", auth.user.id, id]
    );

    const updated = await findOne(db, id);

    await logActivity(db, {
      userId: auth.user.id,
      action: `maintenance_frequency.${STATUS_ACTIONS[status]}`,
      module: MODULE,
      entityType: ENTITY_TYPE,
      entityId: id,
      description: `Maintenance frequency "${updated.name}" ${STATUS_ACTIONS[status]} (was ${FREQUENCY_STATUS_LABELS[before.status]}).`,
      metadata: {
        changes: { status: { from: before.status, to: status } },
        activeContractCount: before.activeContractCount,
        contractCount: before.contractCount,
      },
    });

    return updated;
  });
}

// ---------------------------------------------------------------------------
// Linked contracts
// ---------------------------------------------------------------------------

/** The AMC contracts that use a frequency, newest first. Read only. */
export async function listLinkedContracts(id: string, page: number, pageSize: number) {
  const frequency = await findOne(pool, id);
  const rows = await pool.query<{
    id: string;
    client_id: string;
    client_name: string;
    system_description: string;
    valid_from: string;
    valid_to: string;
    status: string;
  }>(
    `SELECT c.id, c.client_id, cl.name AS client_name, c.system_description,
            to_char(c.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(c.valid_to, 'YYYY-MM-DD') AS valid_to, c.status
     FROM amc_contracts c
     JOIN clients cl ON cl.id = c.client_id
     WHERE c.maintenance_frequency = $1
     ORDER BY c.valid_from DESC, c.id DESC
     LIMIT $2 OFFSET $3`,
    [frequency.code, pageSize, (page - 1) * pageSize]
  );

  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      client: { id: row.client_id, name: row.client_name },
      systemDescription: row.system_description,
      frequency: { code: frequency.code, name: frequency.name },
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status,
    })),
    total: frequency.contractCount,
    activeTotal: frequency.activeContractCount,
    page,
    pageSize,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const REPORT_COLUMNS: ReportColumn[] = [
  { key: "name", header: "Frequency", kind: "text", width: 26, wrap: true },
  { key: "code", header: "Internal code", kind: "identifier", width: 18 },
  { key: "rule", header: "Rule", kind: "text", width: 10 },
  { key: "serviceCount", header: "Services per year", kind: "count", width: 11 },
  { key: "intervalMonths", header: "Interval (months)", kind: "count", width: 11 },
  { key: "codePrefix", header: "Prefix", kind: "identifier", width: 8 },
  { key: "sortOrder", header: "Sort order", kind: "count", width: 9 },
  { key: "status", header: "Status", kind: "text", width: 10 },
  { key: "activeContractCount", header: "Active AMC contracts", kind: "count", width: 12 },
  { key: "contractCount", header: "Total AMC contracts", kind: "count", width: 12 },
  { key: "createdAt", header: "Added", kind: "date", width: 13, excelOnly: true },
  { key: "updatedAt", header: "Last updated", kind: "date", width: 13, excelOnly: true },
];

const SORT_LABELS: Record<string, string> = {
  sortOrder: "Sort order",
  name: "Name",
  code: "Internal code",
  codePrefix: "Prefix",
  serviceCount: "Services per year",
  intervalMonths: "Interval",
  activeContracts: "Active AMC contracts",
  contracts: "Total AMC contracts",
  createdAt: "Date added",
};

const LIST_STATUS_LABELS: Record<ExportFrequenciesQuery["status"], string> = {
  current: "Active and disabled",
  active: "Active",
  disabled: "Disabled",
  archived: "Archived",
  all: "All",
};

function reportRow(item: FrequencyItem): ReportRow {
  return {
    name: item.name,
    code: item.code,
    rule: item.isCustom ? "Custom" : "Fixed",
    serviceCount: item.serviceCount,
    intervalMonths: item.intervalMonths,
    codePrefix: item.codePrefix,
    sortOrder: item.sortOrder,
    status: FREQUENCY_STATUS_LABELS[item.status],
    activeContractCount: item.activeContractCount,
    contractCount: item.contractCount,
    createdAt: item.createdAt.slice(0, 10),
    updatedAt: item.updatedAt.slice(0, 10),
  };
}

function describeFilters(query: ExportFrequenciesQuery): ReportDefinition["filters"] {
  const filters: ReportDefinition["filters"] = [{ label: "Status", value: LIST_STATUS_LABELS[query.status] }];

  if (query.search) {
    filters.push({ label: "Search", value: query.search });
  }
  if (query.sort && SORT_LABELS[query.sort]) {
    filters.push({ label: "Order", value: `${SORT_LABELS[query.sort]} (${query.direction === "desc" ? "descending" : "ascending"})` });
  }

  return filters;
}

/** The list, with the page's filters and order, as a report; and the audit entry to write once the file exists. */
export async function buildFrequenciesExport(auth: AuthContext, query: ExportFrequenciesQuery) {
  const { format, ...filters } = query;
  const { items, total } = await listAllFrequencies(filters, (count) => assertExportSize(format, count));
  const noun = (count: number) => (count === 1 ? "maintenance frequency" : "maintenance frequencies");

  const report: ReportDefinition = {
    title: "Maintenance Frequencies",
    period: null,
    filters: describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "maintenance-frequencies",
    tables: [
      {
        name: "Maintenance Frequencies",
        columns: REPORT_COLUMNS,
        rows: items.map(reportRow),
        notes: total > 0 ? [`${total} ${noun(total)}. Services per year and interval are blank for a custom frequency: its months are chosen on each contract.`] : [],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "maintenance_frequencies.exported",
      module: MODULE,
      entityType: ENTITY_TYPE,
      entityId: null,
      description: `Exported the maintenance frequency list as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${noun(total)}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}

