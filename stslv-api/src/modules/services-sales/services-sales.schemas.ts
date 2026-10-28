import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { idSchema } from "../../shared/validation";

/**
 * The completion state Services Sales shows. Read from the visit's own status,
 * never stored, and never changed here: Service Status completes a visit.
 *   COMPLETED      the visit is completed.
 *   NOT_COMPLETED  scheduled, in progress or postponed (also when Service
 *                  Status shows it as waiting for renewal: it is not completed).
 * Cancelled and historical visits are not on the page.
 */
export const SERVICE_STATUSES = ["NOT_COMPLETED", "COMPLETED"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/**
 * The sales classification of a visit, derived on read:
 *   NOT_COMPLETED  not completed, whether or not a quotation number is recorded.
 *   QUOTE_PENDING  completed, no quotation number.
 *   QUOTED         completed, with a quotation number.
 */
export const SALES_STATUSES = ["NOT_COMPLETED", "QUOTE_PENDING", "QUOTED"] as const;
export type SalesStatus = (typeof SALES_STATUSES)[number];

const page = z.coerce.number().int().min(1).default(1);
const MONTH_MESSAGE = "Month must be a number from 1 to 12.";
const YEAR_MESSAGE = "Year must be between 2000 and 2100.";

export const listServicesSalesSchema = z.object({
  // AMC reference ("AMC-0007"), client, system, service code or quotation number.
  search: z.string().trim().max(200).optional(),
  clientId: idSchema.optional(),
  salesEngineerId: idSchema.optional(),
  systemTypeId: idSchema.optional(),
  frequency: z
    .string({ error: "Select a maintenance frequency." })
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,29}$/, "Select a maintenance frequency.")
    .optional(),
  // Month and year of the scheduled date. Either may be left out: all months, or that month in every year.
  month: z.coerce.number({ error: MONTH_MESSAGE }).int().min(1, MONTH_MESSAGE).max(12, MONTH_MESSAGE).optional(),
  year: z.coerce.number({ error: YEAR_MESSAGE }).int().min(2000, YEAR_MESSAGE).max(2100, YEAR_MESSAGE).optional(),
  serviceStatus: z.enum(SERVICE_STATUSES, { error: "Select Completed or Not Completed." }).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The page's own filters, without paging, plus the file format. */
export const exportServicesSalesSchema = listServicesSalesSchema.omit({ page: true, pageSize: true }).extend({ format: exportFormatSchema });

export const QUOTATION_MAX_LENGTH = 50;
const QUOTATION_MESSAGE = `Quotation number must be at most ${QUOTATION_MAX_LENGTH} characters, without line breaks.`;

export const saveQuotationSchema = z.strictObject({
  // Empty or null clears it. "N/A" is the page's placeholder for "none", never a number.
  quotationNo: z
    .string({ error: QUOTATION_MESSAGE })
    .trim()
    .max(QUOTATION_MAX_LENGTH, QUOTATION_MESSAGE)
    .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), QUOTATION_MESSAGE)
    .refine((value) => !/^n\/?a$/i.test(value), "N/A is not a quotation number. Leave the field empty when there is none.")
    .transform((value) => (value === "" ? null : value))
    .nullable(),
  // The updatedAt the page showed. A save over a newer change is refused, so one person cannot silently overwrite another.
  expectedUpdatedAt: z.string({ error: "Reload the page and try again." }).datetime({ offset: true, error: "Reload the page and try again." }),
});

export type ListServicesSalesQuery = z.infer<typeof listServicesSalesSchema>;
export type ExportServicesSalesQuery = z.infer<typeof exportServicesSalesSchema>;
export type SaveQuotationInput = z.infer<typeof saveQuotationSchema>;
