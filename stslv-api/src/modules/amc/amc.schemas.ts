import { z } from "zod";
import { exportFormatSchema } from "../../shared/export/report";
import { idSchema, optionalText, requiredText } from "../../shared/validation";
import {
  BILLING_STATUSES,
  CONTRACT_STATUSES,
  INVOICE_ELIGIBILITIES,
  OPERATIONAL_VISIT_STATUSES,
  SERVICE_STATUSES,
  SETTABLE_SERVICE_STATUSES,
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

// A maintenance frequency code. Whether it exists and may be selected is checked
// in the service, against the frequency master (migration 0076) or, without it,
// the four built-in codes.
const frequency = z
  .string({ error: "Select a maintenance frequency." })
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,29}$/, "Select a maintenance frequency.");

// The months (1 = January) of a contract on a custom frequency. PROVISIONAL: the
// custom scheduling rule is not yet confirmed by the client.
const customMonths = z
  .array(z.number({ error: "Each month must be a number from 1 to 12." }).int("Each month must be a number from 1 to 12.").min(1, "Each month must be a number from 1 to 12.").max(12, "Each month must be a number from 1 to 12."), {
    error: "Select the months as a list.",
  })
  .max(11, "Select at most 11 months. For a visit every month, choose the monthly frequency.")
  .refine((months) => new Set(months).size === months.length, "Each month can be selected once.");

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
  customMonths,
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
  // Only for a custom frequency; left out or empty otherwise.
  customMonths: contractFields.customMonths.optional(),
  defaultVisitAmount: contractFields.defaultVisitAmount.optional(),
  notes: contractFields.notes.optional(),
  // Optional link to the Sales Engineer master (migration 0070); null or left out: no link.
  salesEngineerId: z.union([idSchema, z.null()], { error: "Select a valid sales engineer." }).optional(),
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
    // Replaces the selected months. Left out: unchanged (cleared when the frequency changes to a fixed one).
    customMonths: contractFields.customMonths.optional(),
    defaultVisitAmount: contractFields.defaultVisitAmount.optional(),
    notes: contractFields.notes.optional(),
    salesEngineerId: z.union([idSchema, z.null()], { error: "Select a valid sales engineer." }).optional(),
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
  // Contracts linked to this Sales Engineer master record (migration 0070).
  salesEngineerId: idSchema.optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** The activity history of one contract, newest first. */
