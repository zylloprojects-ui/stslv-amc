import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import type { Paged } from '../../lib/types'
import { fetchClients, queryString } from './amcApi'
import { formatDate } from './amcFormat'
import { Filter, Pager, VisitStatusPill } from './components'
import { ExecutionVisitModal, type ExecutionMode } from './ExecutionVisitModal'
import type { ExecutionVisit } from './types'

const PAGE_SIZE = 50
const UPCOMING_DAYS = 30

const SCOPES = [
  { value: 'due', label: 'Due and overdue', empty: 'No visits are due.' },
  { value: 'upcoming', label: `Upcoming (next ${UPCOMING_DAYS} days)`, empty: `No visits are planned in the next ${UPCOMING_DAYS} days.` },
  { value: 'open', label: 'All outstanding', empty: 'There are no outstanding visits.' },
  { value: 'completed', label: 'Completed', empty: 'No visits have been completed yet.' },
  { value: 'all', label: 'All visits', empty: 'There are no visits.' },
] as const

type Scope = (typeof SCOPES)[number]['value']
type Dialog = { kind: 'none' } | { kind: 'visit'; visit: ExecutionVisit; mode: ExecutionMode }

export function AmcExecutionPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()

  const [scope, setScope] = useState<Scope>('due')
  const [clientId, setClientId] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canViewClients = auth.can('CLIENTS', 'VIEW')
  const canEdit = auth.can('AMC_EXECUTION', 'EDIT')
  const canReopen = auth.can('AMC_EXECUTION', 'APPROVE')

  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => fetchClients('all'), enabled: canViewClients })
  const visits = useQuery({
    queryKey: ['amc', 'execution', 'list', { scope, clientId, search, page }],
    queryFn: () =>
      api.get<Paged<ExecutionVisit>>(
        `/amc/execution/visits${queryString({ scope, days: scope === 'upcoming' ? UPCOMING_DAYS : undefined, clientId, search, page, pageSize: PAGE_SIZE })}`,
      ),
    placeholderData: keepPreviousData,
  })

  const label = (visit: ExecutionVisit) => `${visit.client.name} ${visit.contract.systemDescription} visit ${visit.sequenceNo}`

  // Starting work needs no further details, so it is a single action on the row.
  const start = useMutation({
    mutationFn: (visit: ExecutionVisit) => api.patch<ExecutionVisit>(`/amc/execution/visits/${visit.id}`, { status: 'IN_PROGRESS' }),
    onMutate: () => {
      setFailure(null)
      setNotice(null)
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['amc'] })
      setNotice(`Visit ${saved.sequenceNo} for ${saved.client.name} (${saved.contract.systemDescription}) is now in progress.`)
    },
    onError: (error) => setFailure(errorMessage(error)),
  })

  const data = visits.data
  const current = SCOPES.find((item) => item.value === scope) ?? SCOPES[0]
  const filtered = search !== '' || clientId !== ''
  const closeDialog = () => setDialog({ kind: 'none' })

  return (
    <>
      <PageHeader title="AMC Execution" description="Maintenance visits to carry out. Record progress, completion and the work performed." />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}
      {failure && (
        <div className="mb-4">
          <Alert>{failure}</Alert>
        </div>
      )}

      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-3">
          <Filter label="Show">
            {(id, className) => (
              <select
                id={id}
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as Scope)
                  setPage(1)
                }}
                className={className}
              >
                {SCOPES.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          {canViewClients && (
            <Filter label="Client">
              {(id, className) => (
                <select
                  id={id}
                  value={clientId}
                  onChange={(event) => {
                    setClientId(event.target.value)
                    setPage(1)
                  }}
                  className={className}
                >
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

        {visits.isPending && <Spinner label="Loading visits" />}

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
            title={filtered ? 'No visits match your filters' : current.empty}
            description={filtered ? 'Try a different search or client.' : 'Visits appear here from the schedule of active AMC contracts.'}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">AMC visits: {current.label}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      {scope === 'completed' ? 'Completed' : 'Planned date'}
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Client
                    </th>
                    <th scope="col" className={TABLE.th}>
                      System
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
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((visit) => {
                    const outstanding = visit.status === 'SCHEDULED' || visit.status === 'IN_PROGRESS' || visit.status === 'POSTPONED'

                    return (
                      <tr key={visit.id} className={TABLE.row}>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {formatDate(scope === 'completed' ? visit.completedDate : visit.scheduledDate)}
                          {scope !== 'completed' && visit.isRescheduled && (
                            <div className="text-xs text-slate-500">was {formatDate(visit.originalScheduledDate)}</div>
                          )}
                        </td>
                        <td className={`${TABLE.td} min-w-40 font-medium text-slate-900`}>{visit.client.name}</td>
                        <td className={TABLE.td}>{visit.contract.systemDescription}</td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          <span className="text-slate-500">No. {visit.sequenceNo} · </span>
                          {formatDate(visit.periodStart)} – {formatDate(visit.periodEnd)}
                        </td>
                        <td className={TABLE.td}>{visit.assignedTo ?? '—'}</td>
                        <td className={TABLE.td}>
                          <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" aria-label={`View ${label(visit)}`} onClick={() => setDialog({ kind: 'visit', visit, mode: 'view' })}>
                              View
                            </Button>
                            {canEdit && (visit.status === 'SCHEDULED' || visit.status === 'POSTPONED') && (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Start ${label(visit)}`}
                                disabled={start.isPending}
                                onClick={() => start.mutate(visit)}
                              >
                                Start
                              </Button>
                            )}
                            {canEdit && outstanding && (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Complete ${label(visit)}`}
                                onClick={() => setDialog({ kind: 'visit', visit, mode: 'complete' })}
                              >
                                Complete
                              </Button>
                            )}
                            {canEdit && (
                              <Button
                                variant="ghost"
                                size="sm"
                                aria-label={`Update ${label(visit)}`}
                                onClick={() => setDialog({ kind: 'visit', visit, mode: 'update' })}
                              >
                                Update
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {dialog.kind === 'visit' && (
        <ExecutionVisitModal
          visit={dialog.visit}
          mode={dialog.mode}
          canReopen={canReopen}
          onClose={closeDialog}
          onSaved={(saved) => {
            setFailure(null)
            setNotice(
              saved.status === 'COMPLETED' && dialog.visit.status !== 'COMPLETED'
                ? `Visit ${saved.sequenceNo} for ${saved.client.name} (${saved.contract.systemDescription}) was completed.`
                : `Visit ${saved.sequenceNo} for ${saved.client.name} (${saved.contract.systemDescription}) was updated.`,
            )
            closeDialog()
          }}
        />
      )}
    </>
  )
}
