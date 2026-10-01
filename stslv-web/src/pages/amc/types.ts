// Shapes returned by the AMC API (/api/amc). Money is text with three decimals
// ("405.000") and is never converted to a JavaScript number. Dates are "YYYY-MM-DD".

export const MAINTENANCE_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUALLY'] as const
export type MaintenanceFrequency = (typeof MAINTENANCE_FREQUENCIES)[number]

export const FREQUENCY_LABELS: Record<MaintenanceFrequency, string> = {
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half-yearly',
  ANNUALLY: 'Annually',
}

export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'EXPIRED', 'CANCELLED'] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
}

export const VISIT_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'POSTPONED', 'CANCELLED'] as const
export type VisitStatus = (typeof VISIT_STATUSES)[number]

export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = {
  SCHEDULED: 'Scheduled',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  POSTPONED: 'Postponed',
  CANCELLED: 'Cancelled',
}

export const INVOICE_ELIGIBILITIES = ['NOT_COMPLETED', 'AMOUNT_REQUIRED', 'NO_INVOICE_REQUIRED', 'READY_FOR_INVOICE'] as const
export type InvoiceEligibility = (typeof INVOICE_ELIGIBILITIES)[number]

export const INVOICE_ELIGIBILITY_LABELS: Record<InvoiceEligibility, string> = {
  NOT_COMPLETED: 'Not completed',
  AMOUNT_REQUIRED: 'Amount required',
  NO_INVOICE_REQUIRED: 'No invoice required',
  READY_FOR_INVOICE: 'Ready for invoice',
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
  defaultVisitAmount: string | null
  status: ContractStatus
  isPastValidity: boolean
  notes: string | null
  createdAt: string
  updatedAt: string
  schedule: {
    visitCount: number
    completedCount: number
    openCount: number
    cancelledCount: number
    amountMissingCount: number
    scheduledTotal: string
    valueDifference: string
  }
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
  canApply: boolean
  blockedReason: string | null
  toCreate: { periodStart: string; periodEnd: string; scheduledDate: string; visitAmount: string | null }[]
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
