import { pool } from "../../config/database";
import { CONTRACT_STATUSES, type ContractStatus, type VisitStatus } from "../amc/amc.constants";
import { getWorkload, type WorkloadMonth } from "../amc/reports.service";
import type { AuthContext } from "../auth/access";
import { schemaHas } from "../../shared/schema-features";

// The AMC Operations Dashboard. Every figure is an aggregate query over the
// stored contracts, visits and invoices at the moment of the request; nothing
// is stored, estimated or annualised. A section the user may not see is null.
//
// "Today" and "this month" are the database's current date (current_date), the
// same date every other STSLV module measures due, overdue and expiry against,
// so the dashboard never disagrees with the schedule or the reports. The time
// zone in use is returned with the figures.

/** Window of the "expiring soon" KPI, in calendar days from today. Matches the reference dashboard's label. */
export const EXPIRING_KPI_DAYS = 45;
/** Window of the Expiring Contracts widget. */
export const EXPIRING_LIST_DAYS = 90;
/** Months shown by the workload and payment charts. */
export const CHART_MONTHS = 6;
/** Rows listed in the widgets; the totals are always given beside them. */
const LIST_LIMIT = 10;

/**
 * Payment is not recorded anywhere in STSLV AMC: an invoice is ISSUED or
 * CANCELLED (migration 0060), with no paid date or paid amount. Payment
 * figures are therefore reported as unavailable, never derived from an
 * invoice number or an invoice status.
 */
export const PAYMENT_UNAVAILABLE = {
  available: false as const,
  reason: "Payment is not recorded in STSLV AMC. Invoices are tracked as Issued or Cancelled only, with no paid date or paid amount.",
};

export interface OperationsKpis {
  /** Requires AMC_CONTRACTS:VIEW. */
  contracts: {
    active: number;
    /** Active contracts whose validity has already ended (still marked Active by a user). */
    activePastValidity: number;
    /** Sum of contract_value over active contracts. Not annualised. */
    activeValue: string;
    /** Sum of final_credit, as entered, over active contracts. Meaning unconfirmed (Q1). */
    finalCreditTotal: string;
    /** Active contracts that have a final credit figure. */
    finalCreditRecorded: number;
    /** Active contracts whose validity ends today or within EXPIRING_KPI_DAYS days. Each contract once. */
    expiringSoon: number;
    expiringSoonDays: number;
    /** Of expiringSoon, how many already have a renewal that is not cancelled; null when renewals are not installed (0072). */
    expiringSoonWithRenewal: number | null;
  } | null;
  /** Requires AMC_SCHEDULE:VIEW or AMC_EXECUTION:VIEW. Counts only. */
  services: {
    /** Visits planned this calendar month: not cancelled, not historical, on a contract that is not cancelled. */
    thisMonth: number;
    completedThisMonth: number;
    openThisMonth: number;
  } | null;
  /** Requires INVOICES:VIEW. Always unavailable today (see PAYMENT_UNAVAILABLE). */
  unpaidInvoices: typeof PAYMENT_UNAVAILABLE | null;
  paidThisMonth: typeof PAYMENT_UNAVAILABLE | null;
}

export interface PortfolioStatus {
  status: ContractStatus;
  count: number;
  /** One decimal, as text; null when there are no contracts at all. */
  percent: string | null;
}

export interface ExpiringRow {
  id: string;
  client: { id: string; name: string };
  systemDescription: string;
  validTo: string;
  /** Negative once validity has ended. */
  daysLeft: number;
  /** The renewal that is not cancelled, if any; null when there is none or renewals are not installed. */
  renewal: { id: string; status: ContractStatus } | null;
}

export interface ScheduleItem {
  id: string;
  contractId: string;
  client: { id: string; name: string };
  systemDescription: string;
  scheduledDate: string;
  /** The person assigned to the visit, else the contract's responsible engineer. */
  assignedTo: string | null;
  status: VisitStatus;
  isOverdue: boolean;
}

