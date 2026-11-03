import { useId, useState, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react'
import { Button } from '../../components/ui'
import { cx } from '../../lib/format'
import {
  CONTRACT_STATUS_LABELS,
  INVOICE_ELIGIBILITY_LABELS,
  VISIT_STATUS_LABELS,
  type ContractStatus,
  type InvoiceEligibility,
  type VisitStatus,
} from './types'

// Building blocks shared by the three AMC pages.

const CONTROL = 'block w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 disabled:bg-slate-100 disabled:text-slate-500'

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  ref?: Ref<HTMLSelectElement>
  label: string
  error?: string | undefined
  hint?: string | undefined
  children: ReactNode
}

/** A labelled drop-down for forms, matching TextField. */
export function SelectField({ label, error, hint, required, className, children, ...rest }: SelectFieldProps) {
  const id = useId()

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <span className="text-red-600" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        className={cx(CONTROL, error ? 'border-red-500' : 'border-slate-300', className)}
        {...rest}
      >
        {children}
      </select>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  )
}

interface FilterProps {
  label: string
  children: (id: string, className: string) => ReactNode
  className?: string
}

/** A labelled control in a list's filter bar. */
export function Filter({ label, children, className }: FilterProps) {
  const id = useId()

  return (
    // A small card: the label sits inside the frame above the control, and the frame lights up on hover and focus.
    <div className={cx('rounded-xl border-[1.5px] border-slate-300 bg-white px-3.5 pb-1.5 pt-2 shadow-sm transition-all focus-within:border-[#1479BD] focus-within:ring-4 focus-within:ring-sky-100 hover:border-[#1479BD]/60', className)}>
      <label htmlFor={id} className="block text-[10px] font-bold uppercase tracking-[0.14em] text-[#1479BD]">
        {label}
      </label>
      {children(id, 'block w-full bg-transparent py-1 text-sm font-semibold text-slate-900 placeholder:font-normal placeholder:text-slate-400 border-0 shadow-none focus:shadow-none focus:outline-none focus-visible:border-transparent focus-visible:shadow-none')}
    </div>
  )
}

/**
 * A filter the user's role may not use. It stays in the filter bar, greyed out with the reason, so the user is not
 * left thinking there is nothing to filter by when the list is only out of their reach.
 */
export function RestrictedFilter({ label, reason }: { label: string; reason: string }) {
  return (
    <Filter label={label} className="opacity-70">
      {(id, className) => (
        <select id={id} disabled title={reason} className={cx(className, 'cursor-not-allowed text-slate-500')}>
          <option>{reason}</option>
        </select>
      )}
    </Filter>
  )
}

/**
 * The Hide / Show button, the same size and look as the Excel and PDF export buttons beside it: a white
 * button with a tile at its left. The tile is blue and filled while the section is hidden.
 */
export function ToggleButton({ open, onClick, controls, openLabel, closedLabel, marked = false, label }: { open: boolean; onClick: () => void; controls?: string | undefined; openLabel: string; closedLabel: string; marked?: boolean; /** Fuller accessible name, e.g. "Hide Recent AMC Contracts"; it should start with the visible label. */ label?: string | undefined }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      className="group inline-flex items-center gap-2.5 rounded-lg border border-slate-300 bg-white py-1 pl-1 pr-3.5 text-sm font-semibold text-[#0b3b66] shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-[#1479BD] hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky-200 active:translate-y-0"
    >
      <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors duration-200', open ? 'bg-sky-50 text-[#1479BD] group-hover:bg-[#1479BD] group-hover:text-white' : 'bg-[#1479BD] text-white')} aria-hidden="true">
        <svg viewBox="0 0 24 24" className={cx('h-4 w-4 transition-transform duration-200', open && 'rotate-180')} fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {open ? openLabel : closedLabel}
      {marked && <span className="h-2 w-2 rounded-full bg-amber-500" title="Filters are applied" />}
    </button>
  )
}

const FILTER_KEY = 'stslev.filters.'

/**
 * A list's filters with a Hide filters / Show filters button above them, so the list can have the
 * room. The filters stay in place and keep working while hidden; the choice is remembered per list.
 */
export function FilterPanel({ id, children }: { id: string; children: ReactNode }) {
  const panelId = useId()
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(FILTER_KEY + id) !== 'closed'
    } catch {
      return true
    }
  })
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(FILTER_KEY + id, next ? 'open' : 'closed')
    } catch {
      // Storage may be blocked; the choice then lasts for this visit only.
    }
  }

  return (
    <div>
      <div className={cx('flex items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-4 py-2 sm:px-5', !open && 'border-b-0')}>
        <span className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[#0b3b66] to-[#1479BD] text-white shadow-sm" aria-hidden="true">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 5h14l-5.5 6.5V16l-3-1.5v-3L3 5Z" />
            </svg>
          </span>
          <span className="text-xs font-bold uppercase tracking-[0.14em] text-[#0b3b66]">Filters</span>
          {!open && <span className="hidden text-xs text-slate-500 sm:inline">Hidden. Anything you set still applies.</span>}
        </span>
        <ToggleButton open={open} onClick={toggle} controls={panelId} openLabel="Hide filters" closedLabel="Show filters" />
      </div>
      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </div>
  )
}

