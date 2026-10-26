import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { dateSchema, moneySchema, optionalDateSchema, pagingSchema } from "../../shared/money";
import { idSchema, optionalText, requiredText } from "../../shared/validation";

// Must match invoices_status_ck. PROVISIONAL: payment is not tracked (Q22).
export const INVOICE_STATUSES = ["ISSUED", "CANCELLED"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// Must match invoices_source_ck. Invoices are raised in Zoho.
export const INVOICE_SOURCES = ["ZOHO"] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

const ID_PATTERN = /^[1-9]\d{0,17}$/;

// One line of an invoice: the visit or the project it covers, and how much of
// the amount excluding VAT belongs to it.
const allocationSchema = z
  .strictObject({
    amcVisitId: z.string().regex(ID_PATTERN, "Select an AMC visit.").optional(),
    projectId: z.string().regex(ID_PATTERN, "Select a project.").optional(),
    amount: moneySchema("Allocated amount", { allowZero: false }),
  })
  .refine(
    (value) => (value.amcVisitId === undefined) !== (value.projectId === undefined),
    "Each allocation names either an AMC visit or a project."
  );

const invoiceFields = {
  // The format of the Zoho number is not confirmed, so it is free text.
  invoiceNumber: requiredText("Invoice number", 50),
  clientId: z.string({ error: "Client is required." }).regex(ID_PATTERN, "Select a client."),
  invoiceDate: dateSchema("Invoice date"),
  amountExclVat: moneySchema("Amount excluding VAT", { allowZero: false }),
  // Entered from the invoice, never calculated. Zero is a real value.
  vatAmount: moneySchema("VAT amount", { allowZero: true }),
  sourceReference: optionalText("Zoho reference", 200),
  notes: optionalText("Notes", 2000),
  allocations: z
    .array(allocationSchema, { error: "Allocate the invoice to at least one AMC visit or project." })
    .min(1, "Allocate the invoice to at least one AMC visit or project.")
    .max(100, "An invoice can be allocated to at most 100 visits and projects."),
};

export const createInvoiceSchema = z.strictObject({
  invoiceNumber: invoiceFields.invoiceNumber,
  clientId: invoiceFields.clientId,
  invoiceDate: invoiceFields.invoiceDate,
  amountExclVat: invoiceFields.amountExclVat,
  vatAmount: invoiceFields.vatAmount,
  sourceReference: invoiceFields.sourceReference.optional(),
  notes: invoiceFields.notes.optional(),
  allocations: invoiceFields.allocations,
});

// Every field optional: a field that is left out is not changed. When
// allocations are sent they replace the invoice's allocations as a whole.
export const updateInvoiceSchema = z
  .strictObject({
    invoiceNumber: invoiceFields.invoiceNumber.optional(),
    clientId: invoiceFields.clientId.optional(),
    invoiceDate: invoiceFields.invoiceDate.optional(),
    amountExclVat: invoiceFields.amountExclVat.optional(),
    vatAmount: invoiceFields.vatAmount.optional(),
    sourceReference: invoiceFields.sourceReference.optional(),
    notes: invoiceFields.notes.optional(),
    allocations: invoiceFields.allocations.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const cancelInvoiceSchema = z.strictObject({
  reason: requiredText("Reason", 500),
});

export const listInvoicesSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  clientId: idSchema.optional(),
  // Invoices that cover this project or this AMC visit.
  projectId: idSchema.optional(),
  amcVisitId: idSchema.optional(),
  dateFrom: optionalDateSchema("From date").optional(),
  dateTo: optionalDateSchema("To date").optional(),
  ...pagingSchema,
});

export const listBillableSchema = z
  .object({
    clientId: idSchema.optional(),
    // Also list work that an active invoice already covers. Only for one client at a time.
    includeInvoiced: z.enum(["true", "false"]).default("false"),
  })
  .refine((value) => value.includeInvoiced === "false" || value.clientId !== undefined, {
    path: ["clientId"],
    message: "Select a client to include work that is already invoiced.",
  });

/** The invoice list's own filters, without paging, plus the file format. */
export const exportInvoicesSchema = listInvoicesSchema.omit({ page: true, pageSize: true }).extend({ format: exportFormatSchema });

/** The pending report lists waiting work only; work that an invoice already covers cannot be asked for. */
export const exportBillableSchema = z.strictObject({
  clientId: idSchema.optional(),
  format: exportFormatSchema,
});

export type ExportInvoicesQuery = z.infer<typeof exportInvoicesSchema>;
export type ExportBillableQuery = z.infer<typeof exportBillableSchema>;
export type AllocationInput = z.infer<typeof allocationSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;
export type ListInvoicesQuery = z.infer<typeof listInvoicesSchema>;
export type ListBillableQuery = z.infer<typeof listBillableSchema>;
