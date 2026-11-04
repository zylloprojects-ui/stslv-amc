import type { ContractStatus, VisitStatus } from '../amc/types'

// What GET /api/dashboard/operations returns. A section the user may not see is
// null. Amounts are decimal strings with three decimals; dates are YYYY-MM-DD.

/** Reference status from the manual Invoice No. of each service; it does not verify that money was received. */
export interface PaymentFigures {
  paid: number
  paidValue: string
  unpaid: number
  unpaidValue: string
  paidThisMonth: number
  paidThisMonthValue: string
  /** The same split over the services scheduled in this calendar month. paid / unpaid are the overall figures. */
  scheduledThisMonth: { withInvoiceNo: number; withInvoiceNoValue: string; withoutInvoiceNo: number; withoutInvoiceNoValue: string }
}

export interface PaymentTrendMonth {
  month: string
  count: number
  value: string
}

export interface WorkloadMonth {
  /** "YYYY-MM" */
  month: string
  planned: number
  completed: number
  open: number
}

export interface ScheduleItem {
  id: string
  contractId: string
  client: { id: string; name: string }
  systemDescription: string
  scheduledDate: string
  assignedTo: string | null
  status: VisitStatus
  isOverdue: boolean
}

export interface ExpiringRow {
  id: string
  client: { id: string; name: string }
  systemDescription: string
  validTo: string
  daysLeft: number
  renewal: { id: string; status: ContractStatus } | null
}

export interface OperationsDashboard {
  asOf: string
  timeZone: string
  kpis: {
    contracts: {
      active: number
      activePastValidity: number
      activeValue: string
      finalCreditTotal: string
      finalCreditRecorded: number
      expiringSoon: number
      expiringSoonDays: number
      expiringSoonWithRenewal: number | null
    } | null
    /** overall and openOverall: every counted visit whatever its date, and those still open. */
    services: { thisMonth: number; completedThisMonth: number; openThisMonth: number; overall: number; openOverall: number } | null
    /** Reference status from the manual Invoice No., over the same services as Accounts. */
    payments: PaymentFigures | null
  }
  portfolio: { total: number; statuses: { status: ContractStatus; count: number; percent: string | null }[] } | null
  expiring: { days: number; total: number; pastValidity: number; items: ExpiringRow[]; renewalsInstalled: boolean } | null
  workload: { months: WorkloadMonth[] } | null
  schedule: { today: ScheduleItem[]; todayTotal: number; upcoming: ScheduleItem[]; upcomingTotal: number; upcomingDays: number } | null
  paymentTrend: { months: PaymentTrendMonth[] } | null
}

export interface CalendarDay {
  date: string
  total: number
  completed: number
  open: number
  overdue: number
}

export interface CalendarMonth {
  month: string
  days: CalendarDay[]
}

export type CheckState = 'OK' | 'ATTENTION' | 'UNAVAILABLE'

export interface Readiness {
  checkedAt: string
  checks: { id: string; label: string; state: CheckState; detail: string }[]
}
