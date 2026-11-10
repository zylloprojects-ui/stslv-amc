import type { Pool, PoolClient } from "pg";
import { logActivity } from "../../shared/activity-log";
import { withTransaction } from "../../shared/db";
import { IN_SCOPE } from "../amc/service-status.service";

// Invoice identities for Invoice Acknowledgements (migration 0114). Deterministic and idempotent: safe to run before
// every read and write; runs under one advisory lock so two requests never build the same identity twice.
//
//   1. Every service in Accounts' scope with an Invoice No. that has no association yet gets one:
//      - verified: an ACTIVE Invoice Tracking record of the same client, with the same number (case ignored), is
//        allocated to the service -> the invoice of that record (created once per record, basis ZOHO);
//      - otherwise -> a new invoice of its own (basis SERVICE). Equal numbers are never merged here.
//   2. A SERVICE invoice whose every active service is now allocated to one active Invoice Tracking record of the same
//      number becomes that record's invoice: upgraded in place when the record has no invoice yet, or joined to it
//      when it has one AND this invoice has no acknowledgement with substance. Otherwise nothing moves; the equal
//      numbers are then flagged for reconciliation on the page.
//   3. Every 0112 (per-service) acknowledgement is adopted into the invoice of its service and number. Exactly one
//      with substance (confirmed, or with a document) becomes current; two or more mark the invoice
//      acknowledgement_conflict, and none is chosen. Nothing is deleted, reversed or re-dated.

const LOCK_KEY = 784_512_112;
const MODULE = "INVOICE_ACKNOWLEDGEMENTS";

/** SQL: whether acknowledgement `alias` has substance (confirmed, or a current document). */
export const SUBSTANTIVE_SQL = (alias: string) =>
  `(${alias}.status = 'ACKNOWLEDGED' OR EXISTS (SELECT 1 FROM attachments sd WHERE sd.entity_type = 'invoice_acknowledgements' AND sd.entity_id = ${alias}.id AND sd.is_current))`;

/** SQL: the ids of an invoice and of every invoice merged into it (its family), for history and documents. */
export const FAMILY_SQL = (idSql: string) => `(
  WITH RECURSIVE family AS (
    SELECT id FROM ack_invoices WHERE id = ${idSql}
    UNION SELECT a.id FROM ack_invoices a JOIN family f ON a.merged_into_id = f.id
  ) SELECT id FROM family)`;

async function zohoMatch(db: PoolClient, visitId: string, invoiceNumber: string, clientId: string): Promise<{ id: string; invoice_number: string } | null> {
  const result = await db.query<{ id: string; invoice_number: string }>(
    `SELECT i.id, i.invoice_number FROM invoice_allocations al JOIN invoices i ON i.id = al.invoice_id
     WHERE al.amc_visit_id = $1 AND i.status <> 'CANCELLED' AND lower(i.invoice_number) = lower($2) AND i.client_id = $3
     ORDER BY i.id LIMIT 1`,
    [visitId, invoiceNumber, clientId]
  );
  return result.rows[0] ?? null;
}

async function liveZohoInvoice(db: PoolClient, zohoId: string): Promise<string | null> {
  const result = await db.query<{ id: string }>("SELECT id FROM ack_invoices WHERE zoho_invoice_id = $1 AND merged_into_id IS NULL", [zohoId]);
  return result.rows[0]?.id ?? null;
}

async function createInvoice(db: PoolClient, clientId: string, number: string, zohoId: string | null): Promise<string> {
  const result = await db.query<{ id: string }>(
    "INSERT INTO ack_invoices (client_id, invoice_number, basis, zoho_invoice_id) VALUES ($1, $2, $3, $4) RETURNING id",
    [clientId, number, zohoId ? "ZOHO" : "SERVICE", zohoId]
  );
  return (result.rows[0] as { id: string }).id;
}

/** Step 1: associations for services that have none. */
async function associateNewServices(db: PoolClient): Promise<void> {
  const pending = await db.query<{ visit_id: string; invoice_number: string; client_id: string }>(
    `SELECT v.id AS visit_id, v.manual_invoice_no AS invoice_number, c.client_id
     FROM amc_visits v JOIN amc_contracts c ON c.id = v.amc_contract_id
     WHERE ${IN_SCOPE} AND v.manual_invoice_no IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ack_invoice_services s WHERE s.amc_visit_id = v.id AND s.invoice_number = v.manual_invoice_no)
     ORDER BY v.id`
  );

  for (const row of pending.rows) {
    const zoho = await zohoMatch(db, row.visit_id, row.invoice_number, row.client_id);
    const invoiceId = zoho ? ((await liveZohoInvoice(db, zoho.id)) ?? (await createInvoice(db, row.client_id, zoho.invoice_number, zoho.id))) : await createInvoice(db, row.client_id, row.invoice_number, null);

    await db.query("INSERT INTO ack_invoice_services (ack_invoice_id, amc_visit_id, invoice_number, basis) VALUES ($1, $2, $3, $4)", [
      invoiceId,
      row.visit_id,
      row.invoice_number,
      zoho ? "ZOHO" : "SERVICE",
    ]);
  }
}

