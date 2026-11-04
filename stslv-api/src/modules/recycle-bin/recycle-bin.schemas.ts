import { z } from "zod";
import { dateSchema, pagingSchema } from "../../shared/money";
import { idSchema } from "../../shared/validation";
import { RECYCLE_TYPES } from "./recycle-bin.kinds";

export const listRecycleBinSchema = z.object({
  type: z.enum(RECYCLE_TYPES, { error: "Select a record type." }).optional(),
  search: z.string().trim().max(200).optional(),
  deletedBy: idSchema.optional(),
  from: dateSchema("From date").optional(),
  to: dateSchema("To date").optional(),
  ...pagingSchema,
});

export type ListRecycleBinQuery = z.infer<typeof listRecycleBinSchema>;

/** The :type segment of the Recycle Bin item routes. */
const TYPE_SEGMENTS = {
  "amc-contracts": "AMC_CONTRACT",
  clients: "CLIENT",
  "system-types": "SYSTEM_TYPE",
  "sales-engineers": "SALES_ENGINEER",
} as const;

export const recycleTypeParamSchema = z
  .enum(Object.keys(TYPE_SEGMENTS) as [keyof typeof TYPE_SEGMENTS, ...(keyof typeof TYPE_SEGMENTS)[]], { error: "Unknown record type." })
  .transform((segment) => TYPE_SEGMENTS[segment]);

export const purgeSchema = z.object({
  confirm: z.string({ error: "Type the code to confirm." }).trim().min(1, "Type the code to confirm.").max(100),
});
