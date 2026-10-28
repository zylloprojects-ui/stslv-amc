import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { ActionButton, ActionGroup, ActionLink } from '../../components/IconActions'
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
import { ContractFormModal } from './ContractFormModal'
import { StatTile } from '../../components/StatTile'
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  FREQUENCY_LABELS,
  frequencyLabel,
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

/** How much of the validity period has passed, 0–100, for the thin timeline under the dates. Display only. */
function validityElapsed(contract: Contract): number {
  const from = Date.parse(`${contract.validFrom}T00:00:00Z`)
  const to = Date.parse(`${contract.validTo}T00:00:00Z`)

  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return 0

  return Math.min(100, Math.max(0, Math.round(((Date.now() - from) / (to - from)) * 100)))
}

const STATUS_EDGE: Record<ContractStatus, string> = {
  ACTIVE: '#10b981',
  DRAFT: '#f59e0b',
  EXPIRED: '#64748b',
  CANCELLED: '#f43f5e',
}

// A contract's details, schedule, invoices and status changes are on its own page (ContractDetailPage).
type Dialog = { kind: 'none' } | { kind: 'create' } | { kind: 'edit'; contract: Contract }

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
            <h2 className="flex items-center gap-2.5 text-lg font-bold tracking-tight text-[#0b3b66]">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#1479BD] to-[#00A6C8] text-white shadow-md" aria-hidden="true">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 6h16M4 12h16M4 18h10" />
                </svg>
              </span>
              Contract register
            </h2>
            <p className="text-sm text-slate-500" aria-live="polite">
              {data ? (
                <>
                  <span className="mr-1 rounded-full bg-[#1479BD] px-2.5 py-0.5 text-xs font-bold tabular-nums text-white shadow-sm">{data.total}</span> {filtered ? 'matching ' : ''}
                  {data.total === 1 ? 'contract' : 'contracts'}
                </>
              ) : (
                'Loading…'
              )}
            </p>
          </div>
          <div className="mx-4 my-4 grid gap-4 rounded-xl border border-sky-100 bg-white/70 p-4 shadow-sm sm:mx-5 sm:grid-cols-2 lg:grid-cols-4">
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
                {Object.keys(FREQUENCY_LABELS).map((value) => (
                  <option key={value} value={value}>
                    {frequencyLabel(value)}
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
                    <tr key={contract.id} className={`${TABLE.row} transition-shadow even:bg-slate-50/60 hover:bg-sky-50 hover:shadow-[inset_5px_0_0_#1479BD] [&>td]:py-4`} style={{ boxShadow: `inset 3px 0 0 ${STATUS_EDGE[contract.status] ?? '#94a3b8'}` }}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      <td className={`${TABLE.td} min-w-48`}>
                        <div className="flex items-center gap-3">
                          <ClientAvatar name={contract.client.name} className="h-11 w-11 text-sm shadow-md ring-2 ring-white" />
                          <span className="min-w-0 break-words text-sm font-bold leading-snug text-[#0b3b66]">{contract.client.name}</span>
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
                        {contract.status === 'ACTIVE' && (
                          <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                            <span
                              className={`block h-full rounded-full ${validityNote(contract)?.ended ? 'bg-amber-500' : validityElapsed(contract) > 80 ? 'bg-gradient-to-r from-amber-400 to-red-500' : 'bg-gradient-to-r from-emerald-400 to-[#1479BD]'}`}
                              style={{ width: `${validityElapsed(contract)}%` }}
                            />
                          </span>
                        )}
                        {validityNote(contract) && (
                          <span className={`mt-0.5 block text-xs ${validityNote(contract)?.ended ? 'text-amber-700' : 'text-slate-500'}`}>{validityNote(contract)?.text}</span>
                        )}
                      </td>
                      <td className={TABLE.td}>
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-[#0b3b66] ring-1 ring-inset ring-sky-100">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {frequencyLabel(contract.maintenanceFrequency)}
                        </span>
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <span className="block text-base font-extrabold tabular-nums text-[#0b3b66]">{formatMoney(contract.contractValue)}</span>
                        {contract.defaultVisitAmount && (
                          <span className="mt-0.5 block text-xs tabular-nums text-slate-500">{formatMoney(contract.defaultVisitAmount)} per visit</span>
                        )}
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap`}>
                        {contract.schedule.visitCount === 0 ? (
                          '—'
                        ) : (
                          <span className="flex items-center gap-3">
                            <span
                              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full p-[3px]"
                              style={{ backgroundImage: `conic-gradient(#1479BD ${Math.round((contract.schedule.completedCount / contract.schedule.visitCount) * 360)}deg, #e2e8f0 0deg)` }}
                              aria-hidden="true"
                            >
                              <span className="flex h-full w-full items-center justify-center rounded-full bg-white text-[11px] font-extrabold tabular-nums text-[#0b3b66]">
                                {Math.round((contract.schedule.completedCount / contract.schedule.visitCount) * 100)}%
                              </span>
                            </span>
                            <span className="text-xs">{`${contract.schedule.completedCount} of ${contract.schedule.visitCount} completed`}</span>
                          </span>
                        )}
                      </td>
                      <td className={TABLE.td}>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <ContractStatusPill status={contract.status} />
                          {contract.isPastValidity && contract.status === 'ACTIVE' && <Pill tone="amber">Validity ended</Pill>}
                        </span>
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <ActionGroup>
                          <ActionLink to={`/amc/contracts/${contract.id}`} label={`View ${label(contract)}`} icon="view" />
                          {canEdit && <ActionButton label={`Edit ${label(contract)}`} icon="edit" onClick={() => setDialog({ kind: 'edit', contract })} />}
                        </ActionGroup>
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
    </>
  )
}
