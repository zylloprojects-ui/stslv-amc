import type { ContractStatus, VisitStatus } from '../amc/types'

// What GET /api/dashboard/operations returns. A section the user may not see is
// null. Amounts are decimal strings with three decimals; dates are YYYY-MM-DD.

/** Payment is not recorded in STSLV AMC, so payment figures always come back like this. */
export interface Unavailable {
  available: false
  reason: string
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
    services: { thisMonth: number; completedThisMonth: number; openThisMonth: number } | null
    unpaidInvoices: Unavailable | null
    paidThisMonth: Unavailable | null
  }
  portfolio: { total: number; statuses: { status: ContractStatus; count: number; percent: string | null }[] } | null
  expiring: { days: number; total: number; pastValidity: number; items: ExpiringRow[]; renewalsInstalled: boolean } | null
  workload: { months: WorkloadMonth[] } | null
  schedule: { today: ScheduleItem[]; todayTotal: number; upcoming: ScheduleItem[]; upcomingTotal: number; upcomingDays: number } | null
  payments: Unavailable | null
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
