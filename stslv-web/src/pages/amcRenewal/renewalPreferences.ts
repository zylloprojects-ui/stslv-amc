import { useCallback, useState } from 'react'

// Renewal Queue columns hidden by this user, remembered in this browser.
// Only how the page looks changes; a blocked browser store gives the default layout.

const PREFIX = 'stslev.amc-renewal'

/** Where the queue's KPI names and order are remembered (see useKpiCustomization). */
export const RENEWAL_KPI_PREFIX = PREFIX

/** The columns a user may hide, in table order. The same ids the export accepts. */
export const COLUMN_IDS = ['client', 'system', 'frequency', 'service', 'expiry', 'contractStatus', 'amount', 'remarks'] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

export const COLUMN_LABELS: Record<ColumnId, string> = {
  client: 'Client',
  system: 'System',
  frequency: 'Frequency',
  service: 'Service',
  expiry: 'Contract Expiry Date',
  contractStatus: 'Contract Status',
  amount: 'Contract Amount',
  remarks: 'Remarks',
}

function load(key: string): ReadonlySet<ColumnId> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return new Set(Array.isArray(saved) ? saved.filter((id): id is ColumnId => COLUMN_IDS.includes(id as ColumnId)) : [])
  } catch {
    return new Set()
  }
}

/** The columns this user has hidden. AMC Reference, Renewal Status and Actions are always shown. */
export function useHiddenColumns(userId: string): [ReadonlySet<ColumnId>, (hidden: ReadonlySet<ColumnId>) => void] {
  const key = `${PREFIX}.hidden-columns.${userId}`
  const [state, setState] = useState(() => ({ key, hidden: load(key) }))

  if (state.key !== key) setState({ key, hidden: load(key) })

  const setHidden = useCallback(
    (next: ReadonlySet<ColumnId>) => {
      setState({ key, hidden: next })
      try {
        if (next.size > 0) localStorage.setItem(key, JSON.stringify([...next]))
        else localStorage.removeItem(key)
      } catch {
        // Storage may be blocked; the choice then lasts for this visit only.
      }
    },
    [key],
  )

  return [state.key === key ? state.hidden : load(key), setHidden]
}
