import { pool } from "../../config/database";
import type { PermissionKey } from "../../shared/permissions";
import type { AuthContext } from "../auth/access";
import { getClient } from "./clients.service";

// Client 360: one client's figures, computed by PostgreSQL from the records
// that reference the client on every request. Nothing is stored, estimated or
// filled in. A section the viewer's role cannot see is null, so the page can
// say so instead of showing a zero.

/** Active contracts whose validity ends within this many days are listed for renewal. The AMC expiry report's default window. */
export const RENEWAL_WINDOW_DAYS = 90;
const RENEWAL_LIMIT = 10;

export interface ClientContractFigures {
  total: number;
  active: number;
  draft: number;
  expired: number;
  cancelled: number;
  /** Sum of contract_value over active contracts: the dashboard's rule. Not annualised. */
  activeValue: string;
  /** Sum of contract_value over every contract that is not cancelled (draft, active and expired). */
  nonCancelledValue: string;
  /** Sum of final_credit, as entered, over active contracts. Meaning unconfirmed (Q1). */
  finalCreditTotal: string;
  /** How many active contracts have a final credit entered. */
  finalCreditRecorded: number;
}

export interface ClientRenewal {
  id: string;
  systemDescription: string;
  validFrom: string;
  validTo: string;
  /** Calendar days from the database's current date; negative once validity has ended. */
  daysLeft: number;
  contractValue: string;
}

export interface ClientVisitFigures {
  /** Scheduled, in progress or postponed, dated today or later. */
  upcoming: number;
  /** Scheduled, in progress or postponed, dated before today. */
  overdue: number;
  completed: number;
  /** Completed with an amount and not covered by an active invoice. */
  readyForInvoice: number;
  /** The scheduled date of the next open visit from today, or null. */
  nextVisitDate: string | null;
}

export interface ClientInvoiceFigures {
  issued: number;
  cancelled: number;
  /** Sums over issued invoices; cancelled invoices are left out. */
  issuedExclVat: string;
  issuedTotal: string;
  lastInvoiceDate: string | null;
}

export interface ClientSummary {
  asOf: string;
  contracts: ClientContractFigures | null;
  renewals: { windowDays: number; total: number; items: ClientRenewal[] } | null;
  visits: ClientVisitFigures | null;
  invoices: ClientInvoiceFigures | null;
  /** Payments are not recorded in this system, so paid and unpaid cannot be told apart. */
  paymentTracking: false;
}

const can = (auth: AuthContext, key: PermissionKey) => auth.permissions.has(key);

async function contractFigures(clientId: string): Promise<ClientContractFigures> {
  const result = await pool.query<{
    total: number;
    active: number;
    draft: number;
    expired: number;
    cancelled: number;
    active_value: string;
    non_cancelled_value: string;
    final_credit_total: string;
    final_credit_recorded: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
            count(*) FILTER (WHERE status = 'DRAFT')::int AS draft,
            count(*) FILTER (WHERE status = 'EXPIRED')::int AS expired,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            COALESCE(sum(contract_value) FILTER (WHERE status = 'ACTIVE'), 0)::numeric(16,3)::text AS active_value,
            COALESCE(sum(contract_value) FILTER (WHERE status <> 'CANCELLED'), 0)::numeric(16,3)::text AS non_cancelled_value,
            COALESCE(sum(final_credit) FILTER (WHERE status = 'ACTIVE'), 0)::numeric(16,3)::text AS final_credit_total,
            count(final_credit) FILTER (WHERE status = 'ACTIVE')::int AS final_credit_recorded
     FROM amc_contracts WHERE client_id = $1`,
    [clientId]
  );
  const row = result.rows[0];

  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    draft: row?.draft ?? 0,
    expired: row?.expired ?? 0,
    cancelled: row?.cancelled ?? 0,
    activeValue: row?.active_value ?? "0.000",
    nonCancelledValue: row?.non_cancelled_value ?? "0.000",
    finalCreditTotal: row?.final_credit_total ?? "0.000",
    finalCreditRecorded: row?.final_credit_recorded ?? 0,
  };
}

/** The AMC expiry report's rule for one client: active contracts ending within the window, or already past validity. */
async function renewals(clientId: string) {
  const condition = "client_id = $1 AND status = 'ACTIVE' AND valid_to <= current_date + $2::int";
  const total = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM amc_contracts WHERE ${condition}`, [clientId, RENEWAL_WINDOW_DAYS]);
  const rows = await pool.query<{ id: string; system_description: string; valid_from: string; valid_to: string; days_left: number; contract_value: string }>(
    `SELECT id, system_description, valid_from::text AS valid_from, valid_to::text AS valid_to,
            (valid_to - current_date)::int AS days_left, contract_value
     FROM amc_contracts WHERE ${condition}
     ORDER BY valid_to, id
     LIMIT $3`,
    [clientId, RENEWAL_WINDOW_DAYS, RENEWAL_LIMIT]
  );

  return {
    windowDays: RENEWAL_WINDOW_DAYS,
    total: total.rows[0]?.count ?? 0,
    items: rows.rows.map((row) => ({
      id: row.id,
      systemDescription: row.system_description,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      daysLeft: row.days_left,
      contractValue: row.contract_value,
    })),
  };
}

