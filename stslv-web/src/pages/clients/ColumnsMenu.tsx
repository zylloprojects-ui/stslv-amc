import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ColumnOption<K extends string> {
  key: K
  label: string
}

/** Below this much room above the button, an upward panel opens downwards instead (only if there is more room there). */
const MIN_ROOM = 200
/** The gap between the button and the panel, and the margin the panel keeps from the window's edges. */
const GAP = 8
const PANEL_WIDTH = 224

/**
 * Where an upward panel goes: fixed to the window, above the Columns button and right-aligned with it. It never
 * leaves the window or slides under the application's sticky top bar: it scrolls inside when the room is short,
 * and opens below the button if there is no room above.
 */
function upwardPosition(button: HTMLElement): CSSProperties {
  const rect = button.getBoundingClientRect()
  const topBar = Math.max(0, document.querySelector('header')?.getBoundingClientRect().bottom ?? 0)
  const above = rect.top - topBar - GAP * 2
  const below = window.innerHeight - rect.bottom - GAP * 2
  const down = above < MIN_ROOM && below > above
  const left = Math.min(Math.max(GAP, rect.right - PANEL_WIDTH), Math.max(GAP, window.innerWidth - PANEL_WIDTH - GAP))

  return {
    left,
    width: PANEL_WIDTH,
    maxHeight: Math.max(120, down ? below : above),
    ...(down ? { top: rect.bottom + GAP } : { bottom: window.innerHeight - rect.top + GAP }),
  }
}

/**
 * A "Columns" button that opens a list of checkboxes, one per optional column.
 * Closes on Escape or a click outside. The column that names a row is not
 * offered, so the table always identifies its rows.
 *
 * placement "up" opens the list above the button, drawn over the page (outside any card or table that would cut it
 * off) and scrolling inside when the window is short. "down" (the default) is the original list under the button.
 */
export function ColumnsMenu<K extends string>({
  options,
  hidden,
  onChange,
  placement = 'down',
}: {
  options: ColumnOption<K>[]
  hidden: ReadonlySet<K>
  onChange: (hidden: Set<K>) => void
  placement?: 'down' | 'up'
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties | null>(null)
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const floating = placement === 'up'

  const inside = useCallback((target: EventTarget | null) => target instanceof Node && (!!root.current?.contains(target) || !!panel.current?.contains(target)), [])

  useEffect(() => {
    if (!open) return

    const onPointer = (event: PointerEvent) => {
      if (!inside(event.target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }

    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, inside])

  // The floating panel follows the button while the page scrolls or the window changes size.
  useLayoutEffect(() => {
    if (!open || !floating) return

    const place = () => {
      if (button.current) setPosition(upwardPosition(button.current))
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, floating])

  // The floating panel sits at the end of the page, so the keyboard is taken into it on opening, and leaving it closes it.
  const placed = position !== null
  useEffect(() => {
    if (open && floating && placed) panel.current?.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus({ preventScroll: true })
  }, [open, floating, placed])

  const toggle = (key: K) => {
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  const shownCount = options.filter((option) => !hidden.has(option.key)).length

  const content: ReactNode = (
    <>
      <fieldset>
        <legend className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Show columns</legend>
        {options.map((option) => (
          <label key={option.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-sky-50">
            <input type="checkbox" checked={!hidden.has(option.key)} onChange={() => toggle(option.key)} className="h-4 w-4 shrink-0 rounded border-slate-300 accent-[#1479BD]" />
            {option.label}
          </label>
        ))}
      </fieldset>
      {/* Client UAT CR-030: back to the default, every column shown. Only the columns offered here, never a restricted one. */}
      <button
        type="button"
        disabled={shownCount === options.length}
        onClick={() => onChange(new Set([...hidden].filter((key) => !options.some((option) => option.key === key))))}
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-sm font-medium text-[#1479BD] hover:bg-sky-50 disabled:cursor-default disabled:text-slate-400 disabled:hover:bg-transparent"
      >
        Show all columns
      </button>
    </>
  )

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-700 shadow-sm transition hover:border-[#1479BD] hover:text-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M9.5 4.5v15M14.5 4.5v15" />
        </svg>
        Columns
        <span className="text-xs tabular-nums text-slate-500">
          {shownCount}/{options.length}
        </span>
      </button>
      {open && !floating && (
        <div id={panelId} className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          {content}
        </div>
      )}
      {open &&
        floating &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            role="group"
            aria-label="Columns"
            style={position ?? { visibility: 'hidden' }}
            onBlur={(event) => {
              if (!inside(event.relatedTarget) && event.relatedTarget !== null) setOpen(false)
            }}
            className="fixed z-50 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-2 shadow-[0_18px_48px_-12px_rgba(8,32,60,0.45)]"
          >
            {content}
          </div>,
          document.body,
        )}
    </div>
  )
}
