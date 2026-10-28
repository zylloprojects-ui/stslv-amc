import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useAuth } from '../../auth/context'
import { ActionButton, ActionGroup } from '../../components/IconActions'
import { ExportButtons } from '../../components/ExportButtons'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { ColumnsMenu, type ColumnOption } from '../clients/ColumnsMenu'
import { FrequencyContractsModal, FrequencyFormModal, FrequencyStatusWarning } from './maintenanceFrequencyDialogs'
import { FREQUENCY_STATUS_LABELS, type FrequencyStatus, type MaintenanceFrequencyRule } from './maintenanceFrequencyTypes'
import { isFeatureUnavailable, type MasterList } from './masterTypes'

// Maintenance Frequencies (migration 0076): the scheduling rules an AMC
// contract's frequency refers to. A frequency is never deleted. Once a contract
// uses it, its code and rule are locked; disabling or archiving it keeps it on
// the contracts that use it and never changes a visit, but stops it being
// offered for new contracts.

type StatusFilter = 'current' | FrequencyStatus | 'all'

const STATUS_FILTERS: Record<StatusFilter, string> = {
  current: 'Active and disabled',
  active: 'Active',
  disabled: 'Disabled',
  archived: 'Archived',
  all: 'All',
}

const STATUS_TONES: Record<FrequencyStatus, 'green' | 'slate' | 'amber'> = { active: 'green', disabled: 'slate', archived: 'amber' }

// The list's order, as the API's sort and direction. Sort order is the API's default.
const SORTS: Record<string, { label: string; sort?: string; direction: 'asc' | 'desc' }> = {
  order: { label: 'Sort order', direction: 'asc' },
  'name-asc': { label: 'Name (A–Z)', sort: 'name', direction: 'asc' },
  'name-desc': { label: 'Name (Z–A)', sort: 'name', direction: 'desc' },
  'code-asc': { label: 'Internal code (A–Z)', sort: 'code', direction: 'asc' },
  'prefix-asc': { label: 'Prefix (A–Z)', sort: 'codePrefix', direction: 'asc' },
  'interval-asc': { label: 'Interval (shortest first)', sort: 'intervalMonths', direction: 'asc' },
  'active-desc': { label: 'Most active contracts', sort: 'activeContracts', direction: 'desc' },
  'created-desc': { label: 'Newest first', sort: 'createdAt', direction: 'desc' },
}

const PAGE_SIZE = 25

// The columns a user may hide. The name always shows, so every row stays identifiable.
type ColumnKey = 'code' | 'rule' | 'services' | 'interval' | 'prefix' | 'sortOrder' | 'status' | 'activeContracts' | 'contracts'
const COLUMN_OPTIONS: ColumnOption<ColumnKey>[] = [
  { key: 'code', label: 'Internal code' },
  { key: 'rule', label: 'Rule' },
  { key: 'services', label: 'Services per year' },
  { key: 'interval', label: 'Interval' },
  { key: 'prefix', label: 'Prefix' },
  { key: 'sortOrder', label: 'Sort order' },
  { key: 'status', label: 'Status' },
  { key: 'activeContracts', label: 'Active AMC contracts' },
  { key: 'contracts', label: 'Total AMC contracts' },
]

// Remembered in this browser only. Storage may be blocked; the choice then lasts for this visit.
const COLUMNS_KEY = 'stslev.maintenance-frequencies.hidden-columns'

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
    // Not remembered; the choice still applies on this page.
  }
}

const FIELD = 'rounded-lg border border-slate-300 bg-white text-sm shadow-sm transition focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60'
const LABEL = 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600'

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; frequency: MaintenanceFrequencyRule }
  | { kind: 'contracts'; frequency: MaintenanceFrequencyRule }
  | { kind: 'confirm-status'; frequency: MaintenanceFrequencyRule; status: Exclude<FrequencyStatus, 'active'> }

function ContractCount({ count, label, onOpen }: { count: number; label: string; onOpen: (() => void) | null }) {
  return count > 0 && onOpen ? (
    <button type="button" onClick={onOpen} aria-label={label} className="font-semibold text-[#1479BD] hover:underline">
      {count}
    </button>
  ) : (
    <>{count}</>
  )
}

export function MaintenanceFrequenciesPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const searchId = useId()
  const statusId = useId()
  const sortId = useId()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('current')
  const [sortKey, setSortKey] = useState('order')
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
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

  const order = SORTS[sortKey] ?? SORTS.order

  // The list's filters and order, shared by the list and its export.
  const filterParams = () => {
    const params = new URLSearchParams({ status, direction: order.direction })
    if (order.sort) params.set('sort', order.sort)
    if (search) params.set('search', search)
    return params
  }

  const list = useQuery({
    queryKey: ['masters', 'maintenance-frequencies', 'list', { search, status, sortKey, page }],
    queryFn: () => {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      return api.get<MasterList<MaintenanceFrequencyRule>>(`/masters/maintenance-frequencies?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
    retry: false,
  })

  const changeStatus = useMutation({
    mutationFn: ({ frequency, status: next, confirm }: { frequency: MaintenanceFrequencyRule; status: FrequencyStatus; confirm: boolean }) =>
      api.post<MaintenanceFrequencyRule>(`/masters/maintenance-frequencies/${frequency.id}/status`, { status: next, ...(confirm ? { confirm: true } : {}) }),
    onMutate: () => setNotice(null),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      setDialog({ kind: 'none' })
      setNotice(
        `${saved.name} is now ${FREQUENCY_STATUS_LABELS[saved.status]}.${saved.status === 'active' ? '' : ' Contracts that use it keep it and their visits are unchanged; it is no longer offered for new contracts.'}`,
      )
    },
    onError: (error, variables) => {
      // The counts changed since the list loaded: active contracts now use it, so ask first.
      if (!variables.confirm && variables.status !== 'active' && error instanceof ApiError && error.details.some((detail) => detail.field === 'confirm')) {
        setDialog({ kind: 'confirm-status', frequency: variables.frequency, status: variables.status })
        changeStatus.reset()
      }
    },
  })

  const applyStatus = (frequency: MaintenanceFrequencyRule, next: FrequencyStatus) => {
    if (next !== 'active' && frequency.activeContractCount > 0) {
      setDialog({ kind: 'confirm-status', frequency, status: next })
      return
    }
    changeStatus.mutate({ frequency, status: next, confirm: false })
  }

  const canCreate = auth.can('SETTINGS', 'CREATE')
  const canEdit = auth.can('SETTINGS', 'EDIT')
  const canExport = auth.can('SETTINGS', 'EXPORT')
  const canViewContracts = auth.can('AMC_CONTRACTS', 'VIEW')
  const closeDialog = () => setDialog({ kind: 'none' })

  const unavailable = list.isError && isFeatureUnavailable(list.error)
  const data = list.data
  const filtered = search !== '' || status !== 'current'
  const statusError = changeStatus.isError && dialog.kind !== 'confirm-status' ? errorMessage(changeStatus.error) : null

  return (
    <>
      <PageHeader
        title="Maintenance Frequencies"
        description="The scheduling rules AMC contracts use. Only active frequencies are offered for new contracts; disabling or archiving one never changes the contracts or visits that already use it."
        actions={canCreate && !unavailable && <Button onClick={() => setDialog({ kind: 'create' })}>Add Frequency</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}
      {statusError && (
        <div className="mb-4">
          <Alert onDismiss={() => changeStatus.reset()}>{statusError}</Alert>
        </div>
      )}
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        {unavailable ? (
          <div className="p-5">
            <Alert tone="info">Database update required: Maintenance Frequencies needs migration 0076, which has not been applied to this database yet.</Alert>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h2 className="text-base font-semibold text-slate-900">Frequency list</h2>
                  <p className="text-sm text-slate-500" aria-live="polite">
                    {data ? (
                      <>
                        <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {filtered ? 'matching ' : ''}
                        {data.total === 1 ? 'frequency' : 'frequencies'}
                      </>
                    ) : (
                      'Loading…'
                    )}
                  </p>
                </div>
                {canExport && (
                  <ExportButtons
                    what="maintenance frequencies"
                    fileStem="maintenance-frequencies"
                    size="sm"
                    path={(format) => `/masters/maintenance-frequencies/export?${filterParams().toString()}&format=${format}`}
                    onError={setExportError}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-end gap-4 p-4 sm:p-5">
                <div className="min-w-56 flex-1">
                  <label htmlFor={searchId} className={LABEL}>
                    Search
                  </label>
                  <input
                    id={searchId}
                    type="search"
                    value={searchInput}
                    onChange={(event) => setSearchInput(event.target.value)}
                    placeholder="Name, internal code or prefix"
                    className={`block w-full px-3 py-2.5 placeholder:text-slate-500 ${FIELD}`}
                  />
                </div>
                <div>
                  <label htmlFor={statusId} className={LABEL}>
                    Status
                  </label>
                  <select
                    id={statusId}
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value as StatusFilter)
                      setPage(1)
                    }}
                    className={`block px-3 py-2.5 ${FIELD}`}
                  >
                    {Object.entries(STATUS_FILTERS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={sortId} className={LABEL}>
                    Sort
                  </label>
                  <select
                    id={sortId}
                    value={sortKey}
                    onChange={(event) => {
                      setSortKey(event.target.value)
                      setPage(1)
                    }}
                    className={`block px-3 py-2.5 ${FIELD}`}
                  >
                    {Object.entries(SORTS).map(([key, option]) => (
                      <option key={key} value={key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="sm:ml-auto">
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
            </div>

            {list.isPending && <Spinner label="Loading maintenance frequencies" />}

            {list.isError && (
              <div className="p-4">
                <Alert>
                  {errorMessage(list.error)}{' '}
                  <button type="button" className="font-medium underline" onClick={() => void list.refetch()}>
                    Try again
                  </button>
                </Alert>
              </div>
            )}

            {data && data.items.length === 0 && (
              <EmptyState
                title={filtered ? 'No frequencies match your search' : 'No maintenance frequencies yet'}
                description={filtered ? 'Try a different search or status filter.' : 'Frequencies you add here set how often contract visits are scheduled, for example Quarterly — 4 services, every 3 months.'}
                action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>Add Frequency</Button> : undefined}
              />
            )}

            {data && data.items.length > 0 && (
              <>
                <TableScroll label="Maintenance frequencies">
                  <table className={TABLE.table}>
                    <caption className="sr-only">Maintenance frequencies</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={TABLE.snHead}>
                          #
                        </th>
                        <th scope="col" className={TABLE.th}>
                          Frequency
                        </th>
                        {show('code') && (
                          <th scope="col" className={TABLE.th}>
                            Internal code
                          </th>
                        )}
                        {show('rule') && (
                          <th scope="col" className={TABLE.th}>
                            Rule
                          </th>
                        )}
                        {show('services') && (
                          <th scope="col" className={`${TABLE.th} text-right`}>
                            Services / year
                          </th>
                        )}
                        {show('interval') && (
                          <th scope="col" className={`${TABLE.th} text-right`}>
                            Interval
                          </th>
                        )}
                        {show('prefix') && (
                          <th scope="col" className={TABLE.th}>
                            Prefix
                          </th>
                        )}
                        {show('sortOrder') && (
                          <th scope="col" className={`${TABLE.th} text-right`}>
                            Sort order
                          </th>
                        )}
                        {show('status') && (
                          <th scope="col" className={TABLE.th}>
                            Status
                          </th>
                        )}
                        {show('activeContracts') && (
                          <th scope="col" className={`${TABLE.th} text-right`}>
                            Active AMC
                          </th>
                        )}
                        {show('contracts') && (
                          <th scope="col" className={`${TABLE.th} text-right`}>
                            Total AMC
                          </th>
                        )}
                        <th scope="col" className={`${TABLE.th} pr-5 text-right`}>
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.items.map((frequency, index) => (
                        <tr key={frequency.id} className={`${TABLE.row} hover:shadow-[inset_3px_0_0_#1479BD]`}>
                          <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                          <td className={`${TABLE.td} min-w-56`}>
                            <span className={`block font-semibold leading-snug ${frequency.isActive ? 'text-slate-900' : 'text-slate-500'}`}>{frequency.name}</span>
                            <span className="mt-0.5 block text-xs text-slate-500">{frequency.ruleSummary}</span>
                            {!frequency.engineSupported && <span className="mt-0.5 block text-xs font-medium text-amber-700">Schedule engine support pending</span>}
                          </td>
                          {show('code') && (
                            <td className={`${TABLE.td} whitespace-nowrap`}>
                              <span className="font-mono text-xs font-semibold text-slate-600">{frequency.code}</span>
                              {frequency.ruleLocked && <span className="mt-0.5 block text-xs text-slate-500">Rule locked: in use</span>}
                            </td>
                          )}
                          {show('rule') && (
                            <td className={TABLE.td}>
                              <Badge tone={frequency.isCustom ? 'blue' : 'slate'}>{frequency.isCustom ? 'Custom months' : 'Fixed interval'}</Badge>
                            </td>
                          )}
                          {show('services') && <td className={`${TABLE.td} text-right tabular-nums`}>{frequency.serviceCount ?? '—'}</td>}
                          {show('interval') && (
                            <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>
                              {frequency.intervalMonths === null ? '—' : `${frequency.intervalMonths} ${frequency.intervalMonths === 1 ? 'month' : 'months'}`}
                            </td>
                          )}
                          {show('prefix') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs font-semibold text-slate-600`}>{frequency.codePrefix}</td>}
                          {show('sortOrder') && <td className={`${TABLE.td} text-right tabular-nums`}>{frequency.sortOrder}</td>}
                          {show('status') && (
                            <td className={`${TABLE.td} whitespace-nowrap`}>
                              <Badge tone={STATUS_TONES[frequency.status]}>{FREQUENCY_STATUS_LABELS[frequency.status]}</Badge>
                            </td>
                          )}
                          {show('activeContracts') && (
                            <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>
                              <ContractCount
                                count={frequency.activeContractCount}
                                label={`View the AMC contracts using ${frequency.name} (${frequency.activeContractCount} active)`}
                                onOpen={canViewContracts ? () => setDialog({ kind: 'contracts', frequency }) : null}
                              />
                            </td>
                          )}
                          {show('contracts') && (
                            <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>
                              <ContractCount
                                count={frequency.contractCount}
                                label={`View the ${frequency.contractCount} AMC ${frequency.contractCount === 1 ? 'contract' : 'contracts'} using ${frequency.name}`}
                                onOpen={canViewContracts ? () => setDialog({ kind: 'contracts', frequency }) : null}
                              />
                            </td>
                          )}
                          <td className={`${TABLE.td} whitespace-nowrap pr-5 text-right`}>
                            {canEdit && (
                              <ActionGroup>
                                <ActionButton label={`Edit ${frequency.name}`} icon="edit" onClick={() => setDialog({ kind: 'edit', frequency })} />
                                {frequency.status === 'active' ? (
                                  <ActionButton
                                    danger
                                    label={`Deactivate ${frequency.name}`}
                                    icon="deactivate"
                                    disabled={changeStatus.isPending && changeStatus.variables?.frequency.id === frequency.id}
                                    onClick={() => applyStatus(frequency, 'disabled')}
                                  />
                                ) : (
                                  <ActionButton
                                    label={`Reactivate ${frequency.name}`}
                                    icon="reactivate"
                                    disabled={(!frequency.engineSupported) || (changeStatus.isPending && changeStatus.variables?.frequency.id === frequency.id)}
                                    onClick={() => applyStatus(frequency, 'active')}
                                  />
                                )}
                                {frequency.status !== 'archived' && (
                                  <ActionButton
                                    danger
                                    label={`Archive ${frequency.name}`}
                                    icon="archive"
                                    disabled={changeStatus.isPending && changeStatus.variables?.frequency.id === frequency.id}
                                    onClick={() => applyStatus(frequency, 'archived')}
                                  />
                                )}
                              </ActionGroup>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>

                <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage} />
              </>
            )}
          </>
        )}
      </div>

      {(dialog.kind === 'create' || dialog.kind === 'edit') && (
        <FrequencyFormModal
          frequency={dialog.kind === 'edit' ? dialog.frequency : null}
          onClose={closeDialog}
          onSaved={(message) => {
            setNotice(message)
            closeDialog()
          }}
        />
      )}

      {dialog.kind === 'contracts' && <FrequencyContractsModal frequency={dialog.frequency} onClose={closeDialog} />}

      {dialog.kind === 'confirm-status' && (
        <FrequencyStatusWarning
          frequency={dialog.frequency}
          status={dialog.status}
          loading={changeStatus.isPending}
          error={changeStatus.isError ? errorMessage(changeStatus.error) : null}
          onConfirm={() => changeStatus.mutate({ frequency: dialog.frequency, status: dialog.status, confirm: true })}
          onCancel={() => {
            changeStatus.reset()
            closeDialog()
          }}
        />
      )}
    </>
  )
}