async function visitFigures(clientId: string): Promise<ClientVisitFigures> {
  const result = await pool.query<{ upcoming: number; overdue: number; completed: number; ready: number; next_visit: string | null }>(
    `SELECT count(*) FILTER (WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED') AND v.scheduled_date >= current_date)::int AS upcoming,
            count(*) FILTER (WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED') AND v.scheduled_date < current_date)::int AS overdue,
            count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
            count(*) FILTER (WHERE b.invoice_eligibility = 'READY_FOR_INVOICE')::int AS ready,
            (min(v.scheduled_date) FILTER (WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED') AND v.scheduled_date >= current_date))::text AS next_visit
     FROM amc_visits v
     JOIN amc_contracts c ON c.id = v.amc_contract_id
     JOIN v_amc_visit_billing b ON b.amc_visit_id = v.id
     WHERE c.client_id = $1`,
    [clientId]
  );
  const row = result.rows[0];

  return {
    upcoming: row?.upcoming ?? 0,
    overdue: row?.overdue ?? 0,
    completed: row?.completed ?? 0,
    readyForInvoice: row?.ready ?? 0,
    nextVisitDate: row?.next_visit ?? null,
  };
}

async function invoiceFigures(clientId: string): Promise<ClientInvoiceFigures> {
  const result = await pool.query<{ issued: number; cancelled: number; excl: string; total: string; last_date: string | null }>(
    `SELECT count(*) FILTER (WHERE status = 'ISSUED')::int AS issued,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            COALESCE(sum(amount_excl_vat) FILTER (WHERE status = 'ISSUED'), 0)::numeric(16,3)::text AS excl,
            COALESCE(sum(total_amount) FILTER (WHERE status = 'ISSUED'), 0)::numeric(16,3)::text AS total,
            (max(invoice_date) FILTER (WHERE status = 'ISSUED'))::text AS last_date
     FROM invoices WHERE client_id = $1`,
    [clientId]
  );
  const row = result.rows[0];

  return {
    issued: row?.issued ?? 0,
    cancelled: row?.cancelled ?? 0,
    issuedExclVat: row?.excl ?? "0.000",
    issuedTotal: row?.total ?? "0.000",
    lastInvoiceDate: row?.last_date ?? null,
  };
}

export async function getClientSummary(auth: AuthContext, id: string): Promise<ClientSummary> {
  // Refuses an unknown client before anything is counted.
  await getClient(id);

  const viewContracts = can(auth, "AMC_CONTRACTS:VIEW");
  const [today, contracts, renewalList, visits, invoices] = await Promise.all([
    pool.query<{ today: string }>("SELECT current_date::text AS today"),
    viewContracts ? contractFigures(id) : null,
    viewContracts ? renewals(id) : null,
    can(auth, "AMC_SCHEDULE:VIEW") ? visitFigures(id) : null,
    can(auth, "INVOICES:VIEW") ? invoiceFigures(id) : null,
  ]);

  return {
    asOf: today.rows[0]?.today ?? "",
    contracts,
    renewals: renewalList,
    visits,
    invoices,
    paymentTracking: false,
  };
}
