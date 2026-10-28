import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { idSchema } from "../../shared/validation";

/**
 * The row colour of Accounts, derived on read and never stored. The first rule that applies wins:
 *   RED    the service is not completed (Service Status "Not Completed" or "Waiting for Renewal").
 *   BLUE   completed, and no active (not cancelled) invoice covers it.
 *   GREEN  completed, and at least one active invoice covers it.
 * An invoice number is not a payment: GREEN says nothing about money received.
 * Kept apart from Master AMC Status's four colours, which also look at the quotation number.
 */
export const ACCOUNTS_COLOURS = ["RED", "BLUE", "GREEN"] as const;
export type AccountsColour = (typeof ACCOUNTS_COLOURS)[number];

/** Completion as Accounts filters it. NOT_COMPLETED includes "Waiting for Renewal": the visit is not done. */
export const ACCOUNTS_SERVICE_FILTERS = ["COMPLETED", "NOT_COMPLETED"] as const;

/**
 * Whether an active invoice is recorded against the visit. Payment is not
 * tracked anywhere in STSLV AMC, so this is the most precise invoice status
 * there is; it is never presented as paid / unpaid.
 */
export const ACCOUNTS_INVOICE_FILTERS = ["RECORDED", "NOT_RECORDED"] as const;

/** The columns a user may hide. AMC Reference, the row colour and the actions always stay. */
export const ACCOUNTS_HIDEABLE_COLUMNS = [
  "client",
  "system",
  "frequency",
  "service",
  "scheduledMonth",
  "visitValue",
  "serviceStatus",
  "serviceReportNo",
  "invoiceNo",
  "payment",
  "salesEngineer",
] as const;
export type AccountsColumn = (typeof ACCOUNTS_HIDEABLE_COLUMNS)[number];

const MONTH_MESSAGE = "Month must be a number from 1 to 12.";
const YEAR_MESSAGE = "Year must be between 2000 and 2100.";

export const listAccountsSchema = z.object({
  // AMC reference ("AMC-0007"), client, invoice number or service report number.
  search: z.string().trim().max(200).optional(),
  clientId: idSchema.optional(),
  salesEngineerId: idSchema.optional(),
  // Month and year of the scheduled date. Either may be left out: all months, or that month in every year.
  month: z.coerce.number({ error: MONTH_MESSAGE }).int().min(1, MONTH_MESSAGE).max(12, MONTH_MESSAGE).optional(),
  year: z.coerce.number({ error: YEAR_MESSAGE }).int().min(2000, YEAR_MESSAGE).max(2100, YEAR_MESSAGE).optional(),
  serviceStatus: z.enum(ACCOUNTS_SERVICE_FILTERS, { error: "Select Completed or Not Completed." }).optional(),
  invoiceStatus: z.enum(ACCOUNTS_INVOICE_FILTERS, { error: "Select Invoice recorded or No invoice recorded." }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The page's own filters, without paging, plus the file format and the columns hidden on the page. */
export const exportAccountsSchema = listAccountsSchema.omit({ page: true, pageSize: true }).extend({
  format: exportFormatSchema,
  hidden: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value, ctx) => {
      const ids = (value ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
      const unknown = ids.filter((id) => !(ACCOUNTS_HIDEABLE_COLUMNS as readonly string[]).includes(id));

      if (unknown.length > 0) {
        ctx.addIssue({ code: "custom", message: `Unknown column: ${unknown.join(", ")}.` });
        return z.NEVER;
      }
      return [...new Set(ids)] as AccountsColumn[];
    }),
});

export type ListAccountsQuery = z.infer<typeof listAccountsSchema>;
export type ExportAccountsQuery = z.infer<typeof exportAccountsSchema>;
