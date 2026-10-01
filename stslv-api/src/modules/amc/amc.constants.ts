// Codes shared by the AMC module. Each list must match the CHECK constraint on
// its column (migrations 0010 and 0011).

export const MAINTENANCE_FREQUENCIES = ["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUALLY"] as const;
export type MaintenanceFrequency = (typeof MAINTENANCE_FREQUENCIES)[number];

/** Months between two visits. Adding a frequency means adding one entry here and to the CHECK constraint. */
export const FREQUENCY_MONTHS: Record<MaintenanceFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  HALF_YEARLY: 6,
  ANNUALLY: 12,
};

export const CONTRACT_STATUSES = ["DRAFT", "ACTIVE", "EXPIRED", "CANCELLED"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

/**
 * Contract status is changed by a user, never automatically: whether a
 * contract expires on its own at the end of its validity is unconfirmed.
 */
export const CONTRACT_TRANSITIONS: Record<ContractStatus, readonly ContractStatus[]> = {
  DRAFT: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["EXPIRED", "CANCELLED"],
  EXPIRED: ["ACTIVE"],
  CANCELLED: ["ACTIVE"],
};

/** The statuses a user can give a visit through the application. */
export const OPERATIONAL_VISIT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "POSTPONED", "CANCELLED"] as const;

/**
 * Every stored status. HISTORICAL is a period row imported from an earlier
 * schedule: whether and when the visit took place is not recorded. It is
 * written only by the controlled import, is read-only in the application, and
 * is neither outstanding work nor ready for invoice.
 */
export const VISIT_STATUSES = [...OPERATIONAL_VISIT_STATUSES, "HISTORICAL"] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

/** Statuses of a visit that still has work outstanding. */
export const OPEN_VISIT_STATUSES = ["SCHEDULED", "IN_PROGRESS", "POSTPONED"] as const;

/** Derived by the v_amc_visit_billing view; never stored. */
export const INVOICE_ELIGIBILITIES = [
  "NOT_COMPLETED",
  "AMOUNT_REQUIRED",
  "NO_INVOICE_REQUIRED",
  "READY_FOR_INVOICE",
  "HISTORICAL",
] as const;
export type InvoiceEligibility = (typeof INVOICE_ELIGIBILITIES)[number];

/**
 * Technical safety limit on the validity period, so a mistyped year cannot
 * generate thousands of visits. It is not a business rule: the client's stated
 * need is contracts of up to 5 years.
 */
export const MAX_CONTRACT_YEARS = 10;
