import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { initialsOf } from '../../lib/format'
import type { DashboardSummary } from '../dashboard/metrics'
import { fetchClients, queryString } from './amcApi'
import { currentMonth, formatDate, formatMoney, monthLabel, monthRange, shiftMonth } from './amcFormat'
import { EligibilityPill, Filter, Pager, PlannedDate, VisitStatusPill } from './components'
import {
  INVOICE_ELIGIBILITIES,
  INVOICE_ELIGIBILITY_LABELS,
  VISIT_STATUSES,
  VISIT_STATUS_LABELS,
  type ScheduleVisit,
  type VisitList,
} from './types'
import { StatTile } from '../../components/StatTile'
import { VisitDetailsModal, VisitEditModal } from './VisitModals'

const PAGE_SIZE = 50

const statIcon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {path}
  </svg>
)

/** The visit figures from the dashboard summary, as a strip above the schedule. Hidden when the figures are not available to this user. */
function ScheduleStats() {
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary') })
  const visits = summary.data?.amc?.visits
  const invoicing = summary.data?.amc?.invoicing

  if (!visits) {
    return null
  }

  return (
    <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="Visit figures">
      <StatTile
        label="Due this month"
        count={visits.dueThisMonth ?? visits.due}
        hint={visits.dueThisMonth === undefined ? 'Due and overdue visits' : `${visits.due} due or overdue in all`}
        icon={statIcon(<><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" /></>)}
        tone="from-[#1479BD] to-[#4aa3df]"
        edge="#1479BD"
        position={0}
      />
      <StatTile
        label="Overdue"
        count={visits.overdue}
        hint={visits.overdue > 0 ? 'Past their planned date' : 'Nothing is late'}
        warn={visits.overdue > 0}
        icon={statIcon(<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" strokeLinecap="round" /></>)}
        tone="from-rose-600 to-rose-400"
        edge="#f43f5e"
        position={1}
      />
      <StatTile
        label="Completed this month"
        count={visits.completedThisMonth ?? 0}
        hint="Visits finished"
        icon={statIcon(<path d="m5 12.5 4.2 4.2L19 7" strokeLinecap="round" strokeLinejoin="round" />)}
        tone="from-emerald-600 to-emerald-400"
        edge="#10b981"
        position={2}
      />
      {invoicing && (
        <StatTile
          label="Ready for invoice"
          count={invoicing.readyForInvoice.count}
          extra={formatMoney(invoicing.readyForInvoice.amount)}
          hint={invoicing.amountRequired.count > 0 ? `${invoicing.amountRequired.count} completed visits need an amount` : 'Raise these in Zoho'}
          warn={invoicing.amountRequired.count > 0}
          icon={statIcon(<><path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" strokeLinejoin="round" /><path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" /></>)}
          tone="from-amber-600 to-amber-400"
          edge="#f59e0b"
          position={3}
        />
      )}
    </div>
  )
}

type Dialog = { kind: 'none' } | { kind: 'view'; visitId: string } | { kind: 'edit'; visit: ScheduleVisit }

export function AmcSchedulePage() {
  const auth = useAuth()

  // An empty month means "all dates".
  const [month, setMonth] = useState(currentMonth)
  const [clientId, setClientId] = useState('')
  const [status, setStatus] = useState('')
  const [system, setSystem] = useState('')
  const [invoiceEligibility, setInvoiceEligibility] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canViewClients = auth.can('CLIENTS', 'VIEW')
  const canViewContracts = auth.can('AMC_CONTRACTS', 'VIEW')
  const canEdit = auth.can('AMC_SCHEDULE', 'EDIT')

  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => fetchClients('all'), enabled: canViewClients })
  const systems = useQuery({ queryKey: ['amc', 'systems'], queryFn: () => api.get<string[]>('/amc/contracts/systems'), enabled: canViewContracts })

  const range = month ? monthRange(month) : { from: undefined, to: undefined }
  const visits = useQuery({
    queryKey: ['amc', 'visits', 'list', { month, clientId, status, system, invoiceEligibility, search, page }],
    queryFn: () =>
      api.get<VisitList>(
        `/amc/visits${queryString({ from: range.from, to: range.to, clientId, status, system, invoiceEligibility, search, page, pageSize: PAGE_SIZE })}`,
      ),
    placeholderData: keepPreviousData,
  })

  const change = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value)
    setPage(1)
  }
  const data = visits.data
  const closeDialog = () => setDialog({ kind: 'none' })
  const label = (visit: ScheduleVisit) => `${visit.client.name} ${visit.contract.systemDescription} visit ${visit.sequenceNo}`

  return (
    <>
      <PageHeader
        title="AMC Schedule"
        description="Maintenance visits generated from the AMC contracts, by scheduled date."
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      <ScheduleStats />

      <Card>
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-base font-semibold text-slate-900">Visit schedule</h2>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
                  <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
                </svg>
                {month ? monthLabel(month) : 'All dates'}
              </span>
            </div>
            <p className="text-sm text-slate-500" aria-live="polite">
              {data ? (
                <>
                  <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {data.total === 1 ? 'visit' : 'visits'}
                </>
              ) : (
                'Loading…'
              )}
            </p>
          </div>
          <div className="grid gap-4 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3">
          <div>
            <Filter label="Month">
              {(id, className) => (
                <input id={id} type="month" value={month} onChange={(event) => change(setMonth)(event.target.value)} className={className} />
              )}
            </Filter>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={!month} onClick={() => change(setMonth)(shiftMonth(month, -1))}>
                Previous month
              </Button>
              <Button variant="secondary" size="sm" disabled={!month} onClick={() => change(setMonth)(shiftMonth(month, 1))}>
                Next month
              </Button>
              <Button variant="ghost" size="sm" onClick={() => change(setMonth)(month ? '' : currentMonth())}>
                {month ? 'All dates' : 'This month'}
              </Button>
            </div>
          </div>
          {canViewClients && (
            <Filter label="Client">
              {(id, className) => (
                <select id={id} value={clientId} onChange={(event) => change(setClientId)(event.target.value)} className={className}>
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
              <select id={id} value={status} onChange={(event) => change(setStatus)(event.target.value)} className={className}>
                <option value="">All statuses</option>
                {VISIT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {VISIT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          {canViewContracts && (
            <Filter label="System">
              {(id, className) => (
                <select id={id} value={system} onChange={(event) => change(setSystem)(event.target.value)} className={className}>
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
          <Filter label="Invoicing">
            {(id, className) => (
              <select id={id} value={invoiceEligibility} onChange={(event) => change(setInvoiceEligibility)(event.target.value)} className={className}>
                <option value="">Any</option>
                {INVOICE_ELIGIBILITIES.map((value) => (
                  <option key={value} value={value}>
                    {INVOICE_ELIGIBILITY_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Search">
            {(id, className) => (
              <input
                id={id}
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Client, system or assigned person"
                className={className}
              />
            )}
          </Filter>
          </div>
        </div>

        {visits.isPending && <Spinner label="Loading schedule" />}

        {visits.isError && (
          <div className="p-4">
            <Alert>
              {errorMessage(visits.error)}{' '}
              <button type="button" className="font-medium underline" onClick={() => void visits.refetch()}>
                Try again
              </button>
            </Alert>
          </div>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            title={month ? `No visits in ${monthLabel(month)}` : 'No visits found'}
            description="Visits appear here when an AMC contract is activated. Try another month or change the filters."
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">AMC schedule{month ? ` for ${monthLabel(month)}` : ''}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.snHead}>
                      #
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Scheduled
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Client and system
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Period
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Assigned to
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Status
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Amount
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Invoicing
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((visit, index) => (
                    <tr key={visit.id} className={`${TABLE.row} ${visit.isOverdue ? 'bg-rose-50/60 shadow-[inset_4px_0_0_#f43f5e]' : 'hover:shadow-[inset_3px_0_0_#1479BD]'}`}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <PlannedDate visit={visit} format={formatDate} />
                        {visit.isRescheduled && <div className="text-xs text-slate-500">was {formatDate(visit.originalScheduledDate)}</div>}
                      </td>
                      <td className={`${TABLE.td} min-w-40 font-semibold text-slate-900`}>
                        {visit.client.name}
                        <div className="mt-1">
                          <span className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-slate-700 ring-1 ring-inset ring-slate-200">
                            {visit.contract.systemDescription}
                          </span>
                        </div>
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <span className="text-slate-500">No. {visit.sequenceNo} · </span>
                        {formatDate(visit.periodStart)} – {formatDate(visit.periodEnd)}
                      </td>
                      <td className={TABLE.td}>
                        {visit.assignedTo ? (
                          <span className="flex items-center gap-2">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-bold text-[#0b3b66] ring-1 ring-inset ring-sky-200" aria-hidden="true">
                              {initialsOf(visit.assignedTo)}
                            </span>
                            <span>{visit.assignedTo}</span>
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className={TABLE.td}>
                        <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right font-semibold tabular-nums text-slate-900`}>{formatMoney(visit.visitAmount)}</td>
                      <td className={TABLE.td}>
                        <EligibilityPill eligibility={visit.invoiceEligibility} />
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" aria-label={`View ${label(visit)}`} onClick={() => setDialog({ kind: 'view', visitId: visit.id })}>
                            View
                          </Button>
                          {canEdit && visit.status !== 'HISTORICAL' && (
                            <Button variant="ghost" size="sm" aria-label={`Edit ${label(visit)}`} onClick={() => setDialog({ kind: 'edit', visit })}>
                              Edit
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage}>
              {' · '}
              Total amount <strong className="tabular-nums text-slate-900">{formatMoney(data.totals.visitAmount)}</strong> (cancelled visits excluded)
              {data.totals.amountMissingCount > 0 && ` · ${data.totals.amountMissingCount} without an amount`}
            </Pager>
          </>
        )}
      </Card>

      {dialog.kind === 'view' && (
        <VisitDetailsModal visitId={dialog.visitId} canEdit={canEdit} onEdit={(visit) => setDialog({ kind: 'edit', visit })} onClose={closeDialog} />
      )}

      {dialog.kind === 'edit' && (
        <VisitEditModal
          visit={dialog.visit}
          onClose={closeDialog}
          onSaved={(saved) => {
            setNotice(`Visit ${saved.sequenceNo} for ${saved.client.name} (${saved.contract.systemDescription}) was updated.`)
            closeDialog()
          }}
        />
      )}
    </>
  )
}
