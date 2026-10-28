import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { cx } from '../lib/format'
import { isAdmin } from '../auth/roles'
import { NAVIGATION, navItemVisible } from './navigation'

interface Destination {
  label: string
  path: string
  group: string
}

const GROUP_STYLE: Record<string, { from: string; to: string; icon: ReactNode }> = {
  General: {
    from: '#1B8AD3',
    to: '#00A6C8',
    icon: <path d="M4 12 12 4l8 8M6 10v9h12v-9" strokeLinecap="round" strokeLinejoin="round" />,
  },
  'Master Data Center': {
    from: '#0E7C86',
    to: '#2DB7A3',
    icon: (
      <>
        <ellipse cx="12" cy="6" rx="7" ry="2.8" />
        <path d="M5 6v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12v6c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8v-6" />
      </>
    ),
  },
  'AMC Operations': {
    from: '#00A6C8',
    to: '#5BAF48',
    icon: (
      <>
        <rect x="3.5" y="7" width="17" height="12.5" rx="2.5" />
        <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" strokeLinecap="round" />
      </>
    ),
  },
  Finance: {
    from: '#FF8212',
    to: '#F5C622',
    icon: <path d="M12 3v18M16.5 7.5c-.6-1.4-2.3-2.2-4.5-2.2-2.5 0-4 1.1-4 2.8 0 4 9 1.7 9 6 0 1.8-1.7 3-4.5 3-2.3 0-4.1-.9-4.7-2.5" strokeLinecap="round" />,
  },
  Administration: {
    from: '#7E6FAC',
    to: '#1B8AD3',
    icon: <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6l-7-2.5Z" strokeLinejoin="round" />,
  },
  Account: {
    from: '#1B8AD3',
    to: '#5BAF48',
    icon: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M4.5 20c0-3.6 3.4-5.5 7.5-5.5s7.5 1.9 7.5 5.5" strokeLinecap="round" />
      </>
    ),
  },
}

/** Marks the part of the label that matches what was typed. */
function Highlight({ text, term }: { text: string; term: string }) {
  const at = term ? text.toLowerCase().indexOf(term.toLowerCase()) : -1

  if (at < 0) {
    return <>{text}</>
  }

  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-amber-200/70 px-0.5 text-inherit">{text.slice(at, at + term.length)}</mark>
      {text.slice(at + term.length)}
    </>
  )
}

/** Quick navigation: type a page name and jump straight to it. */
export function HeaderSearch() {
  const auth = useAuth()
  const navigate = useNavigate()
  const listId = useId()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  // The page last chosen from the list; it stays shown in the box until the user types again.
  const [picked, setPicked] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  // Only pages the signed-in user may view are offered; the API still enforces access.
  const destinations = useMemo<Destination[]>(() => {
    const pages = NAVIGATION.flatMap((section) => {
      const items = section.items.filter((item) => navItemVisible(item, auth.can, isAdmin(auth.user))).map((item) => ({ label: item.label, path: item.path, group: section.title ?? 'General' }))
      // A group's landing page is offered when any of its pages is.
      const landing = section.path && section.title && items.length > 0 ? [{ label: section.title, path: section.path, group: section.title }] : []

      return [...landing, ...items]
    })

    return [...pages, { label: 'My Account', path: '/account', group: 'Account' }]
  }, [auth])

  const term = picked ? '' : query.trim()
  const results = useMemo(() => (term ? destinations.filter((item) => `${item.label} ${item.group}`.toLowerCase().includes(term.toLowerCase())) : destinations), [destinations, term])
  const groups = useMemo(() => {
    const order: string[] = []

    for (const item of results) {
      if (!order.includes(item.group)) order.push(item.group)
    }

    return order.map((group) => ({ group, items: results.filter((item) => item.group === group) }))
  }, [results])

  // Keep the highlighted page in view while moving with the arrow keys.
  useEffect(() => {
    if (open) {
      document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
    }
  }, [active, open, listId])

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)

    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  function go(destination: Destination | undefined) {
    if (!destination) {
      return
    }
    setOpen(false)
    setQuery(destination.label)
    setPicked(destination.path)
    navigate(destination.path)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActive((index) => Math.min(index + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      go(results[active])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative hidden w-full max-w-sm md:block">
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m20 20-4.2-4.2" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        role="combobox"
        aria-label="Search pages"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Search pages…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setPicked(null)
          setActive(0)
          setOpen(true)
        }}
        onFocus={(event) => {
          setOpen(true)
          if (picked) {
            setActive(Math.max(0, results.findIndex((item) => item.path === picked)))
            event.currentTarget.select()
          }
        }}
        onKeyDown={onKeyDown}
        className="block w-full rounded-xl border border-transparent bg-slate-100 py-2.5 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-500 transition-all duration-200 focus:border-[#1479BD] focus:bg-white focus:shadow-[0_0_0_4px_rgba(27,138,211,0.15)] focus:outline-none"
      />

      {open && (
        <div className="login-rise absolute left-0 top-full z-50 mt-2 w-[24rem] overflow-hidden rounded-2xl border border-slate-300 bg-white shadow-2xl ring-1 ring-black/5">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 to-white px-4 py-2.5">
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#0b3b66]">{term ? `Results for “${term}”` : picked ? 'Current page' : 'Quick navigation'}</p>
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-600 ring-1 ring-inset ring-slate-300">
              {results.length} {results.length === 1 ? 'page' : 'pages'}
            </span>
          </div>

          <ul id={listId} role="listbox" aria-label="Pages" className="max-h-80 overflow-y-auto px-2 pb-2">
            {results.length === 0 && <li className="px-3 py-8 text-center text-sm text-slate-500">No matching pages.</li>}
            {groups.map(({ group, items }) => {
              const style = GROUP_STYLE[group] ?? GROUP_STYLE.General

              return (
                <li key={group} role="presentation">
                  <p className="sticky top-0 z-10 flex items-center gap-2 bg-white/95 px-2 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 backdrop-blur">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundImage: `linear-gradient(135deg, ${style?.from}, ${style?.to})` }} aria-hidden="true" />
                    {group}
                  </p>
                  <ul role="presentation" className="space-y-0.5">
                    {items.map((item) => {
                      const index = results.indexOf(item)
                      const selected = index === active

                      return (
                        <li key={item.path} id={`${listId}-${index}`} role="option" aria-selected={selected}>
                          <button
                            type="button"
                            onMouseEnter={() => setActive(index)}
                            onClick={() => go(item)}
                            className={cx('flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors', selected ? 'bg-sky-50 ring-1 ring-inset ring-sky-200' : '')}
                          >
                            <span
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white shadow-sm"
                              style={{ backgroundImage: `linear-gradient(135deg, ${style?.from}, ${style?.to})` }}
                              aria-hidden="true"
                            >
                              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                                {style?.icon}
                              </svg>
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
                              <Highlight text={item.label} term={term} />
                            </span>
                            <span className="flex w-14 shrink-0 justify-end">
                              {item.path === picked ? (
                                <svg viewBox="0 0 20 20" className="h-4 w-4 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2.4" aria-label="Selected">
                                  <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              ) : (
                                selected && (
                                  <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 shadow-sm" aria-hidden="true">
                                    Enter ↵
                                  </kbd>
                                )
                              )}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>

          <p className="flex items-center gap-4 border-t border-slate-200 bg-slate-50 px-4 py-2 text-[11px] text-slate-500" aria-hidden="true">
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-semibold shadow-sm">↑↓</kbd> move
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-semibold shadow-sm">↵</kbd> open
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-semibold shadow-sm">Esc</kbd> close
            </span>
          </p>
        </div>
      )}
    </div>
  )
}
