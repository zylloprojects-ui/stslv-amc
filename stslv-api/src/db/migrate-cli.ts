import { databaseSchema, pool } from "../config/database";
import { runMigrations } from "./migrate";

// Usage:
//   npm run migrate          apply pending migrations
//   npm run migrate:status   list applied and pending migrations, change nothing
async function main() {
  const statusOnly = process.argv.includes("--status");

  const target = await pool.query<{ database: string; schema: string }>(
    "SELECT current_database() AS database, current_schema() AS schema"
  );
  console.log(`Database: ${target.rows[0]?.database}   Schema: ${databaseSchema ?? target.rows[0]?.schema}`);

  const result = await runMigrations(pool, {
    schema: databaseSchema,
    dryRun: statusOnly,
    log: (message) => console.log(message),
  });

  for (const migration of result.status) {
    const applied = result.applied.includes(`${migration.version}_${migration.name}.sql`);
    const label = applied ? "applied now" : migration.state;
    console.log(`  ${migration.version}_${migration.name}  ${label}`);
  }

  if (statusOnly) {
    const pending = result.status.filter((migration) => migration.state === "pending").length;
    console.log(pending === 0 ? "Nothing pending." : `${pending} migration(s) pending. Nothing was changed.`);
  } else {
    console.log(result.applied.length === 0 ? "Nothing to apply." : `${result.applied.length} migration(s) applied.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Migration failed.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
