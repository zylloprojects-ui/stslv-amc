import type { Queryable } from "../../shared/db";
import { conflict } from "../../shared/errors";

// Work that an active (not cancelled) invoice covers is locked: the facts the
// invoice was recorded against must not change underneath it. Cancelling the
// invoice lifts the lock. PROVISIONAL: these rules are pending client
// confirmation.
//
// The AMC and Projects services call these inside the transaction that holds
// the row lock on the visit, project or contract, so an invoice cannot be
// recorded between the check and the change.

const ACTIVE_INVOICE_NUMBERS = `
  SELECT DISTINCT i.invoice_number
  FROM invoice_allocations al
  JOIN invoices i ON i.id = al.invoice_id
  WHERE i.status <> 'CANCELLED'`;

async function invoiceNumbers(db: Queryable, condition: string, id: string): Promise<string[]> {
  const result = await db.query<{ invoice_number: string }>(`${ACTIVE_INVOICE_NUMBERS} AND ${condition} ORDER BY 1`, [id]);

  return result.rows.map((row) => row.invoice_number);
}

function describe(numbers: string[]): string {
  return numbers.length === 1 ? `invoice ${numbers[0]}` : `invoices ${numbers.join(", ")}`;
}

/** Refuses a change to an AMC visit that an active invoice covers. `change` completes "… cannot be …". */
export async function assertVisitNotInvoiced(db: Queryable, visitId: string, change: string): Promise<void> {
  const numbers = await invoiceNumbers(db, "al.amc_visit_id = $1", visitId);

  if (numbers.length > 0) {
    throw conflict(`This visit is covered by ${describe(numbers)} and cannot be ${change}. Cancel the invoice first.`);
  }
}

/** Refuses a change to a project that an active invoice covers. `change` completes "… cannot be …". */
export async function assertProjectNotInvoiced(db: Queryable, projectId: string, jobNumber: string, change: string): Promise<void> {
  const numbers = await invoiceNumbers(db, "al.project_id = $1", projectId);

  if (numbers.length > 0) {
    throw conflict(`Project ${jobNumber} is covered by ${describe(numbers)} and cannot be ${change}. Cancel the invoice first.`);
  }
}

/** Refuses moving an AMC contract to another client while an active invoice covers one of its visits. */
export async function assertContractNotInvoiced(db: Queryable, contractId: string): Promise<void> {
  const numbers = await invoiceNumbers(
    db,
    "al.amc_visit_id IN (SELECT id FROM amc_visits WHERE amc_contract_id = $1)",
    contractId
  );

  if (numbers.length > 0) {
    throw conflict(
      `Visits of this contract are covered by ${describe(numbers)}, so its client cannot be changed. Cancel the invoice first.`
    );
  }
}
