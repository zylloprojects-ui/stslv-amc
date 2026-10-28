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
  // Completed and covered by at least one active invoice (migration 0060).
  "INVOICED",
  "HISTORICAL",
] as const;
export type InvoiceEligibility = (typeof INVOICE_ELIGIBILITIES)[number];

/**
 * The billing status the Monthly Calendar shows for a visit. Derived on read
 * from the visit status and v_amc_visit_billing, never stored:
 *   INVOICED             completed, and at least one active (not cancelled) invoice covers it.
 *   NOT_YET_INVOICED     completed, no active invoice (Ready for invoice, or Amount required).
 *   NO_INVOICE_REQUIRED  completed with an amount of zero.
 *   NOT_COMPLETED        scheduled, in progress or postponed: not billable yet.
 *   CANCELLED            the visit was cancelled.
 * An invoice is not a payment: INVOICED says nothing about money received.
 * Historical visits have no billing status.
 */
export const BILLING_STATUSES = ["INVOICED", "NOT_YET_INVOICED", "NO_INVOICE_REQUIRED", "NOT_COMPLETED", "CANCELLED"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/**
 * The three states the Service Status page shows for a visit. Derived on read,
 * never stored, so they cannot disagree with the visit's own status:
 *   COMPLETED            the visit is completed.
 *   WAITING_FOR_RENEWAL  not completed, and its contract has expired or passed
 *                        its end date without a renewal that is not cancelled.
 *   NOT_COMPLETED        every other scheduled, in-progress or postponed visit.
 * Cancelled and historical visits are not on the page.
 */
export const SERVICE_STATUSES = ["NOT_COMPLETED", "COMPLETED", "WAITING_FOR_RENEWAL"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/** The statuses a user may choose on the Service Status page. Waiting for renewal is derived only. */
export const SETTABLE_SERVICE_STATUSES = ["NOT_COMPLETED", "COMPLETED"] as const;

/**
 * Technical safety limit on the validity period, so a mistyped year cannot
 * generate thousands of visits. It is not a business rule: the client's stated
 * need is contracts of up to 5 years.
 */
export const MAX_CONTRACT_YEARS = 10;
