import type { ContractStatus } from '../amc/types'

// The AMC Renewal API: the queue (/api/amc/renewals/queue) and the renewal
// history (/api/amc/reports/renewals). Read-only; renewing, approving and
// cancelling use the contract routes.

/**
 * Derived by the API, never stored, and never the contract's own status:
 *   DUE             no renewal yet; active or expired, ending within the window or already ended.
 *   UNDER_APPROVAL  a renewal exists as a draft, waiting for the client.
 *   RENEWED         the renewal was approved (activated).
 *   CANCELLED       every renewal made was cancelled; stays here until a new one is started.
 */
export const RENEWAL_STATES = ['DUE', 'UNDER_APPROVAL', 'RENEWED', 'CANCELLED'] as const
export type RenewalState = (typeof RENEWAL_STATES)[number]

export const RENEWAL_STATE_LABELS: Record<RenewalState, string> = {
  DUE: 'Due / Expired',
  UNDER_APPROVAL: 'Under Client Approval',
  RENEWED: 'Renewed',
  CANCELLED: 'Cancelled',
}

export const RENEWAL_STATE_TONES: Record<RenewalState, string> = {
  DUE: 'bg-amber-100 text-amber-900 ring-amber-300',
  UNDER_APPROVAL: 'bg-sky-100 text-[#0b3b66] ring-sky-200',
  RENEWED: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  CANCELLED: 'bg-slate-100 text-slate-700 ring-slate-300',
}

/** The renewal state a renewal contract's own status stands for. */
export function renewalStateOf(status: ContractStatus): RenewalState {
  if (status === 'DRAFT') return 'UNDER_APPROVAL'
  if (status === 'CANCELLED') return 'CANCELLED'
  return 'RENEWED'
}

export interface RenewalQueueItem {
  /** The contract to be renewed. */
  id: string
  reference: string
  client: { id: string; name: string }
  system: { description: string; typeName: string | null }
  frequency: { code: string; label: string }
  services: { completed: number; scheduled: number }
  validFrom: string
  validTo: string
  /** Negative once the validity has ended. */
  daysLeft: number
  contractStatus: ContractStatus
  contractValue: string
  remarks: string | null
  renewalState: RenewalState
  renewal: { id: string; reference: string; status: ContractStatus; validFrom: string; validTo: string } | null
}

export interface RenewalQueueKpis {
  due: number
  underApproval: number
  renewed: number
  cancelled: number
}

export interface RenewalQueue {
  items: RenewalQueueItem[]
  total: number
  page: number
  pageSize: number
  kpis: RenewalQueueKpis
  windowDays: number
  today: string | null
}

interface ContractSummary {
  id: string
  client: { id: string; name: string }
  systemDescription: string
  validFrom: string
  validTo: string
  status: ContractStatus
  createdAt: string
}

export interface RenewalHistory {
  items: { renewal: ContractSummary; createdOn: string; source: { id: string; validFrom: string; validTo: string; status: ContractStatus } }[]
  total: number
  page: number
  pageSize: number
}
