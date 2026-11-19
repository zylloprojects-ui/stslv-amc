import { useCallback, useState } from 'react'

// Accounts columns hidden by this user, remembered in this browser. Only how
// the page looks changes; a blocked browser store gives the default layout.

export const ACCOUNTS_PREFIX = 'stslev.accounts'

/** The columns a user may hide, in table order. The same ids the export accepts. */
export const COLUMN_IDS = [
  'client',
  'system',
  'frequency',
  'service',
  'scheduledMonth',
  'serviceStatus',
  'serviceReportNo',
  'serviceReport',
  // The contract document of the service's AMC contract (2026-11-19), beside the Service Report.
  'amcContract',
  // Client UAT 2026-11-16 (CR-011 to CR-014), provisional order pending the client's confirmation (Q-04).
  'salesEngineer',
  'serviceEngineer',
  'amcValue',
  'visitValue',
  'invoiceNo',
  'invoiceValue',
] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

/** Page-only columns: the downloads have no such column, so they are never sent as hidden to the export. */
export const PAGE_ONLY_COLUMNS: ReadonlySet<ColumnId> = new Set<ColumnId>(['serviceReport', 'amcContract'])

export const COLUMN_LABELS: Record<ColumnId, string> = {
  client: 'Client',
  system: 'System',
  frequency: 'Frequency',
  service: 'Service',
  scheduledMonth: 'Scheduled Month',
  visitValue: 'Service Value (ex VAT)',
  serviceStatus: 'Service Status',
  serviceReportNo: 'Service Report No.',
  serviceReport: 'Service Report',
  amcContract: 'AMC Contract',
  invoiceNo: 'Invoice No.',
  invoiceValue: 'Zoho Invoice Value (ex VAT)',
  salesEngineer: 'Sales Engineer',
  serviceEngineer: 'Service Engineer',
  amcValue: 'AMC Value (ex VAT)',
}

/**
 * Hidden until a user chooses to show them (Hide Columns). Zoho Invoice Value comes from Invoice Tracking, not from the
 * service itself; the client asked for it out of the default view (2026-11-18). Its data, total and export are unchanged.
 */
export const DEFAULT_HIDDEN: ReadonlySet<ColumnId> = new Set<ColumnId>(['invoiceValue'])

function load(key: string): ReadonlySet<ColumnId> {
  try {
    const stored = localStorage.getItem(key)
    // Nothing saved yet: the default layout. A saved list (even an empty one: "show everything") is the user's choice.
    if (stored === null) return DEFAULT_HIDDEN
    const saved: unknown = JSON.parse(stored)
    return new Set(Array.isArray(saved) ? saved.filter((id): id is ColumnId => COLUMN_IDS.includes(id as ColumnId)) : [])
  } catch {
    return DEFAULT_HIDDEN
  }
}

/** The columns this user has hidden. AMC Reference and the actions are always shown. Read again when the signed-in user changes. */
export function useHiddenColumns(userId: string): [ReadonlySet<ColumnId>, (hidden: ReadonlySet<ColumnId>) => void] {
  const key = `${ACCOUNTS_PREFIX}.hidden-columns.${userId}`
  const [state, setState] = useState(() => ({ key, hidden: load(key) }))

  if (state.key !== key) setState({ key, hidden: load(key) })

  const setHidden = useCallback(
    (next: ReadonlySet<ColumnId>) => {
      setState({ key, hidden: next })
      try {
        // Kept even when empty, so "show every column" is remembered instead of falling back to the default.
        localStorage.setItem(key, JSON.stringify([...next]))
      } catch {
        // Storage may be blocked; the choice then lasts for this visit only.
      }
    },
    [key],
  )

  return [state.key === key ? state.hidden : load(key), setHidden]
}
