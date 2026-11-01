import { pool } from "../../config/database";

// The history of a contract's schedule: every generation or update, oldest first,
// read from the append-only activity log. Nothing here writes.

export async function listScheduleGenerations(contractId: string) {
  const rows = await pool.query<{ id: string; created: number; removed: number; frequency: string | null; reason: string | null; billing_basis: string | null; annual_amount: string | null; recalculated: number; preserved: number; valid_from: string | null; valid_to: string | null; full_name: string | null; created_at: Date }>(
    `SELECT l.id, jsonb_array_length(COALESCE(l.metadata -> 'created', '[]'::jsonb))::int AS created,
            jsonb_array_length(COALESCE(l.metadata -> 'removed', '[]'::jsonb))::int AS removed,
            l.metadata -> 'terms' ->> 'maintenanceFrequency' AS frequency,
            l.metadata -> 'terms' ->> 'validFrom' AS valid_from, l.metadata -> 'terms' ->> 'validTo' AS valid_to,
            l.metadata ->> 'reason' AS reason, l.metadata ->> 'billingBasis' AS billing_basis, l.metadata ->> 'annualAmount' AS annual_amount,
            jsonb_array_length(COALESCE(l.metadata -> 'recalculated', '[]'::jsonb))::int AS recalculated,
            jsonb_array_length(COALESCE(l.metadata -> 'preserved', '[]'::jsonb))::int AS preserved,
            u.full_name, l.created_at
     FROM activity_logs l LEFT JOIN users u ON u.id = l.user_id
     WHERE l.action IN ('amc_contract.schedule_generated', 'amc_contract.schedule_regenerated') AND l.entity_type = 'amc_contracts' AND l.entity_id = $1
     ORDER BY l.created_at, l.id`,
    [contractId]
  );

  return rows.rows.map((row, index) => ({
    generation: index + 1,
    added: row.created,
    removed: row.removed,
    maintenanceFrequency: row.frequency,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    // Null on entries written before these were recorded: never guessed.
    reason: row.reason,
    billingBasis: row.billing_basis,
    annualAmount: row.annual_amount,
    recalculated: row.recalculated,
    preserved: row.preserved,
    generatedBy: row.full_name,
    generatedAt: row.created_at.toISOString(),
  }));
}
