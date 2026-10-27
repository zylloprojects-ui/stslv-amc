// Shapes returned by the AMC API (/api/amc). Money is text with three decimals
// ("405.000") and is never converted to a JavaScript number. Dates are "YYYY-MM-DD".

/** The four built-in frequencies, offered when the frequency master (migration 0076) is not available. */
export const MAINTENANCE_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY'] as const

/** A maintenance frequency code. From migration 0076 any code in the frequency master. */
export type MaintenanceFrequency = string

/** Display names of the seeded frequencies (migrations 0075 and 0076), for lists and filters. */
export const FREQUENCY_LABELS: Record<string, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half-yearly',
  ANNUALLY: 'Annually',
  BI_MONTHLY: 'Bi-Monthly / Every 2 Months',
  EVERY_4_MONTHS: 'Every 4 Months',
  CUSTOM: 'Custom',
}

/** A frequency's display name; an unknown code (one added in the frequency master) shows as itself. */
export function frequencyLabel(code: string): string {
  return FREQUENCY_LABELS[code] ?? code
}

/** "Year 2 · Q3" for a visit labelled at generation (migration 0076), otherwise "No. 7". */
export function visitNumberLabel(visit: { sequenceNo: number; cycleNo?: number | null; serviceCode?: string | null }): string {
  return visit.serviceCode && visit.cycleNo ? `Year ${visit.cycleNo} · ${visit.serviceCode}` : `No. ${visit.sequenceNo}`
}

export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'CANCELLED'] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
}

/** The statuses a user can give a visit. */
export const OPERATIONAL_VISIT_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED'] as const

// HISTORICAL is a period row imported from an earlier schedule: whether and
// when the visit took place is not recorded. The application only displays it.
export const VISIT_STATUSES = [...OPERATIONAL_VISIT_STATUSES, 'HISTORICAL'] as const
export type VisitStatus = (typeof VISIT_STATUSES)[number]

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled',
  HISTORICAL: 'Historical',
}

export const INVOICE_ELIGIBILITIES = ['NOT_COMPLETED', 'AMOUNT_REQUIRED', 'NO_INVOICE_REQUIRED', 'READY_FOR_INVOICE', 'INVOICED', 'HISTORICAL'] as const
export type InvoiceEligibility = (typeof INVOICE_ELIGIBILITIES)[number]

export const INVOICE_ELIGIBILITY_LABELS: Record<InvoiceEligibility, string> = {
  NOT_COMPLETED: 'Not completed',
  AMOUNT_REQUIRED: 'Amount required',
  NO_INVOICE_REQUIRED: 'No invoice required',
  READY_FOR_INVOICE: 'Ready for invoice',
  INVOICED: 'Invoiced',
  HISTORICAL: 'Historical',
}

export interface Contract {
  id: string
  client: { id: string; name: string; isActive: boolean }
  responsibleEngineer: string | null
  validFrom: string
  validTo: string
  systemDescription: string
  description: string | null
  contractValue: string
  finalCredit: string | null
  maintenanceFrequency: MaintenanceFrequency
  /** Months (1 = January) of a contract on a custom frequency; empty or absent otherwise. */
  customMonths?: number[]
  defaultVisitAmount: string | null
  status: ContractStatus
  isPastValidity: boolean
  /** Set on a contract imported from an earlier register: visits are generated only for periods from this date. */
  scheduleCutoverDate: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  schedule: {
    visitCount: number
    completedCount: number
    openCount: number
    historicalCount: number
    cancelledCount: number
    amountMissingCount: number
    scheduledTotal: string
    valueDifference: string
  }
}

/** One activity entry recorded against a contract (GET /amc/contracts/:id/history). */
export interface ContractHistoryEntry {
  id: string
  action: string
  description: string | null
  /** Null for an action not made by a signed-in user, such as the historical import. */
  user: { id: string; fullName: string } | null
  changes: Record<string, { from: unknown; to: unknown }> | null
  reason: string | null
  createdAt: string
}

export interface ContractHistory {
  items: ContractHistoryEntry[]
  total: number
  page: number
  pageSize: number
}

export interface ScheduleChange {
  created: number
  removed: number
  kept: number
}

export type SavedContract = Contract & { scheduleChange?: ScheduleChange | null; cancelledVisits?: number }

export interface SchedulePreview {
  validFrom: string
  validTo: string
  maintenanceFrequency: MaintenanceFrequency
  customMonths?: number[]
  canApply: boolean
  blockedReason: string | null
  toCreate: { periodStart: string; periodEnd: string; scheduledDate: string; visitAmount: string | null; cycleNo?: number | null; serviceCode?: string | null }[]
  toRemove: { id: string; sequenceNo: number; periodStart: string; periodEnd: string }[]
  keptCount: number
  blocking: { id: string; sequenceNo: number; periodStart: string; periodEnd: string }[]
}

/** A visit as the execution screens receive it: no amount and no invoicing state. */
export interface ExecutionVisit {
  id: string
  contract: { id: string; status: ContractStatus; systemDescription: string; maintenanceFrequency: MaintenanceFrequency }
  client: { id: string; name: string }
  sequenceNo: number
  /** Taken when the visit was generated (migration 0076); null on older visits. */
  cycleNo?: number | null
  serviceCode?: string | null
  periodStart: string
  periodEnd: string
  originalScheduledDate: string
  scheduledDate: string
  isRescheduled: boolean
  isOverdue: boolean
  assignedTo: string | null
  assignedToOverride: string | null
  status: VisitStatus
  completedDate: string | null
  completedBy: { id: string; fullName: string } | null
  workPerformed: string | null
  executionNotes: string | null
  statusReason: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
}

export interface ScheduleVisit extends ExecutionVisit {
  visitAmount: string | null
  amountIsCustom: boolean
  invoiceEligibility: InvoiceEligibility
}

export interface VisitList {
  items: ScheduleVisit[]
  total: number
  page: number
  pageSize: number
  totals: { visitAmount: string; amountMissingCount: number }
}
