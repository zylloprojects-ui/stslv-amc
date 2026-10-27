import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { pagingSchema } from "../../shared/money";
import { idSchema, optionalText, requiredText } from "../../shared/validation";

const optionalEmail = z
  .string()
  .trim()
  .max(254, "Email must be at most 254 characters.")
  .refine((value) => value === "" || z.email().safeParse(value).success, "Enter a valid email address.")
  .transform((value) => (value === "" ? null : value))
  .nullable();

// An optional link to another record: an empty string or null clears it.
const optionalId = (label: string) =>
  z
    .union([idSchema, z.literal(""), z.null()], { error: `Select a valid ${label}.` })
    .transform((value) => (value === "" ? null : value));

const code = (label: string) =>
  requiredText(label, 20).refine((value) => /^[A-Za-z0-9][A-Za-z0-9 _./&-]*$/.test(value), `${label} may use letters, digits, spaces and - _ . / & only.`);

const sortOrder = z.coerce
  .number({ error: "Sort order must be a whole number." })
  .int("Sort order must be a whole number.")
  .min(0, "Sort order cannot be negative.")
  .max(9999, "Sort order must be at most 9999.");

/** Builds the create schema (strict) and the update schema (every field optional, at least one). */
function shapes<T extends z.ZodRawShape>(fields: T, required: (keyof T)[]) {
  const createShape = Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [key, required.includes(key) ? schema : (schema as z.ZodType).optional()])
  ) as Record<string, z.ZodType>;
  const updateShape = Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, (schema as z.ZodType).optional()]));

  return {
    create: z.strictObject(createShape),
    update: z
      .strictObject(updateShape)
      .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update."),
  };
}

export const departmentSchemas = shapes(
  { code: code("Code"), name: requiredText("Name", 100), description: optionalText("Description", 500) },
  ["code", "name"]
);

export const systemTypeSchemas = shapes(
  { code: code("Code"), name: requiredText("Name", 100), description: optionalText("Description", 500), sortOrder },
  ["code", "name"]
);

const salesEngineerShapes = shapes(
  {
    name: requiredText("Name", 150),
    employeeNo: optionalText("Employee number", 50),
    email: optionalEmail,
    phone: optionalText("Phone", 50),
    departmentId: optionalId("department"),
    userId: optionalId("user"),
    notes: optionalText("Notes", 2000),
  },
  ["name"]
);

// A new engineer may be added already disabled. Later status changes go through the status route, which records them.
export const salesEngineerSchemas = {
  create: salesEngineerShapes.create.extend({ isActive: z.boolean({ error: "Say whether the engineer is active." }).optional() }),
  update: salesEngineerShapes.update,
};

// The code of a frequency is fixed; only its label can be changed (there is no create).
export const maintenanceFrequencySchemas = {
  update: z.strictObject({ label: requiredText("Label", 50) }),
};

export const masterStatusSchema = z.strictObject({
  isActive: z.boolean({ error: "Say whether the record is active." }),
});

export const listMastersSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["active", "inactive", "all"]).default("all"),
  // Sales engineers only: one department, or "none" for engineers without one. Other lists ignore it.
  departmentId: z.union([idSchema, z.literal("none")], { error: "Select a valid department." }).optional(),
  // Checked against the list's own sortable columns in the service.
  sort: z.string().trim().regex(/^[a-zA-Z]{1,30}$/, "Unknown sort.").optional(),
  direction: z.enum(["asc", "desc"]).default("asc"),
  ...pagingSchema,
});

// The list's own filters and order, without paging.
export const exportSalesEngineersSchema = listMastersSchema.omit({ page: true, pageSize: true }).extend({ format: exportFormatSchema });

// The engineer being edited, whose own linked account stays offered.
export const userOptionsSchema = z.object({ engineerId: idSchema.optional() });

export const masterHistorySchema = z.object(pagingSchema);

export type ListMastersQuery = z.infer<typeof listMastersSchema>;
export type ExportSalesEngineersQuery = z.infer<typeof exportSalesEngineersSchema>;
