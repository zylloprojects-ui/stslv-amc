import { pool } from "../../config/database";
import { escapeLike } from "../../shared/validation";
import type { ContractStatus } from "./amc.constants";
import { RENEWAL_WARNING_DAYS } from "./management.service";
import type { ListRenewalQueueQuery, RenewalState } from "./renewal-queue.schemas";
import { amcReference } from "./service-status.service";

// The AMC Renewal queue: one row per contract that is due for renewal or has a
// renewal (migration 0072). Read-only. Eligibility is worked out from
// current_date on every request, so no scheduled job is needed.
//
// A renewal is a separate contract; the contract it renews is never changed by
// this queue. The renewal state is derived (RENEWAL_STATES), never stored.
// The routes require migrations 0070, 0072 and 0075.

/** The contract's renewal that is not cancelled (at most one, by 0072's unique index), and its latest cancelled one. */
const FROM = `
  FROM amc_contracts c
  JOIN clients cl ON cl.id = c.client_id
  LEFT JOIN system_types st ON st.id = c.system_type_id
  LEFT JOIN maintenance_frequencies mf ON mf.code = c.maintenance_frequency
  LEFT JOIN LATERAL (
    SELECT r.id, r.status, r.valid_from, r.valid_to, r.notes
    FROM amc_contracts r WHERE r.renewed_from_id = c.id AND r.status <> 'CANCELLED'
    ORDER BY r.id LIMIT 1
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT r.id, r.status, r.valid_from, r.valid_to
    FROM amc_contracts r WHERE r.renewed_from_id = c.id AND r.status = 'CANCELLED'
    ORDER BY r.updated_at DESC, r.id DESC LIMIT 1
  ) x ON true`;

/** See RENEWAL_STATES. Null: the contract is not on the queue. */
const STATE_SQL = `CASE
    WHEN o.status = 'DRAFT' THEN 'UNDER_APPROVAL'
    WHEN o.id IS NOT NULL THEN 'RENEWED'
    WHEN x.id IS NOT NULL THEN 'CANCELLED'
    WHEN c.status IN ('ACTIVE', 'EXPIRED') AND c.valid_to <= current_date + ${RENEWAL_WARNING_DAYS} THEN 'DUE'
  END`;

const ORDER = `ORDER BY CASE renewal_state WHEN 'DUE' THEN 0 WHEN 'UNDER_APPROVAL' THEN 1 WHEN 'CANCELLED' THEN 2 ELSE 3 END,
  valid_to, lower(client_name), id`;

// Every row of the queue with its state, so filters and counts read one column.
const BASE = `(
  SELECT c.id, cl.id AS client_id, cl.name AS client_name, c.system_description, st.name AS system_type_name,
         c.maintenance_frequency, mf.label AS frequency_label,
         c.valid_from::text AS valid_from, c.valid_to::text AS valid_to, (c.valid_to - current_date)::int AS days_left,
         c.status, c.contract_value::text AS contract_value,
         CASE WHEN o.id IS NOT NULL THEN o.notes ELSE c.notes END AS remarks,
         COALESCE(o.id, x.id) AS renewal_id, COALESCE(o.status, x.status) AS renewal_status,
         COALESCE(o.valid_from, x.valid_from)::text AS renewal_valid_from, COALESCE(o.valid_to, x.valid_to)::text AS renewal_valid_to,
         ${STATE_SQL} AS renewal_state
  ${FROM}
) q`;

// Service progress of each listed contract, read only for the rows on the page.
const SERVICES = `
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE v.status <> 'CANCELLED')::int AS scheduled,
           count(*) FILTER (WHERE v.status = 'COMPLETED')::int AS completed
    FROM amc_visits v WHERE v.amc_contract_id = q.id
  ) s ON true`;

interface QueueRow {
  id: string;
  client_id: string;
  client_name: string;
  system_description: string;
  system_type_name: string | null;
  maintenance_frequency: string;
  frequency_label: string | null;
  valid_from: string;
  valid_to: string;
  days_left: number;
  status: ContractStatus;
  contract_value: string;
  remarks: string | null;
  renewal_id: string | null;
  renewal_status: ContractStatus | null;
  renewal_valid_from: string | null;
  renewal_valid_to: string | null;
  renewal_state: RenewalState;
  scheduled: number;
  completed: number;
}

export interface RenewalQueueItem {
  /** The contract to be renewed (the source). */
  id: string;
  reference: string;
  client: { id: string; name: string };
  system: { description: string; typeName: string | null };
  frequency: { code: string; label: string };
  /** Visits of the source contract: completed, and scheduled (every visit not cancelled). */
  services: { completed: number; scheduled: number };
  validFrom: string;
  validTo: string;
  /** Days from today to the end of validity; negative once it has ended. */
  daysLeft: number;
  /** The source contract's own status, which renewing never changes. */
  contractStatus: ContractStatus;
  /** amc_contracts.contract_value of the source, as a decimal string. */
  contractValue: string;
  /** The renewal's notes when an open renewal exists, otherwise the source contract's notes. */
  remarks: string | null;
  renewalState: RenewalState;
  /** The open renewal, or for CANCELLED the latest cancelled one; null when DUE. */
  renewal: { id: string; reference: string; status: ContractStatus; validFrom: string; validTo: string } | null;
}