/** Whether a section of a page is open, remembered per section in this browser. */
export function useCollapse(id: string): { open: boolean; toggle: () => void } {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(FILTER_KEY + id) !== 'closed'
    } catch {
      return true
    }
  })
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(FILTER_KEY + id, next ? 'open' : 'closed')
    } catch {
      // Storage may be blocked; the choice then lasts for this visit only.
    }
  }

  return { open, toggle }
}

/** A Hide / Show button for a section, for the section's header. */
export function CollapseButton({ open, toggle, controls }: { open: boolean; toggle: () => void; controls?: string }) {
  return <ToggleButton open={open} onClick={toggle} controls={controls} openLabel="Hide" closedLabel="Show" />
}

type Tone = 'green' | 'slate' | 'blue' | 'amber' | 'red'

const TONES: Record<Tone, string> = {
  green: 'bg-green-50 text-green-800 ring-green-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  blue: 'bg-blue-50 text-blue-800 ring-blue-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-800 ring-red-600/20',
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[tone])}>
      {children}
    </span>
  )
}

const CONTRACT_TONES: Record<ContractStatus, Tone> = { DRAFT: 'amber', ACTIVE: 'green', EXPIRED: 'slate', CANCELLED: 'red' }
const VISIT_TONES: Record<VisitStatus, Tone> = {
  SCHEDULED: 'blue',
  IN_PROGRESS: 'amber',
  COMPLETED: 'green',
  POSTPONED: 'slate',
  CANCELLED: 'red',
  HISTORICAL: 'slate',
}
const ELIGIBILITY_TONES: Record<InvoiceEligibility, Tone> = {
  NOT_COMPLETED: 'slate',
  AMOUNT_REQUIRED: 'red',
  NO_INVOICE_REQUIRED: 'slate',
  READY_FOR_INVOICE: 'green',
  INVOICED: 'blue',
  HISTORICAL: 'slate',
}

export function ContractStatusPill({ status }: { status: ContractStatus }) {
  return <Pill tone={CONTRACT_TONES[status]}>{CONTRACT_STATUS_LABELS[status]}</Pill>
}

export function VisitStatusPill({ status, overdue = false }: { status: VisitStatus; overdue?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill tone={VISIT_TONES[status]}>{VISIT_STATUS_LABELS[status]}</Pill>
      {overdue && <Pill tone="red">Overdue</Pill>}
    </span>
  )
}

export function EligibilityPill({ eligibility }: { eligibility: InvoiceEligibility }) {
  // A historical visit is waiting for no invoice; its status already says what it is.
  if (eligibility === 'NOT_COMPLETED' || eligibility === 'HISTORICAL') {
    return <span className="text-slate-400">—</span>
  }

  return <Pill tone={ELIGIBILITY_TONES[eligibility]}>{INVOICE_ELIGIBILITY_LABELS[eligibility]}</Pill>
}

/**
 * The planned date of a visit. A historical visit has none: the earlier
 * schedule gave only its period, so nothing is shown as a date.
 */
export function PlannedDate({ visit, format }: { visit: { status: VisitStatus; scheduledDate: string }; format: (value: string) => string }) {
  return visit.status === 'HISTORICAL' ? <span className="text-slate-500">Not recorded</span> : <>{format(visit.scheduledDate)}</>
}

/** One label/value line of a details view. */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-[2.25rem] grid-cols-[9rem_minmax(0,1fr)] border border-slate-300! [&:not(:first-child)]:-mt-px">
      <dt className="flex items-center border-r border-slate-300! bg-slate-100 px-3 py-1.5 text-[13px] font-bold leading-snug text-slate-800">{label}</dt>
      <dd className="flex min-w-0 items-center whitespace-pre-wrap break-words px-3 py-1.5 text-[13px] leading-snug text-slate-900">{children}</dd>
    </div>
  )
}

/** A text value, or a muted dash when there is none. */
export function OrDash({ value }: { value: string | null }) {
  return value === null ? <span className="text-slate-400">—</span> : <>{value}</>
}

interface PagerProps {
  page: number
  pageSize: number
  total: number
  shown: number
  onPage: (page: number) => void
  children?: ReactNode
}

/** "Showing 1–25 of 60" with previous / next, as on the Clients page. */
export function Pager({ page, pageSize, total, shown, onPage, children }: PagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <p>
        Showing {(page - 1) * pageSize + 1}–{(page - 1) * pageSize + shown} of {total}
        {children}
      </p>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Previous
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
