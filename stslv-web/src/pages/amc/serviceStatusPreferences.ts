import { useCallback, useState } from 'react'
import { orderedIds } from '../dashboard/dashboardPreferences'

// Service Status layout choices, remembered in this browser for each signed-in
// user. They change only how the page looks: a renamed card still counts the
// same business status, and a blocked browser store gives the default layout.

const PREFIX = 'stslev.service-status'

export const KPI_IDS = ['total', 'completed', 'notCompleted', 'waitingForRenewal'] as const
export type KpiId = (typeof KPI_IDS)[number]

export const DEFAULT_KPI_LABELS: Record<KpiId, string> = {
  total: 'Total Services',
  completed: 'Completed',
  notCompleted: 'Not Completed',
  waitingForRenewal: 'Waiting for Renewal',
}

export const KPI_LABEL_MAX = 40

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

/** The card names and order for this user, with resets to the defaults. */
export function useKpiLayout(userId: string) {
  const labelKey = `${PREFIX}.kpi-labels.${userId}`
  const orderKey = `${PREFIX}.kpi-order.${userId}`
  const [custom, setCustom] = useState(() => parseLabels(read(labelKey)))
  const [order, setOrderState] = useState<KpiId[]>(() => {
    const saved = read(orderKey)

    return orderedIds(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : null, KPI_IDS) as KpiId[]
  })

  const labelOf = useCallback((id: KpiId) => custom[id] ?? DEFAULT_KPI_LABELS[id], [custom])

  const setLabels = useCallback(
    (labels: Partial<Record<KpiId, string>>) => {
      const next = parseLabels(labels)

      // A name equal to the default is not stored, so a later change of the default reaches this user.
      for (const id of KPI_IDS) if (next[id] === DEFAULT_KPI_LABELS[id]) delete next[id]
      setCustom(next)
      write(labelKey, Object.keys(next).length > 0 ? next : null)
    },
    [labelKey],
  )

  const setOrder = useCallback(
    (next: KpiId[]) => {
      setOrderState(next)
      write(orderKey, next)
    },
    [orderKey],
  )

  const resetLabels = useCallback(() => {
    setCustom({})
    write(labelKey, null)
  }, [labelKey])

  const resetOrder = useCallback(() => {
    setOrderState([...KPI_IDS])
    write(orderKey, null)
  }, [orderKey])

  return { order, labelOf, labels: custom, setLabels, setOrder, resetLabels, resetOrder }
}

/** Remembered hidden columns of the Service Status table for this user. */
export function useHiddenServiceColumns<K extends string>(userId: string, allowed: readonly K[]): [Set<K>, (hidden: Set<K>) => void] {
  const key = `${PREFIX}.columns.${userId}`
  const [hidden, setHidden] = useState<Set<K>>(() => {
    const saved = read(key)

    return new Set(Array.isArray(saved) ? (saved.filter((id) => allowed.includes(id as K)) as K[]) : [])
  })

  const set = useCallback(
    (next: Set<K>) => {
      setHidden(next)
      write(key, [...next])
    },
    [key],
  )

  return [hidden, set]
}
