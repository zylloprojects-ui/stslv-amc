import { useCallback, useState } from 'react'

// The columns this user has hidden on an administration table, remembered in this browser.
// Only how the page looks changes; a blocked browser store gives the default layout.

function load<K extends string>(key: string, allowed: readonly K[]): ReadonlySet<K> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return new Set(Array.isArray(saved) ? saved.filter((id): id is K => allowed.includes(id as K)) : [])
  } catch {
    return new Set()
  }
}

export function useHiddenColumns<K extends string>(table: string, userId: string, allowed: readonly K[]): [ReadonlySet<K>, (hidden: ReadonlySet<K>) => void] {
  const key = `stslev.${table}.hidden-columns.${userId}`
  const [state, setState] = useState(() => ({ key, hidden: load(key, allowed) }))

  if (state.key !== key) setState({ key, hidden: load(key, allowed) })

  const setHidden = useCallback(
    (next: ReadonlySet<K>) => {
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

  return [state.hidden, setHidden]
}
