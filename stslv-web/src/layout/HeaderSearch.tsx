import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { cx } from '../lib/format'
import { NAVIGATION } from './navigation'

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
  Operations: {
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
  Reporting: { from: '#D1428C', to: '#FF8212', icon: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" strokeLinecap="round" /> },
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
    const pages = NAVIGATION.flatMap((section) =>
      section.items.filter((item) => auth.can(item.module, 'VIEW')).map((item) => ({ label: item.label, path: item.path, group: section.title ?? 'General' })),
    )

    return [...pages, { label: 'My Account', path: '/account', group: 'Account' }]
  }, [auth])

  const term = picked ? '' : query.trim()
  const results = useMemo(
    () => (term ? destinations.filter((item) => `${item.label} ${item.group}`.toLowerCase().includes(term.toLowerCase())) : destinations).slice(0, 8),
    [destinations, term],
  )

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
        <div className="login-rise absolute left-0 top-full z-50 mt-2 w-[22rem] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl ring-1 ring-black/5">
          <p className="border-b border-slate-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            {term ? `Results for “${term}”` : picked ? 'Current page' : 'Quick navigation'}
          </p>

          <ul id={listId} role="listbox" aria-label="Pages" className="max-h-72 overflow-y-auto p-1.5">
            {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">No matching pages.</li>}
            {results.map((item, index) => {
              const style = GROUP_STYLE[item.group] ?? GROUP_STYLE.General
              const selected = index === active

              return (
                <li key={item.path} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(item)}
                    className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors', selected ? 'bg-sky-50' : '')}
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
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-slate-900">
                        <Highlight text={item.label} term={term} />
                      </span>
                      <span className="block truncate text-[11px] text-slate-500">{item.group}</span>
                    </span>
                    {item.path === picked ? (
                      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2.4" aria-label="Selected">
                        <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      selected && (
                        <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500" aria-hidden="true">
                          Enter ↵
                        </span>
                      )
                    )}
                  </button>
                </li>
              )
            })}
          </ul>

          <p className="flex items-center gap-3 border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-400" aria-hidden="true">
            <span>↑↓ to move</span>
            <span>↵ to open</span>
            <span>Esc to close</span>
          </p>
        </div>
      )}
    </div>
  )
}
