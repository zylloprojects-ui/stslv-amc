import { useId, type ReactNode, type Ref, type SelectHTMLAttributes } from 'react'
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
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children(id, 'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400')}
    </div>
  )
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
    <div className="grid grid-cols-3 gap-4 py-2">
      <dt className="text-sm font-medium text-slate-500">{label}</dt>
      <dd className="col-span-2 whitespace-pre-wrap break-words text-sm text-slate-900">{children}</dd>
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
