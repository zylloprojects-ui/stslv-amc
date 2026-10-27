import { pool } from "../../config/database";
import { schemaHas } from "../../shared/schema-features";
import { diffFields, logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { listEntityHistory } from "../../shared/entity-history";
import { conflict, isUniqueViolation, notFound, validationError } from "../../shared/errors";
import { escapeLike } from "../../shared/validation";
import { FREQUENCY_MONTHS, type MaintenanceFrequency } from "../amc/amc.constants";
import type { AuthContext } from "../auth/access";
import type { ListMastersQuery } from "./masters.schemas";

// Master lists (departments, sales engineers, system types, maintenance
// frequencies). Records are deactivated, never deleted, so contracts that refer
// to them stay intact.

interface Field {
  /** Name in the API. */
  name: string;
  column: string;
}

export interface MasterSpec {
  table: string;
  /** Activity log entity type and action prefix, for example "sales_engineers" and "sales_engineer". */
  entityType: string;
  actionPrefix: string;
  /** "Sales engineer", for messages. */
  label: string;
  fields: Field[];
  /** SQL select list for one record; the table is aliased "m". */
  select: string;
  joins: string;
  order: string;
  /** Sort keys the list accepts, mapped to SQL. The first is the default. */
  sorts: Record<string, string>;
  search: string[];
  /** Unique index name -> the field and message reported when it is violated. */
  unique: Record<string, { field: string; message: (input: Record<string, unknown>) => string }>;
  toItem: (row: Record<string, unknown>) => Record<string, unknown>;
  /** Extra checks on the values to be stored (for example that a linked record exists). */
  check?: (db: Queryable, values: Record<string, unknown>, before: Record<string, unknown> | null) => Promise<void>;
}

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

const AUDIT_SELECT = "m.is_active, m.created_at, m.updated_at";

export const DEPARTMENTS: MasterSpec = {
  table: "departments",
  entityType: "departments",
  actionPrefix: "department",
  label: "Department",
  fields: [
    { name: "code", column: "code" },
    { name: "name", column: "name" },
    { name: "description", column: "description" },
  ],
  select: `m.id, m.code, m.name, m.description, ${AUDIT_SELECT},
           (SELECT count(*)::int FROM sales_engineers e WHERE e.department_id = m.id) AS engineer_count`,
  joins: "",
  order: "lower(m.code), m.id",
  sorts: { code: "lower(m.code)", name: "lower(m.name)", createdAt: "m.created_at" },
  search: ["m.code", "m.name"],
  unique: { departments_code_uq: { field: "code", message: (input) => `A department with code "${String(input.code)}" already exists.` } },
  toItem: (row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    engineerCount: row.engineer_count,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }),
};

export const SYSTEM_TYPES: MasterSpec = {
  table: "system_types",
  entityType: "system_types",
  actionPrefix: "system_type",
  label: "System type",
  fields: [
    { name: "code", column: "code" },
    { name: "name", column: "name" },
    { name: "description", column: "description" },
    { name: "sortOrder", column: "sort_order" },
  ],
  select: `m.id, m.code, m.name, m.description, m.sort_order, ${AUDIT_SELECT},
           (SELECT count(*)::int FROM amc_contracts c WHERE c.system_type_id = m.id) AS contract_count`,
  joins: "",
  order: "m.sort_order, lower(m.code), m.id",
  sorts: { sortOrder: "m.sort_order", code: "lower(m.code)", name: "lower(m.name)", createdAt: "m.created_at" },
  search: ["m.code", "m.name"],
  unique: { system_types_code_uq: { field: "code", message: (input) => `A system type with code "${String(input.code)}" already exists.` } },
  toItem: (row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    contractCount: row.contract_count,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }),
};

