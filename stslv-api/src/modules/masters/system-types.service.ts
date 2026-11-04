import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import { getMasterUsage, moveMasterToRecycleBin } from "../recycle-bin/recycle-bin.service";
import { getMaster, listAllMasters, SYSTEM_TYPES } from "./masters.service";
import { SYSTEM_TYPE_STATUS_LABELS, type ExportSystemTypesQuery } from "./system-types.schemas";

// System types only: the AMC contracts that use a type, moving a type to the
// Recycle Bin, and the list as a report. A contract refers to its type by id
// (amc_contracts_all.system_type_id, ON DELETE RESTRICT), so a type's code and
// name can change without touching any contract.

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

/**
 * Moves a system type to the Recycle Bin (migration 0106, approved 2026-11-04). Super Admin only
 * (403 for everyone else, even with System Types Delete). Refused with 409 while an AMC contract
 * outside the Recycle Bin uses the type, in any status; contracts in the Recycle Bin do not block it.
 * The counts come from amc_contracts_all, so the message can never say "used by 0 contracts".
 * Permanent deletion is only possible from the Recycle Bin, for a type never used.
 */
export function deleteSystemType(auth: AuthContext, id: string): Promise<void> {
  return moveMasterToRecycleBin(auth, "SYSTEM_TYPE", id);
}

/** What uses a system type, for the delete dialog. */
export function getSystemTypeUsage(id: string) {
  return getMasterUsage("SYSTEM_TYPE", id);
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
      module: SYSTEM_TYPES.module,
      entityType: SYSTEM_TYPES.entityType,
      entityId: null,
      description: `Exported the system type list as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${total === 1 ? "system type" : "system types"}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}
