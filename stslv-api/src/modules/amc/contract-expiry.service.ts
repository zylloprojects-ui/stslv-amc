import { pool } from "../../config/database";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { validationError } from "../../shared/errors";
import { REPORT_TIME_ZONE } from "../../shared/export/branding";
import { hasStoredReference, referenceSql } from "./contract-reference";
import { BUSINESS_TODAY_SQL } from "../../shared/business-date";

// Controlled contract expiry (P1 fixes, 2026-11-09). RULE APPROVED BY THE OWNER 2026-11-09:
// an ACTIVE contract becomes EXPIRED on the first day after its Valid To date, measured in
// the business time zone (Asia/Muscat, the time zone every STSLV report is printed in).
// Open visits keep their statuses and values; an open renewal does not prevent expiry.
// Business approval is not production activation: applying stays switched off by default
// (AMC_CONTRACT_EXPIRY_ENABLED) until the approved release; see docs/CONTRACT_EXPIRY.md.
//
// What it changes, and nothing else:
//   * amc_contracts.status ACTIVE -> EXPIRED, only for contracts outside the Recycle Bin whose
//     valid_to is before the as-of date. Draft, Expired and Cancelled contracts are never touched.
//   * One activity-log entry per changed contract (amc_contract.status_changed, the same action
//     a person's change writes), marked automatic, with the rule, as-of date and time zone.
// Visits (whatever their status), amounts, manual Invoice No. / Paid, Zoho invoices, documents,
// renewals and earlier history are left exactly as they are. EXPIRED -> ACTIVE stays possible
// through the normal status change.
//
// Idempotent: a second run on the same day finds nothing to change. Two runs at once are
// serialised by a transaction-scoped advisory lock, and the UPDATE re-checks status = 'ACTIVE',
// so a contract a person changed meanwhile is skipped, never overwritten.
//
// There is no timer inside the API. The run is started from outside (npm run contracts:expire),
// by a person or a host scheduler, once a day. Applying is disabled unless
// AMC_CONTRACT_EXPIRY_ENABLED=true; a dry run is always allowed and changes nothing.

/** The time zone the expiry date is measured in: the business (Oman) time zone of every STSLV report. */
export const CONTRACT_TIME_ZONE = REPORT_TIME_ZONE;

/** Arbitrary constant key of the advisory lock that serialises expiry runs. */
const EXPIRY_LOCK_KEY = 7_204_311;

export interface ExpiryCandidate {
  id: string;
  reference: string;
  clientName: string;
  systemDescription: string;
  validFrom: string;
  validTo: string;
}

export interface ExpiryRun {
  /** The business date the rule was measured against (YYYY-MM-DD). */
  asOf: string;
  timeZone: string;
  dryRun: boolean;
  /** Active contracts whose validity ended before asOf. In a dry run, what would change. */
  candidates: ExpiryCandidate[];
  /** Contracts actually changed to EXPIRED (0 in a dry run). */
  expired: number;
  /** Candidates a person changed between listing and updating; left as they were. */
  skipped: number;
}

/** Whether applying expiry is switched on in this environment. Off unless explicitly enabled. */
export function expiryApplyEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.AMC_CONTRACT_EXPIRY_ENABLED?.trim().toLowerCase() === "true";
}

/**
 * The business (Oman) calendar day of an instant, whatever the server's or database's own time zone.
 * 2026-11-09T19:59:59Z is 2026-11-09 in Muscat (23:59:59); 2026-11-09T20:00:00Z is 2026-11-10.
 */
export async function businessDateAt(instant: Date | string, db: Queryable = pool): Promise<string> {
  const result = await db.query<{ day: string }>("SELECT ($1::timestamptz AT TIME ZONE $2)::date::text AS day", [
    instant instanceof Date ? instant.toISOString() : instant,
    CONTRACT_TIME_ZONE,
  ]);

  return (result.rows[0] as { day: string }).day;
}

/** Today in the business time zone (the database clock's now(), read as Oman time). */
export async function businessToday(db: Queryable = pool): Promise<string> {
  const result = await db.query<{ today: string }>(`SELECT ${BUSINESS_TODAY_SQL}::text AS today`);

  return (result.rows[0] as { today: string }).today;
}