export interface OperationsDashboard {
  asOf: string;
  timeZone: string;
  kpis: OperationsKpis;
  /** Requires AMC_CONTRACTS:VIEW. */
  portfolio: { total: number; statuses: PortfolioStatus[] } | null;
  /** Requires AMC_CONTRACTS:VIEW. */
  expiring: { days: number; total: number; pastValidity: number; items: ExpiringRow[]; renewalsInstalled: boolean } | null;
  /** Requires AMC_SCHEDULE:VIEW or AMC_EXECUTION:VIEW. */
  workload: { months: WorkloadMonth[] } | null;
  /** Requires AMC_SCHEDULE:VIEW or AMC_EXECUTION:VIEW. */
  schedule: { today: ScheduleItem[]; todayTotal: number; upcoming: ScheduleItem[]; upcomingTotal: number; upcomingDays: number } | null;
  /** Requires INVOICES:VIEW. */
  payments: typeof PAYMENT_UNAVAILABLE | null;
}

export const canViewVisitCounts = (auth: AuthContext) =>
  auth.permissions.has("AMC_SCHEDULE:VIEW") || auth.permissions.has("AMC_EXECUTION:VIEW");

/** A share of a whole as a percentage with one decimal, rounded half up. Null when there is no whole. */
export function percentOf(count: number, total: number): string | null {
  if (total === 0) return null;
  // Whole numbers only (tenths of a percent), so no floating-point rounding can creep in.
  const tenths = Math.floor((count * 2000 + total) / (2 * total));

  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

async function contractKpis(renewals: boolean): Promise<NonNullable<OperationsKpis["contracts"]>> {
  const renewalCount = renewals
    ? `count(*) FILTER (WHERE c.valid_to BETWEEN current_date AND current_date + $1::int
         AND EXISTS (SELECT 1 FROM amc_contracts r WHERE r.renewed_from_id = c.id AND r.status <> 'CANCELLED'))::int`
    : "NULL::int";
  const result = await pool.query<{
    active: number;
    active_past_validity: number;
    active_value: string;
    final_credit_total: string;
    final_credit_recorded: number;
    expiring_soon: number;
    expiring_soon_with_renewal: number | null;
  }>(
    `SELECT count(*)::int AS active,
            count(*) FILTER (WHERE c.valid_to < current_date)::int AS active_past_validity,
            COALESCE(sum(c.contract_value), 0)::numeric(16,3)::text AS active_value,
            COALESCE(sum(c.final_credit), 0)::numeric(16,3)::text AS final_credit_total,
            count(c.final_credit)::int AS final_credit_recorded,
            count(*) FILTER (WHERE c.valid_to BETWEEN current_date AND current_date + $1::int)::int AS expiring_soon,
            ${renewalCount} AS expiring_soon_with_renewal
     FROM amc_contracts c
     WHERE c.status = 'ACTIVE'`,
    [EXPIRING_KPI_DAYS]
  );
  const row = result.rows[0];

  return {
    active: row?.active ?? 0,
    activePastValidity: row?.active_past_validity ?? 0,
    activeValue: row?.active_value ?? "0.000",
    finalCreditTotal: row?.final_credit_total ?? "0.000",
    finalCreditRecorded: row?.final_credit_recorded ?? 0,
    expiringSoon: row?.expiring_soon ?? 0,
    expiringSoonDays: EXPIRING_KPI_DAYS,
    expiringSoonWithRenewal: row?.expiring_soon_with_renewal ?? null,
  };
}

async function portfolio(): Promise<NonNullable<OperationsDashboard["portfolio"]>> {
  const result = await pool.query<{ status: ContractStatus; count: number }>(
    "SELECT status, count(*)::int AS count FROM amc_contracts GROUP BY status"
  );
  const counts = new Map(result.rows.map((row) => [row.status, row.count]));
  const total = result.rows.reduce((sum, row) => sum + row.count, 0);

  return {
    total,
    // Every status STSLV supports, in workflow order, including those with no contract.
    statuses: CONTRACT_STATUSES.map((status) => {
      const count = counts.get(status) ?? 0;

      return { status, count, percent: percentOf(count, total) };
    }),
  };
}

async function expiring(renewals: boolean): Promise<NonNullable<OperationsDashboard["expiring"]>> {
  // Same contract dates as the KPI, a wider window. Active contracts already past
  // validity are listed first: they are the most urgent and are still marked Active.
  const window = "c.status = 'ACTIVE' AND c.valid_to <= current_date + $1::int";
  const renewalSelect = renewals
    ? `(SELECT json_build_object('id', r.id::text, 'status', r.status) FROM amc_contracts r
        WHERE r.renewed_from_id = c.id AND r.status <> 'CANCELLED' ORDER BY r.id LIMIT 1)`
    : "NULL::json";
  const [totals, rows] = await Promise.all([
    pool.query<{ total: number; past: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE c.valid_to < current_date)::int AS past
       FROM amc_contracts c WHERE ${window}`,
      [EXPIRING_LIST_DAYS]
    ),
    pool.query<{
      id: string;
      client_id: string;
      client_name: string;
      system_description: string;
      valid_to: string;
      days_left: number;
      renewal: { id: string; status: ContractStatus } | null;
    }>(
      `SELECT c.id, cl.id AS client_id, cl.name AS client_name, c.system_description,
              c.valid_to::text AS valid_to, (c.valid_to - current_date)::int AS days_left,
              ${renewalSelect} AS renewal
       FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
       WHERE ${window}
       ORDER BY c.valid_to, lower(cl.name), c.id
       LIMIT $2`,
      [EXPIRING_LIST_DAYS, LIST_LIMIT]
    ),
  ]);

  return {
    days: EXPIRING_LIST_DAYS,
    total: totals.rows[0]?.total ?? 0,
    pastValidity: totals.rows[0]?.past ?? 0,
    renewalsInstalled: renewals,
    items: rows.rows.map((row) => ({
      id: row.id,
      client: { id: row.client_id, name: row.client_name },
      systemDescription: row.system_description,
      validTo: row.valid_to,
      daysLeft: row.days_left,
      renewal: row.renewal,
    })),
  };
}

// The visits the dashboard counts: dated (not historical), not cancelled, on a contract that is not cancelled.
// The same rule as the workload report, so "Services This Month" equals the workload chart's first bar.
const COUNTED_VISIT = `v.status NOT IN ('CANCELLED', 'HISTORICAL')
  AND EXISTS (SELECT 1 FROM amc_contracts cc WHERE cc.id = v.amc_contract_id AND cc.status <> 'CANCELLED')`;

const UPCOMING_DAYS = 7;

async function schedule(): Promise<NonNullable<OperationsDashboard["schedule"]>> {
  const select = `
    SELECT v.id, v.amc_contract_id, cl.id AS client_id, cl.name AS client_name, c.system_description,
           v.scheduled_date::text AS scheduled_date, COALESCE(v.assigned_to, c.responsible_engineer) AS assigned_to, v.status,
           (v.status IN ('SCHEDULED', 'POSTPONED') AND v.scheduled_date < current_date) AS is_overdue
    FROM amc_visits v
    JOIN amc_contracts c ON c.id = v.amc_contract_id
    JOIN clients cl ON cl.id = c.client_id`;
  type Row = {
    id: string;
    amc_contract_id: string;
    client_id: string;
    client_name: string;
    system_description: string;
    scheduled_date: string;
    assigned_to: string | null;
    status: VisitStatus;
    is_overdue: boolean;
  };
  // Upcoming work is outstanding work only; today's list also shows what was already completed today.
  const todayWhere = `${COUNTED_VISIT} AND v.scheduled_date = current_date`;
  const upcomingWhere = `${COUNTED_VISIT} AND v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED')
    AND v.scheduled_date > current_date AND v.scheduled_date <= current_date + $1::int`;
  const [today, upcoming, totals] = await Promise.all([
    pool.query<Row>(`${select} WHERE ${todayWhere} ORDER BY lower(cl.name), v.id LIMIT $1`, [LIST_LIMIT]),
    pool.query<Row>(`${select} WHERE ${upcomingWhere} ORDER BY v.scheduled_date, lower(cl.name), v.id LIMIT $2`, [
      UPCOMING_DAYS,
      LIST_LIMIT,
    ]),
    pool.query<{ today: number; upcoming: number }>(
      `SELECT count(*) FILTER (WHERE ${todayWhere})::int AS today,
              count(*) FILTER (WHERE ${upcomingWhere})::int AS upcoming
       FROM amc_visits v`,
      [UPCOMING_DAYS]
    ),
  ]);
  const toItem = (row: Row): ScheduleItem => ({
    id: row.id,
    contractId: row.amc_contract_id,
    client: { id: row.client_id, name: row.client_name },
    systemDescription: row.system_description,
    scheduledDate: row.scheduled_date,
    assignedTo: row.assigned_to,
    status: row.status,
    isOverdue: row.is_overdue,
  });

  return {
    today: today.rows.map(toItem),
    todayTotal: totals.rows[0]?.today ?? 0,
    upcoming: upcoming.rows.map(toItem),
    upcomingTotal: totals.rows[0]?.upcoming ?? 0,
    upcomingDays: UPCOMING_DAYS,
  };
}

export async function getOperationsDashboard(auth: AuthContext): Promise<OperationsDashboard> {
  const canContracts = auth.permissions.has("AMC_CONTRACTS:VIEW");
  const canVisits = canViewVisitCounts(auth);
  const canInvoices = auth.permissions.has("INVOICES:VIEW");
  const renewals = canContracts ? await schemaHas(["amc_contracts.renewed_from_id"]) : false;

  const [clock, contracts, statusBreakdown, expiringList, workload, todayWork] = await Promise.all([
    pool.query<{ today: string; time_zone: string }>("SELECT current_date::text AS today, current_setting('TimeZone') AS time_zone"),
    canContracts ? contractKpis(renewals) : null,
    canContracts ? portfolio() : null,
    canContracts ? expiring(renewals) : null,
    canVisits ? getWorkload({ months: CHART_MONTHS }) : null,
    canVisits ? schedule() : null,
  ]);
  const thisMonth = workload?.months[0];

  return {
    asOf: clock.rows[0]?.today ?? "",
    timeZone: clock.rows[0]?.time_zone ?? "",
    kpis: {
      contracts,
      services: thisMonth ? { thisMonth: thisMonth.planned, completedThisMonth: thisMonth.completed, openThisMonth: thisMonth.open } : null,
      unpaidInvoices: canInvoices ? PAYMENT_UNAVAILABLE : null,
      paidThisMonth: canInvoices ? PAYMENT_UNAVAILABLE : null,
    },
    portfolio: statusBreakdown,
    expiring: expiringList,
    workload,
    schedule: todayWork,
    payments: canInvoices ? PAYMENT_UNAVAILABLE : null,
  };
}

export interface CalendarDay {
  date: string;
  /** Counted visits planned that day (same rule as Services This Month). */
  total: number;
  completed: number;
  open: number;
  overdue: number;
}

/** Visits per day of one month, for the dashboard's mini calendar. Days without visits are left out. */
export async function getCalendarMonth(month: string): Promise<{ month: string; days: CalendarDay[] }> {
  const result = await pool.query<CalendarDay>(
    `SELECT v.scheduled_date::text AS date,
            count(*)::int AS total,
            count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED'))::int AS open,
            count(*) FILTER (WHERE v.status IN ('SCHEDULED', 'POSTPONED') AND v.scheduled_date < current_date)::int AS overdue
     FROM amc_visits v
     WHERE ${COUNTED_VISIT}
       AND v.scheduled_date >= to_date($1, 'YYYY-MM')
       AND v.scheduled_date < to_date($1, 'YYYY-MM') + interval '1 month'
     GROUP BY v.scheduled_date
     ORDER BY v.scheduled_date`,
    [month]
  );

  return { month, days: result.rows };
}
