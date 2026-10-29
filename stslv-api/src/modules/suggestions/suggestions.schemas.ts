import { z } from "zod";
import { dateSchema, pagingSchema } from "../../shared/money";
import { idSchema, requiredText } from "../../shared/validation";
import { CATEGORIES, STATUSES } from "./suggestions.workflow";

const longText = (label: string, min: number) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .min(min, min > 1 ? `${label} must be at least ${min} characters.` : `${label} is required.`)
    .max(4000, `${label} must be at most 4000 characters.`);

/** An optional note: trimmed; empty means none. */
const optionalNote = z
  .string()
  .trim()
  .max(4000, "Note must be at most 4000 characters.")
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

export const createSuggestionSchema = z.object({
  category: z.enum(CATEGORIES, { error: "Select a type." }),
  subject: requiredText("Subject", 150).refine((value) => value.length >= 3, "Subject must be at least 3 characters."),
  description: longText("Description", 10),
  // The page the popup was opened on. Only a path inside the application is kept.
  pagePath: z
    .string()
    .trim()
    .max(300)
    .regex(/^\/[^\s]*$/, "Must be an application path.")
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  // Sent by the browser so a repeated request does not create a second suggestion.
  requestId: z.uuid("Must be a valid request id.").optional(),
});

const listFilters = {
  status: z.enum(STATUSES).optional(),
  category: z.enum(CATEGORIES).optional(),
  // Subject, description or reference (SUG-00042).
  search: z.string().trim().max(200).optional(),
  ...pagingSchema,
};

export const listMineSchema = z.object(listFilters);

export const listManageSchema = z.object({
  ...listFilters,
  // OPEN: every status still needing attention (Submitted, Under Review, In Progress, Reopened).
  view: z.enum(["ALL", "OPEN"]).default("ALL"),
  submittedBy: idSchema.optional(),
  // A user id, or "none" for unassigned suggestions.
  assignedTo: z.union([idSchema, z.literal("none")]).optional(),
  from: dateSchema("From date").optional(),
  to: dateSchema("To date").optional(),
});

export const changeStatusSchema = z.object({
  status: z.enum(STATUSES, { error: "Select a status." }),
  // The status the caller saw. When it has changed meanwhile, the change is refused (409).
  fromStatus: z.enum(STATUSES, { error: "The current status is required." }),
  // The resolution when resolving; the reason when closing early or reopening; otherwise an optional note.
  note: optionalNote,
});

export const reopenSchema = z.object({
  fromStatus: z.enum(STATUSES, { error: "The current status is required." }),
  reason: longText("Reason", 1),
});

export const commentSchema = z.object({
  body: longText("Comment", 1),
  // Reviewers only: a note the submitter does not see.
  internal: z.boolean().default(false),
});

export const assignSchema = z.object({
  assignedTo: idSchema.nullable(),
});

export type CreateSuggestionInput = z.infer<typeof createSuggestionSchema>;
export type ListMineQuery = z.infer<typeof listMineSchema>;
export type ListManageQuery = z.infer<typeof listManageSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
export type ReopenInput = z.infer<typeof reopenSchema>;
export type CommentInput = z.infer<typeof commentSchema>;
export type AssignInput = z.infer<typeof assignSchema>;
