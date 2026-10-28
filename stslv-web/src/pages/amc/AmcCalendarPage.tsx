import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { LoadError } from '../../components/records'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx } from '../../lib/format'
import { fetchClients, queryString } from './amcApi'
import { currentMonth, formatDate, monthLabel, monthRange, shiftMonth, todayIso } from './amcFormat'
import { BILLING_STATUSES, BILLING_STATUS_LABELS, type CalendarFilters, type CalendarOptions } from './calendar/calendarTypes'
import { RenewalWarnings } from './calendar/RenewalWarnings'
import { YearView } from './calendar/YearView'
import { Filter, VisitStatusPill } from './components'
import { VisitDetailsModal, VisitEditModal } from './VisitModals'
import { OPERATIONAL_VISIT_STATUSES, VISIT_STATUS_LABELS, type ScheduleVisit, type VisitList, type VisitStatus } from './types'

// Historical visits have no recorded date, so they cannot be placed on a day.
const CALENDAR_STATUSES = OPERATIONAL_VISIT_STATUSES
const PAGE_SIZE = 200
// A safety limit on how many visits one month may load.
const MAX_PAGES = 10
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// How many visits a day cell shows before "+N more".
const CELL_LIMIT = 3
// Years offered around the current one, besides the years that have visits.
const YEARS_BACK = 2
const YEARS_AHEAD = 5

const CHIP: Record<VisitStatus, string> = {
  SCHEDULED: 'bg-sky-50 text-sky-900 ring-sky-200 border-l-sky-500',
  IN_PROGRESS: 'bg-amber-50 text-amber-900 ring-amber-200 border-l-amber-500',
  POSTPONED: 'bg-violet-50 text-violet-900 ring-violet-200 border-l-violet-500',
  COMPLETED: 'bg-emerald-50 text-emerald-900 ring-emerald-200 border-l-emerald-500',
  CANCELLED: 'bg-slate-100 text-slate-500 line-through ring-slate-200',
  HISTORICAL: 'bg-slate-100 text-slate-600 ring-slate-200',
}

type View = 'year' | 'month'

/** Every visit of the month that matches the filters, reading further pages while there are more. */
async function fetchMonth(params: Record<string, string>): Promise<{ items: ScheduleVisit[]; total: number; truncated: boolean }> {
  const items: ScheduleVisit[] = []
  let total = 0

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await api.get<VisitList>(`/amc/visits${queryString({ ...params, page, pageSize: PAGE_SIZE })}`)

    items.push(...data.items)
    total = data.total
    if (items.length >= total || data.items.length === 0) break
  }

  return { items, total, truncated: items.length < total }
}

/** The days shown for a month: whole weeks from Sunday to Saturday, as "YYYY-MM-DD". */
function gridDays(month: string): string[] {
  const { from } = monthRange(month)
  const first = new Date(`${from}T00:00:00Z`)
  const start = new Date(first)
  start.setUTCDate(first.getUTCDate() - first.getUTCDay())
  const last = new Date(`${monthRange(month).to}T00:00:00Z`)
  const end = new Date(last)
  end.setUTCDate(last.getUTCDate() + (6 - last.getUTCDay()))

  const days: string[] = []
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    days.push(day.toISOString().slice(0, 10))
  }

  return days
}

function visitLabel(visit: ScheduleVisit) {
  return `${visit.client.name} — ${visit.contract.systemDescription}`
}

function VisitChip({ visit, onOpen }: { visit: ScheduleVisit; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(visit.id)}
      aria-label={`${visitLabel(visit)}, visit ${visit.sequenceNo}, ${VISIT_STATUS_LABELS[visit.status]}${visit.isOverdue ? ', overdue' : ''}`}
      className={cx(
        'block w-full truncate rounded-md border-l-[3px] px-1.5 py-1 text-left text-[11px] font-semibold shadow-sm ring-1 ring-inset transition-transform hover:-translate-y-px hover:shadow-md hover:ring-2 hover:ring-[#1479BD] focus-visible:outline-2 focus-visible:outline-[#1479BD]',
        CHIP[visit.status],
        visit.isOverdue && 'ring-red-300',
      )}
    >
      {visit.isOverdue && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-red-500 align-middle" aria-hidden="true" />}
      {visitLabel(visit)}
    </button>
  )
}

