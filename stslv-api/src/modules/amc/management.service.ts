import { pool } from "../../config/database";
import { schemaHas } from "../../shared/schema-features";
import type { AuthContext } from "../auth/access";
import {
  canViewVisitCounts,
  contractKpis,
  COUNTED_VISIT,
  expiring,
  PAYMENT_UNAVAILABLE,
  type ExpiringRow,
  type OperationsKpis,
} from "../dashboard/operations.service";
import type { ContractStatus } from "./amc.constants";
import { getWorkload } from "./reports.service";
import { amcReference } from "./service-status.service";

// AMC Management: the read-only summary behind the AMC Management page. Every
// figure is an aggregate over the stored contracts, visits and invoices at the
// moment of the request, reusing the definitions the dashboard, the schedule
// and Invoice Tracking already use. Nothing is stored, estimated or written.
// A section the user may not see is null.

/**
 * Expiry warning bands, in days before the end of validity. A contract is in
 * the smallest band whose limit is at or above its days left, so each contract
 * is in one band only: 90 = 61–90 days, 60 = 46–60, 45 = 31–45, 30 = 16–30,
 * 15 = 0–15. Supplied with the AMC Management requirements (reference AMC ERP).
 */
export const EXPIRY_BANDS = [90, 60, 45, 30, 15] as const;
export type ExpiryBand = (typeof EXPIRY_BANDS)[number];

/** The renewal warning: every unrenewed active contract ending within this many days. Never hidden by another band. */
export const RENEWAL_WARNING_DAYS = 45;
/** "Critical": active contracts ending within this many days. */
export const CRITICAL_DAYS = 15;
/** Rows in the Recent AMC Contracts panel. */
const RECENT_LIMIT = 6;

/** The band of a contract with this many days of validity left, or null outside 0–90 days. */
export function expiryBand(daysLeft: number): ExpiryBand | null {
  if (!Number.isInteger(daysLeft) || daysLeft < 0) return null;

  let band: ExpiryBand | null = null;

  for (const limit of EXPIRY_BANDS) {
    if (daysLeft <= limit) band = limit;
  }

  return band;
}

/** A contract is renewed when a renewal of it exists that is not cancelled (the rule of migration 0072's unique index). */
const openRenewal = (alias: string) =>
  `EXISTS (SELECT 1 FROM amc_contracts r WHERE r.renewed_from_id = ${alias}.id AND r.status <> 'CANCELLED')`;

export interface BandCount {
  days: ExpiryBand;
  /** Lowest days left in the band (inclusive). */
  fromDays: number;
  /** Active contracts in the band. */
  count: number;
  /** Of those, the ones with no renewal that is not cancelled (all of them when renewals are not installed). */
  notRenewed: number;
  /** Ids of the unrenewed contracts, ascending: the state the band's alert is read against. */
  notRenewedIds: string[];
}

export interface ExpiryFigures {
  renewalsInstalled: boolean;
  bands: BandCount[];
  /** Unrenewed active contracts ending within RENEWAL_WARNING_DAYS days (0–45, every band below it included). */
  renewalWarning: { days: number; count: number; ids: string[] };
  /** Active contracts ending within CRITICAL_DAYS days, each once, renewed or not. */
  critical: { days: number; count: number; notRenewed: number };
  /**
   * Contracts whose validity has ended (status Expired, or Active with an end
   * date before today) and which have no renewal that is not cancelled. Each
   * contract counts once; a renewed source is left out, its renewal counts on
   * its own dates.
   */
  notRenewedExpired: { count: number; expiredStatus: number; activePastValidity: number };
}

