// Runs once before the test files. Rebuilds the dedicated test schema from the
// migration files, so every run also proves the migrations apply from scratch.
const TEST_SCHEMA = "stslv_test";

export default async function setup() {
  process.env.NODE_ENV = "test";
  process.env.DB_SCHEMA = TEST_SCHEMA;

  const { pool } = await import("../src/config/database.js");
  const { runMigrations } = await import("../src/db/migrate.js");

  try {
    // Only ever the hard-coded test schema. The "public" schema is never dropped.
    await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await runMigrations(pool, { schema: TEST_SCHEMA });
  } finally {
    await pool.end();
  }
}
