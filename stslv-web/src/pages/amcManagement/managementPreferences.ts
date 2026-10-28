import { useCallback, useState } from 'react'
import { orderedIds } from '../dashboard/dashboardPreferences'

// KPI names and order on AMC Management, remembered in this browser for each
// signed-in user and each KPI group, like the dashboard's KPI layout. They are
// display choices only: a renamed card still shows the same figure, and the
// standard name stays available on hover. A blocked or empty browser store
// gives the standard names and order.

const PREFIX = 'stslev.amc-management'

/** Longest display name a user may give a KPI. */
export const KPI_NAME_MAX = 40

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage may be blocked; the choice then lasts for this visit only.
  }
}

function parseList(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)

    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
  } catch {
    return null
  }
}

/** Saved names of KPIs that still exist, each cut to KPI_NAME_MAX characters. Anything else is ignored. */
export function parseNames(raw: string | null, ids: readonly string[]): Record<string, string> {
  if (!raw) return {}
  try {
    const value: unknown = JSON.parse(raw)

    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => ids.includes(entry[0]) && typeof entry[1] === 'string')
        .map(([id, name]) => [id, name.slice(0, KPI_NAME_MAX)]),
    )
  } catch {
    return {}
  }
}

/** The name a card shows: the user's own name when it has any text, else the standard name. */
export function displayName(names: Record<string, string>, id: string, standard: string): string {
  const own = names[id]?.trim()

  return own ? own : standard
}

/**
 * Names and order of one KPI group for this user, with setters that remember them and resets to the standard.
 * `prefix` keeps another page's choices apart from AMC Management's.
 */
export function useKpiCustomization(userId: string, group: string, defaults: readonly string[], prefix = PREFIX) {
  const orderKey = `${prefix}.${group}.kpi-order.${userId}`
  const namesKey = `${prefix}.${group}.kpi-names.${userId}`
  const [order, setOrderState] = useState<string[]>(() => orderedIds(parseList(read(orderKey)), defaults))
  const [names, setNamesState] = useState<Record<string, string>>(() => parseNames(read(namesKey), defaults))

  const setOrder = useCallback(
    (next: string[]) => {
      setOrderState(next)
      write(orderKey, JSON.stringify(next))
    },
    [orderKey],
  )

  const rename = useCallback(
    (id: string, name: string) => {
      setNamesState((current) => {
        const next = { ...current }

        // Kept as typed, so spaces between words survive; shown trimmed.
        if (name.trim() === '') delete next[id]
        else next[id] = name.slice(0, KPI_NAME_MAX)
        write(namesKey, Object.keys(next).length > 0 ? JSON.stringify(next) : null)

        return next
      })
    },
    [namesKey],
  )

  const resetOrder = useCallback(() => {
    setOrderState([...defaults])
    write(orderKey, null)
  }, [defaults, orderKey])

  const resetNames = useCallback(() => {
    setNamesState({})
    write(namesKey, null)
  }, [namesKey])

  return {
    order,
    names,
    setOrder,
    rename,
    resetOrder,
    resetNames,
    orderChanged: order.some((id, index) => id !== defaults[index]),
    namesChanged: Object.keys(names).length > 0,
  }
}
