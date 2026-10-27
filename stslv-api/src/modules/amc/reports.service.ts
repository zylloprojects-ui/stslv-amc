import { pool } from "../../config/database";
import type { ExpiringContractsQuery, WorkloadQuery } from "./amc.schemas";

// Read-only report figures, computed from the stored contracts and visits on
// every request. Nothing here changes a contract's status: expiry is set by a
// user, never automatically (see CONTRACT_TRANSITIONS).

export interface ExpiringContract {
  id: string;
  client: { id: string; name: string };
  systemDescription: string;
  responsibleEngineer: string | null;
  validFrom: string;
  validTo: string;
  /** Calendar days from the database's current date to the end of validity; negative once it has passed. */
  daysLeft: number;
  contractValue: string;
}

/**
 * Active contracts whose validity ends within the chosen number of days,
 * including those whose validity has already ended but are still marked
 * Active. The window is the user's choice, not a business threshold.
 */
export async function listExpiringContracts(query: ExpiringContractsQuery) {
  const conditions = "c.status = 'ACTIVE' AND c.valid_to <= current_date + $1::int";
  const total = await pool.query<{ count: number; past: number }>(
    `SELECT count(*)::int AS count, count(*) FILTER (WHERE c.valid_to < current_date)::int AS past
     FROM amc_contracts c WHERE ${conditions}`,
    [query.days]
  );
  const rows = await pool.query<{
    id: string;
    client_id: string;
    client_name: string;
    system_description: string;
    responsible_engineer: string | null;
    valid_from: string;
    valid_to: string;
    days_left: number;
    contract_value: string;
  }>(
    `SELECT c.id, cl.id AS client_id, cl.name AS client_name, c.system_description, c.responsible_engineer,
            c.valid_from::text AS valid_from, c.valid_to::text AS valid_to,
            (c.valid_to - current_date)::int AS days_left, c.contract_value
     FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
     WHERE ${conditions}
     ORDER BY c.valid_to, lower(cl.name), c.id
     LIMIT $2 OFFSET $3`,
    [query.days, query.pageSize, (query.page - 1) * query.pageSize]
  );
  const today = await pool.query<{ today: string }>("SELECT current_date::text AS today");

  const items: ExpiringContract[] = rows.rows.map((row) => ({
    id: row.id,
    client: { id: row.client_id, name: row.client_name },
    systemDescription: row.system_description,
    responsibleEngineer: row.responsible_engineer,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    daysLeft: row.days_left,
    contractValue: row.contract_value,
  }));

  return {
    asOf: today.rows[0]?.today ?? "",
    days: query.days,
    items,
    total: total.rows[0]?.count ?? 0,
    pastValidity: total.rows[0]?.past ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export interface WorkloadMonth {
  /** "YYYY-MM". */
  month: string;
  /** Visits planned in the month, cancelled visits excluded. */
  planned: number;
  completed: number;
  /** Planned and still scheduled, in progress or postponed. */
  open: number;
}

/**
 * Visits per month by planned date, from the current month forward. Visits of
 * cancelled contracts are left out, as on the dashboard. Historical rows have
 * no recorded date and are never counted.
 */
export async function getWorkload(query: WorkloadQuery) {
  const result = await pool.query<{ month: string; planned: number; completed: number; open: number }>(
    `WITH months AS (
       SELECT to_char(date_trunc('month', current_date) + make_interval(months => n), 'YYYY-MM') AS month
       FROM generate_series(0, $1::int - 1) AS n
     )
     SELECT m.month,
            count(v.id) FILTER (WHERE v.status <> 'CANCELLED')::int AS planned,
            count(v.id) FILTER (WHERE v.status = 'COMPLETED')::int AS completed,
            count(v.id) FILTER (WHERE v.status IN ('SCHEDULED', 'IN_PROGRESS', 'POSTPONED'))::int AS open
     FROM months m
     LEFT JOIN amc_visits v ON to_char(v.scheduled_date, 'YYYY-MM') = m.month AND v.status <> 'HISTORICAL'
       AND EXISTS (SELECT 1 FROM amc_contracts c WHERE c.id = v.amc_contract_id AND c.status <> 'CANCELLED')
     GROUP BY m.month
     ORDER BY m.month`,
    [query.months]
  );

  return { months: result.rows as WorkloadMonth[] };
}
