import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { FREQUENCY_LABELS, MAINTENANCE_FREQUENCIES } from './types'

// The maintenance frequencies a contract can choose from.
//
// From migration 0076 they come from the frequency master
// (GET /api/masters/maintenance-frequencies/options: active frequencies, with
// their rule). Until that list is available (database without 0076, or the
// dedicated route not yet mounted, which answers in the older shape without a
// prefix), the four built-in frequencies are offered, as before.

export interface FrequencyOption {
  code: string
  name: string
  isCustom: boolean
  /** "4 services · every 3 months", when known. */
  ruleSummary: string | null
}

const BUILT_IN: FrequencyOption[] = MAINTENANCE_FREQUENCIES.map((code) => ({ code, name: FREQUENCY_LABELS[code] ?? code, isCustom: false, ruleSummary: null }))

interface MasterOption {
  code: string
  name: string
  isCustom?: boolean
  codePrefix?: string
  ruleSummary?: string
}

export function useFrequencyOptions() {
  const query = useQuery({
    queryKey: ['masters', 'maintenance-frequencies', 'options'],
    queryFn: () => api.get<MasterOption[]>('/masters/maintenance-frequencies/options'),
    retry: false,
    staleTime: 60_000,
  })
  // Only the frequency master's own shape (with a prefix) is trusted to describe custom frequencies.
  const fromMaster = query.data && query.data.length > 0 && query.data.every((item) => typeof item.codePrefix === 'string')

  return {
    options: fromMaster
      ? (query.data as MasterOption[]).map((item) => ({ code: item.code, name: item.name, isCustom: item.isCustom === true, ruleSummary: item.ruleSummary ?? null }))
      : BUILT_IN,
    loading: query.isPending,
    // The master list could not be read, so only the built-in frequencies are offered.
    failed: query.isError,
  }
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const
