// Types and labels of the Monthly Calendar (/amc/calendar). The figures come
// from GET /amc/visits/year-summary; nothing here is calculated from them
// except what the page shows side by side.

/** Mirrors BILLING_STATUSES in the API (amc.constants.ts). Derived on read, never stored. */
export const BILLING_STATUSES = ['INVOICED', 'NOT_YET_INVOICED', 'NO_INVOICE_REQUIRED', 'NOT_COMPLETED', 'CANCELLED'] as const
export type BillingStatus = (typeof BILLING_STATUSES)[number]

export const BILLING_STATUS_LABELS: Record<BillingStatus, string> = {
  INVOICED: 'Invoiced',
  NOT_YET_INVOICED: 'Not yet invoiced',
  NO_INVOICE_REQUIRED: 'No invoice required',
  NOT_COMPLETED: 'Not completed',
  CANCELLED: 'Cancelled',
}

/** The figures of one month, or of the year. Counts are visits; amounts are text with three decimals. */
export interface VisitYearFigures {
  /** Visits that are not cancelled. */
  services: number
  /** Sum of the services' visit amounts. */
  scheduledValue: string
  /** Services without an amount: the value is known to be incomplete. */
  amountMissing: number
  scheduled: number
  inProgress: number
  postponed: number
  completed: number
  cancelled: number
  overdue: number
  invoiced: number
  invoicedValue: string
  notYetInvoiced: number
  notYetInvoicedValue: string
  noInvoiceRequired: number
  notCompleted: number
}

export interface VisitYearSummary {
  year: number
  months: (VisitYearFigures & { month: number })[]
  totals: VisitYearFigures
}

/** GET /amc/service-status/options: the values present on scheduled visits. */
export interface CalendarOptions {
  clients: { id: string; name: string }[]
  /** Null on a database without the Sales Engineer link: the filter is then not offered. */
  salesEngineers: { id: string; name: string }[] | null
  frequencies: { code: string; label: string }[]
  years: number[]
}

/** GET /amc/reports/expiring. */
export interface ExpiringContracts {
  asOf: string
  days: number
  items: {
    id: string
    client: { id: string; name: string }
    systemDescription: string
    validTo: string
    /** Negative when the validity has already ended. */
    daysLeft: number
  }[]
  total: number
  pastValidity: number
}

/** The filters both views share, as the visit endpoints take them. Empty values are left out of the request. */
export interface CalendarFilters {
  search: string
  clientId: string
  salesEngineerId: string
  system: string
  frequency: string
  /** One visit status, or the calendar's statuses separated by commas. */
  status: string
  billingStatus: string
}

/** Renewal warnings cover contracts ending within this many days (approved 2026-10-28). */
export const RENEWAL_WARNING_DAYS = 45

/** "AMC-0007" for contract 7, as Master AMC Status and Service Status show it. PROVISIONAL until the client confirms a numbering rule. */
export function amcReference(contractId: string): string {
  return `AMC-${contractId.padStart(4, '0')}`
}