/** Step 2: SERVICE invoices verified later by Invoice Tracking. */
async function verifyServiceInvoices(db: PoolClient): Promise<void> {
  const candidates = await db.query<{ id: string; client_id: string; zoho_id: string; current_substantive: boolean; conflict: boolean }>(
    `SELECT ai.id, ai.client_id, min(z.id) AS zoho_id, ai.acknowledgement_conflict AS conflict,
            COALESCE((SELECT ${SUBSTANTIVE_SQL("ca")} FROM invoice_acknowledgements ca WHERE ca.id = ai.current_acknowledgement_id), false) AS current_substantive
     FROM ack_invoices ai
     JOIN ack_invoice_services s ON s.ack_invoice_id = ai.id
     JOIN amc_visits v ON v.id = s.amc_visit_id AND v.manual_invoice_no = s.invoice_number
     JOIN amc_contracts c ON c.id = v.amc_contract_id
     LEFT JOIN LATERAL (
       SELECT i.id FROM invoice_allocations al JOIN invoices i ON i.id = al.invoice_id
       WHERE al.amc_visit_id = v.id AND i.status <> 'CANCELLED' AND lower(i.invoice_number) = lower(s.invoice_number) AND i.client_id = ai.client_id
     ) z ON true
     WHERE ai.basis = 'SERVICE' AND ai.merged_into_id IS NULL AND ${IN_SCOPE}
     GROUP BY ai.id
     HAVING count(*) = count(z.id) AND count(DISTINCT z.id) = 1
     ORDER BY ai.id`
  );

  for (const row of candidates.rows) {
    const existing = await liveZohoInvoice(db, row.zoho_id);

    if (!existing) {
      await db.query("UPDATE ack_invoices SET basis = 'ZOHO', zoho_invoice_id = $2 WHERE id = $1", [row.id, row.zoho_id]);
      continue;
    }
    // Joining an invoice that already has its own acknowledgement work would choose between them: left for a user.
    if (row.current_substantive || row.conflict) continue;

    const moved = await db.query<{ amc_visit_id: string }>("UPDATE ack_invoice_services SET ack_invoice_id = $2 WHERE ack_invoice_id = $1 RETURNING amc_visit_id", [row.id, existing]);
    await db.query("UPDATE ack_invoices SET merged_into_id = $2, current_acknowledgement_id = NULL WHERE id = $1", [row.id, existing]);
    await logActivity(db, {
      userId: null,
      action: "invoice_acknowledgement.invoice_verified",
      module: MODULE,
      entityType: "ack_invoices",
      entityId: existing,
      description: `Invoice Tracking now records this invoice: ${moved.rowCount} service(s) of invoice record ${row.id} joined it.`,
      metadata: { from: row.id, into: existing, zohoInvoiceId: row.zoho_id, visits: moved.rows.map((r) => r.amc_visit_id) },
    });
  }
}

/** The live invoice of an association (following reconciliation merges). */
async function liveInvoiceOf(db: PoolClient, invoiceId: string): Promise<string> {
  let id = invoiceId;
  for (let i = 0; i < 50; i++) {
    const next = (await db.query<{ merged_into_id: string | null }>("SELECT merged_into_id FROM ack_invoices WHERE id = $1", [id])).rows[0]?.merged_into_id;
    if (!next) return id;
    id = next;
  }
  return id;
}

