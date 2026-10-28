import { useCallback, useState } from 'react'

// Services Sales layout choices, remembered in this browser for each signed-in
// user. They change only how the page looks: a renamed or moved card still
// counts the same business status, a hidden column still exists in the data
// and the export, and a blocked browser store gives the default layout.

const PREFIX = 'stslev.services-sales'

export const KPI_IDS = ['total', 'notCompleted', 'quotePending', 'quoted'] as const
export type KpiId = (typeof KPI_IDS)[number]

export const DEFAULT_KPI_LABELS: Record<KpiId, string> = {
  total: 'Total Services',
  notCompleted: 'Not Completed',
  quotePending: 'Completed / Quote Pending',
  quoted: 'Quoted',
}

export const KPI_LABEL_MAX = 40

export const COLUMN_IDS = ['client', 'system', 'frequency', 'service', 'dueDate', 'serviceStatus', 'quotation', 'salesEngineer'] as const
export type ColumnId = (typeof COLUMN_IDS)[number]

export const COLUMN_LABELS: Record<ColumnId, string> = {
  client: 'Client',
  system: 'System',
  frequency: 'Frequency',
  service: 'Service',
  dueDate: 'Scheduled Month / Due Date',
  serviceStatus: 'Service Status',
  quotation: 'Quote No.',
  salesEngineer: 'Sales Engineer',
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)

    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage may be blocked; the choice then lasts for this visit only.
  }
}

/** Saved names that are still valid; anything else falls back to the default name. */
function parseLabels(value: unknown): Partial<Record<KpiId, string>> {
  if (!value || typeof value !== 'object') return {}
  const labels: Partial<Record<KpiId, string>> = {}

  for (const id of KPI_IDS) {
    const label = (value as Record<string, unknown>)[id]
    if (typeof label === 'string' && label.trim() !== '' && label.trim().length <= KPI_LABEL_MAX) labels[id] = label.trim()
  }

  return labels
}

/** The saved order: the known ids in their saved order, then any id added since, in the default order. */
function parseOrder(value: unknown): KpiId[] {
  const saved = Array.isArray(value) ? value.filter((id, index, list): id is KpiId => KPI_IDS.includes(id as KpiId) && list.indexOf(id) === index) : []

  return [...saved, ...KPI_IDS.filter((id) => !saved.includes(id))]
}

/** The card names and order for this user, with separate resets for each. */
export function useKpiLayout(userId: string) {
  const labelKey = `${PREFIX}.kpi-labels.${userId}`
  const orderKey = `${PREFIX}.kpi-order.${userId}`
  const [custom, setCustom] = useState(() => parseLabels(read(labelKey)))
  const [order, setOrderState] = useState<KpiId[]>(() => parseOrder(read(orderKey)))

  const labels: Record<KpiId, string> = { ...DEFAULT_KPI_LABELS, ...custom }

  const setLabels = useCallback(
    (next: Record<KpiId, string>) => {
      // Only names that differ from the default are kept, so a later change of a default still shows.
      const kept = parseLabels(Object.fromEntries(KPI_IDS.filter((id) => next[id].trim() !== DEFAULT_KPI_LABELS[id]).map((id) => [id, next[id]])))
      setCustom(kept)
      write(labelKey, Object.keys(kept).length > 0 ? kept : null)
    },
    [labelKey],
  )
  const resetLabels = useCallback(() => {
    setCustom({})
    write(labelKey, null)
  }, [labelKey])
  const setOrder = useCallback(
    (next: KpiId[]) => {
      const valid = parseOrder(next)
      setOrderState(valid)
      write(orderKey, valid)
    },
    [orderKey],
  )
  const resetOrder = useCallback(() => {
    setOrderState([...KPI_IDS])
    write(orderKey, null)
  }, [orderKey])

  return { labels, order, setLabels, resetLabels, setOrder, resetOrder, labelsCustomised: Object.keys(custom).length > 0, orderCustomised: order.some((id, index) => id !== KPI_IDS[index]) }
}

/** The columns this user has hidden. The AMC Reference column is always shown, so each row stays identified. */
export function useHiddenColumns(userId: string): [ReadonlySet<ColumnId>, (hidden: ReadonlySet<ColumnId>) => void] {
  const key = `${PREFIX}.hidden-columns.${userId}`
  const [hidden, setHiddenState] = useState<ReadonlySet<ColumnId>>(() => {
    const saved = read(key)
    return new Set(Array.isArray(saved) ? saved.filter((id): id is ColumnId => COLUMN_IDS.includes(id as ColumnId)) : [])
  })

  const setHidden = useCallback(
    (next: ReadonlySet<ColumnId>) => {
      setHiddenState(next)
      write(key, next.size > 0 ? [...next] : null)
    },
    [key],
  )

  return [hidden, setHidden]
}
