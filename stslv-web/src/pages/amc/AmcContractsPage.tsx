import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { isSuperAdmin } from '../../auth/roles'
import { refreshOperationalData } from '../../lib/refreshOperationalData'
import { ExportButtons } from '../../components/ExportButtons'
import { ActionButton, ActionGroup, ActionLink } from '../../components/IconActions'
import { Alert, Button, Card, ConfirmDialog, EmptyState, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import type { Paged } from '../../lib/types'
import { ColumnsMenu, type ColumnOption } from '../clients/ColumnsMenu'
import { queryString } from './amcApi'
import { formatDate, formatMoney } from './amcFormat'
import { ContractStatusPill, Filter, FilterPanel, Pager, Pill } from './components'
import { ContractFormModal } from './ContractFormModal'
import { StatTile } from '../../components/StatTile'
import {
  CONTRACT_STATUSES,
  CONTRACT_STATUS_LABELS,
  frequencyLabel,
  type Contract,
  type ContractStatus,
  type SavedContract,
} from './types'

const PAGE_SIZE = 25

/** The columns a user may hide; the same ids the export accepts. # , Client and Actions always stay. */
type ColumnKey = 'reference' | 'system' | 'engineer' | 'validity' | 'frequency' | 'contractValue' | 'finalCredit' | 'visits' | 'status'

const COLUMN_OPTIONS: ColumnOption<ColumnKey>[] = [
  { key: 'reference', label: 'AMC Reference' },
  { key: 'system', label: 'System' },
  { key: 'engineer', label: 'Engineer' },
  { key: 'validity', label: 'Validity' },
  { key: 'frequency', label: 'Frequency' },
  { key: 'contractValue', label: 'Contract value' },
  { key: 'finalCredit', label: 'Credit' },
  { key: 'visits', label: 'Visits' },
  { key: 'status', label: 'Status' },
]

// The hidden columns, remembered in this browser only. Storage may be blocked; the choice then lasts for this visit.
const COLUMNS_KEY = 'stslev.amc-contracts.hidden-columns'

function readHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]') as unknown
    const known = new Set<string>(COLUMN_OPTIONS.map((option) => option.key))

    return new Set(Array.isArray(stored) ? stored.filter((key): key is ColumnKey => typeof key === 'string' && known.has(key)) : [])
  } catch {
    return new Set()
  }
}

function saveHiddenColumns(hidden: Set<ColumnKey>) {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify([...hidden]))
  } catch {
    // Nothing to do: the choice lasts for this visit.
  }
}

/** Totals are PostgreSQL's sums over every contract the filters select, not only this page. */
type ContractList = Paged<Contract> & { totals?: { contractValue: string; finalCredit: string } }

/** GET /amc/contracts/filter-options: the values present on contracts. */
interface ContractFilterOptions {
  clients: { id: string; name: string }[]
  systems: string[]
  /** Null on a database without the Sales Engineer link: the filter is then not offered. */
  salesEngineers: { id: string; name: string }[] | null
  frequencies: { code: string; label: string }[]
  /** Every calendar year a contract's validity period covers. */
  years: number[]
}

/** GET /amc/contracts/kpis: figures over every contract that is not in the Recycle Bin, whatever its status. */
interface ContractKpis {
  total: number
  /** Sum of AMC Value / Year, OMR excluding VAT. */
  contractValue: string
  /** Sum of Final Credit, OMR excluding VAT. A contract without one adds nothing. */
  finalCredit: string
  /** Contracts with no Final Credit recorded (added before it was required). */
  finalCreditMissing: number
  /** Status Expired, or Active with an end date before today. Each contract counts once. */
  expired: number
}

interface KpiSpec {
  key: string
  label: string
  count: number
  value?: string
  extra?: string
  hint: string
  warn?: boolean
  icon: ReactNode
  tone: string
  /** The colour of the tile's edge and its soft tint. */
  edge: string
}

/**
 * The register's four figures. They count every contract outside the Recycle Bin and do not follow the filters
 * below; the Filtered Total row under the register gives the sums of what the filters select.
 */