/** Step 3: 0112 acknowledgements (one per service) adopted into their invoices. */
async function adoptLegacyAcknowledgements(db: PoolClient): Promise<void> {
  const legacy = await db.query<{ id: string; amc_visit_id: string; invoice_number: string; client_id: string }>(
    `SELECT a.id, a.amc_visit_id, a.invoice_number, c.client_id
     FROM invoice_acknowledgements a JOIN amc_visits_all v ON v.id = a.amc_visit_id JOIN amc_contracts_all c ON c.id = v.amc_contract_id
     WHERE a.ack_invoice_id IS NULL ORDER BY a.id`
  );
  const touched = new Set<string>();

  for (const ack of legacy.rows) {
    let association = (
      await db.query<{ ack_invoice_id: string }>("SELECT ack_invoice_id FROM ack_invoice_services WHERE amc_visit_id = $1 AND invoice_number = $2", [ack.amc_visit_id, ack.invoice_number])
    ).rows[0]?.ack_invoice_id;

    // The service no longer carries this number (or is outside the page): it still gets its own invoice record, as history.
    if (!association) {
      association = await createInvoice(db, ack.client_id, ack.invoice_number, null);
      await db.query("INSERT INTO ack_invoice_services (ack_invoice_id, amc_visit_id, invoice_number, basis) VALUES ($1, $2, $3, 'SERVICE')", [association, ack.amc_visit_id, ack.invoice_number]);
    }

    const invoiceId = await liveInvoiceOf(db, association);

    await db.query("UPDATE invoice_acknowledgements SET ack_invoice_id = $2 WHERE id = $1", [ack.id, invoiceId]);
    await logActivity(db, {
      userId: null,
      action: "invoice_acknowledgement.adopted",
      module: MODULE,
      entityType: "invoice_acknowledgements",
      entityId: ack.id,
      description: `Service-level acknowledgement of Invoice ${ack.invoice_number} (service ${ack.amc_visit_id}) attached to its invoice record ${invoiceId}. Its documents, status and dates are unchanged.`,
      metadata: { ackInvoiceId: invoiceId, visitId: ack.amc_visit_id, invoiceNumber: ack.invoice_number },
    });
    touched.add(invoiceId);
  }

  for (const invoiceId of touched) await settleCurrent(db, invoiceId, null);
}

/**
 * Decides the current acknowledgement of an invoice from its family's acknowledgements with substance: none -> keep
 * the current one; exactly one -> it; two or more -> none, flagged for an authorised choice. Returns the outcome.
 */
export async function settleCurrent(db: PoolClient, invoiceId: string, userId: string | null): Promise<"KEPT" | "SET" | "CONFLICT"> {
  const substantive = await db.query<{ id: string }>(
    `SELECT a.id FROM invoice_acknowledgements a WHERE a.ack_invoice_id IN ${FAMILY_SQL("$1")} AND ${SUBSTANTIVE_SQL("a")} ORDER BY a.id`,
    [invoiceId]
  );
  const ids = substantive.rows.map((row) => row.id);
  const current = (await db.query<{ current_acknowledgement_id: string | null }>("SELECT current_acknowledgement_id FROM ack_invoices WHERE id = $1", [invoiceId])).rows[0]?.current_acknowledgement_id ?? null;

  if (ids.length === 0) return "KEPT";
  if (ids.length === 1) {
    if (current === ids[0]) return "KEPT";
    // A pointer elsewhere in the family is released first: one invoice per current acknowledgement.
    await db.query("UPDATE ack_invoices SET current_acknowledgement_id = NULL WHERE current_acknowledgement_id = $1 AND id <> $2", [ids[0], invoiceId]);
    await db.query("UPDATE ack_invoices SET current_acknowledgement_id = $2, acknowledgement_conflict = false WHERE id = $1", [invoiceId, ids[0]]);
    return "SET";
  }

  await db.query("UPDATE ack_invoices SET current_acknowledgement_id = NULL, acknowledgement_conflict = true WHERE id = $1", [invoiceId]);
  await logActivity(db, {
    userId,
    action: "invoice_acknowledgement.conflict_flagged",
    module: MODULE,
    entityType: "ack_invoices",
    entityId: invoiceId,
    description: `${ids.length} acknowledgements with documents or confirmations belong to this invoice. None is chosen automatically; an authorised user must choose the current one. All are kept.`,
    metadata: { acknowledgementIds: ids },
  });
  return "CONFLICT";
}

/**
 * Runs the three steps in one transaction under the advisory lock. `target` names another pool (the upgrade
 * rehearsal tests run it on their own schema); by default the application's.
 */
export async function syncInvoices(target?: Pool): Promise<void> {
  const run = async (db: PoolClient) => {
    await db.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
    await associateNewServices(db);
    await verifyServiceInvoices(db);
    await adoptLegacyAcknowledgements(db);
  };

  if (!target) return withTransaction(run);

  const client = await target.connect();
  try {
    await client.query("BEGIN");
    await run(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