/** Band counts, the renewal warning and the expiry KPIs, in two queries. */
export async function getExpiryFigures(): Promise<ExpiryFigures> {
  const renewals = await schemaHas(["amc_contracts.renewed_from_id"]);
  const renewed = renewals ? openRenewal("c") : "false";
  const maxBand = EXPIRY_BANDS[0];

  const [inWindow, expired] = await Promise.all([
    pool.query<{ id: string; days_left: number; renewed: boolean }>(
      `SELECT c.id, (c.valid_to - current_date)::int AS days_left, ${renewed} AS renewed
       FROM amc_contracts c
       WHERE c.status = 'ACTIVE' AND c.valid_to BETWEEN current_date AND current_date + $1::int
       ORDER BY c.id`,
      [maxBand]
    ),
    pool.query<{ expired_status: number; active_past_validity: number }>(
      `SELECT count(*) FILTER (WHERE c.status = 'EXPIRED')::int AS expired_status,
              count(*) FILTER (WHERE c.status = 'ACTIVE')::int AS active_past_validity
       FROM amc_contracts c
       WHERE (c.status = 'EXPIRED' OR (c.status = 'ACTIVE' AND c.valid_to < current_date))
         AND NOT ${renewed}`
    ),
  ]);

  const rows = inWindow.rows;
  const bands: BandCount[] = EXPIRY_BANDS.map((days, index) => {
    const lower = EXPIRY_BANDS[index + 1];
    const members = rows.filter((row) => expiryBand(row.days_left) === days);
    const notRenewed = members.filter((row) => !row.renewed);

    return {
      days,
      fromDays: lower === undefined ? 0 : lower + 1,
      count: members.length,
      notRenewed: notRenewed.length,
      notRenewedIds: notRenewed.map((row) => row.id),
    };
  });
  const warning = rows.filter((row) => row.days_left <= RENEWAL_WARNING_DAYS && !row.renewed);
  const critical = rows.filter((row) => row.days_left <= CRITICAL_DAYS);
  const expiredRow = expired.rows[0];

  return {
    renewalsInstalled: renewals,
    bands,
    renewalWarning: { days: RENEWAL_WARNING_DAYS, count: warning.length, ids: warning.map((row) => row.id) },
    critical: { days: CRITICAL_DAYS, count: critical.length, notRenewed: critical.filter((row) => !row.renewed).length },
    notRenewedExpired: {
      count: (expiredRow?.expired_status ?? 0) + (expiredRow?.active_past_validity ?? 0),
      expiredStatus: expiredRow?.expired_status ?? 0,
      activePastValidity: expiredRow?.active_past_validity ?? 0,
    },
  };
}

export interface RecentContract {
  id: string;
  /** "AMC-0007", derived from the id (provisional, like Service Status). */
  reference: string;
  client: { id: string; name: string };
  systemDescription: string;
  status: ContractStatus;
  contractValue: string;
  createdAt: string;
}