function ContractKpiStrip() {
  const kpis = useQuery({ queryKey: ['amc', 'contracts', 'kpis'], queryFn: () => api.get<ContractKpis>('/amc/contracts/kpis') })
  const figures = kpis.data

  if (kpis.isError) {
    return (
      <div className="mb-5">
        <Alert>The contract figures could not be loaded. {errorMessage(kpis.error)}</Alert>
      </div>
    )
  }
  if (!figures) {
    return null
  }

  const icon = (path: ReactNode) => (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {path}
    </svg>
  )

  const specs: KpiSpec[] = [
    {
      key: 'all',
      label: 'All AMC Contracts',
      count: figures.total,
      hint: 'Every status. Recycle Bin excluded.',
      icon: icon(<path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5v4h4M9.5 12h5M9.5 15.5h5" strokeLinecap="round" strokeLinejoin="round" />),
      tone: 'from-[#1479BD] to-[#4aa3df]',
      edge: '#1479BD',
    },
    {
      key: 'contractValue',
      label: 'Total AMC Value',
      count: 0,
      value: formatMoney(figures.contractValue),
      extra: 'OMR',
      hint: 'Sum of AMC Value / Year, excluding VAT.',
      icon: icon(<><rect x="3.5" y="6.5" width="17" height="11" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 9.5v5M17.5 9.5v5" strokeLinecap="round" /></>),
      tone: 'from-emerald-600 to-emerald-400',
      edge: '#10b981',
    },
    {
      key: 'finalCredit',
      label: 'Total Final Credit',
      count: 0,
      value: formatMoney(figures.finalCredit),
      extra: 'OMR',
      hint:
        figures.finalCreditMissing > 0
          ? `Excluding VAT. ${figures.finalCreditMissing} ${figures.finalCreditMissing === 1 ? 'contract has' : 'contracts have'} no Final Credit recorded.`
          : 'Sum of Final Credit, excluding VAT.',
      warn: figures.finalCreditMissing > 0,
      icon: icon(<><path d="M5 19.5h14M6.5 16.5v-5M10.5 16.5v-5M13.5 16.5v-5M17.5 16.5v-5M4.5 9 12 4.5 19.5 9Z" strokeLinecap="round" strokeLinejoin="round" /></>),
      tone: 'from-violet-600 to-violet-400',
      edge: '#8b5cf6',
    },
    {
      key: 'expired',
      label: 'Expired',
      count: figures.expired,
      hint: 'Status Expired, or Active with its end date passed.',
      icon: icon(<><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" strokeLinecap="round" /></>),
      tone: 'from-slate-600 to-slate-400',
      edge: '#64748b',
    },
  ]

  return (
    <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="AMC contract figures">
      {specs.map((tile, position) => (
        <StatTile
          key={tile.key}
          label={tile.label}
          count={tile.count}
          value={tile.value}
          extra={tile.extra}
          hint={tile.hint}
          warn={tile.warn}
          icon={tile.icon}
          tone={tile.tone}
          edge={tile.edge}
          position={position}
        />
      ))}
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
type Dialog = { kind: 'none' } | { kind: 'create' } | { kind: 'edit'; contract: Contract } | { kind: 'delete'; contract: Contract }

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
  const queryClient = useQueryClient()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<ContractStatus | 'all'>('all')
  const [clientId, setClientId] = useState('')
  const [frequency, setFrequency] = useState('')
  const [system, setSystem] = useState('')
  const [year, setYear] = useState('')
  const [salesEngineerId, setSalesEngineerId] = useState('')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [hiddenColumns, setHiddenColumns] = useState<Set<ColumnKey>>(readHiddenColumns)
  const show = (key: ColumnKey) => !hiddenColumns.has(key)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  // Clients, systems, sales engineers, frequencies and years present on contracts.
  const options = useQuery({ queryKey: ['amc', 'contracts', 'filter-options'], queryFn: () => api.get<ContractFilterOptions>('/amc/contracts/filter-options') })

  const contracts = useQuery({
    queryKey: ['amc', 'contracts', 'list', { search, status, clientId, system, year, salesEngineerId, frequency, page }],
    queryFn: () =>
      api.get<ContractList>(
        `/amc/contracts${queryString({ search, status, clientId, system, year, salesEngineerId, frequency, page, pageSize: PAGE_SIZE })}`,
      ),
    placeholderData: keepPreviousData,
  })

  const canCreate = auth.can('AMC_CONTRACTS', 'CREATE')
  const canExport = auth.can('AMC_CONTRACTS', 'EXPORT')
  const [exportError, setExportError] = useState<string | null>(null)
  const canEdit = auth.can('AMC_CONTRACTS', 'EDIT')
  // Moving a contract to the Recycle Bin is Super Admin only; the API refuses everyone else with 403.
  const canDelete = isSuperAdmin(auth.user)

  const data = contracts.data
  const filtered = search !== '' || status !== 'all' || clientId !== '' || system !== '' || year !== '' || salesEngineerId !== '' || frequency !== ''
  // A changed filter starts again from the first page.
  const choose = (set: (value: string) => void) => (event: ChangeEvent<HTMLSelectElement>) => {
    set(event.target.value)
    setPage(1)
  }
  const resetFilters = () => {
    setSearchInput('')
    setSearch('')
    setStatus('all')
    setClientId('')
    setSystem('')
    setYear('')
    setSalesEngineerId('')
    setFrequency('')
    setPage(1)
  }
  const closeDialog = () => setDialog({ kind: 'none' })
  const label = (contract: Contract) => `${contract.client.name} ${contract.systemDescription}`
  // Moves a contract to the Recycle Bin. Nothing is removed; Super Admin can restore it there.
  const remove = useMutation({
    mutationFn: (contract: Contract) => api.delete(`/amc/contracts/${contract.id}`),
    onMutate: () => setNotice(null),
    onSuccess: async (_result, contract) => {
      setDialog({ kind: 'none' })
      // Every page that shows contracts, services or their figures.
      await refreshOperationalData(queryClient)
      setNotice(`The contract for ${label(contract)} was moved to the Recycle Bin.`)
    },
  })
  // The Filtered Total row: the label spans every column before the first amount.
  const leadingColumns = 2 + (['reference', 'system', 'engineer', 'validity', 'frequency'] as const).filter(show).length
  const trailingColumns = 1 + (show('visits') ? 1 : 0) + (canEdit ? 1 : 0) + (show('status') ? 1 : 0)

  return (
    <>
      <PageHeader
        title="AMC Contracts"
        description="Maintenance contracts. An active contract generates its visit schedule from its validity period and frequency."
        actions={
          <div className="flex flex-wrap gap-2">
            {canExport && (
              // The download covers every contract that matches the filters, on every page.
              <ExportButtons
                what="AMC Contracts"
                fileStem="amc-contracts"
                path={(format) => `/amc/contracts/export${queryString({ search, status, clientId, system, year, salesEngineerId, frequency, format, hidden: [...hiddenColumns].join(',') })}`}
                onError={setExportError}
              />
            )}
            {canCreate && <Button onClick={() => setDialog({ kind: 'create' })}>Add Contract</Button>}
          </div>
        }
      />

      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      {notice && (
        <div className="mb-4">
          <Alert tone="success">{notice}</Alert>
        </div>
      )}

      <ContractKpiStrip />
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
          <FilterPanel id="amc-contracts">
<div className="mx-4 my-4 grid gap-4 rounded-xl border border-sky-100 bg-white/70 p-4 shadow-sm sm:mx-5 sm:grid-cols-2 lg:grid-cols-4">
          <Filter label="Search">
            {(id, className) => (
              <input
                id={id}
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="AMC reference, client, system or engineer"
                className={className}
              />
            )}
          </Filter>
          <Filter label="Client">
            {(id, className) => (
              <select id={id} value={clientId} onChange={choose(setClientId)} className={className}>
                <option value="">All clients</option>
                <OptionsNotice source={options} count={options.data?.clients.length ?? 0} empty="No clients have AMC contracts yet" />
                {(options.data?.clients ?? []).map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="System">
            {(id, className) => (
              <select id={id} value={system} onChange={choose(setSystem)} className={className}>
                <option value="">All systems</option>
                <OptionsNotice source={options} count={options.data?.systems.length ?? 0} empty="No systems on AMC contracts yet" />
                {(options.data?.systems ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Year">
            {(id, className) => (
              <select id={id} value={year} onChange={choose(setYear)} title="Contracts whose validity period covers any day of the year" className={className}>
                <option value="">All years</option>
                <OptionsNotice source={options} count={options.data?.years.length ?? 0} empty="No contract years yet" />
                {(options.data?.years ?? []).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          {options.data?.salesEngineers !== null && (
            <Filter label="Sales engineer">
              {(id, className) => (
                <select id={id} value={salesEngineerId} onChange={choose(setSalesEngineerId)} className={className}>
                  <option value="">All sales engineers</option>
                  <OptionsNotice source={options} count={options.data?.salesEngineers?.length ?? 0} empty="No sales engineers linked to AMC contracts" />
                  {(options.data?.salesEngineers ?? []).map((engineer) => (
                    <option key={engineer.id} value={engineer.id}>
                      {engineer.name}
                    </option>
                  ))}
                </select>
              )}
            </Filter>
          )}
          <Filter label="Frequency">
            {(id, className) => (
              <select id={id} value={frequency} onChange={choose(setFrequency)} className={className}>
                <option value="">All frequencies</option>
                <OptionsNotice source={options} count={options.data?.frequencies.length ?? 0} empty="No frequencies on AMC contracts yet" />
                {(options.data?.frequencies ?? []).map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Contract status">
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
                <option value="all">All contract statuses</option>
                {CONTRACT_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {CONTRACT_STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <div className="flex items-end gap-2">
            <Button variant="secondary" onClick={resetFilters} disabled={!filtered} className="flex-1 rounded-xl">
              Reset filters
            </Button>
            <ColumnsMenu
              options={COLUMN_OPTIONS}
              hidden={hiddenColumns}
              onChange={(next) => {
                setHiddenColumns(next)
                saveHiddenColumns(next)
              }}
            />
          </div>
          </div>
</FilterPanel>
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
                    {show('reference') && (
                      <th scope="col" className={TABLE.th}>
                        AMC Reference
                      </th>
                    )}
                    <th scope="col" className={TABLE.th}>
                      Client
                    </th>
                    {show('system') && (
                      <th scope="col" className={TABLE.th}>
                        System
                      </th>
                    )}
                    {show('engineer') && (
                      <th scope="col" className={TABLE.th}>
                        Engineer
                      </th>
                    )}
                    {show('validity') && (
                      <th scope="col" className={TABLE.th}>
                        Validity
                      </th>
                    )}
                    {show('frequency') && (
                      <th scope="col" className={TABLE.th}>
                        Frequency
                      </th>
                    )}
                    {show('contractValue') && (
                      <th scope="col" className={`${TABLE.th} text-right`}>
                        Contract value
                      </th>
                    )}
                    {show('finalCredit') && (
                      <th scope="col" className={`${TABLE.th} text-right`}>
                        Credit
                      </th>
                    )}
                    {show('visits') && (
                      <th scope="col" className={TABLE.th}>
                        Visits
                      </th>
                    )}
                    {canEdit && (
                      <th scope="col" className={TABLE.th}>
                        Contract
                      </th>
                    )}
                    {show('status') && (
                      <th scope="col" className={TABLE.th}>
                        Status
                      </th>
                    )}
                    <th scope="col" className={`${TABLE.th} text-right`}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((contract, index) => (
                    <tr key={contract.id} className={`${TABLE.row} transition-shadow even:bg-slate-50/60 hover:bg-sky-50 hover:shadow-[inset_5px_0_0_#1479BD] [&>td]:py-4`} style={{ boxShadow: `inset 3px 0 0 ${STATUS_EDGE[contract.status] ?? '#94a3b8'}` }}>
                      <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                      {show('reference') && (
                        <td className={`${TABLE.td} whitespace-nowrap font-mono text-sm font-semibold text-[#0b3b66]`}>
                          <Link to={`/amc/contracts/${contract.id}`} className="hover:underline">
                            {contract.amcReference}
                          </Link>
                        </td>
                      )}
                      <td className={`${TABLE.td} min-w-48`}>
                        <span className="min-w-0 break-words text-sm font-bold leading-snug text-[#0b3b66]">{contract.client.name}</span>
                      </td>
                      {show('system') && <td className={TABLE.td}>
                        <span className="inline-block rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold tracking-wide text-slate-700 ring-1 ring-inset ring-slate-200">
                          {contract.systemDescription}
                        </span>
                      </td>}
                      {show('engineer') && <td className={TABLE.td}>
                        {contract.responsibleEngineer ? (
                          <span>{contract.responsibleEngineer}</span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>}
                      {show('validity') && <td className={`${TABLE.td} whitespace-nowrap`}>
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
                      </td>}
                      {show('frequency') && <td className={TABLE.td}>
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-sky-50 px-2 py-1 text-xs font-medium text-[#0b3b66] ring-1 ring-inset ring-sky-100">
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-[#1479BD]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5M20 4v4.5h-4.5M20 12a8 8 0 0 1-13.7 5.6L4 15.5M4 20v-4.5h4.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          {frequencyLabel(contract.maintenanceFrequency)}
                        </span>
                      </td>}
                      {show('contractValue') && <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <span className="block text-base font-extrabold tabular-nums text-[#0b3b66]">{formatMoney(contract.contractValue)}</span>
                        {contract.defaultVisitAmount && (
                          <span className="mt-0.5 block text-xs tabular-nums text-slate-500">{formatMoney(contract.defaultVisitAmount)} per visit</span>
                        )}
                      </td>}
                      {show('finalCredit') && <td className={`${TABLE.td} whitespace-nowrap text-right font-semibold tabular-nums text-slate-900`}>{formatMoney(contract.finalCredit)}</td>}
                      {show('visits') && <td className={`${TABLE.td} whitespace-nowrap`}>
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
                      </td>}
                      {canEdit && (
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          <Link to={`/amc/contracts/${contract.id}?tab=documents`} aria-label={`Upload Contract for ${label(contract)}`} className="text-sm font-semibold text-[#1479BD] hover:underline">
                            Upload Contract
                          </Link>
                        </td>
                      )}
                      {show('status') && <td className={TABLE.td}>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <ContractStatusPill status={contract.status} />
                          {contract.isPastValidity && contract.status === 'ACTIVE' && <Pill tone="amber">Validity ended</Pill>}
                        </span>
                      </td>}
                      <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                        <ActionGroup>
                          <ActionLink to={`/amc/contracts/${contract.id}`} label={`View ${label(contract)}`} icon="view" />
                          {canEdit && <ActionButton label={`Edit ${label(contract)}`} icon="edit" onClick={() => setDialog({ kind: 'edit', contract })} />}
                          {canDelete && (
                            <ActionButton
                              danger
                              label={`Delete ${label(contract)}`}
                              icon="delete"
                              disabled={remove.isPending && remove.variables?.id === contract.id}
                              onClick={() => {
                                remove.reset()
                                setDialog({ kind: 'delete', contract })
                              }}
                            />
                          )}
                        </ActionGroup>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {data.totals && (show('contractValue') || show('finalCredit')) && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold text-slate-900">
                      <th scope="row" colSpan={leadingColumns} className={`${TABLE.td} text-right`}>
                        Filtered Total ({data.total} {data.total === 1 ? 'contract' : 'contracts'})
                      </th>
                      {show('contractValue') && <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(data.totals.contractValue)}</td>}
                      {show('finalCredit') && <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(data.totals.finalCredit)}</td>}
                      <td colSpan={trailingColumns} className={TABLE.td} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>

      {dialog.kind === 'delete' && (
        <ConfirmDialog
          title="Move contract to the Recycle Bin"
          message={
            <>
              Move the contract for <strong>{label(dialog.contract)}</strong> to the Recycle Bin?
              <span className="mt-2 block text-sm">
                It leaves AMC Contracts, schedules, the calendar, Accounts and the dashboard figures. Nothing is removed: its services, service reports,
                quotations, invoices, documents and history are kept, and Super Admin can restore it from Administration &gt; Recycle Bin.
              </span>
            </>
          }
          confirmLabel="Move to Recycle Bin"
          danger
          loading={remove.isPending}
          error={remove.isError ? errorMessage(remove.error) : null}
          onConfirm={() => remove.mutate(dialog.contract)}
          onCancel={() => {
            remove.reset()
            closeDialog()
          }}
        />
      )}
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
