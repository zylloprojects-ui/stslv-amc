import { useEffect, useId, useRef, useState } from 'react'

export interface ColumnOption<K extends string> {
  key: K
  label: string
}

/**
 * A "Columns" button that opens a list of checkboxes, one per optional column.
 * Closes on Escape or a click outside. The column that names a row is not
 * offered, so the table always identifies its rows.
 */
export function ColumnsMenu<K extends string>({ options, hidden, onChange }: { options: ColumnOption<K>[]; hidden: ReadonlySet<K>; onChange: (hidden: Set<K>) => void }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return

    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
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
  }, [open])

  const toggle = (key: K) => {
    const next = new Set(hidden)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  const shownCount = options.filter((option) => !hidden.has(option.key)).length

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
      {open && (
        <div id={panelId} className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
          <fieldset>
            <legend className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">Show columns</legend>
            {options.map((option) => (
              <label key={option.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-slate-700 hover:bg-sky-50">
                <input type="checkbox" checked={!hidden.has(option.key)} onChange={() => toggle(option.key)} className="h-4 w-4 rounded border-slate-300 accent-[#1479BD]" />
                {option.label}
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  )
}
