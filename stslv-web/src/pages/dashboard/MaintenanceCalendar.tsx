import { ContractLink } from '../../components/ContractLink'
import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { LoadError } from '../../components/records'
import { Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx, formatCount } from '../../lib/format'
import type { Invoice } from '../../lib/invoiceTypes'
import { queryString } from '../amc/amcApi'
import { formatDate, formatMoney } from '../amc/amcFormat'
import { VisitStatusPill } from '../amc/components'
import {
  INVOICE_ELIGIBILITY_LABELS,
  frequencyLabel,
  type ScheduleVisit,
} from '../amc/types'
import type { OperationsDashboard, ScheduleItem } from './operationsTypes'

interface Props {
  schedule: NonNullable<OperationsDashboard['schedule']>
  /** The server's date: "today" here is the same day every module counts from. */
  asOf: string
  canSchedule: boolean
  canInvoices: boolean
}

function WorkItem({ item, onOpen, showDate }: { item: ScheduleItem; onOpen: ((id: string) => void) | null; showDate?: boolean }) {
  const body = (
    <>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-slate-900">{item.client.name}</span>
        <span className="block truncate text-xs text-slate-600">
          {item.systemDescription}
          {item.assignedTo ? ` · ${item.assignedTo}` : ''}
          {showDate ? ` · ${formatDate(item.scheduledDate)}` : ''}
        </span>
      </span>
      <VisitStatusPill status={item.status} overdue={item.isOverdue} />
    </>
  )

  return (
    <li>
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(item.id)}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-[#1479BD]"
          aria-label={`Service details: ${item.client.name}, ${item.systemDescription}, ${formatDate(item.scheduledDate)}`}
        >
          {body}
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3 px-2 py-2">{body}</div>
      )}
    </li>
  )
}

/** Today's work, the next days and the details of a selected service, stacked across the full width. */
export function MaintenanceCalendar({ schedule, asOf, canSchedule, canInvoices }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const open = canSchedule ? setSelected : null

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
        <h3 className="flex items-center justify-between gap-2 border-b border-slate-200 bg-sky-50 px-4 py-2 text-sm font-bold text-[#0b3b66]">
          <span>Today · {formatDate(asOf)}</span>
          <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset ring-sky-200">{formatCount(schedule.todayTotal)}</span>
        </h3>
        {schedule.today.length === 0 ? (
          <p className="flex items-center gap-2.5 px-4 py-3.5 text-sm text-slate-600">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700" aria-hidden="true">
              ✓
            </span>
            No maintenance planned today.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 px-3 py-1.5">
            {schedule.today.map((item) => (
              <WorkItem key={item.id} item={item} onOpen={open} />
            ))}
          </ul>
        )}
        {schedule.todayTotal > schedule.today.length && (
          <p className="border-t border-slate-200 bg-slate-50 px-5 py-2.5 text-xs text-slate-600">
            Showing {schedule.today.length} of {schedule.todayTotal}.
          </p>
        )}
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
        <h3 className="flex items-center justify-between gap-2 border-b border-slate-200 bg-sky-50 px-4 py-2 text-sm font-bold text-[#0b3b66]">
          <span>Next {schedule.upcomingDays} days</span>
          <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset ring-sky-200">{formatCount(schedule.upcomingTotal)} open</span>
        </h3>
        {schedule.upcoming.length === 0 ? (
          <p className="flex items-center gap-2.5 px-4 py-3.5 text-sm text-slate-600">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700" aria-hidden="true">
              ✓
            </span>
            No open service obligations in the next {schedule.upcomingDays} days.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 px-3 py-1.5">
            {schedule.upcoming.map((item) => (
              <WorkItem key={item.id} item={item} onOpen={open} showDate />
            ))}
          </ul>
        )}
        {schedule.upcomingTotal > schedule.upcoming.length && (
          <p className="border-t border-slate-200 bg-slate-50 px-5 py-2.5 text-xs text-slate-600">
            Showing {schedule.upcoming.length} of {schedule.upcomingTotal}.
          </p>
        )}
      </div>

      <ServiceDetails visitId={selected} canSchedule={canSchedule} canInvoices={canInvoices} onClear={() => setSelected(null)} />
    </div>
  )
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cx('min-w-0 rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5', wide && 'col-span-2 xl:col-span-1')}>
      <dt className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</dt>
      <dd className="mt-1 min-w-0 break-words text-sm font-semibold text-slate-900">{children}</dd>
    </div>
  )
}