export const contractHistorySchema = z.object({
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// An optional link: an id, or null to remove the link. Left out: unchanged.
const optionalLink = (label: string) => z.union([idSchema, z.null()], { error: `Select a valid ${label}.` }).optional();

/** Links a contract to master records (migration 0070). */
export const contractMastersSchema = z
  .strictObject({ salesEngineerId: optionalLink("sales engineer"), systemTypeId: optionalLink("system type") })
  .refine((value) => value.salesEngineerId !== undefined || value.systemTypeId !== undefined, "Provide at least one link to change.");

/** Active contracts whose validity ends within this many days (the user's choice of window). */
export const expiringContractsSchema = z.object({
  days: z.coerce.number().int().min(0).max(730).default(90),
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Renewals made, newest first. */
export const renewalHistorySchema = z.object({
  page,
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Visits per month from the current month forward. */
export const workloadSchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

/** Proposed terms for a schedule preview. Anything left out uses the stored value. */
export const schedulePreviewSchema = z.object({
  validFrom: isoDate("Valid from").optional(),
  validTo: isoDate("Valid to").optional(),
  maintenanceFrequency: frequency.optional(),
  // Comma-separated months for a custom frequency, for example "2,5,8,11".
  customMonths: z
    .string()
    .trim()
    .regex(/^(\d{1,2}(,\d{1,2})*)?$/, "Give the months as numbers separated by commas.")
    .transform((value) => (value === "" ? [] : value.split(",").map(Number)))
    .pipe(customMonths)
    .optional(),
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
  // Contracts linked to this Sales Engineer master record (migration 0070).
  salesEngineerId: idSchema.optional(),
  frequency: frequency.optional(),
  // The Monthly Calendar's billing status; see BILLING_STATUSES.
  billingStatus: z.enum(BILLING_STATUSES, { error: "Select a billing status." }).optional(),
  overdue: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(200).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The schedule's own filters, without paging, plus the file format. */
export const exportVisitsSchema = listVisitsSchema.omit({ page: true, pageSize: true }).extend({ format: exportFormatSchema });

const YEAR_MESSAGE = "Year must be between 2000 and 2100.";

/** The Monthly Calendar's year: the schedule's filters, with a calendar year in place of a date range. */
export const visitYearSummarySchema = listVisitsSchema.omit({ page: true, pageSize: true, from: true, to: true }).extend({
  year: z.coerce.number({ error: YEAR_MESSAGE }).int(YEAR_MESSAGE).min(2000, YEAR_MESSAGE).max(2100, YEAR_MESSAGE),
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

// ---------------------------------------------------------------------------
// Service Status
// ---------------------------------------------------------------------------

export const listServiceStatusSchema = z.object({
  // AMC reference ("AMC-0007"), client, system or service code, report number.
  search: z.string().trim().max(200).optional(),
  clientId: idSchema.optional(),
  salesEngineerId: idSchema.optional(),
  systemTypeId: idSchema.optional(),
  frequency: frequency.optional(),
  // Month and year of the scheduled date. Either may be left out: all months, or that month in every year.
  month: z.coerce.number({ error: "Month must be a number from 1 to 12." }).int().min(1, "Month must be a number from 1 to 12.").max(12, "Month must be a number from 1 to 12.").optional(),
  year: z.coerce.number({ error: "Year must be between 2000 and 2100." }).int().min(2000, "Year must be between 2000 and 2100.").max(2100, "Year must be between 2000 and 2100.").optional(),
  serviceStatus: z.enum(SERVICE_STATUSES, { error: "Select a service status." }).optional(),
  page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** The page's own filters, without paging, plus the file format. */
export const exportServiceStatusSchema = listServiceStatusSchema.omit({ page: true, pageSize: true }).extend({ format: exportFormatSchema });

const REPORT_NUMBER_MESSAGE = "Service report number must be at most 50 characters, without line breaks.";

export const saveServiceStatusSchema = z
  .strictObject({
    // Waiting for renewal is derived and cannot be chosen.
    status: z.enum(SETTABLE_SERVICE_STATUSES, { error: "Select Completed or Not Completed." }).optional(),
    // Required when the visit becomes completed; may correct the date of a completed visit.
    completedDate: isoDate("Completion date").optional(),
    // Empty or null clears it.
    reportNumber: z
      .string({ error: REPORT_NUMBER_MESSAGE })
      .trim()
      .max(50, REPORT_NUMBER_MESSAGE)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), REPORT_NUMBER_MESSAGE)
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional(),
    // The updatedAt the page showed. A save over a newer change is refused, so one person cannot silently overwrite another.
    expectedUpdatedAt: z.string({ error: "Reload the page and try again." }).datetime({ offset: true, error: "Reload the page and try again." }),
  })
  .refine((value) => value.status !== undefined || value.reportNumber !== undefined || value.completedDate !== undefined, "Provide a status, completion date or report number to save.");

export const summarySchema = z.object({
  upcomingDays: z.coerce.number().int().min(1).max(366).default(30),
});

export type CreateContractInput = z.infer<typeof createContractSchema>;
export type UpdateContractInput = z.infer<typeof updateContractSchema>;
export type ChangeContractStatusInput = z.infer<typeof changeContractStatusSchema>;
export type ListContractsQuery = z.infer<typeof listContractsSchema>;
export type ContractHistoryQuery = z.infer<typeof contractHistorySchema>;
export type ContractMastersInput = z.infer<typeof contractMastersSchema>;
export type ExpiringContractsQuery = z.infer<typeof expiringContractsSchema>;
export type RenewalHistoryQuery = z.infer<typeof renewalHistorySchema>;
export type WorkloadQuery = z.infer<typeof workloadSchema>;
export type SchedulePreviewQuery = z.infer<typeof schedulePreviewSchema>;
export type ListVisitsQuery = z.infer<typeof listVisitsSchema>;
export type ExportVisitsQuery = z.infer<typeof exportVisitsSchema>;
export type VisitYearSummaryQuery = z.infer<typeof visitYearSummarySchema>;
export type UpdateVisitInput = z.infer<typeof updateVisitSchema>;
export type ListExecutionQuery = z.infer<typeof listExecutionSchema>;
export type UpdateExecutionInput = z.infer<typeof updateExecutionSchema>;
export type ListServiceStatusQuery = z.infer<typeof listServiceStatusSchema>;
export type ExportServiceStatusQuery = z.infer<typeof exportServiceStatusSchema>;
export type SaveServiceStatusInput = z.infer<typeof saveServiceStatusSchema>;
