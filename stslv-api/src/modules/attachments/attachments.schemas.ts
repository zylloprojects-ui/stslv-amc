import { z } from "zod";
import { idSchema, optionalText, requiredText } from "../../shared/validation";

export const ENTITY_TYPES = ["amc_contracts", "procurement_requests", "project_expenses"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

// PROVISIONAL (Q14). Must match attachments_category_ck.
export const CATEGORIES_BY_ENTITY: Record<EntityType, readonly string[]> = {
  amc_contracts: ["SIGNED_CONTRACT", "LPO", "PURCHASE_ORDER", "CLIENT_APPROVAL", "SERVICE_REPORT", "OTHER"],
  procurement_requests: ["QUOTATION", "PURCHASE_ORDER", "DELIVERY_NOTE", "OTHER"],
  project_expenses: ["RECEIPT", "BILL", "OTHER"],
};

export const listAttachmentsSchema = z.object({
  entityType: z.enum(ENTITY_TYPES, { error: "Select a record type." }),
  entityId: idSchema,
});

// Sent in the query string next to the raw file body.
export const uploadSchema = z
  .object({
    entityType: z.enum(ENTITY_TYPES, { error: "Select a record type." }),
    entityId: idSchema,
    category: z.string().trim().min(1, "Select a document type."),
    title: requiredText("Title", 200),
    notes: optionalText("Notes", 1000).optional(),
  })
  .refine((value) => CATEGORIES_BY_ENTITY[value.entityType].includes(value.category), {
    path: ["category"],
    message: "Select a document type for this record.",
  });

export const versionSchema = z.object({
  notes: optionalText("Notes", 1000).optional(),
});

export type UploadInput = z.infer<typeof uploadSchema>;
