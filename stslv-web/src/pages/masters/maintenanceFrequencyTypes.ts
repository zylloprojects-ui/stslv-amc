// Maintenance frequencies (migration 0076), as returned by /api/masters/maintenance-frequencies.

import type { ContractStatus } from '../amc/types'

export type FrequencyStatus = 'active' | 'disabled' | 'archived'

export const FREQUENCY_STATUS_LABELS: Record<FrequencyStatus, string> = { active: 'Active', disabled: 'Disabled', archived: 'Archived' }

/** Months between services that divide the year evenly. Matches the API and the database. */
export const VALID_INTERVALS = [1, 2, 3, 4, 6, 12] as const

/**
 * Whether the schedule engine can generate a rule. Mirrors the API
 * (maintenance-frequencies.rules.ts engineSupports), which checks again: since
 * migration 0076 every valid interval and custom months (PROVISIONAL rule).
 */
export function engineCanGenerate(rule: { isCustom: boolean; intervalMonths: number | null }): boolean {
  return rule.isCustom || (rule.intervalMonths !== null && (VALID_INTERVALS as readonly number[]).includes(rule.intervalMonths))
}

export interface MaintenanceFrequencyRule {
  id: string
  /** Stable internal key that contracts store, for example QUARTERLY. */
  code: string
  name: string
  label: string
  isCustom: boolean
  /** Null for a custom frequency: its months are chosen on each contract. */
  serviceCount: number | null
  intervalMonths: number | null
  codePrefix: string
  /** "4 services · every 3 months". */
  ruleSummary: string
  sortOrder: number
  status: FrequencyStatus
  isActive: boolean
  archivedAt: string | null
  /** True once any contract uses it: the code and scheduling rule can no longer change. */
  ruleLocked: boolean
  /** Whether the schedule engine can generate visits for this rule today. */
  engineSupported: boolean
  contractCount: number
  activeContractCount: number
  createdAt: string
  updatedAt: string
}

/** GET /api/masters/maintenance-frequencies/:id/contracts */
export interface FrequencyLinkedContract {
  id: string
  client: { id: string; name: string }
  systemDescription: string
  frequency: { code: string; name: string }
  validFrom: string
  validTo: string
  status: ContractStatus
}
