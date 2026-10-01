import { z } from "zod";
import { dateSchema, optionalDateSchema, optionalMoneySchema, pagingSchema } from "../../shared/money";
import { idSchema, optionalText, requiredText } from "../../shared/validation";

// PROVISIONAL status list (open question Q8). Must match procurement_requests_status_ck.
export const PROCUREMENT_STATUSES = ["REQUESTED", "QUOTED", "ORDERED", "DELIVERED", "CANCELLED"] as const;
export type ProcurementStatus = (typeof PROCUREMENT_STATUSES)[number];

const procurementFields = {
  reference: optionalText("Request reference", 100),
  description: requiredText("Requirement", 1000),
  requestDate: dateSchema("Request date"),
  supplierName: optionalText("Supplier", 200),
  quotationReference: optionalText("Quotation reference", 100),
  quotationDate: optionalDateSchema("Quotation date"),
  quotationAmount: optionalMoneySchema("Quotation amount"),
  poReference: optionalText("Order / PO reference", 100),
  orderDate: optionalDateSchema("Order date"),
  expectedDeliveryDate: optionalDateSchema("Expected delivery"),
  notes: optionalText("Notes", 2000),
};

export const createProcurementSchema = z.strictObject({
  projectId: z.string({ error: "Project is required." }).regex(/^[1-9]\d{0,17}$/, "Select a project."),
  reference: procurementFields.reference.optional(),
  description: procurementFields.description,
  requestDate: procurementFields.requestDate,
  supplierName: procurementFields.supplierName.optional(),
  quotationReference: procurementFields.quotationReference.optional(),
  quotationDate: procurementFields.quotationDate.optional(),
  quotationAmount: procurementFields.quotationAmount.optional(),
  poReference: procurementFields.poReference.optional(),
  orderDate: procurementFields.orderDate.optional(),
  expectedDeliveryDate: procurementFields.expectedDeliveryDate.optional(),
  notes: procurementFields.notes.optional(),
});

// Every field optional: a field that is left out is not changed. The project
// cannot be changed, and status is changed through its own route.
export const updateProcurementSchema = z
  .strictObject({
    reference: procurementFields.reference.optional(),
    description: procurementFields.description.optional(),
    requestDate: procurementFields.requestDate.optional(),
    supplierName: procurementFields.supplierName.optional(),
    quotationReference: procurementFields.quotationReference.optional(),
    quotationDate: procurementFields.quotationDate.optional(),
    quotationAmount: procurementFields.quotationAmount.optional(),
    poReference: procurementFields.poReference.optional(),
    orderDate: procurementFields.orderDate.optional(),
    expectedDeliveryDate: procurementFields.expectedDeliveryDate.optional(),
    notes: procurementFields.notes.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const changeProcurementStatusSchema = z.strictObject({
  status: z.enum(PROCUREMENT_STATUSES, { error: "Select a valid status." }),
  // Only used with DELIVERED. Left out: today.
  deliveredDate: optionalDateSchema("Delivered date").optional(),
});

export const listProcurementSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(PROCUREMENT_STATUSES).optional(),
  projectId: idSchema.optional(),
  ...pagingSchema,
});

export type CreateProcurementInput = z.infer<typeof createProcurementSchema>;
export type UpdateProcurementInput = z.infer<typeof updateProcurementSchema>;
export type ChangeProcurementStatusInput = z.infer<typeof changeProcurementStatusSchema>;
export type ListProcurementQuery = z.infer<typeof listProcurementSchema>;
