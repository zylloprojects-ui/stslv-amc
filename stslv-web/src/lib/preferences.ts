import { useCallback, useEffect, useState } from 'react'

// Display preferences, remembered in this browser only.
const THEME_KEY = 'stslev.theme'
const SIDEBAR_KEY = 'stslev.sidebar-collapsed'
const PALETTE_KEY = 'stslev.palette'

export type Theme = 'light' | 'dark'

// What was chosen in this visit, so a blocked or full browser store still works until the page is closed.
const remembered: Record<string, string> = {}
const listeners = new Set<() => void>()

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return remembered[key] ?? null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be blocked; the preference then lasts for this visit only.
    remembered[key] = value
  }

  // Tell every part of the page that shows this preference (the header, the sidebar, the Settings page).
  listeners.forEach((listener) => listener())
}

function useStored<T>(readValue: () => T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(readValue)

  useEffect(() => {
    const update = () => setValue(readValue())

    listeners.add(update)
    return () => {
      listeners.delete(update)
    }
    // readValue only reads the stored value, so it does not need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return [value, setValue]
}

export function useTheme(): [Theme, () => void, (theme: Theme) => void] {
  const [theme] = useStored<Theme>(() => (read(THEME_KEY) === 'dark' ? 'dark' : 'light'))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const set = useCallback((next: Theme) => write(THEME_KEY, next), [])
  const toggle = useCallback(() => write(THEME_KEY, read(THEME_KEY) === 'dark' ? 'light' : 'dark'), [])

  return [theme, toggle, set]
}

const narrowLaptop = () => window.matchMedia?.('(min-width: 1024px) and (max-width: 1359px)')?.matches ?? false

export function useSidebarCollapsed(): [boolean, () => void, (value: boolean) => void] {
  // Until the person chooses, a laptop-sized window starts with the narrow sidebar, so wide tables have room.
  const [collapsed] = useStored<boolean>(() => {
    const saved = read(SIDEBAR_KEY)

    return saved !== null ? saved === '1' : narrowLaptop()
  })

  const set = useCallback((value: boolean) => write(SIDEBAR_KEY, value ? '1' : '0'), [])
  const toggle = useCallback(() => {
    const saved = read(SIDEBAR_KEY)
    const current = saved !== null ? saved === '1' : narrowLaptop()

    write(SIDEBAR_KEY, current ? '0' : '1')
  }, [])

  return [collapsed, toggle, set]
}

export const PALETTES = [
  { id: 'ocean', name: 'Ocean Navy', note: 'Dark blue' },
  { id: 'sky', name: 'Sky Light', note: 'Soft blue' },
  { id: 'mint', name: 'Mint Light', note: 'Soft green' },
  { id: 'sand', name: 'Sand Light', note: 'Warm cream' },
  { id: 'lavender', name: 'Lavender Light', note: 'Soft violet' },
] as const

export type PaletteId = (typeof PALETTES)[number]['id']

export function usePalette(): [PaletteId, (id: PaletteId) => void] {
  const [palette] = useStored<PaletteId>(() => {
    const saved = read(PALETTE_KEY)

    return PALETTES.some((item) => item.id === saved) ? (saved as PaletteId) : 'ocean'
  })

  useEffect(() => {
    document.documentElement.dataset.palette = palette
  }, [palette])

  const choose = useCallback((id: PaletteId) => write(PALETTE_KEY, id), [])

  return [palette, choose]
}
