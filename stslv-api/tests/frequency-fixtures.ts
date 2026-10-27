import { pool } from "../src/config/database";

// The maintenance frequency rows that migrations 0075 and 0076 seed, exactly as
// the migrations write them.
//
// resetData() (helpers.ts) runs "TRUNCATE ... users ... CASCADE". That also
// empties maintenance_frequencies, whose created_by refers to users. From 0076
// every contract refers to one of these codes, so after a reset they must be
// put back before a test can create a contract.
//
// Before 0076 is in the schema this does nothing: the table then has no rule
// columns, and nothing depends on its rows.

export const SEEDED_FREQUENCIES = [
  { code: "MONTHLY", label: "Monthly", sortOrder: 1, isActive: true, isCustom: false, serviceCount: 12, intervalMonths: 1, codePrefix: "M" },
  { code: "QUARTERLY", label: "Quarterly", sortOrder: 2, isActive: true, isCustom: false, serviceCount: 4, intervalMonths: 3, codePrefix: "Q" },
  { code: "HALF_YEARLY", label: "Half-yearly", sortOrder: 3, isActive: true, isCustom: false, serviceCount: 2, intervalMonths: 6, codePrefix: "H" },
  { code: "ANNUALLY", label: "Annually", sortOrder: 4, isActive: true, isCustom: false, serviceCount: 1, intervalMonths: 12, codePrefix: "A" },
  { code: "BI_MONTHLY", label: "Bi-Monthly / Every 2 Months", sortOrder: 5, isActive: false, isCustom: false, serviceCount: 6, intervalMonths: 2, codePrefix: "BM" },
  { code: "EVERY_4_MONTHS", label: "Every 4 Months", sortOrder: 6, isActive: false, isCustom: false, serviceCount: 3, intervalMonths: 4, codePrefix: "T" },
  { code: "CUSTOM", label: "Custom", sortOrder: 7, isActive: false, isCustom: true, serviceCount: null, intervalMonths: null, codePrefix: "C" },
] as const;

/** True when the connected schema has the 0076 rule columns. */
async function hasFrequencyRules(): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'maintenance_frequencies' AND column_name = 'code_prefix'
     ) AS present`
  );

  return result.rows[0]?.present === true;
}

/**
 * Puts back the seeded frequency rows after a reset. A row that would clash
 * with one already present (code, name or prefix) is skipped (ON CONFLICT DO NOTHING). Returns how many rows it added;
 * always 0 before migration 0076.
 */
export async function restoreSeededFrequencies(): Promise<number> {
  if (!(await hasFrequencyRules())) {
    return 0;
  }

  const result = await pool.query(
    `INSERT INTO maintenance_frequencies (code, label, sort_order, is_active, is_custom, service_count, interval_months, code_prefix)
     SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::boolean[], $5::boolean[], $6::smallint[], $7::smallint[], $8::text[])
     ON CONFLICT DO NOTHING`,
    [
      SEEDED_FREQUENCIES.map((row) => row.code),
      SEEDED_FREQUENCIES.map((row) => row.label),
      SEEDED_FREQUENCIES.map((row) => row.sortOrder),
      SEEDED_FREQUENCIES.map((row) => row.isActive),
      SEEDED_FREQUENCIES.map((row) => row.isCustom),
      SEEDED_FREQUENCIES.map((row) => row.serviceCount),
      SEEDED_FREQUENCIES.map((row) => row.intervalMonths),
      SEEDED_FREQUENCIES.map((row) => row.codePrefix),
    ]
  );

  return result.rowCount ?? 0;
}
