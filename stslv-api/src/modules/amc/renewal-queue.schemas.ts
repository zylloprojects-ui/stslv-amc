import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";

/**
 * The renewal state of a contract on the AMC Renewal queue, derived on read
 * from the contract and the renewals made of it (migration 0072). Never stored,
 * and never written to the contract's own status. The first rule that applies wins:
 *   UNDER_APPROVAL  a renewal that is not cancelled exists and is still a draft.
 *   RENEWED         a renewal that is not cancelled exists and is active or expired.
 *   CANCELLED       every renewal made of it was cancelled (e.g. the client declined).
 *                   It stays here until a new renewal is started.
 *   DUE             no renewal at all; the contract is active or expired and ends
 *                   within RENEWAL_WARNING_DAYS days or has already ended.
 * A contract matching none of these is not on the queue.
 */
export const RENEWAL_STATES = ["DUE", "UNDER_APPROVAL", "RENEWED", "CANCELLED"] as const;
export type RenewalState = (typeof RENEWAL_STATES)[number];

/** The columns a user may hide. AMC Reference and the actions always stay. */
export const RENEWAL_QUEUE_HIDEABLE_COLUMNS = [
  "client",
  "system",
  "frequency",
  "service",
  "expiry",
  "contractStatus",
  "amount",
  "remarks",
] as const;
export type RenewalQueueColumn = (typeof RENEWAL_QUEUE_HIDEABLE_COLUMNS)[number];

export const listRenewalQueueSchema = z.object({
  // AMC reference ("AMC-0007"), client or system.
  search: z.string().trim().max(200).optional(),
  renewalStatus: z.enum(RENEWAL_STATES, { error: "Select Due / Expired, Under Client Approval, Renewed or Cancelled." }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The queue's own filters, without paging, plus the file format and the columns hidden on the page. */
export const exportRenewalQueueSchema = listRenewalQueueSchema.omit({ page: true, pageSize: true }).extend({
  format: exportFormatSchema,
  hidden: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value, ctx) => {
      const ids = (value ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
      const unknown = ids.filter((id) => !(RENEWAL_QUEUE_HIDEABLE_COLUMNS as readonly string[]).includes(id));

      if (unknown.length > 0) {
        ctx.addIssue({ code: "custom", message: `Unknown column: ${unknown.join(", ")}.` });
        return z.NEVER;
      }
      return [...new Set(ids)] as RenewalQueueColumn[];
    }),
});

/** Renewal History as a file: every renewal made, newest first. */
export const exportRenewalHistorySchema = z.object({ format: exportFormatSchema });

export type ListRenewalQueueQuery = z.infer<typeof listRenewalQueueSchema>;
export type ExportRenewalQueueQuery = z.infer<typeof exportRenewalQueueSchema>;
export type ExportRenewalHistoryQuery = z.infer<typeof exportRenewalHistorySchema>;
