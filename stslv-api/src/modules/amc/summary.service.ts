import { pool } from "../../config/database";
import type { AuthContext } from "../auth/access";

// AMC figures for the dashboard and reports. Every number is a query over
// amc_contracts and amc_visits at the moment of the request; nothing is stored
// or estimated. Sections the user has no permission for are returned as null.

export interface AmcSummary {
  /** The database's current date, which "due", "overdue" and "upcoming" are measured against. */
  asOf: string;
  /** Requires AMC_CONTRACTS:VIEW. */
  contracts: {
    active: number;
    /** Active contracts whose validity period has ended. */
    activePastValidity: number;
    draft: number;
    expired: number;
    cancelled: number;
  } | null;
  /** Requires AMC_SCHEDULE:VIEW or AMC_EXECUTION:VIEW. */
  visits: {
    /** Outstanding visits planned for today or earlier. */
    due: number;
    /** Scheduled or postponed visits whose planned date has passed. */
    overdue: number;
    /** Outstanding visits planned after today, within upcomingDays. */
    upcoming: number;
    upcomingDays: number;
    /** Visits planned in the current calendar month, cancelled visits excluded. */
    dueThisMonth: number;
    inProgress: number;
    postponed: number;
    /** Completed visits with a completion date in the current calendar month. */
    completedThisMonth: number;
    completedTotal: number;
  } | null;
  /** Requires AMC_SCHEDULE:VIEW, because it contains amounts. */
  invoicing: {
    /** Completed visits with an amount above zero. */
    readyForInvoice: { count: number; amount: string };
    /** Completed visits with no amount set: they need an amount before they can be invoiced. */
    amountRequired: { count: number };
    /** Completed visits with an amount of zero: nothing to invoice. */
    noInvoiceRequired: { count: number };
  } | null;
}

export function canViewSummary(auth: AuthContext): boolean {
  return (
    auth.permissions.has("AMC_CONTRACTS:VIEW") ||
    auth.permissions.has("AMC_SCHEDULE:VIEW") ||
    auth.permissions.has("AMC_EXECUTION:VIEW")
  );
}

export async function getAmcSummary(auth: AuthContext, upcomingDays: number): Promise<AmcSummary> {
  const canContracts = auth.permissions.has("AMC_CONTRACTS:VIEW");
  const canAmounts = auth.permissions.has("AMC_SCHEDULE:VIEW");
  const canVisits = canAmounts || auth.permissions.has("AMC_EXECUTION:VIEW");

  const today = await pool.query<{ today: string }>("SELECT current_date::text AS today");
  const summary: AmcSummary = {
    asOf: today.rows[0]?.today ?? "",
    contracts: null,
    visits: null,
    invoicing: null,
  };

  if (canContracts) {
    const result = await pool.query<{
      active: number;
      active_past_validity: number;
      draft: number;
      expired: number;
      cancelled: number;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
              count(*) FILTER (WHERE status = 'ACTIVE' AND valid_to < current_date)::int AS active_past_validity,
              count(*) FILTER (WHERE status = 'DRAFT')::int AS draft,
              count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
              count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled
       FROM amc_contracts`
    );
    const row = result.rows[0];

    summary.contracts = {
      active: row?.active ?? 0,
      activePastValidity: row?.active_past_validity ?? 0,
      draft: row?.draft ?? 0,
      expired: row?.expired ?? 0,
      cancelled: row?.cancelled ?? 0,
    };
  }

  if (canVisits) {
    // "Outstanding" matches the execution work list: not completed, not
    // cancelled, and the contract itself has not been cancelled.
    const result = await pool.query<{
      due: number;
      overdue: number;
      upcoming: number;
      due_this_month: number;
      in_progress: number;
      postponed: number;
      completed_this_month: number;
      completed_total: number;
    }>(
      `WITH visits AS (
         SELECT v.status, v.scheduled_date, v.completed_date,
                (v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED') AND c.status <> 'CANCELLED') AS outstanding
         FROM amc_visits v
         JOIN amc_contracts c ON c.id = v.amc_contract_id
       )
       SELECT count(*) FILTER (WHERE outstanding AND scheduled_date <= current_date)::int AS due,
              count(*) FILTER (WHERE outstanding AND status IN ('SCHEDULED', 'POSTPONED') AND scheduled_date < current_date)::int AS overdue,
              count(*) FILTER (WHERE outstanding AND scheduled_date > current_date AND scheduled_date <= current_date + $1::int)::int AS upcoming,
              count(*) FILTER (WHERE status <> 'CANCELLED' AND date_trunc('month', scheduled_date) = date_trunc('month', current_date))::int AS due_this_month,
              count(*) FILTER (WHERE outstanding AND status = 'IN_PROGRESS')::int AS in_progress,
              count(*) FILTER (WHERE outstanding AND status = 'POSTPONED')::int AS postponed,
              count(*) FILTER (WHERE status = 'COMPLETED' AND date_trunc('month', completed_date) = date_trunc('month', current_date))::int AS completed_this_month,
              count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed_total
       FROM visits`,
      [upcomingDays]
    );
    const row = result.rows[0];

    summary.visits = {
      due: row?.due ?? 0,
      overdue: row?.overdue ?? 0,
      upcoming: row?.upcoming ?? 0,
      upcomingDays,
      dueThisMonth: row?.due_this_month ?? 0,
      inProgress: row?.in_progress ?? 0,
      postponed: row?.postponed ?? 0,
      completedThisMonth: row?.completed_this_month ?? 0,
      completedTotal: row?.completed_total ?? 0,
    };
  }

  if (canAmounts) {
    const result = await pool.query<{
      ready_count: number;
      ready_amount: string;
      amount_required_count: number;
      no_invoice_count: number;
    }>(
      `SELECT count(*) FILTER (WHERE b.invoice_eligibility = 'READY_FOR_INVOICE')::int AS ready_count,
              COALESCE(sum(v.visit_amount) FILTER (WHERE b.invoice_eligibility = 'READY_FOR_INVOICE'), 0)::numeric(16,3) AS ready_amount,
              count(*) FILTER (WHERE b.invoice_eligibility = 'AMOUNT_REQUIRED')::int AS amount_required_count,
              count(*) FILTER (WHERE b.invoice_eligibility = 'NO_INVOICE_REQUIRED')::int AS no_invoice_count
       FROM amc_visits v
       JOIN v_amc_visit_billing b ON b.amc_visit_id = v.id`
    );
    const row = result.rows[0];

    summary.invoicing = {
      readyForInvoice: { count: row?.ready_count ?? 0, amount: row?.ready_amount ?? "0.000" },
      amountRequired: { count: row?.amount_required_count ?? 0 },
      noInvoiceRequired: { count: row?.no_invoice_count ?? 0 },
    };
  }

  return summary;
}
