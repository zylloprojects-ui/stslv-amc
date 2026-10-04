import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../config/database";
import { loadConfig } from "../legacy-import/config";
import { WATCHED_TABLES } from "../legacy-import/database";
import { runDryRun } from "../legacy-import/dry-run";
import { parseArguments } from "../legacy-import/options";
import { renderJson, renderReport } from "../legacy-import/report";

// Historical Excel import: DRY RUN.
//
// Usage:
//   npm run legacy-import:dry-run
//   npm run legacy-import:dry-run -- --config <file> --out <folder>
//
// It reads the three source workbooks and the database, works out what an
// import would create and what it would hold, writes a report, and stops.
// It writes nothing to the database and does not touch the workbooks.
//
// There is no import mode in this script. Running it cannot import anything.

// stslv-api/src/scripts -> the repository root.
const REPOSITORY = path.resolve(__dirname, "..", "..", "..");
// Client data lives here; Git ignores the folder.
const CLIENT_SOURCE = path.join(REPOSITORY, "docs", "client-source");

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const config = loadConfig(path.resolve(options.config ?? path.join(CLIENT_SOURCE, "legacy-import.config.json")));
  const outDirectory = path.resolve(options.out ?? path.join(CLIENT_SOURCE, "import-dry-run"));
  const result = await runDryRun(config, pool);
  const { totals } = result.plan;

  mkdirSync(outDirectory, { recursive: true });
  writeFileSync(path.join(outDirectory, "dry-run-report.md"), renderReport(result));
  writeFileSync(path.join(outDirectory, "dry-run-plan.json"), renderJson(result));

  const sourcesUnchanged = result.sources.every((file) => result.after.sources.find((other) => other.role === file.role)?.sha256 === file.sha256);
  const databaseUnchanged = WATCHED_TABLES.every((table) => result.database.counts[table] === result.after.database.counts[table]);
  const failed = result.plan.checks.filter((check) => !check.passed);

  console.log("HISTORICAL EXCEL IMPORT - DRY RUN. Nothing is imported.");
  console.log(`Database read: ${result.database.database} (schema ${result.database.schema}), cutover date an import run today would record: ${result.plan.asOf}`);
  for (const file of result.sources) {
    console.log(`  ${file.file}: sha256 ${file.sha256.slice(0, 16)}... matches the analysed file`);
  }
  console.log(`Clients:   ${totals.clients.rawNames} raw names -> ${totals.clients.masters} client records: ${totals.clients.proposedNew} new, ${totals.clients.existing} existing, ${totals.clients.deferred} not needed yet, ${totals.clients.heldMasters} held; ${totals.clients.heldAliases} alias(es) awaiting approval`);
  console.log(`Contracts: ${totals.contracts.source} source rows: ${totals.contracts.importable} importable (${totals.contracts.importableValue}), ${totals.contracts.held} held (${totals.contracts.heldValue})`);
  console.log(`Visits:    ${totals.visits.source} source rows: ${totals.visits.importable} historical (${totals.visits.importableAmount}), ${totals.visits.held} held (${totals.visits.heldAmount}), ${totals.visits.generatedWithoutSource} generated without a source row`);
  console.log(`Projects:  ${totals.projects.source} source rows: ${totals.projects.importable} importable (${totals.projects.importableValue}), ${totals.projects.held} held (${totals.projects.heldValue})`);
  console.log(`Checks:    ${result.plan.checks.length - failed.length} of ${result.plan.checks.length} passed`);
  for (const check of failed) {
    console.log(`  FAILED: ${check.name} - ${check.detail}`);
  }
  console.log(`Database unchanged: ${databaseUnchanged ? "yes" : "NO"}   Workbooks unchanged: ${sourcesUnchanged ? "yes" : "NO"}`);
  console.log(`Report: ${path.join(outDirectory, "dry-run-report.md")}`);
  console.log(`Data:   ${path.join(outDirectory, "dry-run-plan.json")}`);

  if (failed.length > 0 || !databaseUnchanged || !sourcesUnchanged) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "The dry run failed.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
