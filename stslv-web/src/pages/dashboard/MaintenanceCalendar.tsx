import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { LoadError } from '../../components/records'
import { Button, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx, formatCount } from '../../lib/format'
import type { Invoice } from '../../lib/invoiceTypes'
import { queryString } from '../amc/amcApi'
import { formatDate, formatMoney, monthLabel, shiftMonth } from '../amc/amcFormat'
import { VisitStatusPill } from '../amc/components'
import {
  FREQUENCY_LABELS,
  INVOICE_ELIGIBILITY_LABELS,
  OPERATIONAL_VISIT_STATUSES,
  type ScheduleVisit,
  type VisitList,
} from '../amc/types'
import { monthCells } from './calendarCells'
import type { CalendarMonth, OperationsDashboard, ScheduleItem } from './operationsTypes'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface Props {
  schedule: NonNullable<OperationsDashboard['schedule']>
  /** The server's date: "today" here is the same day every module counts from. */
  asOf: string
  canSchedule: boolean
  canInvoices: boolean
  expanded: boolean
  onToggle: (expanded: boolean) => void
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

/** Today's work, the next days, a collapsible month calendar and the details of a selected service. */
export function MaintenanceCalendar({ schedule, asOf, canSchedule, canInvoices, expanded, onToggle }: Props) {
  const [month, setMonth] = useState(asOf.slice(0, 7))
  const [day, setDay] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const open = canSchedule ? setSelected : null

  const calendar = useQuery({
    queryKey: ['dashboard', 'calendar', month],
    queryFn: () => api.get<CalendarMonth>(`/dashboard/calendar?month=${month}`),
    enabled: expanded,
    placeholderData: keepPreviousData,
  })
  const counts = new Map((calendar.data?.days ?? []).map((entry) => [entry.date, entry]))

  // A day's services, from the schedule the user may already read. Amounts stay with the schedule permission.
  const dayVisits = useQuery({
    queryKey: ['amc', 'visits', 'day', day],
    queryFn: () =>
      api.get<VisitList>(`/amc/visits${queryString({ from: day, to: day, status: OPERATIONAL_VISIT_STATUSES.filter((s) => s !== 'CANCELLED').join(','), pageSize: 50 })}`),
    enabled: canSchedule && day !== null,
  })

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" aria-expanded={expanded} aria-controls="dashboard-mini-calendar" onClick={() => onToggle(!expanded)}>
          {expanded ? 'Hide calendar ▴' : 'Show calendar ▾'}
        </Button>
        {canSchedule && (
          <Link to="/amc/calendar" className="rounded-lg bg-sky-50 px-3 py-1.5 text-sm font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200 hover:bg-sky-100">
            Open full calendar →
          </Link>
        )}
        </div>
        <p className="flex items-center gap-3 text-[11px] text-slate-600" aria-hidden="true">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded border border-sky-200 bg-sky-50" /> Visits
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded border-2 border-[#1479BD]" /> Today
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-red-600" /> Overdue
          </span>
        </p>
      </div>

    <div className={cx('grid min-w-0 items-stretch gap-4', expanded && 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
      <div className={cx('min-w-0 flex-col', expanded ? 'flex' : 'hidden')}>
        {expanded && (
          <div id="dashboard-mini-calendar" className="flex-1 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-sky-50 px-3 py-2">
              <Button variant="secondary" size="sm" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
                ←
              </Button>
              <h3 className="text-sm font-bold text-[#0b3b66]" aria-live="polite">
                {monthLabel(month)}
              </h3>
              <Button variant="secondary" size="sm" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
                →
              </Button>
            </div>
            <div className="p-3">
            {calendar.isError && <LoadError error={calendar.error} onRetry={() => void calendar.refetch()} />}
            {calendar.isPending && <Spinner size="sm" label="Loading calendar" />}
            {calendar.data && (
              <div role="grid" aria-label={`Visits in ${monthLabel(month)}`} className="grid grid-cols-7 gap-1 text-center">
                {WEEKDAYS.map((name) => (
                  <span key={name} role="columnheader" className="pb-1 text-[10px] font-bold uppercase tracking-wider text-slate-700">
                    {name}
                  </span>
                ))}
                {monthCells(month).map((date, index) => {
                  if (!date) return <span key={`blank-${index}`} role="gridcell" />
                  const entry = counts.get(date)
                  const label = `${formatDate(date)}: ${entry ? `${entry.total} ${entry.total === 1 ? 'visit' : 'visits'}${entry.overdue ? `, ${entry.overdue} overdue` : ''}` : 'no visits'}`

                  return (
                    <span key={date} role="gridcell">
                      <button
                        type="button"
                        aria-label={label}
                        aria-pressed={day === date}
                        disabled={!canSchedule || !entry}
                        onClick={() => setDay(date)}
                        className={cx(
                          'flex h-10 w-full flex-col items-center justify-center rounded-md border text-xs font-semibold tabular-nums transition-colors',
                          date === asOf && 'ring-2 ring-[#1479BD] ring-offset-1',
                          day === date
                            ? 'border-[#1479BD] bg-[#1479BD] text-white shadow-sm'
                            : entry
                              ? 'border-sky-200 bg-sky-50 text-slate-900 hover:bg-sky-100'
                              : 'border-transparent text-slate-600',
                        )}
                      >
                        <span>{Number(date.slice(8))}</span>
                        {entry && (
                          <span className={cx('min-w-4 rounded-full px-1 text-[10px] font-bold leading-4', day === date ? 'bg-white/25 text-white' : entry.overdue ? 'bg-red-600 text-white' : 'bg-[#1479BD] text-white')}>
                            {entry.total}
                          </span>
                        )}
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
            {day && canSchedule && (
              <div className="mt-3 border-t border-slate-200 pt-2">
                <h4 className="px-2 text-sm font-bold text-[#0b3b66]">Services on {formatDate(day)}</h4>
                {dayVisits.isPending && <Spinner size="sm" label="Loading services" />}
                {dayVisits.isError && <LoadError error={dayVisits.error} onRetry={() => void dayVisits.refetch()} />}
                {dayVisits.data && (
                  <ul className="divide-y divide-slate-100">
                    {dayVisits.data.items.map((visit) => (
                      <WorkItem
                        key={visit.id}
                        onOpen={open}
                        item={{
                          id: visit.id,
                          contractId: visit.contract.id,
                          client: visit.client,
                          systemDescription: visit.contract.systemDescription,
                          scheduledDate: visit.scheduledDate,
                          assignedTo: visit.assignedTo,
                          status: visit.status,
                          isOverdue: visit.isOverdue,
                        }}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )}
            </div>
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-3">
          <div className="space-y-4">
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
          </div>

  <ServiceDetails visitId={selected} canSchedule={canSchedule} canInvoices={canInvoices} onClear={() => setSelected(null)} />
      </div>
    </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-200 px-4 py-1.5 text-sm last:border-0 even:bg-slate-50/70">
      <dt className="shrink-0 font-bold text-slate-800">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-slate-900">{children}</dd>
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
          <button type="button" className="text-xs font-medium text-[#1479BD] hover:underline" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {!canSchedule && <p className="px-4 py-3.5 text-sm text-slate-600">Service details need the AMC Schedule view permission.</p>}
      {canSchedule && !visitId && <p className="px-4 py-3.5 text-sm text-slate-600">Select a service from today’s work, the next days or the calendar.</p>}
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
        <dl>
          <Field label="AMC reference">
            {/* STSLV AMC has no contract number yet; the record number identifies the contract. */}
            <Link to={`/amc/contracts/${data.contract.id}`} className="text-[#1479BD] hover:underline">
              Contract record {data.contract.id}
            </Link>
          </Field>
          <Field label="Client">{data.client.name}</Field>
          <Field label="System / service">{data.contract.systemDescription}</Field>
          <Field label="Engineer">{data.assignedTo ?? '—'}</Field>
          <Field label="Frequency">{FREQUENCY_LABELS[data.contract.maintenanceFrequency]}</Field>
          <Field label="Scheduled date">{formatDate(data.scheduledDate)}</Field>
          <Field label="Status">
            <VisitStatusPill status={data.status} overdue={data.isOverdue} />
          </Field>
          <Field label="Scheduled amount">{data.visitAmount === null ? 'Not set' : formatMoney(data.visitAmount)}</Field>
          <Field label="Invoice status">{INVOICE_ELIGIBILITY_LABELS[data.invoiceEligibility]}</Field>
          <Field label="Invoice no.">
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
          <Field label="Payment status">Not tracked in STSLV AMC</Field>
        </dl>
      )}
    </section>
  )
}
