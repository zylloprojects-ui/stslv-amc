import { useId, useState, type ReactNode } from 'react'
import type { UseFormRegisterReturn } from 'react-hook-form'
import { errorMessage } from '../lib/api'
import { cx } from '../lib/format'
import { formatMoney } from '../lib/money'
import { projectLabel } from '../lib/projectOptions'
import {
  PROCUREMENT_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
  type InvoiceState,
  type ProcurementStatus,
  type ProjectOption,
  type ProjectStatus,
} from '../lib/projectTypes'
import { Alert, Badge, Button, SelectField } from './ui'

// Building blocks shared by the Projects, Procurement and Expenses pages.

export const FILTER_LABEL = 'mb-1 block text-sm font-medium text-slate-700'
export const FILTER_INPUT = 'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400'

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const tone = ({ NEW: 'blue', IN_PROGRESS: 'amber', COMPLETED: 'green', CANCELLED: 'slate' } as const)[status]

  return <Badge tone={tone}>{PROJECT_STATUS_LABELS[status]}</Badge>
}

/** Shown only for the two states that matter to invoicing. */
export function InvoiceStateBadge({ state }: { state: InvoiceState }) {
  if (state === 'READY_FOR_INVOICE') {
    return <Badge tone="amber">Ready for invoice</Badge>
  }
  if (state === 'NO_INVOICE_REQUIRED') {
    return <Badge tone="slate">No invoice required</Badge>
  }

  return null
}

export function ProcurementStatusBadge({ status }: { status: ProcurementStatus }) {
  const tone = ({ REQUESTED: 'blue', QUOTED: 'amber', ORDERED: 'amber', DELIVERED: 'green', CANCELLED: 'slate' } as const)[status]

  return <Badge tone={tone}>{PROCUREMENT_STATUS_LABELS[status]}</Badge>
}

/** A money amount, right-aligned with figures that line up in a column. */
export function Money({ value, className }: { value: string | null | undefined; className?: string }) {
  const negative = typeof value === 'string' && value.startsWith('-')

  return <span className={cx('tabular-nums', negative && 'text-red-700', className)}>{formatMoney(value)}</span>
}

interface PagerProps {
  page: number
  pageSize: number
  shown: number
  total: number
  onPage: (page: number) => void
  children?: ReactNode
}

export function Pager({ page, pageSize, shown, total, onPage, children }: PagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <p>
        Showing {(page - 1) * pageSize + 1}–{(page - 1) * pageSize + shown} of {total}
      </p>
      {children}
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

export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-4 py-2.5">
      <dt className="text-sm font-medium text-slate-500">{label}</dt>
      <dd className="col-span-2 whitespace-pre-wrap break-words text-sm text-slate-900">{children}</dd>
    </div>
  )
}

export function OrDash({ value }: { value: string | null }) {
  return value === null ? <span className="text-slate-400">—</span> : <>{value}</>
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="p-4">
      <Alert>
        {errorMessage(error)}{' '}
        <button type="button" className="font-medium underline" onClick={onRetry}>
          Try again
        </button>
      </Alert>
    </div>
  )
}

interface ProjectPickerFieldProps {
  options: ProjectOption[]
  /** From react-hook-form: register('projectId'). */
  registration: UseFormRegisterReturn
  selectedId: string
  error?: string | undefined
}

/**
 * Project choice for a new record. Cancelled projects cannot take new records,
 * so they are left out. The box above the list narrows a long list of jobs.
 */
export function ProjectPickerField({ options, registration, selectedId, error }: ProjectPickerFieldProps) {
  const filterId = useId()
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const visible = options.filter(
    (option) =>
      option.id === selectedId || (option.status !== 'CANCELLED' && (needle === '' || projectLabel(option).toLowerCase().includes(needle))),
  )

  return (
    <div className="space-y-2">
      <div>
        <label htmlFor={filterId} className={FILTER_LABEL}>
          Find a job
        </label>
        <input
          id={filterId}
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Type a job number, client or description to narrow the list"
          className={FILTER_INPUT}
        />
      </div>
      <SelectField label="Project / job" required error={error} {...registration}>
        <option value="">Select a project…</option>
        {visible.map((option) => (
          <option key={option.id} value={option.id}>
            {projectLabel(option)}
          </option>
        ))}
      </SelectField>
    </div>
  )
}
