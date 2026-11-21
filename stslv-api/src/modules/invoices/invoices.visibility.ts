import { hiddenFieldsFor, hiddenReportKeys, responseFields, type ResponseFields } from "../../shared/visibility-fields";
import type { AuthContext } from "../auth/access";

// Role visibility on Invoice Tracking (migration 0123, step B "Lock it"). Invoice no., client, date, the amount
// excluding VAT, VAT, what the invoice covers and its status are required when recording an invoice, so they always
// stay. The Zoho reference and notes are locked in the invoice form when hidden, and the service keeps their stored
// values (createInvoice / updateInvoice). The router also answers the contract page's invoice list and the
// Dashboard's Recent Invoices, which follow the same columns.

export const INVOICE_FIELD_VISIBILITY = {
  page: "invoiceTracking",
  fields: {
    total: ["totalAmount"],
    zohoReference: ["sourceReference"],
    notes: ["notes"],
    recordedBy: ["createdBy"],
  },
} as const;

type Column = keyof (typeof INVOICE_FIELD_VISIBILITY)["fields"];

const spec: ResponseFields<Column> = {
  ...INVOICE_FIELD_VISIBILITY,
  isItem: (value) => typeof value === "object" && value !== null && "invoiceNumber" in value && "allocations" in value && "amountExclVat" in value,
  blank: (item, hidden) => ({
    ...item,
    totalAmount: hidden.has("totalAmount") ? null : item.totalAmount,
    sourceReference: hidden.has("sourceReference") ? null : item.sourceReference,
    notes: hidden.has("notes") ? null : item.notes,
    // The record keeps its author's id; only the name is withheld.
    createdBy: hidden.has("createdBy") ? { id: (item.createdBy as { id: string }).id, fullName: "" } : item.createdBy,
  }),
  extras: (data, hidden) => {
    if (!hidden.has("totalAmount")) return data;
    const out = { ...data };
    // The list's totals and the summary's issued figures.
    if (typeof out.totals === "object" && out.totals !== null) out.totals = { ...(out.totals as object), totalAmount: null };
    if (typeof out.issued === "object" && out.issued !== null) out.issued = { ...(out.issued as object), totalAmount: null };
    return out;
  },
};

/** Router middleware: every JSON answer of Invoice Tracking leaves out the fields hidden from the user's role. */
export const applyInvoiceVisibility = responseFields(spec);

/** The invoice fields hidden from the user: a save never changes them (the stored values are kept). */
export const invoiceHiddenFields = (auth: Pick<AuthContext, "hidden">) => hiddenFieldsFor(auth, INVOICE_FIELD_VISIBILITY);

/** The report columns of the invoice downloads left out for the user. */
export const invoiceHiddenReportKeys = (auth: Pick<AuthContext, "hidden">) =>
  hiddenReportKeys(auth, INVOICE_FIELD_VISIBILITY, { total: ["totalAmount"], zohoReference: ["sourceReference"], notes: ["notes"], recordedBy: ["recordedBy"] });