async function recentContracts(): Promise<{ total: number; items: RecentContract[] }> {
  const [total, rows] = await Promise.all([
    pool.query<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts"),
    pool.query<{
      id: string;
      client_id: string;
      client_name: string;
      system_description: string;
      status: ContractStatus;
      contract_value: string;
      created_at: Date;
    }>(
      `SELECT c.id, cl.id AS client_id, cl.name AS client_name, c.system_description, c.status,
              c.contract_value::text AS contract_value, c.created_at
       FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $1`,
      [RECENT_LIMIT]
    ),
  ]);

  return {
    total: total.rows[0]?.count ?? 0,
    items: rows.rows.map((row) => ({
      id: row.id,
      reference: amcReference(row.id),
      client: { id: row.client_id, name: row.client_name },
      systemDescription: row.system_description,
      status: row.status,
      contractValue: row.contract_value,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export interface ScheduleFigures {
  /** Visits planned this calendar month (the dashboard's Services This Month). Counts only. */
  servicesThisMonth: { planned: number; completed: number; open: number };
  /**
   * Completed visits waiting for an invoice: invoice eligibility
   * READY_FOR_INVOICE (completed, amount above zero, no active invoice), the
   * Invoice Tracking work list. Future visits are never in it. Requires
   * AMC_SCHEDULE:VIEW, because it contains amounts.
   */
  pendingBilling: { count: number; amount: string; amountRequired: number } | null;
  /**
   * Visit amounts of the visits planned this calendar month (same visits as
   * servicesThisMonth). A planned amount: not invoiced, not collected.
   * Requires AMC_SCHEDULE:VIEW.
   */
  currentScheduledValue: { amount: string; visits: number; amountMissing: number } | null;
  /**
   * The schedule engine runs when a contract is saved or its schedule is
   * generated; there is no background job. Active contracts with no dated,
   * uncancelled visit are the ones it has not covered.
   */
  engine: { activeContracts: number; withoutSchedule: number };
}

async function scheduleFigures(canAmounts: boolean): Promise<ScheduleFigures> {
  const [workload, engine, amounts] = await Promise.all([
    getWorkload({ months: 1 }),
    pool.query<{ active: number; without_schedule: number }>(
      `SELECT count(*)::int AS active,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM amc_visits v WHERE v.amc_contract_id = c.id AND v.status NOT IN ('CANCELLED', 'HISTORICAL')
              ))::int AS without_schedule
       FROM amc_contracts c
       WHERE c.status = 'ACTIVE'`
    ),
    canAmounts
      ? pool.query<{
          ready_count: number;
          ready_amount: string;
          amount_required: number;
          month_amount: string;
          month_visits: number;
          month_missing: number;
        }>(
          `WITH month_visits AS (
             SELECT v.visit_amount FROM amc_visits v
             WHERE ${COUNTED_VISIT} AND date_trunc('month', v.scheduled_date) = date_trunc('month', current_date)
           )
           SELECT b.ready_count, b.ready_amount, b.amount_required,
                  m.month_amount, m.month_visits, m.month_missing
           FROM (SELECT count(*) FILTER (WHERE vb.invoice_eligibility = 'READY_FOR_INVOICE')::int AS ready_count,
                        COALESCE(sum(v.visit_amount) FILTER (WHERE vb.invoice_eligibility = 'READY_FOR_INVOICE'), 0)::numeric(16,3)::text AS ready_amount,
                        count(*) FILTER (WHERE vb.invoice_eligibility = 'AMOUNT_REQUIRED')::int AS amount_required
                 FROM amc_visits v JOIN v_amc_visit_billing vb ON vb.amc_visit_id = v.id) b
           CROSS JOIN (SELECT COALESCE(sum(visit_amount), 0)::numeric(16,3)::text AS month_amount,
                              count(*)::int AS month_visits,
                              count(*) FILTER (WHERE visit_amount IS NULL)::int AS month_missing
                       FROM month_visits) m`
        )
      : null,
  ]);
  const month = workload.months[0];
  const money = amounts?.rows[0];

  return {
    servicesThisMonth: { planned: month?.planned ?? 0, completed: month?.completed ?? 0, open: month?.open ?? 0 },
    pendingBilling: money ? { count: money.ready_count, amount: money.ready_amount, amountRequired: money.amount_required } : null,
    currentScheduledValue: money ? { amount: money.month_amount, visits: money.month_visits, amountMissing: money.month_missing } : null,
    engine: { activeContracts: engine.rows[0]?.active ?? 0, withoutSchedule: engine.rows[0]?.without_schedule ?? 0 },
  };
}

export interface InvoiceFigures {
  /** Payment is not recorded (invoices are Issued or Cancelled only): never derived from an invoice number or status. */
  paid: typeof PAYMENT_UNAVAILABLE;
  unpaid: typeof PAYMENT_UNAVAILABLE;
  paidTotal: typeof PAYMENT_UNAVAILABLE;
  /** What Invoice Tracking records today. */
  module: { issued: number; cancelled: number; paymentTracked: false };
}

async function invoiceFigures(): Promise<InvoiceFigures> {
  const result = await pool.query<{ issued: number; cancelled: number }>(
    `SELECT count(*) FILTER (WHERE status <> 'CANCELLED')::int AS issued,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
     FROM invoices`
  );

  return {
    paid: PAYMENT_UNAVAILABLE,
    unpaid: PAYMENT_UNAVAILABLE,
    paidTotal: PAYMENT_UNAVAILABLE,
    module: { issued: result.rows[0]?.issued ?? 0, cancelled: result.rows[0]?.cancelled ?? 0, paymentTracked: false },
  };
}

export interface AmcManagementSummary {
  asOf: string;
  timeZone: string;
  /** Group A. Requires AMC_CONTRACTS:VIEW (the endpoint's own permission). */
  contracts: NonNullable<OperationsKpis["contracts"]>;
  /** Group B. Requires AMC_SCHEDULE:VIEW or AMC_EXECUTION:VIEW; amounts need AMC_SCHEDULE:VIEW. */
  schedule: ScheduleFigures | null;
  /** Group C. Requires INVOICES:VIEW. */
  invoices: InvoiceFigures | null;
  expiry: ExpiryFigures & {
    /** Active contracts ending within 90 days or already past validity, soonest first (the dashboard's list), with their band. */
    list: { days: number; total: number; pastValidity: number; items: (ExpiringRow & { reference: string; band: ExpiryBand | null })[] };
  };
  recentContracts: { total: number; items: RecentContract[] };
}

/** The AMC Management summary. The caller has AMC_CONTRACTS:VIEW. */
export async function getAmcManagementSummary(auth: AuthContext): Promise<AmcManagementSummary> {
  const canVisits = canViewVisitCounts(auth);
  const canAmounts = auth.permissions.has("AMC_SCHEDULE:VIEW");
  const canInvoices = auth.permissions.has("INVOICES:VIEW");
  const renewals = await schemaHas(["amc_contracts.renewed_from_id"]);

  const [clock, contracts, schedule, invoices, expiry, list, recent] = await Promise.all([
    pool.query<{ today: string; time_zone: string }>("SELECT current_date::text AS today, current_setting('TimeZone') AS time_zone"),
    contractKpis(renewals),
    canVisits ? scheduleFigures(canAmounts) : null,
    canInvoices ? invoiceFigures() : null,
    getExpiryFigures(),
    expiring(renewals),
    recentContracts(),
  ]);

  return {
    asOf: clock.rows[0]?.today ?? "",
    timeZone: clock.rows[0]?.time_zone ?? "",
    contracts,
    schedule,
    invoices,
    expiry: {
      ...expiry,
      list: {
        days: list.days,
        total: list.total,
        pastValidity: list.pastValidity,
        items: list.items.map((row) => ({ ...row, reference: amcReference(row.id), band: expiryBand(row.daysLeft) })),
      },
    },
    recentContracts: recent,
  };
}
