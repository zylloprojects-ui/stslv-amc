import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
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
import { VisitDetailsModal, VisitEditModal } from './VisitModals'

const PAGE_SIZE = 50

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

      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-3">
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
                  {data.items.map((visit) => (
                    <tr key={visit.id} className={TABLE.row}>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <PlannedDate visit={visit} format={formatDate} />
                        {visit.isRescheduled && <div className="text-xs text-slate-500">was {formatDate(visit.originalScheduledDate)}</div>}
                      </td>
                      <td className={`${TABLE.td} min-w-40 font-medium text-slate-900`}>
                        {visit.client.name}
                        <div className="text-xs font-normal text-slate-500">{visit.contract.systemDescription}</div>
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <span className="text-slate-500">No. {visit.sequenceNo} · </span>
                        {formatDate(visit.periodStart)} – {formatDate(visit.periodEnd)}
                      </td>
                      <td className={TABLE.td}>{visit.assignedTo ?? '—'}</td>
                      <td className={TABLE.td}>
                        <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(visit.visitAmount)}</td>
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
