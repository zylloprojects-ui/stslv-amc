import type { ContractStatus, VisitStatus } from '../amc/types'

// What GET /api/dashboard/operations returns. A section the user may not see is
// null. Amounts are decimal strings with three decimals; dates are YYYY-MM-DD.

/** Reference status from the manual Invoice No. of each service; it does not verify that money was received. */
export interface PaymentFigures {
  paid: number
  /** Sum of the service values (Ex VAT) of the services with an Invoice No.; services without a value add nothing. */
  paidValue: string
  /** Of paid, the services with no recorded value. Absent from an older API. */
  paidAmountMissing?: number
  unpaid: number
  unpaidValue: string
  /** Of unpaid, the services with no recorded value. Absent from an older API. */
  unpaidAmountMissing?: number
  paidThisMonth: number
  paidThisMonthValue: string
  /** The same split over the services scheduled in this calendar month. paid / unpaid are the overall figures. */
  scheduledThisMonth: {
    withInvoiceNo: number
    withInvoiceNoValue: string
    withInvoiceNoAmountMissing?: number
    withoutInvoiceNo: number
    withoutInvoiceNoValue: string
    withoutInvoiceNoAmountMissing?: number
  }
}

/** The part of a response the shared KPI cards read: GET /api/dashboard/operations and GET /api/amc/management/summary both carry it. */
export interface SharedKpiSource {
  kpis: OperationsDashboard['kpis']
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
  /** The contract's AMC Reference Number. */
  reference: string
  client: { id: string; name: string }
  systemDescription: string
  validTo: string
  daysLeft: number
  renewal: { id: string; reference: string; status: ContractStatus } | null
}

export interface OperationsDashboard {
  asOf: string
  timeZone: string
  kpis: {
    contracts: {
      /** Active contract periods counted once: within validity (Oman), not waiting for the period they renew. */
      active: number
      /** Status Active but past Valid To: expired by the approved rule, not counted. */
      activePastValidity: number
      /** Active renewals that take over when the period they renew ends; not counted yet. Absent from an older API. */
      activeAwaitingPredecessor?: number
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
  /** The Current Year (YTD) row. Null without schedule or execution view; absent from an older API (the row is then not shown). */
  yearToDate?: YearToDateServices | null
}

/**
 * Counted services (the same scope as Current Month and Overall) scheduled from January 1 of Oman's year through Oman's
 * today, both included. Visits ahead are not counted. pending = due - completed; overdue is part of pending.
 */
export interface YearToDateServices {
  from: string
  to: string
  due: number
  completed: number
  pending: number
  overdue: number
}

/** What a Dashboard card reads: the shared KPI figures, and the Dashboard-only YTD figures (AMC Management has none). */
export interface DashboardKpiSource extends SharedKpiSource {
  yearToDate?: YearToDateServices | null
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
