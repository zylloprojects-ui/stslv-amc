import { useCallback, useState } from 'react'

// Dashboard layout choices, remembered in this browser for each signed-in user.
// They are conveniences only: nothing here changes what the API returns, and a
// blocked or empty browser store simply gives the default layout.

const PREFIX = 'stslev.dashboard'

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

/**
 * The saved order of the KPI cards: the saved ids that still exist, in their
 * saved order, followed by any card added since, in the default order.
 */
export function orderedIds(saved: readonly string[] | null, defaults: readonly string[]): string[] {
  const known = (saved ?? []).filter((id, index, list) => defaults.includes(id) && list.indexOf(id) === index)

  return [...known, ...defaults.filter((id) => !known.includes(id))]
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

/** The KPI order for this user, with a setter that remembers it and a reset to the default order. */
export function useKpiOrder(userId: string, defaults: readonly string[]) {
  const key = `${PREFIX}.kpi-order.${userId}`
  const [order, setOrder] = useState<string[]>(() => orderedIds(parseList(read(key)), defaults))

  const save = useCallback(
    (next: string[]) => {
      setOrder(next)
      write(key, JSON.stringify(next))
    },
    [key],
  )

  const reset = useCallback(() => {
    setOrder([...defaults])
    write(key, null)
  }, [defaults, key])

  return { order, setOrder: save, reset }
}

/** A remembered on/off choice for this user, for example whether the calendar is open. */
export function useStoredFlag(userId: string, name: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const key = `${PREFIX}.${name}.${userId}`
  const [value, setValue] = useState<boolean>(() => {
    const saved = read(key)

    return saved === null ? fallback : saved === '1'
  })

  const set = useCallback(
    (next: boolean) => {
      setValue(next)
      write(key, next ? '1' : '0')
    },
    [key],
  )

  return [value, set]
}

/** Remembered hidden columns of a dashboard table for this user. */
export function useHiddenColumns(userId: string, table: string, allowed: readonly string[]): [string[], (columns: string[]) => void] {
  const key = `${PREFIX}.columns.${table}.${userId}`
  const [hidden, setHidden] = useState<string[]>(() => (parseList(read(key)) ?? []).filter((id) => allowed.includes(id)))

  const set = useCallback(
    (columns: string[]) => {
      setHidden(columns)
      write(key, JSON.stringify(columns))
    },
    [key],
  )

  return [hidden, set]
}
