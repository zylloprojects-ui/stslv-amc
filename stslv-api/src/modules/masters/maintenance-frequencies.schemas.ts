import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { pagingSchema } from "../../shared/money";
import { requiredText } from "../../shared/validation";
import { CODE_PATTERN, normalizeCode, normalizePrefix, PREFIX_PATTERN, ruleProblems } from "./maintenance-frequencies.rules";

// Maintenance frequencies (migration 0076): list, form, status and export.

const code = z
  .string({ error: "Enter an internal code." })
  .transform(normalizeCode)
  .refine((value) => value !== "", "Enter an internal code.")
  .refine((value) => CODE_PATTERN.test(value), "The internal code must be 2-30 characters: letters, digits and underscores, starting with a letter (for example EVERY_4_MONTHS).");

const codePrefix = z
  .string({ error: "Enter a service code prefix." })
  .transform(normalizePrefix)
  .refine((value) => value !== "", "Enter a service code prefix.")
  .refine((value) => PREFIX_PATTERN.test(value), "The service code prefix must be 1-4 letters (for example Q or BM).");

// Numbers as JSON numbers; null (or omitted) when they do not apply.
const ruleNumber = (label: string) =>
  z
    .number({ error: `${label} must be a whole number.` })
    .int(`${label} must be a whole number.`)
    .min(1, `${label} must be at least 1.`)
    .max(12, `${label} must be at most 12.`)
    .nullable();

const sortOrder = z
  .number({ error: "Sort order must be a whole number." })
  .int("Sort order must be a whole number.")
  .min(0, "Sort order cannot be negative.")
  .max(9999, "Sort order must be at most 9999.");

const fields = {
  name: requiredText("Name", 50),
  code,
  codePrefix,
  isCustom: z.boolean({ error: "Say whether the frequency uses custom month selection." }),
  serviceCount: ruleNumber("Services per year"),
  intervalMonths: ruleNumber("Interval"),
  sortOrder,
};

export const createFrequencySchema = z
  .strictObject({
    ...fields,
    isCustom: fields.isCustom.default(false),
    serviceCount: fields.serviceCount.default(null),
    intervalMonths: fields.intervalMonths.default(null),
    sortOrder: sortOrder.optional(),
    // A new frequency cannot start archived.
    status: z.enum(["active", "disabled"], { error: "Select Active or Disabled." }).default("active"),
  })
  .superRefine((value, context) => {
    for (const problem of ruleProblems(value)) {
      context.addIssue({ code: "custom", path: [problem.field], message: problem.message });
    }
  });

// The rule is checked in the service, against the stored record merged with the change.
export const updateFrequencySchema = z
  .strictObject({
    name: fields.name.optional(),
    code: fields.code.optional(),
    codePrefix: fields.codePrefix.optional(),
    isCustom: fields.isCustom.optional(),
    serviceCount: fields.serviceCount.optional(),
    intervalMonths: fields.intervalMonths.optional(),
    sortOrder: sortOrder.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const frequencyStatusSchema = z.strictObject({
  status: z.enum(["active", "disabled", "archived"], { error: "Select Active, Disabled or Archived." }),
  // Required when active AMC contracts use the frequency and it is being disabled or archived.
  confirm: z.boolean().optional(),
});

// "current" (the default) is Active and Disabled; archived frequencies show only when asked for.
export const FREQUENCY_LIST_STATUSES = ["current", "active", "disabled", "archived", "all"] as const;

const listFilters = {
  search: z.string().trim().max(200).optional(),
  status: z.enum(FREQUENCY_LIST_STATUSES, { error: "Select a valid status." }).default("current"),
  // Checked against the list's own sortable columns in the service.
  sort: z.string().trim().regex(/^[a-zA-Z]{1,30}$/, "Unknown sort.").optional(),
  direction: z.enum(["asc", "desc"]).default("asc"),
};

export const listFrequenciesSchema = z.object({ ...listFilters, ...pagingSchema });

export const exportFrequenciesSchema = z.object({ ...listFilters, format: exportFormatSchema });

export const frequencyPagingSchema = z.object(pagingSchema);

export type CreateFrequencyInput = z.infer<typeof createFrequencySchema>;
export type UpdateFrequencyInput = z.infer<typeof updateFrequencySchema>;
export type ListFrequenciesQuery = z.infer<typeof listFrequenciesSchema>;
export type ExportFrequenciesQuery = z.infer<typeof exportFrequenciesSchema>;
