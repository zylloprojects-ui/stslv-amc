import { pool } from "../config/database";

// The activity log entries recorded against one record, newest first. Only the
// readable parts of an entry's details are returned (recorded field changes and
// a reason); other stored details stay internal.

export interface HistoryEntry {
  id: string;
  /** Dotted verb, for example "client.updated". */
  action: string;
  description: string | null;
  /** Null for an action not made by a signed-in user (for example the historical import). */
  user: { id: string; fullName: string } | null;
  /** Field changes recorded with the entry, as { field: { from, to } }. */
  changes: Record<string, { from: unknown; to: unknown }> | null;
  reason: string | null;
  createdAt: string;
}

export async function listEntityHistory(entityType: string, entityId: string, page: number, pageSize: number) {
  const total = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM activity_logs WHERE entity_type = $1 AND entity_id = $2",
    [entityType, entityId]
  );
  const rows = await pool.query<{
    id: string;
    action: string;
    description: string | null;
    user_id: string | null;
    full_name: string | null;
    changes: unknown;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT l.id, l.action, l.description, l.user_id, u.full_name,
            l.metadata -> 'changes' AS changes, l.metadata ->> 'reason' AS reason, l.created_at
     FROM activity_logs l
     LEFT JOIN users u ON u.id = l.user_id
     WHERE l.entity_type = $1 AND l.entity_id = $2
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $3 OFFSET $4`,
    [entityType, entityId, pageSize, (page - 1) * pageSize]
  );

  const items: HistoryEntry[] = rows.rows.map((row) => ({
    id: row.id,
    action: row.action,
    description: row.description,
    user: row.user_id ? { id: row.user_id, fullName: row.full_name ?? "" } : null,
    changes:
      row.changes !== null && typeof row.changes === "object" && !Array.isArray(row.changes)
        ? (row.changes as Record<string, { from: unknown; to: unknown }>)
        : null,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  }));

  return { items, total: total.rows[0]?.count ?? 0, page, pageSize };
}
