import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction } from "../../shared/db";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import { conflict, notFound } from "../../shared/errors";
import type { AuthContext } from "../auth/access";
import { getMaster, listAllMasters, SYSTEM_TYPES } from "./masters.service";
import { SYSTEM_TYPE_STATUS_LABELS, type ExportSystemTypesQuery } from "./system-types.schemas";

// System types only: the AMC contracts that use a type, deletion of an unused
// type, and the list as a report. A contract refers to its type by id
// (amc_contracts.system_type_id, ON DELETE RESTRICT), so a type's code and name
// can change without touching any contract.

interface SystemTypeItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  contractCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The AMC contracts linked to a type, newest first. Read only. */
export async function listLinkedContracts(id: string, page: number, pageSize: number) {
  // 404 for an unknown type, rather than an empty list.
  await getMaster(SYSTEM_TYPES, id);

  const total = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts WHERE system_type_id = $1", [id]);
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
     WHERE c.system_type_id = $1
     ORDER BY c.valid_from DESC, c.id DESC
     LIMIT $2 OFFSET $3`,
    [id, pageSize, (page - 1) * pageSize]
  );

  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      client: { id: row.client_id, name: row.client_name },
      systemDescription: row.system_description,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status,
    })),
    total: total.rows[0]?.count ?? 0,
    page,
    pageSize,
  };
}

const inUseMessage = (name: string, count: number) =>
  `"${name}" is used by ${count} AMC ${count === 1 ? "contract" : "contracts"} and cannot be deleted. Disable it instead: ` +
  "the contracts keep it, and it is no longer offered for new contracts.";

/** True for a PostgreSQL foreign-key violation (23503). */
function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "23503";
}

/**
 * Deletes a system type that no AMC contract uses. A type in use is refused
 * with a 409; the database's ON DELETE RESTRICT refuses it again should a
 * contract be linked between the check and the delete.
 */
export async function deleteSystemType(auth: AuthContext, id: string): Promise<void> {
  let name = "";

  try {
    await withTransaction(async (db) => {
      // Locked, so no contract can be linked to it until this transaction ends.
      const found = await db.query<Record<string, unknown>>(`SELECT ${SYSTEM_TYPES.select} FROM system_types m WHERE m.id = $1 FOR UPDATE OF m`, [id]);
      const row = found.rows[0];

      if (!row) {
        throw notFound(`${SYSTEM_TYPES.label} not found.`);
      }

      const type = SYSTEM_TYPES.toItem(row) as unknown as SystemTypeItem;
      name = type.name;

      if (type.contractCount > 0) {
        throw conflict(inUseMessage(type.name, type.contractCount));
      }

      await db.query("DELETE FROM system_types WHERE id = $1", [id]);
      await logActivity(db, {
        userId: auth.user.id,
        action: "system_type.deleted",
        module: "SETTINGS",
        entityType: SYSTEM_TYPES.entityType,
        entityId: id,
        description: `System type "${type.name}" deleted.`,
        // The record no longer exists; the log keeps what it was.
        metadata: { deleted: { code: type.code, name: type.name, description: type.description, sortOrder: type.sortOrder, isActive: type.isActive } },
      });
    });
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      const count = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts WHERE system_type_id = $1", [id]);

      throw conflict(inUseMessage(name, count.rows[0]?.count ?? 1));
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const COLUMNS: ReportColumn[] = [
  { key: "code", header: "Code", kind: "identifier", width: 12 },
  { key: "name", header: "System type", kind: "text", width: 28, wrap: true },
  { key: "description", header: "Description", kind: "text", width: 40, wrap: true },
  { key: "sortOrder", header: "Sort order", kind: "count", width: 11 },
  { key: "status", header: "Status", kind: "text", width: 11 },
  { key: "contractCount", header: "Linked AMC contracts", kind: "count", width: 14 },
  { key: "createdAt", header: "Added", kind: "date", width: 13, excelOnly: true },
  { key: "updatedAt", header: "Last updated", kind: "date", width: 13, excelOnly: true },
];

const SORT_LABELS: Record<string, string> = { sortOrder: "Sort order", code: "Code", name: "Name", createdAt: "Date added" };

function typeRow(type: SystemTypeItem): ReportRow {
  return {
    code: type.code,
    name: type.name,
    description: type.description,
    sortOrder: type.sortOrder,
    status: SYSTEM_TYPE_STATUS_LABELS[type.isActive ? "active" : "inactive"],
    contractCount: type.contractCount,
    createdAt: type.createdAt.slice(0, 10),
    updatedAt: type.updatedAt.slice(0, 10),
  };
}

function describeFilters(query: ExportSystemTypesQuery): ReportDefinition["filters"] {
  const filters: ReportDefinition["filters"] = [{ label: "Status", value: query.status === "all" ? "All" : SYSTEM_TYPE_STATUS_LABELS[query.status] }];

  if (query.search) {
    filters.push({ label: "Search", value: query.search });
  }
  if (query.sort && SORT_LABELS[query.sort]) {
    filters.push({ label: "Order", value: `${SORT_LABELS[query.sort]} (${query.direction === "desc" ? "descending" : "ascending"})` });
  }

  return filters;
}

/** The System Types list, with the page's filters and order, as a report; and the audit entry to write once the file exists. */
export async function buildSystemTypesExport(auth: AuthContext, query: ExportSystemTypesQuery) {
  const { format, ...filters } = query;
  const { items, total } = await listAllMasters(SYSTEM_TYPES, filters, (count) => assertExportSize(format, count));

  const report: ReportDefinition = {
    title: "System Types",
    period: null,
    filters: describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "system-types",
    tables: [
      {
        name: "System Types",
        columns: COLUMNS,
        rows: (items as unknown as SystemTypeItem[]).map(typeRow),
        notes: total > 0 ? [`${total} ${total === 1 ? "system type" : "system types"}.`] : [],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "system_types.exported",
      module: "SETTINGS",
      entityType: SYSTEM_TYPES.entityType,
      entityId: null,
      description: `Exported the system type list as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${total === 1 ? "system type" : "system types"}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}
