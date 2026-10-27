import { useSyncExternalStore } from 'react'

// Which loader design is shown, remembered in this browser only. A tiny shared store keeps every
// loader on the page in step when the user picks a different style.
const STYLE_KEY = 'stslev.loader'

export const LOADERS = [
  { id: 'brand', name: 'Logo ring', note: 'Your logo inside a gradient ring' },
  { id: 'pinwheel', name: 'Pinwheel', note: 'Logo petals light up in turn' },
  { id: 'ripple', name: 'Pulse', note: 'Logo with spreading rings' },
  { id: 'skeleton', name: 'Skeleton', note: 'Page-shaped placeholders' },
  { id: 'minimal', name: 'Minimal', note: 'Quiet logo and slim bar' },
  { id: 'orbit', name: 'Orbit', note: 'AMC icons circling the logo' },
] as const

export type LoaderStyle = (typeof LOADERS)[number]['id']

function initial(): LoaderStyle {
  try {
    const saved = localStorage.getItem(STYLE_KEY)

    return LOADERS.some((item) => item.id === saved) ? (saved as LoaderStyle) : 'brand'
  } catch {
    return 'brand'
  }
}

let style: LoaderStyle = initial()
let previews = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

export function useLoaderStyle(): [LoaderStyle, (id: LoaderStyle) => void] {
  const current = useSyncExternalStore(subscribe, () => style)

  return [current, setLoaderStyle]
}

/** Counts how many times a preview was requested, so the page loader can replay itself. */
export function useLoaderPreviews(): number {
  return useSyncExternalStore(subscribe, () => previews)
}

export function setLoaderStyle(id: LoaderStyle) {
  style = id
  previews += 1

  try {
    localStorage.setItem(STYLE_KEY, id)
  } catch {
    // Storage may be blocked; the choice then lasts for this visit only.
  }

  emit()
}