export const SALES_ENGINEERS: MasterSpec = {
  table: "sales_engineers",
  entityType: "sales_engineers",
  actionPrefix: "sales_engineer",
  label: "Sales engineer",
  fields: [
    { name: "name", column: "name" },
    { name: "employeeNo", column: "employee_no" },
    { name: "email", column: "email" },
    { name: "phone", column: "phone" },
    { name: "departmentId", column: "department_id" },
    { name: "userId", column: "user_id" },
    { name: "notes", column: "notes" },
  ],
  select: `m.id, m.name, m.employee_no, m.email, m.phone, m.department_id, d.code AS department_code, d.name AS department_name,
           m.user_id, u.full_name AS user_name, u.email AS user_email, m.notes, ${AUDIT_SELECT},
           (SELECT count(*)::int FROM amc_contracts c WHERE c.sales_engineer_id = m.id) AS contract_count`,
  joins: "LEFT JOIN departments d ON d.id = m.department_id LEFT JOIN users u ON u.id = m.user_id",
  order: "lower(m.name), m.id",
  sorts: { name: "lower(m.name)", employeeNo: "lower(m.employee_no)", department: "lower(d.code)", createdAt: "m.created_at" },
  search: ["m.name", "m.employee_no", "m.email", "m.phone"],
  unique: {
    sales_engineers_name_uq: { field: "name", message: (input) => `A sales engineer named "${String(input.name)}" already exists.` },
    sales_engineers_employee_no_uq: { field: "employeeNo", message: (input) => `Employee number "${String(input.employeeNo)}" is already used.` },
    sales_engineers_user_uq: { field: "userId", message: () => "That user is already linked to another sales engineer." },
  },
  toItem: (row) => ({
    id: row.id,
    name: row.name,
    employeeNo: row.employee_no,
    email: row.email,
    phone: row.phone,
    department: row.department_id ? { id: row.department_id, code: row.department_code, name: row.department_name } : null,
    user: row.user_id ? { id: row.user_id, fullName: row.user_name, email: row.user_email } : null,
    notes: row.notes,
    contractCount: row.contract_count,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }),
  check: async (db, values, before) => {
    // A new link must be to an active department; an unchanged link to a since-deactivated one is kept.
    if (values.departmentId && values.departmentId !== before?.departmentId) {
      const department = await db.query<{ is_active: boolean }>("SELECT is_active FROM departments WHERE id = $1", [values.departmentId]);

      if (!department.rows[0]?.is_active) {
        throw validationError("Select an active department.", [{ field: "departmentId", message: "Select an active department." }]);
      }
    }
    if (values.userId && values.userId !== before?.userId) {
      const user = await db.query("SELECT 1 FROM users WHERE id = $1", [values.userId]);

      if (user.rowCount === 0) {
        throw validationError("Select an existing user.", [{ field: "userId", message: "Select an existing user." }]);
      }
    }
  },
};

// The four frequencies are fixed (migration 0075): only the label and the
// active flag change. A contract keeps its own frequency code, so neither
// change touches an existing contract or its visits.
export const MAINTENANCE_FREQUENCIES: MasterSpec = {
  table: "maintenance_frequencies",
  entityType: "maintenance_frequencies",
  actionPrefix: "maintenance_frequency",
  label: "Maintenance frequency",
  fields: [{ name: "label", column: "label" }],
  select: `m.id, m.code, m.label, m.sort_order, ${AUDIT_SELECT},
           (SELECT count(*)::int FROM amc_contracts c WHERE c.maintenance_frequency = m.code) AS contract_count`,
  joins: "",
  order: "m.sort_order, m.id",
  sorts: { sortOrder: "m.sort_order", label: "lower(m.label)" },
  search: ["m.code", "m.label"],
  unique: { maintenance_frequencies_label_uq: { field: "label", message: (input) => `A maintenance frequency labelled "${String(input.label)}" already exists.` } },
  toItem: (row) => ({
    id: row.id,
    code: row.code,
    label: row.label,
    // Messages and the activity log name a record by "name".
    name: row.label,
    intervalMonths: FREQUENCY_MONTHS[row.code as MaintenanceFrequency] ?? null,
    sortOrder: row.sort_order,
    contractCount: row.contract_count,
    isActive: row.is_active,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }),
};

