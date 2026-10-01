import { z } from "zod";
import { optionalText, requiredText } from "../../shared/validation";

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
};

export const createClientSchema = z.strictObject({
  name: clientFields.name,
  contactPerson: clientFields.contactPerson.optional(),
  email: clientFields.email.optional(),
  phone: clientFields.phone.optional(),
  address: clientFields.address.optional(),
  notes: clientFields.notes.optional(),
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
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const listClientsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ListClientsQuery = z.infer<typeof listClientsSchema>;
