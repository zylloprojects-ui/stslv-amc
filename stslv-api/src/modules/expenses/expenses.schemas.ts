import { z } from "zod";
import { dateSchema, moneySchema, optionalDateSchema, pagingSchema } from "../../shared/money";
import { idSchema, optionalText, requiredText } from "../../shared/validation";

const ID_PATTERN = /^[1-9]\d{0,17}$/;

const expenseFields = {
  projectId: z.string({ error: "Project is required." }).regex(ID_PATTERN, "Select a project."),
  categoryId: z.string({ error: "Category is required." }).regex(ID_PATTERN, "Select a category."),
  expenseDate: dateSchema("Expense date"),
  description: requiredText("Description", 1000),
  payeeName: optionalText("Supplier / payee", 200),
  amount: moneySchema("Amount", { allowZero: false }),
  paymentReference: optionalText("Payment reference", 100),
  notes: optionalText("Notes", 2000),
};

export const createExpenseSchema = z.strictObject({
  projectId: expenseFields.projectId,
  categoryId: expenseFields.categoryId,
  expenseDate: expenseFields.expenseDate,
  description: expenseFields.description,
  payeeName: expenseFields.payeeName.optional(),
  amount: expenseFields.amount,
  paymentReference: expenseFields.paymentReference.optional(),
  notes: expenseFields.notes.optional(),
});

// Every field optional: a field that is left out is not changed. The project
// may be changed, so a cost recorded against the wrong job can be corrected.
export const updateExpenseSchema = z
  .strictObject({
    projectId: expenseFields.projectId.optional(),
    categoryId: expenseFields.categoryId.optional(),
    expenseDate: expenseFields.expenseDate.optional(),
    description: expenseFields.description.optional(),
    payeeName: expenseFields.payeeName.optional(),
    amount: expenseFields.amount.optional(),
    paymentReference: expenseFields.paymentReference.optional(),
    notes: expenseFields.notes.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const voidExpenseSchema = z.strictObject({
  reason: requiredText("Reason", 500),
});

export const listExpensesSchema = z.object({
  search: z.string().trim().max(200).optional(),
  projectId: idSchema.optional(),
  categoryId: idSchema.optional(),
  dateFrom: optionalDateSchema("From date").optional(),
  dateTo: optionalDateSchema("To date").optional(),
  // Voided expenses are hidden unless asked for. They never count towards a total.
  includeVoided: z.enum(["true", "false"]).default("false"),
  ...pagingSchema,
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;
export type VoidExpenseInput = z.infer<typeof voidExpenseSchema>;
export type ListExpensesQuery = z.infer<typeof listExpensesSchema>;
