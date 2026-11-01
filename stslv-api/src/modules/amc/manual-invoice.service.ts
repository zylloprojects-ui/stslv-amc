import { z } from "zod";
import { logActivity } from "../../shared/activity-log";
import { withTransaction, type Queryable } from "../../shared/db";
import { conflict, notFound } from "../../shared/errors";
import type { AuthContext } from "../auth/access";

// The manual Invoice No. of a scheduled service. Approved rule: a number entered
// means Paid, cleared means Unpaid. No invoice is generated, no VAT is
// calculated and neither a date nor an amount is asked for. It is a reference
// status, not verification that money was received, and it is independent of the
// service status and of the Zoho invoices in Invoice Tracking.

/** Shown wherever Paid or Unpaid appears, so nobody reads it as a bank-verified payment. */
export const PAID_STATUS_NOTE = "Paid means a manual Invoice No. is entered on the service. It is a reference status and does not verify that money was received.";

export type PaymentStatus = "PAID" | "UNPAID";

export const PAYMENT_STATUS_SQL = "(CASE WHEN v.manual_invoice_no IS NULL THEN 'UNPAID' ELSE 'PAID' END)";

export const setManualInvoiceSchema = z.strictObject({
  invoiceNo: z
    .string({ error: "Enter the Invoice No., or clear it." })
    .trim()
    .max(50, "An Invoice No. has at most 50 characters.")
    .nullable()
    .transform((value) => (value === "" ? null : value)),
  expectedUpdatedAt: z.string({ error: "Reload the page and try again." }).datetime({ offset: true, error: "Reload the page and try again." }),
});
export type SetManualInvoiceInput = z.infer<typeof setManualInvoiceSchema>;

export interface ManualInvoiceResult {
  id: string;
  manualInvoiceNo: string | null;
  paymentStatus: PaymentStatus;
  paidAt: string | null;
  updatedAt: string;
}

export async function setManualInvoice(auth: AuthContext, id: string, input: SetManualInvoiceInput): Promise<ManualInvoiceResult> {
  return withTransaction(async (client) => {
    const found = await client.query<{
      status: string;
      sequence_no: number;
      manual_invoice_no: string | null;
      same: boolean;
      client_name: string;
      system_description: string;
    }>(
      `SELECT v.status, v.sequence_no, v.manual_invoice_no, cl.name AS client_name, c.system_description,
              date_trunc('milliseconds', $2::timestamptz) = date_trunc('milliseconds', v.updated_at) AS same
       FROM amc_visits v
       JOIN amc_contracts c ON c.id = v.amc_contract_id
       JOIN clients cl ON cl.id = c.client_id
       WHERE v.id = $1
       FOR UPDATE OF v`,
      [id, input.expectedUpdatedAt]
    );
    const row = found.rows[0];

    if (!row) {
      throw notFound("AMC visit not found.");
    }
    if (row.status === "HISTORICAL" || row.status === "CANCELLED") {
      throw conflict(`This visit is ${row.status === "HISTORICAL" ? "a historical record" : "cancelled"}, so its Invoice No. cannot be changed.`);
    }
    if (!row.same) {
      throw conflict("This service was changed by someone else after the page was loaded. Reload to see the latest values, then save again.");
    }

    if (row.manual_invoice_no !== input.invoiceNo) {
      await client.query(
        `UPDATE amc_visits
         SET manual_invoice_no = $1::text,
             -- Correcting a number keeps the original date: the service did not become Paid again.
             manual_invoice_at = CASE WHEN $1::text IS NULL THEN NULL ELSE COALESCE(manual_invoice_at, now()) END,
             manual_invoice_by = CASE WHEN $1::text IS NULL THEN NULL ELSE $2::bigint END,
             updated_by = $2
         WHERE id = $3`,
        [input.invoiceNo, auth.user.id, id]
      );
      await logActivity(client, {
        userId: auth.user.id,
        action: "amc_visit.manual_invoice_changed",
        module: "INVOICES",
        entityType: "amc_visits",
        entityId: id,
        description: `Manual Invoice No. of AMC visit ${row.sequence_no} for "${row.client_name}" (${row.system_description}) ${
          input.invoiceNo ? `set to ${input.invoiceNo}: reference status Paid` : "cleared: reference status Unpaid"
        }.`,
        metadata: { changes: { manualInvoiceNo: { from: row.manual_invoice_no, to: input.invoiceNo } } },
      });
    }

    return readResult(client, id);
  });
}

async function readResult(db: Queryable, id: string): Promise<ManualInvoiceResult> {
  const result = await db.query<{ manual_invoice_no: string | null; manual_invoice_at: Date | null; updated_at: Date }>(
    "SELECT manual_invoice_no, manual_invoice_at, updated_at FROM amc_visits WHERE id = $1",
    [id]
  );
  const row = result.rows[0];

  if (!row) {
    throw notFound("AMC visit not found.");
  }

  return {
    id,
    manualInvoiceNo: row.manual_invoice_no,
    paymentStatus: row.manual_invoice_no ? "PAID" : "UNPAID",
    paidAt: row.manual_invoice_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A paid service keeps its amount: it must not change underneath the recorded number. */
export async function assertVisitNotPaid(db: Queryable, id: string, action: string): Promise<void> {
  const result = await db.query<{ manual_invoice_no: string | null }>("SELECT manual_invoice_no FROM amc_visits WHERE id = $1", [id]);
  const number = result.rows[0]?.manual_invoice_no;

  if (number) {
    throw conflict(`This visit cannot be ${action}: it is Paid with Invoice No. ${number}. Clear the Invoice No. first.`);
  }
}