async function listCandidates(db: Queryable, asOf: string, lock: boolean): Promise<ExpiryCandidate[]> {
  const result = await db.query<{
    id: string;
    reference: string;
    client_name: string;
    system_description: string;
    valid_from: string;
    valid_to: string;
  }>(
    `SELECT c.id, ${referenceSql("c", await hasStoredReference())} AS reference, cl.name AS client_name, c.system_description,
            c.valid_from::text AS valid_from, c.valid_to::text AS valid_to
     FROM amc_contracts c JOIN clients cl ON cl.id = c.client_id
     WHERE c.status = 'ACTIVE' AND c.valid_to < $1::date
     ORDER BY c.valid_to, c.id
     ${lock ? "FOR UPDATE OF c" : ""}`,
    [asOf]
  );

  return result.rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    clientName: row.client_name,
    systemDescription: row.system_description,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  }));
}

export interface ExpiryOptions {
  /** false (the default) lists only. true changes the contracts; refused unless `enabled`. */
  apply?: boolean;
  /** The as-of date; defaults to today in CONTRACT_TIME_ZONE. A later date than today is refused. */
  asOf?: string;
  /** Whether applying is allowed here (expiryApplyEnabled() for the CLI). */
  enabled?: boolean;
}

/**
 * Lists, and with `apply` expires, the Active contracts whose Valid To is before the as-of date.
 * Always one transaction; a dry run takes no lock and writes nothing.
 */
export async function runContractExpiry(options: ExpiryOptions = {}): Promise<ExpiryRun> {
  const apply = options.apply === true;

  if (apply && options.enabled !== true) {
    throw validationError(
      "Applying contract expiry is disabled in this environment. Set AMC_CONTRACT_EXPIRY_ENABLED=true only as part of the approved release (docs/CONTRACT_EXPIRY.md). A dry run needs no switch."
    );
  }

  return withTransaction(async (client) => {
    const today = await businessToday(client);
    const asOf = options.asOf ?? today;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`))) {
      throw validationError("The as-of date must be a calendar date (YYYY-MM-DD).");
    }
    // Expiring ahead of time would end contracts that are still valid.
    if (asOf > today) {
      throw validationError(`The as-of date cannot be after today (${today}, ${CONTRACT_TIME_ZONE}).`);
    }

    if (!apply) {
      return { asOf, timeZone: CONTRACT_TIME_ZONE, dryRun: true, candidates: await listCandidates(client, asOf, false), expired: 0, skipped: 0 };
    }

    await client.query("SELECT pg_advisory_xact_lock($1)", [EXPIRY_LOCK_KEY]);
    const candidates = await listCandidates(client, asOf, true);
    let expired = 0;

    for (const contract of candidates) {
      // Re-checked in the statement itself: only a contract still Active and past validity changes.
      const updated = await client.query(
        "UPDATE amc_contracts SET status = 'EXPIRED', updated_by = NULL WHERE id = $1 AND status = 'ACTIVE' AND valid_to < $2::date",
        [contract.id, asOf]
      );

      if ((updated.rowCount ?? 0) === 0) continue;
      expired += 1;

      await logActivity(client, {
        // A system action: no person made this change.
        userId: null,
        action: "amc_contract.status_changed",
        module: "AMC_CONTRACTS",
        entityType: "amc_contracts",
        entityId: contract.id,
        description: `AMC contract for "${contract.clientName}" (${contract.systemDescription}) changed from ACTIVE to EXPIRED automatically: validity ended on ${contract.validTo}.`,
        metadata: {
          changes: { status: { from: "ACTIVE", to: "EXPIRED" } },
          automatic: true,
          rule: "Active contract past Valid To",
          validTo: contract.validTo,
          asOf,
          timeZone: CONTRACT_TIME_ZONE,
        },
      });
    }

    return { asOf, timeZone: CONTRACT_TIME_ZONE, dryRun: false, candidates, expired, skipped: candidates.length - expired };
  });
}
