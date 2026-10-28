import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { idSchema } from "../../shared/validation";
import { SERVICE_STATUSES } from "./amc.constants";

/**
 * The row colour of Master AMC Status, derived on read and never stored.
 * The first rule that applies wins:
 *   RED     the service is not completed (Service Status "Not Completed" or "Waiting for Renewal").
 *   YELLOW  completed, no active (not cancelled) invoice covers it.
 *   BLUE    completed and invoiced, no quotation number recorded.
 *   GREEN   completed, invoiced and with a quotation number.
 * An invoice number is not a payment: GREEN says nothing about money received.
 */
export const ROW_COLOURS = ["RED", "YELLOW", "BLUE", "GREEN"] as const;
export type RowColour = (typeof ROW_COLOURS)[number];

/** The columns a user may hide. AMC Reference, the row colour and the View action always stay. */
export const MASTER_STATUS_HIDEABLE_COLUMNS = [
  "client",
  "system",
  "frequency",
  "service",
  "scheduledMonth",
  "visitValue",
  "serviceStatus",
  "invoiceNo",
  "quotationNo",
  "salesEngineer",
] as const;
export type MasterStatusColumn = (typeof MASTER_STATUS_HIDEABLE_COLUMNS)[number];

const page = z.coerce.number().int().min(1).default(1);
const MONTH_MESSAGE = "Month must be a number from 1 to 12.";
const YEAR_MESSAGE = "Year must be between 2000 and 2100.";

export const listMasterStatusSchema = z.object({
  // AMC reference ("AMC-0007"), client, invoice number or quotation number.
  search: z.string().trim().max(200).optional(),
  clientId: idSchema.optional(),
  salesEngineerId: idSchema.optional(),
  // Month and year of the scheduled date. Either may be left out: all months, or that month in every year.
  month: z.coerce.number({ error: MONTH_MESSAGE }).int().min(1, MONTH_MESSAGE).max(12, MONTH_MESSAGE).optional(),
  year: z.coerce.number({ error: YEAR_MESSAGE }).int().min(2000, YEAR_MESSAGE).max(2100, YEAR_MESSAGE).optional(),
  serviceStatus: z.enum(SERVICE_STATUSES, { error: "Select a service status." }).optional(),
  colour: z.enum(ROW_COLOURS, { error: "Select Red, Yellow, Blue or Green." }).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The page's own filters, without paging, plus the file format and the columns
 * the user has hidden on the page ("client,salesEngineer"), so the file shows
 * what the table shows.
 */
export const exportMasterStatusSchema = listMasterStatusSchema.omit({ page: true, pageSize: true }).extend({
  format: exportFormatSchema,
  hidden: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value, ctx) => {
      const ids = (value ?? "").split(",").map((id) => id.trim()).filter((id) => id !== "");
      const unknown = ids.filter((id) => !(MASTER_STATUS_HIDEABLE_COLUMNS as readonly string[]).includes(id));

      if (unknown.length > 0) {
        ctx.addIssue({ code: "custom", message: `Unknown column: ${unknown.join(", ")}.` });
        return z.NEVER;
      }
      return [...new Set(ids)] as MasterStatusColumn[];
    }),
});

export type ListMasterStatusQuery = z.infer<typeof listMasterStatusSchema>;
export type ExportMasterStatusQuery = z.infer<typeof exportMasterStatusSchema>;
