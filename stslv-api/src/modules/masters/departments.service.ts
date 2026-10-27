import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { AuthContext } from "../auth/access";
import { DEPARTMENTS, listAllMasters, listMasters, type MasterSpec } from "./masters.service";
import { DEPARTMENT_STATUS_LABELS, type ExportDepartmentsQuery, type ListDepartmentsQuery } from "./departments.schemas";

// Departments only: the list and its export. An engineer refers to a
// department by id (sales_engineers.department_id, ON DELETE RESTRICT); no
// record stores the department code, so a code or name can change without
// touching any engineer. Departments are disabled, never deleted.

interface DepartmentItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  engineerCount: number;
  activeEngineerCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const ENGINEER_COUNT = "(SELECT count(*)::int FROM sales_engineers e WHERE e.department_id = m.id)";

/**
 * The shared department spec, as the list reads it: the description is
 * searched too, the default order is name then code, and each row also counts
 * its active engineers (those a disable affects day to day).
 */
const DEPARTMENT_LIST: MasterSpec = {
  ...DEPARTMENTS,
  select: `${DEPARTMENTS.select},
           (SELECT count(*)::int FROM sales_engineers e WHERE e.department_id = m.id AND e.is_active) AS active_engineer_count`,
  order: "lower(m.name), lower(m.code), m.id",
  sorts: { name: "lower(m.name)", code: "lower(m.code)", engineers: ENGINEER_COUNT, createdAt: "m.created_at", updatedAt: "m.updated_at" },
  search: ["m.code", "m.name", "m.description"],
  toItem: (row) => ({ ...DEPARTMENTS.toItem(row), activeEngineerCount: row.active_engineer_count }),
};

export function listDepartments(query: ListDepartmentsQuery) {
  return listMasters(DEPARTMENT_LIST, query);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const COLUMNS: ReportColumn[] = [
  { key: "code", header: "Code", kind: "identifier", width: 12 },
  { key: "name", header: "Department", kind: "text", width: 28, wrap: true },
  { key: "description", header: "Description", kind: "text", width: 40, wrap: true },
  { key: "status", header: "Status", kind: "text", width: 11 },
  { key: "engineerCount", header: "Linked engineers", kind: "count", width: 12 },
  { key: "activeEngineerCount", header: "Active engineers", kind: "count", width: 12, excelOnly: true },
  { key: "createdAt", header: "Added", kind: "date", width: 13, excelOnly: true },
  { key: "updatedAt", header: "Last updated", kind: "date", width: 13, excelOnly: true },
];

const SORT_LABELS: Record<string, string> = { name: "Name", code: "Code", engineers: "Linked engineers", createdAt: "Date added", updatedAt: "Last updated" };

function departmentRow(department: DepartmentItem): ReportRow {
  return {
    code: department.code,
    name: department.name,
    description: department.description,
    status: DEPARTMENT_STATUS_LABELS[department.isActive ? "active" : "inactive"],
    engineerCount: department.engineerCount,
    activeEngineerCount: department.activeEngineerCount,
    createdAt: department.createdAt.slice(0, 10),
    updatedAt: department.updatedAt.slice(0, 10),
  };
}

function describeFilters(query: ExportDepartmentsQuery): ReportDefinition["filters"] {
  const filters: ReportDefinition["filters"] = [{ label: "Status", value: query.status === "all" ? "All" : DEPARTMENT_STATUS_LABELS[query.status] }];

  if (query.search) {
    filters.push({ label: "Search", value: query.search });
  }
  if (query.sort && SORT_LABELS[query.sort]) {
    filters.push({ label: "Order", value: `${SORT_LABELS[query.sort]} (${query.direction === "desc" ? "descending" : "ascending"})` });
  }

  return filters;
}

/** The Departments list, with the page's filters and order, as a report; and the audit entry to write once the file exists. */
export async function buildDepartmentsExport(auth: AuthContext, query: ExportDepartmentsQuery) {
  const { format, ...filters } = query;
  const { items, total } = await listAllMasters(DEPARTMENT_LIST, filters, (count) => assertExportSize(format, count));
  const noun = (count: number) => (count === 1 ? "department" : "departments");

  const report: ReportDefinition = {
    title: "Departments",
    period: null,
    filters: describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "departments",
    tables: [
      {
        name: "Departments",
        columns: COLUMNS,
        rows: (items as unknown as DepartmentItem[]).map(departmentRow),
        notes: total > 0 ? [`${total} ${noun(total)}.`] : [],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "departments.exported",
      module: "SETTINGS",
      entityType: DEPARTMENTS.entityType,
      entityId: null,
      description: `Exported the department list as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${noun(total)}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}
