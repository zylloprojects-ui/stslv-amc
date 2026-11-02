import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { assertExportSize, type ReportColumn, type ReportDefinition, type ReportRow } from "../../shared/export/report";
import type { PermissionKey } from "../../shared/permissions";
import type { AuthContext } from "../auth/access";
import type { ExportSalesEngineersQuery } from "./masters.schemas";
import { getMaster, listAllMasters, SALES_ENGINEERS } from "./masters.service";

// Engineer 360, the engineer list export and the accounts an engineer may be
// linked to. Every figure is counted by PostgreSQL from the contracts linked
// to the engineer (amc_contracts.sales_engineer_id) on each request. Contracts
// that only carry the engineer's name as typed text are not linked, so they
// are not counted. Nothing is estimated: there is no performance, commission
// or revenue figure, because the system records none.

/** The status words shown for the stored active flag. Archived needs a migration (not built). */
export const ENGINEER_STATUS_LABELS = { active: "Active", inactive: "Disabled" } as const;

const UPCOMING_LIMIT = 10;
// Visits still to be done: the statuses the schedule counts as open.
const OPEN_VISIT = "v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED')";

export interface EngineerContractFigures {
  total: number;
  active: number;
  draft: number;
  expired: number;
  cancelled: number;
  /** Sum of contract_value over active contracts: the dashboard's rule. Not annualised. */
  activeValue: string;
}

export interface EngineerVisitFigures {
  /** Open visits dated today or later. */
  upcoming: number;
  /** Open visits dated before today. */
  overdue: number;
  nextVisitDate: string | null;
}

export interface EngineerUpcomingVisit {
  id: string;
  scheduledDate: string;
  sequenceNo: number;
  status: string;
  assignedTo: string | null;
  contract: { id: string; systemDescription: string; clientName: string };
}

export interface EngineerSummary {
  asOf: string;
  /** Null when the viewer's role cannot see AMC contracts. */
  contracts: EngineerContractFigures | null;
  /** Null when the viewer's role cannot see the AMC schedule. */
  visits: EngineerVisitFigures | null;
  upcoming: { total: number; items: EngineerUpcomingVisit[] } | null;
}

const can = (auth: AuthContext, key: PermissionKey) => auth.permissions.has(key);