type Dialog = { kind: 'none' } | { kind: 'view'; visitId: string } | { kind: 'edit'; visit: ScheduleVisit }

/**
 * The Monthly Calendar: a year of maintenance visits month by month (Year view),
 * or one month by scheduled day (Month view). Both read the same visit records
 * as the AMC Schedule, with the same filters, and change nothing except through
 * the existing visit details and edit dialogs. The view and the month are kept
 * in the address, so switching views keeps the period and the filters.
 */
export function AmcCalendarPage() {
  const auth = useAuth()
  const [params, setParams] = useSearchParams()
  const view: View = params.get('view') === 'month' ? 'month' : 'year'
  const monthParam = params.get('month')
  const month = monthParam && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : currentMonth()
  const year = Number(month.slice(0, 4))

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [clientId, setClientId] = useState('')
  const [salesEngineerId, setSalesEngineerId] = useState('')
  const [system, setSystem] = useState('')
  const [frequency, setFrequency] = useState('')
  const [status, setStatus] = useState('')
  const [billingStatus, setBillingStatus] = useState('')
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canViewClients = auth.can('CLIENTS', 'VIEW')
  const canViewContracts = auth.can('AMC_CONTRACTS', 'VIEW')
  const canEdit = auth.can('AMC_SCHEDULE', 'EDIT')
  const canExport = auth.can('AMC_SCHEDULE', 'EXPORT')
  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => fetchClients('all'), enabled: canViewClients })
  // Sales engineers, frequencies and years present on scheduled visits; open to every schedule viewer.
  const options = useQuery({ queryKey: ['amc', 'service-status', 'options'], queryFn: () => api.get<CalendarOptions>('/amc/service-status/options') })
  const systems = useQuery({ queryKey: ['amc', 'systems'], queryFn: () => api.get<string[]>('/amc/contracts/systems'), enabled: canViewContracts })

  const filters: CalendarFilters = {
    search,
    clientId,
    salesEngineerId,
    system,
    frequency,
    status: status || CALENDAR_STATUSES.join(','),
    billingStatus,
  }
  const filtered = Boolean(search || clientId || salesEngineerId || system || frequency || status || billingStatus)

  const range = monthRange(month)
  const visits = useQuery({
    queryKey: ['amc', 'visits', 'calendar', { month, ...filters }],
    queryFn: () => fetchMonth({ from: range.from, to: range.to, ...filters }),
    placeholderData: keepPreviousData,
    enabled: view === 'month',
  })

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleVisit[]>()

    for (const visit of visits.data?.items ?? []) {
      const list = map.get(visit.scheduledDate) ?? []
      list.push(visit)
      map.set(visit.scheduledDate, list)
    }

    return map
  }, [visits.data])

  const thisYear = Number(currentMonth().slice(0, 4))
  const years = [
    ...new Set([...(options.data?.years ?? []), ...Array.from({ length: YEARS_BACK + YEARS_AHEAD + 1 }, (_, index) => thisYear - YEARS_BACK + index), year]),
  ].sort((a, b) => a - b)

  const days = gridDays(month)
  const today = todayIso()
  const daysWithVisits = [...byDay.keys()].sort()
  const selectedVisits = selectedDay ? (byDay.get(selectedDay) ?? []) : []
  const open = (visitId: string) => setDialog({ kind: 'view', visitId })
  const navigate = (next: { view?: View; month?: string }) => {
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous)
        updated.set('view', next.view ?? view)
        updated.set('month', next.month ?? month)

        return updated
      },
      { replace: true },
    )
  }
  const goTo = (target: string) => {
    navigate({ month: target })
    setSelectedDay(null)
  }
  // Moving between years keeps the month, so Month view opens where it was.
  const goToYear = (target: number) => navigate({ month: `${target}-${month.slice(5)}` })

  return (
    <>
      <PageHeader title="Monthly Calendar" description="Scheduled maintenance visits by year and by month. Select a month or a visit to see its details." />

      {notice && <p className="mb-4 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">{notice}</p>}
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      {canViewContracts && <RenewalWarnings clientId={clientId} />}

      <Card className="frame-hover mb-5 overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-[#1479BD] via-[#00A6C8] to-[#4aa3df]" aria-hidden="true" />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-4 py-3.5 sm:px-5">
          <div role="group" aria-label="Calendar view" className="inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1 shadow-inner">
            {(['year', 'month'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => navigate({ view: value })}
                className={cx(
                  'rounded-lg px-4 py-1.5 text-sm font-bold transition-all focus-visible:outline-2 focus-visible:outline-[#1479BD]',
                  view === value ? 'bg-gradient-to-br from-[#1479BD] to-[#00A6C8] text-white shadow-md' : 'text-slate-600 hover:text-slate-900',
                )}
              >
                {value === 'year' ? 'Year view' : 'Month view'}
              </button>
            ))}
          </div>

          {view === 'year' ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => goToYear(year - 1)} aria-label="Previous year">
                ‹
              </Button>
              <label className="sr-only" htmlFor="calendar-year">
                Year
              </label>
              <select
                id="calendar-year"
                value={year}
                onChange={(event) => goToYear(Number(event.target.value))}
                className="rounded-xl border border-sky-200 bg-white px-4 py-1.5 text-lg font-extrabold text-[#0b3b66] shadow-sm"
              >
                {years.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <Button variant="secondary" size="sm" onClick={() => goToYear(year + 1)} aria-label="Next year">
                ›
              </Button>
              <Button variant="secondary" size="sm" onClick={() => goToYear(thisYear)} disabled={year === thisYear}>
                This year
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => goTo(shiftMonth(month, -1))} aria-label="Previous month">
                ‹
              </Button>
              <h2 className="min-w-48 text-center text-xl font-extrabold tracking-tight text-[#0b3b66]" aria-live="polite">
                {monthLabel(month)}
              </h2>
              <Button variant="secondary" size="sm" onClick={() => goTo(shiftMonth(month, 1))} aria-label="Next month">
                ›
              </Button>
              <Button variant="secondary" size="sm" onClick={() => goTo(currentMonth())} disabled={month === currentMonth()}>
                This month
              </Button>
            </div>
          )}

          {view === 'month' && (
            <p className="rounded-full bg-sky-50 px-3 py-1 text-sm font-semibold text-[#0b3b66] ring-1 ring-sky-100">
              {visits.data ? `${visits.data.total} visit${visits.data.total === 1 ? '' : 's'} this month` : 'Loading…'}
            </p>
          )}
        </div>

        <div className="grid gap-4 bg-slate-50/50 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          <Filter label="Search">
            {(id, className) => (
              <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Client, system or engineer" className={className} />
            )}
          </Filter>
          {canViewClients && (
            <Filter label="Client">
              {(id, className) => (
                <select id={id} value={clientId} onChange={(event) => setClientId(event.target.value)} className={className}>
                  <option value="">All clients</option>
                  {(clients.data ?? []).map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          {options.data?.salesEngineers && (
            <Filter label="Sales engineer">
              {(id, className) => (
                <select id={id} value={salesEngineerId} onChange={(event) => setSalesEngineerId(event.target.value)} className={className}>
                  <option value="">All sales engineers</option>
                  {options.data.salesEngineers?.map((engineer) => (
                    <option key={engineer.id} value={engineer.id}>
                      {engineer.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          {canViewContracts && (
            <Filter label="System">
              {(id, className) => (
                <select id={id} value={system} onChange={(event) => setSystem(event.target.value)} className={className}>
                  <option value="">All systems</option>
                  {(systems.data ?? []).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          {options.data && (
            <Filter label="Frequency">
              {(id, className) => (
                <select id={id} value={frequency} onChange={(event) => setFrequency(event.target.value)} className={className}>
                  <option value="">All frequencies</option>
                  {options.data.frequencies.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.label}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          <Filter label="Visit status">
            {(id, className) => (
              <select id={id} value={status} onChange={(event) => setStatus(event.target.value)} className={className}>
                <option value="">All statuses</option>
                {CALENDAR_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {VISIT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Billing status">
            {(id, className) => (
              <select id={id} value={billingStatus} onChange={(event) => setBillingStatus(event.target.value)} className={className}>
                <option value="">All</option>
                {BILLING_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {BILLING_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
        </div>
      </Card>

      {view === 'year' && (
        <YearView
          year={year}
          filters={filters}
          canExport={canExport}
          onExportError={setExportError}
          onOpenMonth={(target) => {
            navigate({ view: 'month', month: target })
            setSelectedDay(null)
          }}
        />
      )}

      {view === 'month' && (
        <Card className="frame-hover">
          {visits.isPending && <Spinner label="Loading visits" />}
          {visits.isError && <LoadError error={visits.error} onRetry={() => void visits.refetch()} />}
          {visits.data?.truncated && (
            <p className="border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-900">
              Showing the first {visits.data.items.length} of {visits.data.total} visits. Narrow the filters to see the rest.
            </p>
          )}

          {visits.data && (
            <>
              {/* Month grid, from small tablets up. */}
              <div className="hidden p-3 sm:block" role="group" aria-label={`Visits in ${monthLabel(month)}`}>
                <div className="grid grid-cols-7 overflow-hidden rounded-t-xl bg-gradient-to-r from-[#0b3b66] via-[#0f5a96] to-[#1479BD]" aria-hidden="true">
                  {WEEKDAYS.map((day) => (
                    <div key={day} className={cx('px-2 py-2.5 text-center text-xs font-bold uppercase tracking-[0.14em] text-white', (day === 'Sun' || day === 'Sat') && 'text-sky-200')}>
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-px overflow-hidden rounded-b-xl border-2 border-slate-300 bg-slate-300 shadow-md">
                  {days.map((day) => {
                    const inMonth = day.startsWith(month)
                    const list = byDay.get(day) ?? []
                    const weekend = [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())

                    return (
                      <div
                        key={day}
                        role="group"
                        aria-label={`${formatDate(day)}, ${list.length} visit${list.length === 1 ? '' : 's'}`}
                        className={cx(
                          'relative min-h-32 bg-white p-2 transition-all duration-150 hover:z-10 hover:bg-sky-50 hover:shadow-[inset_0_0_0_2px_#1479BD]',
                          weekend && 'bg-slate-50/80',
                          !inMonth && 'bg-slate-100/70 text-slate-400',
                          day === today && 'bg-sky-50 shadow-[inset_0_3px_0_#1479BD]',
                          selectedDay === day && 'ring-2 ring-inset ring-[#1479BD]',
                        )}
                      >
                        <div className="mb-1 flex items-center justify-between">
                          <span
                            className={cx(
                              'flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold',
                              day === today ? 'bg-gradient-to-br from-[#1479BD] to-[#00A6C8] text-white shadow-md' : inMonth ? 'text-slate-700' : 'text-slate-400',
                            )}
                          >
                            {Number(day.slice(8))}
                          </span>
                          {list.length > 0 && (
                            <span className="rounded-full bg-[#1479BD]/10 px-1.5 text-[10px] font-extrabold tabular-nums text-[#0b3b66]" aria-hidden="true">
                              {list.length}
                            </span>
                          )}
                        </div>
                        <div className="space-y-1">
                          {list.slice(0, CELL_LIMIT).map((visit) => (
                            <VisitChip key={visit.id} visit={visit} onOpen={open} />
                          ))}
                          {list.length > CELL_LIMIT && (
                            <button type="button" onClick={() => setSelectedDay(day)} className="w-full rounded px-1.5 text-left text-[11px] font-semibold text-[#1479BD] hover:underline">
                              +{list.length - CELL_LIMIT} more
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* One day's full list, when "+N more" was chosen. */}
              {selectedDay && (
                <section aria-label={`Visits on ${formatDate(selectedDay)}`} className="hidden border-t border-slate-200 px-5 py-4 sm:block">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900">Visits on {formatDate(selectedDay)}</h3>
                    <Button variant="secondary" size="sm" onClick={() => setSelectedDay(null)}>
                      Close
                    </Button>
                  </div>
                  <DayList visits={selectedVisits} onOpen={open} />
                </section>
              )}

              {/* Phones: the month as a list of days. */}
              <div className="sm:hidden">
                {daysWithVisits.length === 0 ? null : (
                  <ol aria-label={`Visits in ${monthLabel(month)}, by day`} className="divide-y divide-slate-100">
                    {daysWithVisits.map((day) => (
                      <li key={day} className="px-4 py-3">
                        <h3 className={cx('mb-2 text-sm font-semibold', day === today ? 'text-[#1479BD]' : 'text-slate-900')}>{formatDate(day)}</h3>
                        <DayList visits={byDay.get(day) ?? []} onOpen={open} />
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              {visits.data.items.length === 0 && (
                <EmptyState title="No visits this month" description={filtered ? 'Try different filters or another month.' : 'Move to another month to see its visits.'} />
              )}

              <p className="flex flex-wrap gap-2 border-t border-slate-200 bg-slate-50/60 px-5 py-3 text-xs font-medium text-slate-700">
                {CALENDAR_STATUSES.map((value) => (
                  <span key={value} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 shadow-sm">
                    <span className={cx('inline-block h-3 w-3 rounded ring-1 ring-inset', CHIP[value])} aria-hidden="true" />
                    {VISIT_STATUS_LABELS[value]}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-white px-2.5 py-1 shadow-sm">
                  <span className="inline-block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
                  Overdue
                </span>
              </p>
            </>
          )}
        </Card>
      )}

      {dialog.kind === 'view' && (
        <VisitDetailsModal
          visitId={dialog.visitId}
          canEdit={canEdit}
          onEdit={(visit) => setDialog({ kind: 'edit', visit })}
          onClose={() => setDialog({ kind: 'none' })}
        />
      )}
      {dialog.kind === 'edit' && (
        <VisitEditModal
          visit={dialog.visit}
          onClose={() => setDialog({ kind: 'none' })}
          onSaved={(saved) => {
            setNotice(`Visit ${saved.sequenceNo} for ${saved.client.name} (${saved.contract.systemDescription}) was updated.`)
            setDialog({ kind: 'none' })
          }}
        />
      )}
    </>
  )
}

function DayList({ visits, onOpen }: { visits: ScheduleVisit[]; onOpen: (id: string) => void }) {
  return (
    <ul className="space-y-2">
      {visits.map((visit) => (
        <li key={visit.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2">
          <div className="min-w-0">
            <button type="button" onClick={() => onOpen(visit.id)} className="text-left text-sm font-semibold text-[#1479BD] hover:underline">
              {visitLabel(visit)}, visit {visit.sequenceNo}
            </button>
            <p className="text-xs text-slate-500">
              Engineer: {visit.assignedTo ?? '—'} ·{' '}
              <Link to={`/amc/contracts/${visit.contract.id}`} className="text-blue-700 hover:underline">
                Open contract
              </Link>
            </p>
          </div>
          <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
        </li>
      ))}
    </ul>
  )
}
