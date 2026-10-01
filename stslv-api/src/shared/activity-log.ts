import type { Queryable } from "./db";

export interface ActivityEntry {
  /** Null for system actions such as a command-line script. */
  userId: string | null;
  /** Dotted verb, for example "client.updated". */
  action: string;
  /** Functional area, for example "CLIENTS", "USERS" or "AUTH". */
  module: string;
  /** Table name of the affected record. */
  entityType: string;
  entityId: string | null;
  description: string;
  /** Changed fields and context. Never include passwords, hashes or tokens. */
  metadata?: Record<string, unknown>;
}

/**
 * Writes one audit entry. Pass the transaction client so the entry is
 * committed (or rolled back) together with the change it describes.
 */
export async function logActivity(db: Queryable, entry: ActivityEntry): Promise<void> {
  await db.query(
    `INSERT INTO activity_logs (user_id, action, module, entity_type, entity_id, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.userId,
      entry.action,
      entry.module,
      entry.entityType,
      entry.entityId,
      entry.description,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ]
  );
}

/** Field-level differences between two records, as { field: { from, to } }. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[]
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const field of fields) {
    if (before[field] !== after[field]) {
      changes[field] = { from: before[field], to: after[field] };
    }
  }

  return changes;
}
