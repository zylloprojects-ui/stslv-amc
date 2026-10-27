import { z } from "zod";
import { dateSchema, pagingSchema } from "../../shared/money";
import { idSchema } from "../../shared/validation";

const dateRange = {
  // Both ends included, as calendar days in the database's time zone.
  from: dateSchema("From date").optional(),
  to: dateSchema("To date").optional(),
};

export const listLoginsSchema = z.object({
  outcome: z.enum(["SUCCESS", "FAILED"]).optional(),
  userId: idSchema.optional(),
  // Matches the user's name or email, or the network address.
  search: z.string().trim().max(200).optional(),
  ...dateRange,
  ...pagingSchema,
});

export const listActivitySchema = z.object({
  module: z
    .string()
    .trim()
    .regex(/^[A-Z_]{1,40}$/, "Select a module.")
    .optional(),
  userId: idSchema.optional(),
  entityType: z
    .string()
    .trim()
    .regex(/^[a-z_]{1,60}$/, "Select a record type.")
    .optional(),
  entityId: idSchema.optional(),
  // Matches the action or the description.
  search: z.string().trim().max(200).optional(),
  ...dateRange,
  ...pagingSchema,
});

export type ListLoginsQuery = z.infer<typeof listLoginsSchema>;
export type ListActivityQuery = z.infer<typeof listActivitySchema>;