function toItem(row: QueueRow): RenewalQueueItem {
  return {
    id: row.id,
    reference: amcReference(row.id),
    client: { id: row.client_id, name: row.client_name },
    system: { description: row.system_description, typeName: row.system_type_name },
    frequency: { code: row.maintenance_frequency, label: row.frequency_label ?? row.maintenance_frequency },
    services: { completed: row.completed, scheduled: row.scheduled },
    validFrom: row.valid_from,
    validTo: row.valid_to,
    daysLeft: row.days_left,
    contractStatus: row.status,
    contractValue: row.contract_value,
    remarks: row.remarks,
    renewalState: row.renewal_state,
    renewal:
      row.renewal_id && row.renewal_status && row.renewal_valid_from && row.renewal_valid_to
        ? { id: row.renewal_id, reference: amcReference(row.renewal_id), status: row.renewal_status, validFrom: row.renewal_valid_from, validTo: row.renewal_valid_to }
        : null,
  };
}

export type RenewalQueueFilters = Omit<ListRenewalQueueQuery, "page" | "pageSize">;

/** "AMC-0007", "amc7" or "7" names contract 7. */
const REFERENCE_PATTERN = /^(?:amc-?)?0*(\d{1,15})$/i;

/** The search condition, shared by the rows and the cards. The state filter is applied to the rows only. */
function searchSql(search: string | undefined, params: unknown[]): string {
  if (!search) return "";
  params.push(`%${escapeLike(search)}%`);
  const p = `$${params.length}`;
  const matches = [`q.client_name ILIKE ${p}`, `q.system_description ILIKE ${p}`, `q.system_type_name ILIKE ${p}`];
  const reference = REFERENCE_PATTERN.exec(search);

  if (reference) {
    params.push(reference[1]);
    matches.push(`q.id = $${params.length}::bigint`);
  }
  return ` AND (${matches.join(" OR ")})`;
}

function filterSql(filters: RenewalQueueFilters) {
  const params: unknown[] = [];
  const search = searchSql(filters.search, params);
  const cardWhere = `WHERE q.renewal_state IS NOT NULL${search}`;
  let where = cardWhere;

  if (filters.renewalStatus) {
    params.push(filters.renewalStatus);
    where += ` AND q.renewal_state = $${params.length}`;
  }
  return { where, cardWhere, params };
}

export interface RenewalQueueKpis {
  due: number;
  underApproval: number;
  renewed: number;
  cancelled: number;
}

/** The card figures: every state, for the search applied (not the state filter, so each card keeps its own count). */
async function kpis(cardWhere: string, params: unknown[], paramCount: number): Promise<RenewalQueueKpis> {
  const result = await pool.query<{ due: number; under_approval: number; renewed: number; cancelled: number }>(
    `SELECT count(*) FILTER (WHERE q.renewal_state = 'DUE')::int AS due,
            count(*) FILTER (WHERE q.renewal_state = 'UNDER_APPROVAL')::int AS under_approval,
            count(*) FILTER (WHERE q.renewal_state = 'RENEWED')::int AS renewed,
            count(*) FILTER (WHERE q.renewal_state = 'CANCELLED')::int AS cancelled
     FROM ${BASE} ${cardWhere}`,
    params.slice(0, paramCount)
  );
  const row = result.rows[0];

  return { due: row?.due ?? 0, underApproval: row?.under_approval ?? 0, renewed: row?.renewed ?? 0, cancelled: row?.cancelled ?? 0 };
}

async function count(where: string, params: unknown[]): Promise<number> {
  const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${BASE} ${where}`, params);

  return result.rows[0]?.count ?? 0;
}

/** Parameters used by the search alone: the state filter, when given, is the last one. */
const searchParamCount = (filters: RenewalQueueFilters, params: unknown[]) => params.length - (filters.renewalStatus ? 1 : 0);

export async function listRenewalQueue(query: ListRenewalQueueQuery) {
  const { where, cardWhere, params } = filterSql(query);
  const [figures, total, today, rows] = await Promise.all([
    kpis(cardWhere, params, searchParamCount(query, params)),
    count(where, params),
    pool.query<{ today: string }>("SELECT current_date::text AS today"),
    pool.query<QueueRow>(`SELECT q.*, s.scheduled, s.completed FROM ${BASE} ${SERVICES} ${where} ${ORDER} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      query.pageSize,
      (query.page - 1) * query.pageSize,
    ]),
  ]);

  return {
    items: rows.rows.map(toItem),
    total,
    page: query.page,
    pageSize: query.pageSize,
    kpis: figures,
    windowDays: RENEWAL_WARNING_DAYS,
    today: today.rows[0]?.today ?? null,
  };
}

/**
 * Every queue row that matches the filters, in the page's order, for an export.
 * `checkSize` is given the number of rows before any is read and throws when the
 * export cannot hold that many.
 */
export async function listAllRenewalQueue(filters: RenewalQueueFilters, checkSize: (count: number) => void) {
  const { where, cardWhere, params } = filterSql(filters);
  const [figures, total] = await Promise.all([kpis(cardWhere, params, searchParamCount(filters, params)), count(where, params)]);

  checkSize(total);

  const rows = await pool.query<QueueRow>(`SELECT q.*, s.scheduled, s.completed FROM ${BASE} ${SERVICES} ${where} ${ORDER}`, params);

  return { items: rows.rows.map(toItem), kpis: figures, total };
}