async function contractFigures(engineerId: string): Promise<EngineerContractFigures> {
  const result = await pool.query<{ total: number; active: number; draft: number; expired: number; cancelled: number; active_value: string }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
            count(*) FILTER (WHERE status = 'DRAFT')::int AS draft,
            count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            COALESCE(sum(contract_value) FILTER (WHERE status = 'ACTIVE'), 0)::numeric(16,3)::text AS active_value
     FROM amc_contracts WHERE sales_engineer_id = $1`,
    [engineerId]
  );
  const row = result.rows[0];

  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    draft: row?.draft ?? 0,
    expired: row?.expired ?? 0,
    cancelled: row?.cancelled ?? 0,
    activeValue: row?.active_value ?? "0.000",
  };
}

async function visitFigures(engineerId: string): Promise<EngineerVisitFigures> {
  const result = await pool.query<{ upcoming: number; overdue: number; next_visit: string | null }>(
    `SELECT count(*) FILTER (WHERE ${OPEN_VISIT} AND v.scheduled_date >= current_date)::int AS upcoming,
            count(*) FILTER (WHERE ${OPEN_VISIT} AND v.scheduled_date < current_date)::int AS overdue,
            (min(v.scheduled_date) FILTER (WHERE ${OPEN_VISIT} AND v.scheduled_date >= current_date))::text AS next_visit
     FROM amc_visits v
     JOIN amc_contracts c ON c.id = v.amc_contract_id
     WHERE c.sales_engineer_id = $1`,
    [engineerId]
  );
  const row = result.rows[0];

  return { upcoming: row?.upcoming ?? 0, overdue: row?.overdue ?? 0, nextVisitDate: row?.next_visit ?? null };
}

/** The next open visits from today on the engineer's contracts, soonest first. */
async function upcomingVisits(engineerId: string, total: number) {
  const rows = await pool.query<{
    id: string;
    scheduled_date: string;
    sequence_no: number;
    status: string;
    assigned_to: string | null;
    contract_id: string;
    system_description: string;
    client_name: string;
  }>(
    `SELECT v.id, v.scheduled_date::text AS scheduled_date, v.sequence_no, v.status, v.assigned_to,
            c.id AS contract_id, c.system_description, cl.name AS client_name
     FROM amc_visits v
     JOIN amc_contracts c ON c.id = v.amc_contract_id
     JOIN clients cl ON cl.id = c.client_id
     WHERE c.sales_engineer_id = $1 AND ${OPEN_VISIT} AND v.scheduled_date >= current_date
     ORDER BY v.scheduled_date, v.id
     LIMIT $2`,
    [engineerId, UPCOMING_LIMIT]
  );

  return {
    total,
    items: rows.rows.map((row) => ({
      id: row.id,
      scheduledDate: row.scheduled_date,
      sequenceNo: row.sequence_no,
      status: row.status,
      assignedTo: row.assigned_to,
      contract: { id: row.contract_id, systemDescription: row.system_description, clientName: row.client_name },
    })),
  };
}

export async function getEngineerSummary(auth: AuthContext, id: string): Promise<EngineerSummary> {
  // Refuses an unknown engineer before anything is counted.
  await getMaster(SALES_ENGINEERS, id);

  const viewSchedule = can(auth, "AMC_SCHEDULE:VIEW");
  const [today, contracts, visits] = await Promise.all([
    pool.query<{ today: string }>("SELECT current_date::text AS today"),
    can(auth, "AMC_CONTRACTS:VIEW") ? contractFigures(id) : null,
    viewSchedule ? visitFigures(id) : null,
  ]);

  return {
    asOf: today.rows[0]?.today ?? "",
    contracts,
    visits,
    upcoming: visits ? await upcomingVisits(id, visits.upcoming) : null,
  };
}

/**
 * The accounts an engineer may be linked to: active and approved, and not
 * already linked to another engineer. The engineer being edited keeps their
 * own account in the list. No account is created here.
 */
export async function engineerUserOptions(engineerId: string | undefined) {
  const rows = await pool.query<{ id: string; full_name: string; email: string }>(
    `SELECT u.id, u.full_name, u.email
     FROM users u
     WHERE u.is_active AND u.approval_status = 'APPROVED'
       AND NOT EXISTS (SELECT 1 FROM sales_engineers e WHERE e.user_id = u.id AND e.id IS DISTINCT FROM $1::bigint)
     ORDER BY lower(u.full_name), u.id`,
    [engineerId ?? null]
  );

  return rows.rows.map((row) => ({ id: row.id, fullName: row.full_name, email: row.email }));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const COLUMNS: ReportColumn[] = [
  { key: "code", header: "Engineer code", kind: "identifier", width: 13 },
  { key: "name", header: "Engineer name", kind: "text", width: 26, wrap: true },
  { key: "employeeNo", header: "Employee no.", kind: "identifier", width: 14 },
  { key: "department", header: "Department", kind: "text", width: 20, wrap: true },
  { key: "email", header: "Email", kind: "text", width: 28, wrap: true },
  { key: "phone", header: "Phone", kind: "identifier", width: 16 },
  { key: "user", header: "User account", kind: "text", width: 22, wrap: true },
  { key: "activeContracts", header: "Active contracts", kind: "count", width: 10 },
  { key: "status", header: "Status", kind: "text", width: 10 },
  { key: "contracts", header: "All contracts", kind: "count", width: 10, excelOnly: true },
  { key: "notes", header: "Notes", kind: "text", width: 36, wrap: true, excelOnly: true },
  { key: "createdAt", header: "Added", kind: "date", width: 13, excelOnly: true },
];

interface EngineerItem {
  code: string;
  name: string;
  employeeNo: string | null;
  email: string | null;
  phone: string | null;
  department: { code: string; name: string } | null;
  user: { fullName: string; email: string } | null;
  notes: string | null;
  contractCount: number;
  activeContractCount: number;
  isActive: boolean;
  createdAt: string;
}

function engineerRow(item: EngineerItem): ReportRow {
  return {
    code: item.code,
    name: item.name,
    employeeNo: item.employeeNo,
    department: item.department ? `${item.department.code} — ${item.department.name}` : null,
    email: item.email,
    phone: item.phone,
    user: item.user ? item.user.fullName : "Not linked",
    activeContracts: item.activeContractCount,
    status: ENGINEER_STATUS_LABELS[item.isActive ? "active" : "inactive"],
    contracts: item.contractCount,
    notes: item.notes,
    createdAt: item.createdAt.slice(0, 10),
  };
}

async function describeFilters(query: ExportSalesEngineersQuery): Promise<ReportDefinition["filters"]> {
  const filters: ReportDefinition["filters"] = [
    { label: "Status", value: query.status === "all" ? "All" : ENGINEER_STATUS_LABELS[query.status] },
  ];

  if (query.departmentId === "none") {
    filters.push({ label: "Department", value: "No department" });
  } else if (query.departmentId) {
    const department = await pool.query<{ label: string }>("SELECT code || ' — ' || name AS label FROM departments WHERE id = $1", [query.departmentId]);
    filters.push({ label: "Department", value: department.rows[0]?.label ?? "Unknown department" });
  }
  if (query.search) {
    filters.push({ label: "Search", value: query.search });
  }

  return filters;
}

export async function buildSalesEngineersExport(auth: AuthContext, query: ExportSalesEngineersQuery) {
  const { format, ...filters } = query;
  const { items, total } = await listAllMasters(SALES_ENGINEERS, filters, (count) => assertExportSize(format, count));
  const noun = total === 1 ? "sales engineer" : "sales engineers";

  const report: ReportDefinition = {
    title: "Sales Engineers",
    period: null,
    filters: await describeFilters(query),
    generatedAt: new Date(),
    generatedBy: auth.user.fullName,
    orientation: "landscape",
    fileStem: "sales-engineers",
    tables: [
      {
        name: "Sales Engineers",
        columns: COLUMNS,
        rows: (items as unknown as EngineerItem[]).map(engineerRow),
        // An empty export already says so in the table; a count of zero would only repeat it.
        notes: total > 0 ? [`${total} ${noun}. Contract counts include only contracts linked to the engineer in the master list.`] : [],
      },
    ],
  };

  const recordExport = () =>
    logActivity(pool, {
      userId: auth.user.id,
      action: "sales_engineers.exported",
      module: SALES_ENGINEERS.module,
      entityType: "sales_engineers",
      entityId: null,
      description: `Exported the sales engineer list as ${format === "xlsx" ? "Excel" : "PDF"} (${total} ${noun}).`,
      metadata: { format, filters, rowCount: total },
    });

  return { report, recordExport };
}
