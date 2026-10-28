import type { ContractStatus } from '../amc/types'
import type { ExpiringRow, Unavailable } from '../dashboard/operationsTypes'

// What GET /api/amc/management/summary returns. A section the user may not see
// is null. Amounts are decimal strings with three decimals; dates are YYYY-MM-DD.

export type ExpiryBand = 90 | 60 | 45 | 30 | 15

export interface BandCount {
  days: ExpiryBand
  fromDays: number
  count: number
  notRenewed: number
  notRenewedIds: string[]
}

export interface RecentContract {
  id: string
  /** "AMC-0007": derived from the contract id, never stored (provisional). */
  reference: string
  client: { id: string; name: string }
  systemDescription: string
  status: ContractStatus
  contractValue: string
  createdAt: string
}

export interface AmcManagementSummary {
  asOf: string
  timeZone: string
  contracts: {
    active: number
    activePastValidity: number
    activeValue: string
    finalCreditTotal: string
    finalCreditRecorded: number
    expiringSoon: number
    expiringSoonDays: number
    expiringSoonWithRenewal: number | null
  }
  schedule: {
    servicesThisMonth: { planned: number; completed: number; open: number }
    pendingBilling: { count: number; amount: string; amountRequired: number } | null
    currentScheduledValue: { amount: string; visits: number; amountMissing: number } | null
    engine: { activeContracts: number; withoutSchedule: number }
  } | null
  invoices: {
    paid: Unavailable
    unpaid: Unavailable
    paidTotal: Unavailable
    module: { issued: number; cancelled: number; paymentTracked: false }
  } | null
  expiry: {
    renewalsInstalled: boolean
    bands: BandCount[]
    renewalWarning: { days: number; count: number; ids: string[] }
    critical: { days: number; count: number; notRenewed: number }
    notRenewedExpired: { count: number; expiredStatus: number; activePastValidity: number }
    list: { days: number; total: number; pastValidity: number; items: (ExpiringRow & { reference: string; band: ExpiryBand | null })[] }
  }
  recentContracts: { total: number; items: RecentContract[] }
}

export const MANAGEMENT_QUERY_KEY = ['amc', 'management', 'summary'] as const