/** The selected service, read again from the schedule so the stored values are shown. */
function ServiceDetails({ visitId, canSchedule, canInvoices, onClear }: { visitId: string | null; canSchedule: boolean; canInvoices: boolean; onClear: () => void }) {
  const visit = useQuery({
    queryKey: ['amc', 'visits', 'detail', visitId],
    queryFn: () => api.get<ScheduleVisit>(`/amc/visits/${visitId}`),
    enabled: canSchedule && visitId !== null,
  })
  const invoices = useQuery({
    queryKey: ['invoices', 'list', { amcVisitId: visitId }],
    queryFn: () => api.get<{ items: Invoice[] }>(`/invoices${queryString({ amcVisitId: visitId, status: 'ISSUED', pageSize: 10 })}`),
    enabled: canInvoices && visitId !== null,
  })
  const data = visit.data

  return (
    <section aria-labelledby="service-details" className="min-w-0 flex-1 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm" aria-live="polite">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-sky-50 px-4 py-2">
        <h3 id="service-details" className="text-sm font-bold text-[#0b3b66]">
          Service details
        </h3>
        {visitId && (
          <button type="button" className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-[#1479BD] ring-1 ring-inset ring-sky-200 hover:bg-sky-100" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {!canSchedule && <p className="px-4 py-3.5 text-sm text-slate-600">Service details need the AMC Schedule view permission.</p>}
      {canSchedule && !visitId && <p className="px-4 py-3.5 text-sm text-slate-600">Select a service from today’s work or the next days.</p>}
      {canSchedule && visitId && visit.isPending && (
        <div className="p-4">
          <Spinner size="sm" label="Loading service" />
        </div>
      )}
      {visit.isError && (
        <div className="p-4">
          <LoadError error={visit.error} onRetry={() => void visit.refetch()} />
        </div>
      )}
      {data && (
        <div className="space-y-4 p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0e5a96] to-[#2f9bd8] text-white shadow-sm" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
                <path d="M3.5 10h17M8 3v4M16 3v4M9 15l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-base font-bold leading-tight text-[#0b3b66]">{data.client.name}</p>
              <p className="mt-0.5 break-words text-sm text-slate-600">{data.contract.systemDescription}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <VisitStatusPill status={data.status} overdue={data.isOverdue} />
                <ContractLink id={data.contract.id} className="rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-[#1479BD] ring-1 ring-inset ring-sky-200 hover:bg-sky-100">
                  {data.contract.reference}
                </ContractLink>
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-2.5 md:grid-cols-3 xl:grid-cols-4">
            <Field label="Scheduled date">{formatDate(data.scheduledDate)}</Field>
            <Field label="Frequency">{frequencyLabel(data.contract.maintenanceFrequency)}</Field>
            <Field label="Engineer">{data.assignedTo ?? '—'}</Field>
            <Field label="Scheduled amount">
              <span className="text-base font-bold tabular-nums text-[#0b3b66]">{data.visitAmount === null ? 'Not set' : formatMoney(data.visitAmount)}</span>
            </Field>
            <Field label="Invoice status">{INVOICE_ELIGIBILITY_LABELS[data.invoiceEligibility]}</Field>
            <Field label="Invoice No.">{data.manualInvoiceNo ?? 'None entered'}</Field>
            <Field label="Zoho invoices">
              {!canInvoices
                ? 'Needs Invoice Tracking access'
                : invoices.isPending
                  ? '…'
                  : invoices.isError
                    ? 'Could not be loaded'
                    : invoices.data && invoices.data.items.length > 0
                      ? invoices.data.items.map((invoice) => invoice.invoiceNumber).join(', ')
                      : 'None recorded'}
            </Field>
            <Field label="Payment status" wide>
              {data.manualInvoiceNo ? `Paid · Invoice No. ${data.manualInvoiceNo} (reference status, not verified payment)` : 'Unpaid'}
            </Field>
          </dl>
        </div>
      )}
    </section>
  )
}
