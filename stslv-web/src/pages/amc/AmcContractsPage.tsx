import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { initialsOf } from '../../lib/format'
import type { Paged } from '../../lib/types'
import { ClientAvatar } from '../clients/clientAvatar'
import type { DashboardSummary } from '../dashboard/metrics'
import { fetchClients, queryString } from './amcApi'
import { formatDate, formatMoney } from './amcFormat'
import { ContractStatusPill, Filter, Pager, Pill } from './components'
import { ContractDetailsModal } from './ContractDetailsModal'
import { ContractFormModal } from './ContractFormModal'
import { StatTile } from '../../components/StatTile'
import { ContractStatusDialog } from './ContractStatusDialog'
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  FREQUENCY_LABELS,
  MAINTENANCE_FREQUENCIES,
  type Contract,
  type ContractStatus,
  type SavedContract,
} from './types'

const PAGE_SIZE = 25

interface TileSpec {
  key: ContractStatus | 'all'
  label: string
  count: number
  hint?: string
  icon: ReactNode
  tone: string
  /** The colour of the tile's edge and its soft tint. */
  edge: string
}

/** The contract figures from the dashboard summary, as clickable tiles that filter the register. Hidden when the figures are not available. */
function StatusTiles({ selected, onSelect }: { selected: ContractStatus | 'all'; onSelect: (value: ContractStatus | 'all') => void }) {
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary') })
  const figures = summary.data?.amc?.contracts

  if (!figures) {
    return null
  }

  const active = figures.active
  const draft = figures.draft ?? 0
  const expired = figures.expired ?? 0
  const cancelled = figures.cancelled ?? 0
  const icon = (path: ReactNode) => (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {path}
    </svg>
  )

  const specs: TileSpec[] = [
    { key: 'all', label: 'All contracts', count: active + draft + expired + cancelled, icon: icon(<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5v4h4M9.5 12h5M9.5 15.5h5" strokeLinecap="round" strokeLinejoin="round" />), tone: 'from-[#1479BD] to-[#4aa3df]', edge: '#1479BD' },
    {
      key: 'ACTIVE',
      label: 'Active',
      count: active,
      hint: figures.activePastValidity > 0 ? `${figures.activePastValidity} past their validity` : 'All within validity',
      icon: icon(<path d="m5 12.5 4.2 4.2L19 7" strokeLinecap="round" strokeLinejoin="round" />),
      tone: 'from-emerald-600 to-emerald-400', edge: '#10b981',
    },
    { key: 'DRAFT', label: 'Draft', count: draft, icon: icon(<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" strokeLinecap="round" strokeLinejoin="round" />), tone: 'from-amber-600 to-amber-400', edge: '#f59e0b' },
    { key: 'EXPIRED', label: 'Expired', count: expired, icon: icon(<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" strokeLinecap="round" /></>), tone: 'from-slate-600 to-slate-400', edge: '#64748b' },
    { key: 'CANCELLED', label: 'Cancelled', count: cancelled, icon: icon(<><circle cx="12" cy="12" r="8" /><path d="m8.5 8.5 7 7" strokeLinecap="round" /></>), tone: 'from-rose-600 to-rose-400', edge: '#f43f5e' },
  ]

  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" role="group" aria-label="Filter contracts by status">
      {specs.map((tile, position) => {
        const on = selected === tile.key

        return (
          <StatTile
            key={tile.key}
            label={tile.label}
            count={tile.count}
            hint={tile.hint}
            warn={tile.key === 'ACTIVE' && figures.activePastValidity > 0}
            icon={tile.icon}
            tone={tile.tone}
            edge={tile.edge}
            position={position}
            selected={on}
            onSelect={() => onSelect(on && tile.key !== 'all' ? 'all' : tile.key)}
          />
        )
      })}
    </div>
  )
}

/** How far a contract is from the end of its validity, in words. Only for a contract that is running. */
function validityNote(contract: Contract): { text: string; ended: boolean } | null {
  if (contract.status !== 'ACTIVE') {
    return null
  }

  const end = Date.parse(`${contract.validTo}T00:00:00Z`)
  const now = new Date()
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((end - today) / 86_400_000)

  if (Number.isNaN(days)) {
    return null
  }
  if (days < 0) {
    return { text: `Ended ${-days} day${days === -1 ? '' : 's'} ago`, ended: true }
  }

  return { text: days === 0 ? 'Ends today' : `${days} day${days === 1 ? '' : 's'} left`, ended: false }
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; contract: Contract }
  | { kind: 'view'; contractId: string }
  | { kind: 'status'; contract: Contract; status: ContractStatus }

function scheduleNote(saved: SavedContract): string {
  const change = saved.scheduleChange
  const parts: string[] = []

  if (change && change.created > 0) parts.push(`${change.created} visit(s) added to the schedule`)
  if (change && change.removed > 0) parts.push(`${change.removed} untouched visit(s) removed`)
  if (saved.cancelledVisits) parts.push(`${saved.cancelledVisits} visit(s) cancelled`)

  return parts.length > 0 ? ` ${parts.join(', ')}.` : ''
}

export function AmcContractsPage() {
  const auth = useAuth()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ContractStatus | 'all'>('all')
  const [clientId, setClientId] = useState('')
  const [frequency, setFrequency] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const canViewClients = auth.can('CLIENTS', 'VIEW')
  const clients = useQuery({ queryKey: ['clients', 'all'], queryFn: () => fetchClients('all'), enabled: canViewClients })

  const contracts = useQuery({
    queryKey: ['amc', 'contracts', 'list', { search, status, clientId, frequency, page }],
    queryFn: () =>
      api.get<Paged<Contract>>(`/amc/contracts${queryString({ search, status, clientId, frequency, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })

  const canCreate = auth.can('AMC_CONTRACTS', 'CREATE')
  const canEdit = auth.can('AMC_CONTRACTS', 'EDIT')
  const canCancel = auth.can('AMC_CONTRACTS', 'DELETE')

  const data = contracts.data
  const filtered = search !== '' || status !== 'all' || clientId !== '' || frequency !== ''
  const closeDialog = () => setDialog({ kind: 'none' })
  const label = (contract: Contract) => `${contract.client.name} ${contract.systemDescription}`

  return (
    <>
      <PageHeader
        title="AMC Contracts"
        description="Maintenance contracts. An active contract generates its visit schedule from its validity period and frequency."
        actions={canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>Add Contract</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      <StatusTiles
        selected={status}
        onSelect={(value) => {
          setStatus(value)
          setPage(1)
        }}
      />
      <Card>
        <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-4 sm:px-5">
            <h2 className="text-base font-semibold text-slate-900">Contract register</h2>
            <p className="text-sm text-slate-500" aria-live="polite">
              {data ? (
                <>
                  <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {filtered ? 'matching ' : ''}
                  {data.total === 1 ? 'contract' : 'contracts'}
                </>
              ) : (
                'Loading…'
              )}
            </p>
          </div>
          <div className="grid gap-4 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          <Filter label="Search">
            {(id, className) => (
              <input
                id={id}
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Client, system or engineer"
                className={className}
              />
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
          <Filter label="Status">
            {(id, className) => (
              <select
                id={id}
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as ContractStatus | 'all')
                  setPage(1)
                }}
                className={className}
              >
                <option value="all">All statuses</option>
                {CONTRACT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {CONTRACT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Frequency">
            {(id, className) => (
              <select
                id={id}
                value={frequency}
                onChange={(event) => {
                  setFrequency(event.target.value)
                  setPage(1)
                }}
                className={className}
              >
                <option value="">All frequencies</option>
                {MAINTENANCE_FREQUENCIES.map((value) => (
                  <option key={value} value={value}>
                    {FREQUENCY_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          </div>
        </div>

        {contracts.isPending && <Spinner label="Loading contracts" />}

        {contracts.isError && (
          <div className="p-4">
            <Alert>
              {errorMessage(contracts.error)}{' '}
              <button type="button" className="font-medium underline" onClick={() => void contracts.refetch()}>
                Try again
              </button>
            </Alert>
          </div>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No contracts match your filters' : 'No AMC contracts yet'}
            description={
              filtered ? 'Try a different search or filter.' : 'Add a contract to generate its maintenance schedule automatically.'
            }
            action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>Add Contract</Button> : undefined}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">AMC contracts</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.snHead}>
                      #
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Client
                    </th>
                    <th scope="col" className={TABLE.th}>
                      System
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Engineer
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Validity
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Frequency
                    </th>
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Contract value
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Visits
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
                  {data.items.map((contract, index) => (
                    <tr key={contract.id} className={`${TABLE.row} hover:shadow-[inset_3px_0_0_#1479BD]`}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      <td className={`${TABLE.td} min-w-48`}>
                        <div className="flex items-center gap-3">
                          <ClientAvatar name={contract.client.name} className="h-9 w-9 text-xs" />
                          <span className="min-w-0 break-words text-sm font-semibold leading-snug text-slate-900">{contract.client.name}</span>
                        </div>
                      </td>
                      <td className={TABLE.td}>
                        <span className="inline-block rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold tracking-wide text-slate-700 ring-1 ring-inset ring-slate-200">
                          {contract.systemDescription}
                        </span>
                      </td>
                      <td className={TABLE.td}>
                        {contract.responsibleEngineer ? (
                          <span className="flex items-center gap-2">
                            <span
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-bold text-[#0b3b66] ring-1 ring-inset ring-sky-200"
                              aria-hidden="true"
                            >
                              {initialsOf(contract.responsibleEngineer)}
                            </span>
                            <span>{contract.responsibleEngineer}</span>
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        <span className="block font-medium text-slate-800">
                          {formatDate(contract.validFrom)} – {formatDate(contract.validTo)}
                        </span>
                        {validityNote(contract) && (
                          <span className={`mt-0.5 block text-xs ${validityNote(contract)?.ended ? 'text-amber-700' : 'text-slate-500'}`}>{validityNote(contract)?.text}</span>
                        )}
                      </td>
                      <td className={TABLE.td}>
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-[#0b3b66] ring-1 ring-inset ring-sky-100">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {FREQUENCY_LABELS[contract.maintenanceFrequency]}
                        </span>
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <span className="block font-semibold tabular-nums text-slate-900">{formatMoney(contract.contractValue)}</span>
                        {contract.defaultVisitAmount && (
                          <span className="mt-0.5 block text-xs tabular-nums text-slate-500">{formatMoney(contract.defaultVisitAmount)} per visit</span>
                        )}
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        {contract.schedule.visitCount === 0 ? (
                          '—'
                        ) : (
                          <>
                            <span
                              className="mb-1 block h-1.5 w-28 overflow-hidden rounded-full bg-slate-200"
                              aria-hidden="true"
                            >
                              <span
                                className="block h-full rounded-full bg-gradient-to-r from-[#1479BD] to-[#4aa3df]"
                                style={{ width: `${Math.round((contract.schedule.completedCount / contract.schedule.visitCount) * 100)}%` }}
                              />
                            </span>
                            <span className="text-xs">{`${contract.schedule.completedCount} of ${contract.schedule.visitCount} completed`}</span>
                          </>
                        )}
                      </td>
                      <td className={TABLE.td}>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <ContractStatusPill status={contract.status} />
                          {contract.isPastValidity && contract.status === 'ACTIVE' && <Pill tone="amber">Validity ended</Pill>}
                        </span>
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                          <button
                            type="button"
                            aria-label={`View ${label(contract)}`}
                            onClick={() => setDialog({ kind: 'view', contractId: contract.id })}
                            className="px-3 py-1.5 text-xs font-semibold text-[#1479BD] transition-colors hover:bg-sky-50 focus-visible:relative focus-visible:z-10"
                          >
                            View
                          </button>
                          {canEdit && (
                            <button
                              type="button"
                              aria-label={`Edit ${label(contract)}`}
                              onClick={() => setDialog({ kind: 'edit', contract })}
                              className="px-3 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10"
                            >
                              Edit
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {(dialog.kind === 'create' || dialog.kind === 'edit') && (
        <ContractFormModal
          contract={dialog.kind === 'edit' ? dialog.contract : null}
          onClose={closeDialog}
          onSaved={(saved) => {
            setNotice(`The contract for ${label(saved)} was ${dialog.kind === 'edit' ? 'updated' : 'added'}.${scheduleNote(saved)}`)
            closeDialog()
          }}
        />
      )}

      {dialog.kind === 'view' && (
        <ContractDetailsModal
          contractId={dialog.contractId}
          canEdit={canEdit}
          canCancel={canCancel}
          canViewSchedule={auth.can('AMC_SCHEDULE', 'VIEW')}
          onEdit={(contract) => setDialog({ kind: 'edit', contract })}
          onChangeStatus={(contract, next) => setDialog({ kind: 'status', contract, status: next })}
          onClose={closeDialog}
        />
      )}

      {dialog.kind === 'status' && (
        <ContractStatusDialog
          contract={dialog.contract}
          status={dialog.status}
          onClose={() => setDialog({ kind: 'view', contractId: dialog.contract.id })}
          onChanged={(saved) => {
            setNotice(`The contract for ${label(saved)} is now ${CONTRACT_STATUS_LABELS[saved.status]}.${scheduleNote(saved)}`)
            setDialog({ kind: 'view', contractId: saved.id })
          }}
        />
      )}
    </>
  )
}
