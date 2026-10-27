import { pool } from "../config/database";

// Whether the connected database already has the tables or columns a feature
// needs. Migrations reach each database only with approval, so code that uses
// a newer table or column checks first and keeps older features working.

const known = new Map<string, boolean>();

/** Each item is a table ("attachments") or a column ("clients.vat_number"). True when all are present. */
export async function schemaHas(items: readonly string[]): Promise<boolean> {
  const missing = items.filter((item) => known.get(item) !== true);

  if (missing.length === 0) {
    return true;
  }

  const result = await pool.query<{ item: string; present: boolean }>(
    `SELECT item,
            CASE WHEN position('.' IN item) = 0
                 THEN to_regclass(current_schema() || '.' || item) IS NOT NULL
                 ELSE EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_schema = current_schema()
                                AND table_name = split_part(item, '.', 1)
                                AND column_name = split_part(item, '.', 2))
            END AS present
     FROM unnest($1::text[]) AS item`,
    [missing]
  );

  // Only what exists is remembered, so applying a migration takes effect without a restart.
  for (const row of result.rows) {
    if (row.present) known.set(row.item, true);
  }

  return result.rows.every((row) => row.present);
}
