import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../lib/format'

interface Choice {
  value: string
  label: string
  disabled: boolean
}

interface Open {
  select: HTMLSelectElement
  rect: DOMRect
  choices: Choice[]
}

const SEARCH_FROM = 8
const MAX_HEIGHT = 288

function choicesOf(select: HTMLSelectElement): Choice[] {
  return [...select.options].map((option) => ({ value: option.value, label: option.textContent?.trim() || option.value, disabled: option.disabled }))
}

/**
 * A modern drop-down list for every <select> in the application.
 *
 * The real <select> stays in the page: it is what screen readers, the keyboard and the forms use, so nothing about
 * how the controls work changes. Only when a person opens one with the mouse is the browser's plain list replaced by
 * this one: rounded, with a tick on the chosen entry, and a search box when the list is long. Choosing an entry sets
 * the select and tells the page exactly as the browser's own list would.
 */
export function SelectPopup() {
  const [open, setOpen] = useState<Open | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const close = useCallback((refocus: boolean) => {
    setOpen((current) => {
      if (current && refocus) {
        current.select.focus({ preventScroll: true })
      }

      return null
    })
    setQuery('')
  }, [])

  const choose = useCallback(
    (choice: Choice) => {
      if (!open || choice.disabled) {
        return
      }

      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set

      if (setter && open.select.value !== choice.value) {
        setter.call(open.select, choice.value)
        open.select.dispatchEvent(new Event('change', { bubbles: true }))
      }

      close(true)
    },
    [close, open],
  )

  // A real mouse press on a select opens this list instead of the browser's. Scripted events (tests, tools) are left alone.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const select = target?.closest('select')

      if (!select || !event.isTrusted || event.button !== 0 || select.disabled || select.multiple || select.size > 1) {
        return
      }

      event.preventDefault()
      select.focus({ preventScroll: true })

      const choices = choicesOf(select)

      setQuery('')
      setActive(Math.max(0, choices.findIndex((choice) => choice.value === select.value)))
      setOpen((current) => (current?.select === select ? null : { select, rect: select.getBoundingClientRect(), choices }))
    }

    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return open ? open.choices.filter((choice) => !needle || choice.label.toLowerCase().includes(needle)) : []
  }, [open, query])

  // While open: click away, scroll away, resize or press Escape to close; arrows and Enter pick an entry.
  useEffect(() => {
    if (!open) {
      return
    }

    const onPointer = (event: MouseEvent) => {
      const inside = event.target instanceof Node && (panelRef.current?.contains(event.target) || open.select.contains(event.target))

      if (!inside) {
        close(false)
      }
    }
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && panelRef.current?.contains(event.target))) {
        close(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        event.preventDefault()
        close(true)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((current) => Math.min(Math.max(current + (event.key === 'ArrowDown' ? 1 : -1), 0), Math.max(shown.length - 1, 0)))
      } else if (event.key === 'Enter') {
        const choice = shown[active]

        if (choice) {
          event.preventDefault()
          event.stopPropagation()
          choose(choice)
        }
      }
    }

    document.addEventListener('mousedown', onPointer, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('mousedown', onPointer, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, close, choose, shown, active])

  useEffect(() => {
    if (open && open.choices.length > SEARCH_FROM) {
      searchRef.current?.focus({ preventScroll: true })
    }
  }, [open])

  // Keep the highlighted entry in view while moving with the arrows.
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) {
    return null
  }

  const { rect, choices, select } = open
  const searchable = choices.length > SEARCH_FROM
  const below = window.innerHeight - rect.bottom
  const flip = below < 220 && rect.top > below
  const width = Math.max(rect.width, 208)
  const left = Math.min(rect.left, window.innerWidth - width - 8)
  const height = Math.min(MAX_HEIGHT, (flip ? rect.top : below) - 16)

  return createPortal(
    <div
      ref={panelRef}
      aria-hidden="true"
      className="select-popup login-fade fixed z-[300] flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_18px_48px_-12px_rgba(8,32,60,0.45)] ring-1 ring-slate-900/5"
      style={{ left: Math.max(8, left), width, maxHeight: Math.max(160, height), ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) }}
    >
      {searchable && (
        <div className="shrink-0 border-b border-slate-100 p-2">
          <div className="relative">
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m20 20-4.2-4.2" strokeLinecap="round" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              placeholder="Search…"
              tabIndex={-1}
              className="block w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2 text-sm outline-none focus:border-[#1479BD] focus:bg-white"
            />
          </div>
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">Nothing matches “{query}”</li>}
        {shown.map((choice, index) => {
          const selected = choice.value === select.value
          // The first entry of a filter ("All clients", "Any") is the way to clear it: set it apart from the rest.
          const clears = index === 0 && !query && (choice.value === '' || choice.value === 'all')

          return (
            <li key={`${choice.value}-${index}`} className={cx(clears && 'mb-1 border-b border-slate-100 pb-1')}>
              <button
                type="button"
                tabIndex={-1}
                disabled={choice.disabled}
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(choice)}
                className={cx(
                  'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  index === active ? 'bg-sky-50 text-[#0b3b66]' : 'text-slate-700',
                  selected && 'font-semibold text-[#0b3b66]',
                  clears && !selected && 'text-slate-500',
                )}
              >
                <span className="min-w-0 flex-1 break-words">{choice.label}</span>
                {selected && (
                  <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                    <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </div>,
    document.body,
  )
}