async function findOne(db: Queryable, spec: MasterSpec, id: string, lock = false) {
  if (lock) {
    await db.query(`SELECT id FROM ${spec.table} WHERE id = $1 FOR UPDATE`, [id]);
  }

  const result = await db.query<Record<string, unknown>>(`SELECT ${spec.select} FROM ${spec.table} m ${spec.joins} WHERE m.id = $1`, [id]);
  const row = result.rows[0];

  if (!row) {
    throw notFound(`${spec.label} not found.`);
  }

  return spec.toItem(row);
}

/** The flat stored values of a record, by API field name, for comparison and logging. */
function flatValues(spec: MasterSpec, item: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const field of spec.fields) {
    if (field.name === "departmentId") values.departmentId = (item.department as { id: string } | null)?.id ?? null;
    else if (field.name === "userId") values.userId = (item.user as { id: string } | null)?.id ?? null;
    else values[field.name] = item[field.name] ?? null;
  }

  return values;
}

function rethrowUnique(spec: MasterSpec, error: unknown, input: Record<string, unknown>): never {
  for (const [constraint, info] of Object.entries(spec.unique)) {
    if (isUniqueViolation(error, constraint)) {
      const message = info.message(input);

      throw conflict(message, [{ field: info.field, message }]);
    }
  }

  throw error;
}

export async function listMasters(spec: MasterSpec, query: ListMastersQuery) {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status !== "all") {
    conditions.push(query.status === "active" ? "m.is_active" : "NOT m.is_active");
  }
  if (query.search) {
    params.push(`%${escapeLike(query.search)}%`);
    conditions.push(`(${spec.search.map((column) => `${column} ILIKE $${params.length}`).join(" OR ")})`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortKey = query.sort ?? Object.keys(spec.sorts)[0] ?? "";
  const sortSql = Object.hasOwn(spec.sorts, sortKey) ? spec.sorts[sortKey] : undefined;

  if (!sortSql) {
    throw validationError("Unknown sort.", [{ field: "sort", message: `Sort by one of: ${Object.keys(spec.sorts).join(", ")}.` }]);
  }

  const direction = query.direction === "desc" ? "DESC" : "ASC";
  const order = query.sort ? `${sortSql} ${direction} NULLS LAST, m.id ${direction}` : spec.order;
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${spec.table} m ${where}`, params);
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT ${spec.select} FROM ${spec.table} m ${spec.joins} ${where}
     ORDER BY ${order}
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, query.pageSize, (query.page - 1) * query.pageSize]
  );

  return { items: rows.rows.map(spec.toItem), total: total.rows[0]?.count ?? 0, page: query.page, pageSize: query.pageSize };
}

export function getMaster(spec: MasterSpec, id: string) {
  return findOne(pool, spec, id);
}

/** The activity recorded against one record, newest first. */
export async function listMasterHistory(spec: MasterSpec, id: string, page: number, pageSize: number) {
  await findOne(pool, spec, id);

  return listEntityHistory(spec.entityType, id, page, pageSize);
}

export async function createMaster(auth: AuthContext, spec: MasterSpec, input: Record<string, unknown>) {
  try {
    return await withTransaction(async (db) => {
      const values = Object.fromEntries(spec.fields.map((field) => [field.name, input[field.name] ?? null]));

      await spec.check?.(db, values, null);

      const columns = spec.fields.filter((field) => input[field.name] !== undefined);
      const params = [...columns.map((field) => input[field.name]), auth.user.id];
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO ${spec.table} (${[...columns.map((field) => field.column), "created_by", "updated_by"].join(", ")})
         VALUES (${[...columns.map((_, index) => `$${index + 1}`), `$${params.length}`, `$${params.length}`].join(", ")})
         RETURNING id`,
        params
      );
      const id = (inserted.rows[0] as { id: string }).id;
      const created = await findOne(db, spec, id);

      await logActivity(db, {
        userId: auth.user.id,
        action: `${spec.actionPrefix}.created`,
        module: "SETTINGS",
        entityType: spec.entityType,
        entityId: id,
        description: `${spec.label} "${String(created.name)}" created.`,
      });

      return created;
    });
  } catch (error) {
    rethrowUnique(spec, error, input);
  }
}

