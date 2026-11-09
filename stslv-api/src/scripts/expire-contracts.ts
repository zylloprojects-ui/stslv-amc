import "dotenv/config";
import { pool } from "../config/database";
import { expiryApplyEnabled, runContractExpiry } from "../modules/amc/contract-expiry.service";

/**
 * npm run contracts:expire                     dry run: lists the Active contracts past Valid To, changes nothing
 * npm run contracts:expire -- --as-of 2026-11-09   dry run measured on that (past or current) date
 * npm run contracts:expire -- --apply          changes them to EXPIRED, one audit entry each
 *
 * --apply is refused unless AMC_CONTRACT_EXPIRY_ENABLED=true. That switch stays off until the client
 * approves the expiry rule (docs/CONTRACT_EXPIRY.md). Running it twice changes nothing the second time.
 * Prints contract references, clients and dates only: never connection details.
 * Exit code 0 on success, 1 on any error.
 */
function parseArgs(argv: string[]): { apply: boolean; asOf?: string } {
  const apply = argv.includes("--apply");
  const index = argv.indexOf("--as-of");
  const asOf = index >= 0 ? argv[index + 1] : undefined;

  if (index >= 0 && !asOf) throw new Error("--as-of needs a date (YYYY-MM-DD).");
  for (const arg of argv) {
    if (arg.startsWith("--") && arg !== "--apply" && arg !== "--as-of") throw new Error(`Unknown option ${arg}.`);
  }

  return { apply, ...(asOf ? { asOf } : {}) };
}

async function main(): Promise<void> {
  const { apply, asOf } = parseArgs(process.argv.slice(2));
  const run = await runContractExpiry({ apply, enabled: expiryApplyEnabled(), ...(asOf ? { asOf } : {}) });

  console.log(`${run.dryRun ? "DRY RUN (nothing changed)" : "APPLIED"}: Active contracts with Valid To before ${run.asOf} (${run.timeZone})`);
  for (const contract of run.candidates) {
    console.log(`  ${contract.reference}  ${contract.clientName}  ${contract.systemDescription}  valid ${contract.validFrom} to ${contract.validTo}`);
  }
  console.log(run.dryRun ? `${run.candidates.length} contract(s) would change to EXPIRED.` : `${run.expired} changed to EXPIRED, ${run.skipped} skipped (changed meanwhile).`);
}

main()
  .then(() => pool.end())
  .catch(async (error: unknown) => {
    console.error(`FAILED: ${(error as Error).message}`);
    await pool.end();
    process.exitCode = 1;
  });
