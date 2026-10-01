import { useCallback, useEffect, useState } from 'react'

// Display preferences, remembered in this browser only.
const THEME_KEY = 'stslev.theme'
const SIDEBAR_KEY = 'stslev.sidebar-collapsed'
const PALETTE_KEY = 'stslev.palette'

export type Theme = 'light' | 'dark'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be blocked; the preference then lasts for this visit only.
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (read(THEME_KEY) === 'dark' ? 'dark' : 'light'))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark'
      write(THEME_KEY, next)
      return next
    })
  }, [])

  return [theme, toggle]
}

export function useSidebarCollapsed(): [boolean, () => void, (value: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => read(SIDEBAR_KEY) === '1')

  const set = useCallback((value: boolean) => {
    write(SIDEBAR_KEY, value ? '1' : '0')
    setCollapsed(value)
  }, [])

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      write(SIDEBAR_KEY, current ? '0' : '1')
      return !current
    })
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
  const [palette, setPalette] = useState<PaletteId>(() => {
    const saved = read(PALETTE_KEY)

    return PALETTES.some((item) => item.id === saved) ? (saved as PaletteId) : 'ocean'
  })

  useEffect(() => {
    document.documentElement.dataset.palette = palette
  }, [palette])

  const choose = useCallback((id: PaletteId) => {
    write(PALETTE_KEY, id)
    setPalette(id)
  }, [])

  return [palette, choose]
}
