import { z } from "zod";

export const RECORD_KINDS = ["CLIENT", "AMC_CONTRACT", "AMC_VISIT", "PROJECT"] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export const listRowsSchema = z.object({
  kind: z.enum(["all", ...RECORD_KINDS]).default("all"),
  // imported: the record is in the normal application. provisional: it is held, in staging only.
  status: z.enum(["all", "imported", "provisional"]).default("all"),
  /** A hold reason code, for example DUPLICATE_JOB_NUMBER. */
  reason: z
    .string()
    .trim()
    .regex(/^[A-Z_]{1,60}$/, "Must be a reason code.")
    .optional(),
  /** with: the source row has an invoice cell that is not blank. shared: its invoice is on more than one record, or it lists several. */
  invoice: z.enum(["all", "with", "shared", "marker"]).default("all"),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type ListRowsQuery = z.infer<typeof listRowsSchema>;
