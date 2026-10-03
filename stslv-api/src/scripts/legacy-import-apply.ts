import path from "node:path";
import { pool } from "../config/database";
import { applyImport } from "../legacy-import/apply";
import { loadConfig } from "../legacy-import/config";

// Historical Excel import: THE IMPORT ITSELF. It writes to the database.
//
// Usage:
//   npm run legacy-import:apply -- --confirm-database <database name>
//   npm run legacy-import:apply -- --confirm-database <database name> --config <file> --label <text>
//
// Run the dry run first (npm run legacy-import:dry-run) and read its report:
// this script writes exactly that plan.
//
// --confirm-database is required and must be the name of the database the
// API is connected to (DB_NAME). It is there so that the import cannot be
// run against a database by accident.
//
// It is safe to run twice: source records that are already staged are left
// as they are, and a second run writes nothing.

// stslv-api/src/scripts -> the repository root.
const REPOSITORY = path.resolve(__dirname, "..", "..", "..");
// Client data lives here; Git ignores the folder.
const CLIENT_SOURCE = path.join(REPOSITORY, "docs", "client-source");

interface ApplyArguments {
  config: string | null;
  confirmDatabase: string;
  label: string | null;
}

export function parseApplyArguments(argv: string[]): ApplyArguments {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index] as string;
    const value = argv[index + 1];

    if (!["--config", "--confirm-database", "--label"].includes(name) || value === undefined || value.startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${name}.`);
    }

    values.set(name, value);
  }

  const confirmDatabase = values.get("--confirm-database");

  if (!confirmDatabase) {
    throw new Error("--confirm-database <database name> is required: name the database this import is meant for.");
  }

  return { config: values.get("--config") ?? null, confirmDatabase, label: values.get("--label") ?? null };
}

async function main() {
  const options = parseApplyArguments(process.argv.slice(2));
  const target = await pool.query<{ database: string; schema: string }>("SELECT current_database() AS database, current_schema() AS schema");
  const connected = target.rows[0]?.database;

  if (connected !== options.confirmDatabase) {
    throw new Error(`Connected to database "${connected}", but --confirm-database names "${options.confirmDatabase}". Nothing was read or changed.`);
  }

  const config = loadConfig(path.resolve(options.config ?? path.join(CLIENT_SOURCE, "legacy-import.config.json")));
  const result = await applyImport(config, pool, options.label ? { label: options.label } : {});

  console.log(`HISTORICAL EXCEL IMPORT into ${result.database} (schema ${result.schema}).`);
  for (const file of result.sources) {
    console.log(`  ${file.file}: sha256 ${file.sha256.slice(0, 16)}... matches the analysed file`);
  }
  console.log(`Source records: ${result.sourceRecords}; already staged by an earlier run: ${result.alreadyStaged}`);

  if (result.batchId === null) {
    console.log("Every source record is already staged. Nothing was written.");
    return;
  }

  console.log(`Batch ${result.batchId}, cutover date ${result.cutoverDate}`);
  console.log(`Staged:  ${result.staged.imported} imported, ${result.staged.held} provisional (held)`);
  console.log(
    `Created: ${result.created.clients} clients (${result.existingClientsUsed} existing used), ${result.created.contracts} DRAFT contracts, ` +
      `${result.created.visits} HISTORICAL visits, ${result.created.projects} HISTORICAL projects`
  );
  console.log(`Reconciliation: ${result.reconciliation.length} of ${result.reconciliation.length} checks passed`);
  for (const check of result.reconciliation) {
    console.log(`  ${check.name}: ${check.detail}`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "The import failed.");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
