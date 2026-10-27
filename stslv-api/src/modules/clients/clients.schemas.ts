import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { optionalText, requiredText } from "../../shared/validation";

export const CLIENT_TYPES = ["COMPANY", "INDIVIDUAL"] as const;

export const CLIENT_TYPE_LABELS: Record<(typeof CLIENT_TYPES)[number], string> = { COMPANY: "Company", INDIVIDUAL: "Individual" };

/** The stored is_active flag in words. An inactive client is shown as Disabled. */
export const CLIENT_STATUS_LABELS: Record<"active" | "inactive", string> = { active: "Active", inactive: "Disabled" };

const optionalEmail = z
  .string()
  .trim()
  .max(254, "Email must be at most 254 characters.")
  .refine((value) => value === "" || z.email().safeParse(value).success, "Enter a valid email address.")
  .transform((value) => (value === "" ? null : value))
  .nullable();

const clientFields = {
  name: requiredText("Client name", 200),
  contactPerson: optionalText("Contact person", 200),
  email: optionalEmail,
  phone: optionalText("Phone", 50),
  address: optionalText("Address", 1000),
  notes: optionalText("Notes", 2000),
  // Migration 0074. Null clears the value.
  clientType: z
    .union([z.enum(CLIENT_TYPES), z.literal(""), z.null()], { error: "Select Company or Individual." })
    .transform((value) => (value === "" ? null : value)),
  vatNumber: optionalText("VAT number", 50),
};

export const createClientSchema = z.strictObject({
  name: clientFields.name,
  contactPerson: clientFields.contactPerson.optional(),
  email: clientFields.email.optional(),
  phone: clientFields.phone.optional(),
  address: clientFields.address.optional(),
  notes: clientFields.notes.optional(),
  clientType: clientFields.clientType.optional(),
  vatNumber: clientFields.vatNumber.optional(),
});

// Every field optional: a field that is left out is not changed.
// is_active is not editable here; use the deactivate / reactivate routes.
export const updateClientSchema = z
  .strictObject({
    name: clientFields.name.optional(),
    contactPerson: clientFields.contactPerson.optional(),
    email: clientFields.email.optional(),
    phone: clientFields.phone.optional(),
    address: clientFields.address.optional(),
    notes: clientFields.notes.optional(),
    clientType: clientFields.clientType.optional(),
    vatNumber: clientFields.vatNumber.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const listClientsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  // Migration 0074; ignored on a database without it.
  clientType: z.enum(CLIENT_TYPES).optional(),
  sort: z.enum(["name", "createdAt", "updatedAt"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** The list's own filters and order, without paging, plus the file format. */
export const exportClientsSchema = listClientsSchema.omit({ page: true, pageSize: true }).extend({ format: exportFormatSchema });

export const exportClientContractsSchema = z.object({ format: exportFormatSchema });

export type ExportClientsQuery = z.infer<typeof exportClientsSchema>;
export type ExportClientContractsQuery = z.infer<typeof exportClientContractsSchema>;
export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ListClientsQuery = z.infer<typeof listClientsSchema>;
