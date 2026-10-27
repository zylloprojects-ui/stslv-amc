import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { LoadError } from '../../components/records'
import { Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx } from '../../lib/format'
import { fetchClients, queryString } from './amcApi'
import { currentMonth, formatDate, monthLabel, monthRange, shiftMonth, todayIso } from './amcFormat'
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

const CHIP: Record<VisitStatus, string> = {
  SCHEDULED: 'bg-sky-50 text-sky-900 ring-sky-200',
  IN_PROGRESS: 'bg-amber-50 text-amber-900 ring-amber-200',
  POSTPONED: 'bg-violet-50 text-violet-900 ring-violet-200',
  COMPLETED: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
  CANCELLED: 'bg-slate-100 text-slate-500 line-through ring-slate-200',
  HISTORICAL: 'bg-slate-100 text-slate-600 ring-slate-200',
}

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
        'block w-full truncate rounded px-1.5 py-0.5 text-left text-[11px] font-medium ring-1 ring-inset hover:brightness-95 focus-visible:outline-2 focus-visible:outline-[#1479BD]',
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

/** A month of maintenance visits on a calendar, by scheduled date. Read-only; visits open in the existing details view. */
export function AmcCalendarPage() {
  const auth = useAuth()
  const [month, setMonth] = useState(currentMonth())
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [clientId, setClientId] = useState('')
  const [status, setStatus] = useState('')
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canViewClients = auth.can('CLIENTS', 'VIEW')
  const canEdit = auth.can('AMC_SCHEDULE', 'EDIT')
  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => fetchClients('all'), enabled: canViewClients })

  const range = monthRange(month)
  const visits = useQuery({
    queryKey: ['amc', 'visits', 'calendar', { month, search, clientId, status }],
    queryFn: () => fetchMonth({ from: range.from, to: range.to, search, clientId, status: status || CALENDAR_STATUSES.join(',') }),
    placeholderData: keepPreviousData,
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

  const days = gridDays(month)
  const today = todayIso()
  const daysWithVisits = [...byDay.keys()].sort()
  const selectedVisits = selectedDay ? (byDay.get(selectedDay) ?? []) : []
  const open = (visitId: string) => setDialog({ kind: 'view', visitId })
  const goTo = (target: string) => {
    setMonth(target)
    setSelectedDay(null)
  }

  return (
    <>
      <PageHeader title="AMC Calendar" description="Maintenance visits by scheduled date. Select a visit to see its details." />

      {notice && <p className="mb-4 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900" role="status">{notice}</p>}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => goTo(shiftMonth(month, -1))} aria-label="Previous month">
              ‹
            </Button>
            <h2 className="min-w-40 text-center text-base font-semibold text-slate-900" aria-live="polite">
              {monthLabel(month)}
            </h2>
            <Button variant="secondary" size="sm" onClick={() => goTo(shiftMonth(month, 1))} aria-label="Next month">
              ›
            </Button>
            <Button variant="secondary" size="sm" onClick={() => goTo(currentMonth())} disabled={month === currentMonth()}>
              This month
            </Button>
          </div>
          <p className="text-sm text-slate-600">
            {visits.data ? `${visits.data.total} visit${visits.data.total === 1 ? '' : 's'} this month` : 'Loading…'}
          </p>
        </div>

        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-3 sm:px-5">
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
          <Filter label="Status">
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
        </div>

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
              <div className="grid grid-cols-7 gap-px" aria-hidden="true">
                {WEEKDAYS.map((day) => (
                  <div key={day} className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {day}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200">
                {days.map((day) => {
                  const inMonth = day.startsWith(month)
                  const list = byDay.get(day) ?? []

                  return (
                    <div
                      key={day}
                      role="group"
                      aria-label={`${formatDate(day)}, ${list.length} visit${list.length === 1 ? '' : 's'}`}
                      className={cx('min-h-28 bg-white p-1.5', !inMonth && 'bg-slate-50 text-slate-400', selectedDay === day && 'ring-2 ring-inset ring-[#1479BD]')}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span
                          className={cx(
                            'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                            day === today ? 'bg-[#1479BD] text-white' : inMonth ? 'text-slate-700' : 'text-slate-400',
                          )}
                        >
                          {Number(day.slice(8))}
                        </span>
                      </div>
                      <div className="space-y-0.5">
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
              <EmptyState title="No visits this month" description={search || clientId || status ? 'Try different filters or another month.' : 'Move to another month to see its visits.'} />
            )}

            <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-200 px-5 py-3 text-xs text-slate-600">
              {CALENDAR_STATUSES.map((value) => (
                <span key={value} className="inline-flex items-center gap-1.5">
                  <span className={cx('inline-block h-3 w-3 rounded ring-1 ring-inset', CHIP[value])} aria-hidden="true" />
                  {VISIT_STATUS_LABELS[value]}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                Overdue
              </span>
            </p>
          </>
        )}
      </Card>

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
