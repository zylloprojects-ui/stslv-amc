import { pool } from "../../config/database";
import { notFound } from "../../shared/errors";
import type { RenewalHistoryQuery } from "./amc.schemas";

// Read-only views of renewal links (migration 0072).

export interface ContractSummary {
  id: string;
  client: { id: string; name: string };
  systemDescription: string;
  validFrom: string;
  validTo: string;
  status: string;
  createdAt: string;
}

const SUMMARY = `c.id, cl.id AS client_id, cl.name AS client_name, c.system_description,
                 c.valid_from::text AS valid_from, c.valid_to::text AS valid_to, c.status, c.created_at`;

interface SummaryRow {
  id: string;
  client_id: string;
  client_name: string;
  system_description: string;
  valid_from: string;
  valid_to: string;
  status: string;
  created_at: Date;
}

function toSummary(row: SummaryRow): ContractSummary {
  return {
    id: row.id,
    client: { id: row.client_id, name: row.client_name },
    systemDescription: row.system_description,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

/** The contract this one renews, and the renewals made of it (newest first). */
export async function getContractRenewals(contractId: string) {
  const own = await pool.query<{ renewed_from_id: string | null }>("SELECT renewed_from_id FROM amc_contracts WHERE id = $1", [contractId]);

  if (!own.rows[0]) {
    throw notFound("AMC contract not found.");
  }

  const sourceId = own.rows[0].renewed_from_id;
  const source = sourceId
    ? await pool.query<SummaryRow>(`SELECT ${SUMMARY} FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id WHERE c.id = $1`, [sourceId])
    : null;
  const renewals = await pool.query<SummaryRow>(
    `SELECT ${SUMMARY} FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id WHERE c.renewed_from_id = $1 ORDER BY c.created_at DESC, c.id DESC`,
    [contractId]
  );

  return {
    renewedFrom: source?.rows[0] ? toSummary(source.rows[0]) : null,
    renewals: renewals.rows.map(toSummary),
  };
}

type HistoryRow = SummaryRow & { source_valid_from: string; source_valid_to: string; source_status: string; source_id: string; created_on: string };

const HISTORY = `SELECT ${SUMMARY}, s.id AS source_id, s.valid_from::text AS source_valid_from, s.valid_to::text AS source_valid_to, s.status AS source_status,
            c.created_at::date::text AS created_on
     FROM amc_contracts c
     JOIN clients cl ON cl.id = c.client_id
     JOIN amc_contracts s ON s.id = c.renewed_from_id
     ORDER BY c.created_at DESC, c.id DESC`;

function toHistoryItem(row: HistoryRow) {
  return {
    renewal: toSummary(row),
    /** The day the renewal was made, in the database's time zone (the same day current_date gives). */
    createdOn: row.created_on,
    source: { id: row.source_id, validFrom: row.source_valid_from, validTo: row.source_valid_to, status: row.source_status },
  };
}

export type RenewalHistoryItem = ReturnType<typeof toHistoryItem>;

async function historyCount(): Promise<number> {
  const total = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM amc_contracts WHERE renewed_from_id IS NOT NULL");

  return total.rows[0]?.count ?? 0;
}

/** Every renewal made, newest first: the source contract and the renewal contract. */
export async function listRenewalHistory(query: RenewalHistoryQuery) {
  const [total, rows] = await Promise.all([
    historyCount(),
    pool.query<HistoryRow>(`${HISTORY} LIMIT $1 OFFSET $2`, [query.pageSize, (query.page - 1) * query.pageSize]),
  ]);

  return { items: rows.rows.map(toHistoryItem), total, page: query.page, pageSize: query.pageSize };
}

/** Every renewal made, newest first, for an export. `checkSize` throws when the export cannot hold that many rows. */
export async function listAllRenewalHistory(checkSize: (count: number) => void) {
  const total = await historyCount();

  checkSize(total);

  const rows = await pool.query<HistoryRow>(HISTORY);

  return { items: rows.rows.map(toHistoryItem), total };
}
