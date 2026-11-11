import { holdsPermission } from "../../shared/permissions";
import { schemaHas } from "../../shared/schema-features";
import type { AuthContext } from "../auth/access";

// The acknowledgement state of ONE service's invoice, for the service-level views (Master AMC Status, Service Status,
// Contract 360), added 2026-11-11. Read-only: it changes no acknowledgement, invoice, Invoice No. or service status,
// and runs no invoice sync. It reads the Invoice Acknowledgements records (0112-0116) exactly as that module does:
//
//   * no manual Invoice No. on the service            -> NOT_APPLICABLE (no invoice to acknowledge; neutral)
//   * the invoice's current acknowledgement confirmed -> ACKNOWLEDGED   ("Yes", green). Confirmation requires the
//                                                         uploaded document and checks it (0112 guard, OK / Confirm).
//   * a document uploaded but not yet confirmed       -> AWAITING_CONFIRMATION ("No", red, with that note)
//   * anything else, including an invoice the module  -> PENDING        ("No", red)
//     has not linked yet
//
// An Invoice No. alone never makes a service acknowledged. A shared Invoice No. is one invoice (ack_invoices): every
// service linked to it reads the same state. The service's own link (ack_invoice_services) is followed, which
// reconciliation moves when invoices are linked, so a linked-away invoice is never read.

export type ServiceAcknowledgementState = "NOT_APPLICABLE" | "PENDING" | "AWAITING_CONFIRMATION" | "ACKNOWLEDGED";

export interface ServiceAcknowledgement {
  state: ServiceAcknowledgementState;
  /** The Yes / No / Not Applicable reading: Yes only when ACKNOWLEDGED. */
  acknowledged: "YES" | "NO" | "NOT_APPLICABLE";
  /** The Invoice Acknowledgements invoice id, for the private document download; null when not linked yet. */
  invoiceId: string | null;
  /** A current acknowledgement document is on file (download: GET /api/invoice-acknowledgements/:invoiceId/document). */
  documentAvailable: boolean;
  /** When it was confirmed (ISO); null unless acknowledged. */
  acknowledgedAt: string | null;
  /** The invoice holds conflicting acknowledgements and needs reconciliation in Invoice Acknowledgements. */
  needsReconciliation: boolean;
}

/** SQL (a jsonb value, or NULL when there is no Invoice No.) for the visit aliased `v`. */
export const SERVICE_ACKNOWLEDGEMENT_SQL = `CASE WHEN v.manual_invoice_no IS NULL THEN NULL ELSE COALESCE((
    SELECT jsonb_build_object(
             'invoiceId', ai.id::text,
             'status', ca.status,
             'acknowledgedAt', ca.acknowledged_at,
             'conflict', ai.acknowledgement_conflict,
             'document', EXISTS (SELECT 1 FROM attachments d WHERE d.entity_type = 'invoice_acknowledgements' AND d.entity_id = ca.id AND d.is_current))
    FROM ack_invoice_services s
    JOIN ack_invoices ai ON ai.id = s.ack_invoice_id AND ai.merged_into_id IS NULL
    LEFT JOIN invoice_acknowledgements ca ON ca.id = ai.current_acknowledgement_id
    WHERE s.amc_visit_id = v.id AND s.invoice_number = v.manual_invoice_no
    LIMIT 1), '{}'::jsonb) END`;

interface StoredAcknowledgement {
  invoiceId?: string;
  status?: string | null;
  acknowledgedAt?: string | null;
  conflict?: boolean;
  document?: boolean;
}

/** The API reading of SERVICE_ACKNOWLEDGEMENT_SQL's value. */
export function toServiceAcknowledgement(value: unknown): ServiceAcknowledgement {
  if (value === null || value === undefined) {
    return { state: "NOT_APPLICABLE", acknowledged: "NOT_APPLICABLE", invoiceId: null, documentAvailable: false, acknowledgedAt: null, needsReconciliation: false };
  }
  const stored = value as StoredAcknowledgement;
  const documentAvailable = stored.document === true;
  const state: ServiceAcknowledgementState =
    stored.status === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : documentAvailable ? "AWAITING_CONFIRMATION" : "PENDING";

  return {
    state,
    acknowledged: state === "ACKNOWLEDGED" ? "YES" : "NO",
    invoiceId: stored.invoiceId ?? null,
    documentAvailable,
    acknowledgedAt: state === "ACKNOWLEDGED" && stored.acknowledgedAt ? new Date(stored.acknowledgedAt).toISOString() : null,
    needsReconciliation: stored.conflict === true,
  };
}

/** The Yes / No / Not Applicable wording of a state, for exports. */
export function acknowledgedLabel(acknowledgement: ServiceAcknowledgement): string {
  if (acknowledgement.acknowledged === "YES") return "Yes";
  if (acknowledgement.acknowledged === "NOT_APPLICABLE") return "Not Applicable";
  return acknowledgement.state === "AWAITING_CONFIRMATION" ? "No (document awaiting confirmation)" : "No";
}

/**
 * Whether the acknowledgement state is shown to this user: Invoice Acknowledgements: View (as on Accounts), on a
 * database that has the acknowledgement tables. Without it the field is never sent.
 */
export async function serviceAcknowledgementsVisible(auth: Pick<AuthContext, "permissions"> | null | undefined): Promise<boolean> {
  if (!auth?.permissions || !holdsPermission(auth.permissions, "INVOICE_ACKNOWLEDGEMENTS:VIEW")) return false;

  // The same check as Accounts' indicator (0114 creates both tables).
  return schemaHas(["ack_invoices", "ack_invoice_services"]);
}
