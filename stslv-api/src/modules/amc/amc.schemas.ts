import { z } from "zod";
import { idSchema, optionalText, requiredText } from "../../shared/validation";
import {
  CONTRACT_STATUSES,
  INVOICE_ELIGIBILITIES,
  MAINTENANCE_FREQUENCIES,
  OPERATIONAL_VISIT_STATUSES,
  VISIT_STATUSES,
} from "./amc.constants";
import { isValidIsoDate } from "./amc.schedule";

// ---------------------------------------------------------------------------
// Money
// Amounts travel through the API as text ("405.000") and are stored as
// numeric(14,3). They are never converted to a JavaScript number, so no
// floating-point rounding can reach a stored value.
// ---------------------------------------------------------------------------

const MONEY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

/** "405" -> "405.000", "0405.5" -> "405.500": the same text PostgreSQL returns. */
export function normalizeMoney(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");

  return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.padEnd(3, "0")}`;
}

const moneyMessage = (label: string) =>
  `${label} must be an amount of zero or more with at most 3 decimal places, sent as text (for example "405.000").`;

const requiredMoney = (label: string) =>
  z
    .string({ error: moneyMessage(label) })
    .trim()
    .regex(MONEY_PATTERN, moneyMessage(label))
    .transform(normalizeMoney);

/** Optional amount: an empty string or null clears it. */
const optionalMoney = (label: string) =>
  z
    .string({ error: moneyMessage(label) })
    .trim()
    .refine((value) => value === "" || MONEY_PATTERN.test(value), moneyMessage(label))
    .transform((value) => (value === "" ? null : normalizeMoney(value)))
    .nullable();

// ---------------------------------------------------------------------------
// Dates: calendar days, "YYYY-MM-DD".
// ---------------------------------------------------------------------------

const isoDate = (label: string) =>
  z
    .string({ error: `${label} is required.` })
    .trim()
    .refine(isValidIsoDate, `${label} must be a valid date (YYYY-MM-DD).`);

const optionalIsoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || isValidIsoDate(value), `${label} must be a valid date (YYYY-MM-DD).`)
    .transform((value) => (value === "" ? null : value))
    .nullable();

const frequency = z.enum(MAINTENANCE_FREQUENCIES, { error: "Select a maintenance frequency." });

const page = z.coerce.number().int().min(1).default(1);

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

const contractFields = {
  clientId: idSchema,
  responsibleEngineer: optionalText("Responsible engineer", 200),
  validFrom: isoDate("Valid from"),
  validTo: isoDate("Valid to"),
  systemDescription: requiredText("System", 200),
  description: optionalText("Description", 2000),
  contractValue: requiredMoney("Contract value"),
  finalCredit: optionalMoney("Final credit"),
  maintenanceFrequency: frequency,
  defaultVisitAmount: optionalMoney("Default visit amount"),
  notes: optionalText("Notes", 2000),
};

export const createContractSchema = z.strictObject({
  clientId: contractFields.clientId,
  responsibleEngineer: contractFields.responsibleEngineer.optional(),
  validFrom: contractFields.validFrom,
  validTo: contractFields.validTo,
  systemDescription: contractFields.systemDescription,
  description: contractFields.description.optional(),
  contractValue: contractFields.contractValue,
  finalCredit: contractFields.finalCredit.optional(),
  maintenanceFrequency: contractFields.maintenanceFrequency,
  defaultVisitAmount: contractFields.defaultVisitAmount.optional(),
  notes: contractFields.notes.optional(),
  // A contract is created as a draft (no schedule) or active (schedule generated at once).
  status: z.enum(["DRAFT", "ACTIVE"]).default("DRAFT"),
});

// Every field optional: a field that is left out is not changed.
// Status is not editable here; use the status route.
export const updateContractSchema = z
  .strictObject({
    clientId: contractFields.clientId.optional(),
    responsibleEngineer: contractFields.responsibleEngineer.optional(),
    validFrom: contractFields.validFrom.optional(),
    validTo: contractFields.validTo.optional(),
    systemDescription: contractFields.systemDescription.optional(),
    description: contractFields.description.optional(),
    contractValue: contractFields.contractValue.optional(),
    finalCredit: contractFields.finalCredit.optional(),
    maintenanceFrequency: contractFields.maintenanceFrequency.optional(),
    defaultVisitAmount: contractFields.defaultVisitAmount.optional(),
    notes: contractFields.notes.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const changeContractStatusSchema = z.strictObject({
  status: z.enum(CONTRACT_STATUSES, { error: "Select a contract status." }),
  // Only meaningful when the contract becomes EXPIRED or CANCELLED: also
  // cancels its visits that are still scheduled or postponed. Never implied.
  cancelOpenVisits: z.boolean().default(false),
  reason: optionalText("Reason", 500).optional(),
});

export const listContractsSchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum([...CONTRACT_STATUSES, "all"]).default("all"),
  clientId: idSchema.optional(),
  frequency: frequency.optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Proposed terms for a schedule preview. Anything left out uses the stored value. */
export const schedulePreviewSchema = z.object({
  validFrom: isoDate("Valid from").optional(),
  validTo: isoDate("Valid to").optional(),
  maintenanceFrequency: frequency.optional(),
});

// ---------------------------------------------------------------------------
// Visits (schedule)
// ---------------------------------------------------------------------------

const visitStatusList = z
  .string()
  .trim()
  .transform((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== ""))
  .pipe(z.array(z.enum(VISIT_STATUSES)).max(VISIT_STATUSES.length));

export const listVisitsSchema = z.object({
  // Range on the scheduled date, both ends included.
  from: isoDate("From").optional(),
  to: isoDate("To").optional(),
  clientId: idSchema.optional(),
  contractId: idSchema.optional(),
  // One status or several separated by commas.
  status: visitStatusList.optional(),
  system: z.string().trim().max(200).optional(),
  invoiceEligibility: z.enum(INVOICE_ELIGIBILITIES).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(200).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateVisitSchema = z
  .strictObject({
    visitAmount: optionalMoney("Visit amount").optional(),
    scheduledDate: isoDate("Scheduled date").optional(),
    assignedTo: optionalText("Assigned to", 200).optional(),
    notes: optionalText("Notes", 2000).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export const EXECUTION_SCOPES = ["due", "upcoming", "open", "completed", "all"] as const;

export const listExecutionSchema = z.object({
  // due: outstanding work dated today or earlier. upcoming: outstanding work in the next `days` days.
  scope: z.enum(EXECUTION_SCOPES).default("due"),
  days: z.coerce.number().int().min(1).max(366).default(30),
  clientId: idSchema.optional(),
  search: z.string().trim().max(200).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const updateExecutionSchema = z
  .strictObject({
    // HISTORICAL is not offered: it is written only by the controlled import.
    status: z.enum(OPERATIONAL_VISIT_STATUSES, { error: "Select a visit status." }).optional(),
    completedDate: optionalIsoDate("Completion date").optional(),
    // New planned date, for example when a visit is postponed.
    scheduledDate: isoDate("Scheduled date").optional(),
    workPerformed: optionalText("Work performed", 4000).optional(),
    executionNotes: optionalText("Execution notes", 4000).optional(),
    statusReason: optionalText("Reason", 500).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "Provide at least one field to update.");

export const summarySchema = z.object({
  upcomingDays: z.coerce.number().int().min(1).max(366).default(30),
});

export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
export type ChangeContractStatusInput = z.infer<typeof changeContractStatusSchema>;
export type ListContractsQuery = z.infer<typeof listContractsSchema>;
export type SchedulePreviewQuery = z.infer<typeof schedulePreviewSchema>;
export type ListVisitsQuery = z.infer<typeof listVisitsSchema>;
export type UpdateVisitInput = z.infer<typeof updateVisitSchema>;
export type ListExecutionQuery = z.infer<typeof listExecutionSchema>;
export type UpdateExecutionInput = z.infer<typeof updateExecutionSchema>;
