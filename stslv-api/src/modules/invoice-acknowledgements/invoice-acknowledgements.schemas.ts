import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { idSchema } from "../../shared/validation";

/** Pending: no confirmed acknowledgement (no document yet, or one attached and awaiting OK / Confirm). Acknowledged: confirmed. */
export const ACKNOWLEDGEMENT_STATUSES = ["PENDING", "ACKNOWLEDGED"] as const;
export type AcknowledgementStatus = (typeof ACKNOWLEDGEMENT_STATUSES)[number];

/**
 * Which date the date range filters. INVOICE_DATE is the date of the Zoho invoice in Invoice Tracking with the same
 * number (only where one exists: a manual Invoice No. carries no date); ACKNOWLEDGED_DATE is the Oman date of confirmation.
 */
export const ACKNOWLEDGEMENT_DATE_BASES = ["INVOICE_DATE", "ACKNOWLEDGED_DATE"] as const;

/** The columns the list may be sorted by. Amounts are not offered: a role may be shown none. */
export const ACKNOWLEDGEMENT_SORTS = ["reference", "client", "invoiceNo", "invoiceDate", "status", "acknowledgedAt"] as const;
export type AcknowledgementSort = (typeof ACKNOWLEDGEMENT_SORTS)[number];

/** The columns a user may hide. AMC Contract, Invoice No., Acknowledgement Status and the actions always stay. */
export const ACKNOWLEDGEMENT_HIDEABLE_COLUMNS = [
  "client",
  "service",
  "serviceReportNo",
  "invoiceDate",
  "serviceValue",
  "invoiceValue",
  "acknowledgedAt",
  "uploadedBy",
  "document",
] as const;
export type AcknowledgementColumn = (typeof ACKNOWLEDGEMENT_HIDEABLE_COLUMNS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateSchema = z
  .string()
  .trim()
  .regex(DATE, "Enter a date as YYYY-MM-DD.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), "Enter a real date.");

const filtersShape = z.object({
  // AMC contract number, client, invoice number, service report number or document name.
  search: z.string().trim().max(200).optional(),
  clientId: idSchema.optional(),
  contractId: idSchema.optional(),
  invoiceNo: z.string().trim().max(50).optional(),
  status: z.enum(ACKNOWLEDGEMENT_STATUSES, { error: "Select Pending or Acknowledged." }).optional(),
  dateBasis: z.enum(ACKNOWLEDGEMENT_DATE_BASES, { error: "Select Invoice Date or Acknowledged Date." }).default("INVOICE_DATE"),
  fromDate: dateSchema.optional(),
  toDate: dateSchema.optional(),
  sort: z.enum(ACKNOWLEDGEMENT_SORTS, { error: "Unknown sort column." }).optional(),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const rangeIsOrdered = (value: { fromDate?: string | undefined; toDate?: string | undefined }) =>
  !value.fromDate || !value.toDate || value.fromDate <= value.toDate;
const RANGE_MESSAGE = { message: "The From date must be on or before the To date.", path: ["toDate"] };

export const listAcknowledgementsSchema = filtersShape
  .extend({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine(rangeIsOrdered, RANGE_MESSAGE);

/** The page's own filters, without paging, plus the file format and the columns hidden on the page. */
export const exportAcknowledgementsSchema = filtersShape
  .extend({
    format: exportFormatSchema,
    hidden: z
      .string()
      .trim()
      .max(500)
      .optional()
      .transform((value, ctx) => {
        const ids = (value ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
        const unknown = ids.filter((id) => !(ACKNOWLEDGEMENT_HIDEABLE_COLUMNS as readonly string[]).includes(id));

        if (unknown.length > 0) {
          ctx.addIssue({ code: "custom", message: `Unknown column: ${unknown.join(", ")}.` });
          return z.NEVER;
        }
        return [...new Set(ids)] as AcknowledgementColumn[];
      }),
  })
  .refine(rangeIsOrdered, RANGE_MESSAGE);

/** OK / Confirm names the exact document the user saw, so a document changed by someone else meanwhile is never confirmed. */
export const confirmAcknowledgementSchema = z.strictObject({
  attachmentId: idSchema,
});

export const REPLACE_REASON_MIN = 3;
export const REPLACE_REASON_MAX = 500;

export const replaceReasonSchema = z
  .string({ error: "Give the reason for replacing the acknowledgement document." })
  .trim()
  .min(REPLACE_REASON_MIN, `Give the reason for replacing the acknowledgement document (at least ${REPLACE_REASON_MIN} characters).`)
  .max(REPLACE_REASON_MAX, `The reason has at most ${REPLACE_REASON_MAX} characters.`);

export type ListAcknowledgementsQuery = z.infer<typeof listAcknowledgementsSchema>;
export type ExportAcknowledgementsQuery = z.infer<typeof exportAcknowledgementsSchema>;
export type AcknowledgementFilters = z.infer<typeof filtersShape>;