export async function updateMaster(auth: AuthContext, spec: MasterSpec, id: string, input: Record<string, unknown>) {
  try {
    return await withTransaction(async (db) => {
      const before = await findOne(db, spec, id, true);
      const beforeValues = flatValues(spec, before);
      const afterValues = { ...beforeValues, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
      const changes = diffFields(beforeValues, afterValues, spec.fields.map((field) => field.name));

      if (Object.keys(changes).length === 0) {
        return before;
      }

      await spec.check?.(db, afterValues, beforeValues);

      const changed = spec.fields.filter((field) => field.name in changes);
      await db.query(
        `UPDATE ${spec.table} SET ${changed.map((field, index) => `${field.column} = $${index + 1}`).join(", ")}, updated_by = $${changed.length + 1}
         WHERE id = $${changed.length + 2}`,
        [...changed.map((field) => afterValues[field.name]), auth.user.id, id]
      );

      const updated = await findOne(db, spec, id);

      await logActivity(db, {
        userId: auth.user.id,
        action: `${spec.actionPrefix}.updated`,
        module: "SETTINGS",
        entityType: spec.entityType,
        entityId: id,
        description: `${spec.label} "${String(updated.name)}" updated.`,
        metadata: { changes },
      });

      return updated;
    });
  } catch (error) {
    rethrowUnique(spec, error, input);
  }
}

/** Deactivates or reactivates a record. Deactivated records stay linked to existing contracts but cannot be newly selected. */
export function setMasterStatus(auth: AuthContext, spec: MasterSpec, id: string, isActive: boolean) {
  return withTransaction(async (db) => {
    const before = await findOne(db, spec, id, true);

    if (before.isActive === isActive) {
      return before;
    }

    await db.query(`UPDATE ${spec.table} SET is_active = $1, updated_by = $2 WHERE id = $3`, [isActive, auth.user.id, id]);
    const updated = await findOne(db, spec, id);

    await logActivity(db, {
      userId: auth.user.id,
      action: `${spec.actionPrefix}.${isActive ? "reactivated" : "deactivated"}`,
      module: "SETTINGS",
      entityType: spec.entityType,
      entityId: id,
      description: `${spec.label} "${String(updated.name)}" ${isActive ? "reactivated" : "deactivated"}.`,
      metadata: { changes: { isActive: { from: before.isActive, to: isActive } } },
    });

    return updated;
  });
}

/** Active records for a picker (for example the contract form), without paging. */
export async function masterOptions(spec: MasterSpec) {
  const rows = await pool.query<Record<string, unknown>>(`SELECT ${spec.select} FROM ${spec.table} m ${spec.joins} WHERE m.is_active ORDER BY ${spec.order}`);

  return rows.rows.map(spec.toItem);
}

export type MasterCategory = "clients" | "sales-engineers" | "system-types" | "maintenance-frequencies" | "departments";

/** Tables each category needs; a category whose tables are missing reports that a database update is required. */
const CATEGORY_TABLES: Record<MasterCategory, { table: string; requires: string[] }> = {
  clients: { table: "clients", requires: ["clients"] },
  "sales-engineers": { table: "sales_engineers", requires: ["sales_engineers"] },
  "system-types": { table: "system_types", requires: ["system_types"] },
  "maintenance-frequencies": { table: "maintenance_frequencies", requires: ["maintenance_frequencies"] },
  departments: { table: "departments", requires: ["departments"] },
};

/**
 * Active-record counts for the Master Data Center, for the given categories only
 * (the caller passes those the user may read). activeCount is null when the
 * category's database update has not been applied.
 */
export async function masterSummary(categories: MasterCategory[]) {
  return Promise.all(
    categories.map(async (key) => {
      const { table, requires } = CATEGORY_TABLES[key];

      if (!(await schemaHas(requires))) {
        return { key, available: false, activeCount: null };
      }

      const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE is_active`);

      return { key, available: true, activeCount: result.rows[0]?.count ?? 0 };
    })
  );
}
