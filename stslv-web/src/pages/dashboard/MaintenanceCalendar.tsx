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
          className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-[#1479BD]"
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
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="min-w-0 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 rounded-xl border border-slate-200 p-3">
            <h3 className="px-2 text-sm font-semibold text-slate-900">
              Today · {formatDate(asOf)} <span className="font-normal text-slate-600">({formatCount(schedule.todayTotal)})</span>
            </h3>
            {schedule.today.length === 0 ? (
              <p className="px-2 py-3 text-sm text-slate-600">No maintenance planned today.</p>
            ) : (
              <ul className="mt-1 divide-y divide-slate-100">
                {schedule.today.map((item) => (
                  <WorkItem key={item.id} item={item} onOpen={open} />
                ))}
              </ul>
            )}
            {schedule.todayTotal > schedule.today.length && (
              <p className="px-2 pt-2 text-xs text-slate-600">
                Showing {schedule.today.length} of {schedule.todayTotal}.
              </p>
            )}
          </div>
          <div className="min-w-0 rounded-xl border border-slate-200 p-3">
            <h3 className="px-2 text-sm font-semibold text-slate-900">
              Next {schedule.upcomingDays} days <span className="font-normal text-slate-600">({formatCount(schedule.upcomingTotal)} open)</span>
            </h3>
            {schedule.upcoming.length === 0 ? (
              <p className="px-2 py-3 text-sm text-slate-600">No open service obligations in the next {schedule.upcomingDays} days.</p>
            ) : (
              <ul className="mt-1 divide-y divide-slate-100">
                {schedule.upcoming.map((item) => (
                  <WorkItem key={item.id} item={item} onOpen={open} showDate />
                ))}
              </ul>
            )}
            {schedule.upcomingTotal > schedule.upcoming.length && (
              <p className="px-2 pt-2 text-xs text-slate-600">
                Showing {schedule.upcoming.length} of {schedule.upcomingTotal}.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" aria-expanded={expanded} aria-controls="dashboard-mini-calendar" onClick={() => onToggle(!expanded)}>
            {expanded ? 'Hide calendar ▴' : 'Show calendar ▾'}
          </Button>
          {canSchedule && (
            <Link to="/amc/calendar" className="text-sm font-medium text-[#1479BD] hover:underline">
              Open full calendar →
            </Link>
          )}
        </div>

        {expanded && (
          <div id="dashboard-mini-calendar" className="rounded-xl border border-slate-200 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Button variant="secondary" size="sm" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
                ←
              </Button>
              <h3 className="text-sm font-semibold text-slate-900" aria-live="polite">
                {monthLabel(month)}
              </h3>
              <Button variant="secondary" size="sm" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
                →
              </Button>
            </div>
            {calendar.isError && <LoadError error={calendar.error} onRetry={() => void calendar.refetch()} />}
            {calendar.isPending && <Spinner size="sm" label="Loading calendar" />}
            {calendar.data && (
              <div role="grid" aria-label={`Visits in ${monthLabel(month)}`} className="grid grid-cols-7 gap-1 text-center">
                {WEEKDAYS.map((name) => (
                  <span key={name} role="columnheader" className="text-[11px] font-semibold uppercase text-slate-500">
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
                          'flex h-11 w-full flex-col items-center justify-center rounded-md text-xs tabular-nums',
                          date === asOf && 'ring-2 ring-[#1479BD]',
                          day === date ? 'bg-[#1479BD] text-white' : entry ? 'bg-sky-50 text-slate-900 hover:bg-sky-100' : 'text-slate-500',
                        )}
                      >
                        <span>{Number(date.slice(8))}</span>
                        {entry && (
                          <span className={cx('text-[10px] font-bold', day === date ? 'text-white' : entry.overdue ? 'text-red-700' : 'text-[#0b3b66]')}>
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
              <div className="mt-3 border-t border-slate-100 pt-2">
                <h4 className="px-2 text-sm font-semibold text-slate-900">Services on {formatDate(day)}</h4>
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
        )}
      </div>

      <ServiceDetails visitId={selected} canSchedule={canSchedule} canInvoices={canInvoices} onClear={() => setSelected(null)} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-2 text-sm last:border-0">
      <dt className="shrink-0 text-slate-600">{label}</dt>
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
    <section aria-labelledby="service-details" className="min-w-0 rounded-xl border border-slate-200 p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <h3 id="service-details" className="text-sm font-semibold text-slate-900">
          Service details
        </h3>
        {visitId && (
          <button type="button" className="text-xs font-medium text-[#1479BD] hover:underline" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {!canSchedule && <p className="mt-3 text-sm text-slate-600">Service details need the AMC Schedule view permission.</p>}
      {canSchedule && !visitId && <p className="mt-3 text-sm text-slate-600">Select a service from today’s work, the next days or the calendar.</p>}
      {canSchedule && visitId && visit.isPending && <Spinner size="sm" label="Loading service" />}
      {visit.isError && <LoadError error={visit.error} onRetry={() => void visit.refetch()} />}
      {data && (
        <dl className="mt-2">
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
