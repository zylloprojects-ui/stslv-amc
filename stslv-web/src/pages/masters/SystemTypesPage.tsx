import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, EmptyState, Modal, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { ColumnsMenu, type ColumnOption } from '../clients/ColumnsMenu'
import { MasterFormModal, type AnyRecord } from './MasterDataPage'
import { isFeatureUnavailable, type MasterList, type SystemType } from './masterTypes'
import { DeleteSystemTypeModal, LinkedContractsModal } from './systemTypeDialogs'

// System Types (migration 0070): the classification an AMC contract is linked
// to. A contract refers to its type by id, so editing a type's code or name
// never breaks the link. Disabled types stay on the contracts that use them but
// are not offered for new ones. Only a type no contract uses can be deleted.

type StatusFilter = 'active' | 'inactive' | 'all'
type StatusValue = 'active' | 'inactive'

// The stored flag in words. Archived needs a database update (not built).
const STATUS_LABELS: Record<StatusValue, string> = { active: 'Active', inactive: 'Disabled' }

// The list's order, as the API's sort and direction. Sort order is the API's default: ties fall back to the code.
const SORTS: Record<string, { label: string; sort?: string; direction: 'asc' | 'desc' }> = {
  order: { label: 'Sort order', direction: 'asc' },
  'code-asc': { label: 'Code (A–Z)', sort: 'code', direction: 'asc' },
  'name-asc': { label: 'Name (A–Z)', sort: 'name', direction: 'asc' },
  'name-desc': { label: 'Name (Z–A)', sort: 'name', direction: 'desc' },
  'created-desc': { label: 'Newest first', sort: 'createdAt', direction: 'desc' },
}

const PAGE_SIZE = 25

// The columns a user may hide. The name always shows, so every row stays identifiable.
type ColumnKey = 'code' | 'sortOrder' | 'status' | 'contracts'
const COLUMN_OPTIONS: ColumnOption<ColumnKey>[] = [
  { key: 'code', label: 'Code' },
  { key: 'sortOrder', label: 'Sort order' },
  { key: 'status', label: 'Status' },
  { key: 'contracts', label: 'Linked AMC contracts' },
]

// Remembered in this browser only. Storage may be blocked; the choice then lasts for this visit.
const COLUMNS_KEY = 'stslev.system-types.hidden-columns'

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

/**
 * The status of one row as a select. Choosing a different status does nothing
 * by itself: Apply saves it, Cancel puts the select back.
 */
function StatusCell({ type, busy, onApply }: { type: SystemType; busy: boolean; onApply: (type: SystemType) => void }) {
  // The list keys this cell by the stored status, so a saved change starts it afresh.
  const current: StatusValue = type.isActive ? 'active' : 'inactive'
  const [chosen, setChosen] = useState<StatusValue>(current)
  const changed = chosen !== current

  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={`Status of ${type.name}`}
        value={chosen}
        disabled={busy}
        onChange={(event) => setChosen(event.target.value as StatusValue)}
        className={`rounded-lg border px-2 py-1.5 text-xs font-semibold shadow-sm focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60 ${
          chosen === 'active' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-slate-100 text-slate-700'
        }`}
      >
        <option value="active">{STATUS_LABELS.active}</option>
        <option value="inactive">{STATUS_LABELS.inactive}</option>
      </select>
      {changed && (
        <>
          <Button size="sm" loading={busy} onClick={() => onApply(type)} aria-label={`Apply ${STATUS_LABELS[chosen]} to ${type.name}`}>
            Apply
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setChosen(current)} aria-label={`Keep ${type.name} ${STATUS_LABELS[current]}`}>
            Cancel
          </Button>
        </>
      )}
    </div>
  )
}

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; type: SystemType }
  | { kind: 'contracts'; type: SystemType }
  | { kind: 'delete'; type: SystemType }
  | { kind: 'in-use'; type: SystemType }

export function SystemTypesPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const searchId = useId()
  const statusId = useId()
  const sortId = useId()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
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
    queryKey: ['masters', 'system-types', 'list', { search, status, sortKey, page }],
    queryFn: () => {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      return api.get<MasterList<SystemType>>(`/masters/system-types?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
    retry: false,
  })

  // Applies the status chosen in a row. The only change a row can ask for is the opposite of the stored status.
  const toggle = useMutation({
    mutationFn: (type: SystemType) => api.post<SystemType>(`/masters/system-types/${type.id}/status`, { isActive: !type.isActive }),
    onMutate: () => setNotice(null),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      setNotice(`${saved.name} is now ${STATUS_LABELS[saved.isActive ? 'active' : 'inactive']}.${saved.isActive ? '' : ' Contracts that use it keep it; it is no longer offered for new contracts.'}`)
    },
  })

  const canCreate = auth.can('SETTINGS', 'CREATE')
  const canEdit = auth.can('SETTINGS', 'EDIT')
  const canDelete = auth.can('SETTINGS', 'DELETE')
  const canExport = auth.can('SETTINGS', 'EXPORT')
  const canViewContracts = auth.can('AMC_CONTRACTS', 'VIEW')
  const closeDialog = () => setDialog({ kind: 'none' })

  const unavailable = list.isError && isFeatureUnavailable(list.error)
  const data = list.data
  const filtered = search !== '' || status !== 'all'

  return (
    <>
      <PageHeader
        title="System Types"
        description="The classification of the system an AMC contract covers. Only active types are offered for new contracts; disabling a type never changes the contracts that already use it."
        actions={canCreate && !unavailable && <Button onClick={() => setDialog({ kind: 'create' })}>Add System Type</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}
      {toggle.isError && (
        <div className="mb-4">
          <Alert onDismiss={() => toggle.reset()}>{errorMessage(toggle.error)}</Alert>
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
            <Alert tone="info">Database update required: System Types needs migration 0070, which has not been applied to this database yet.</Alert>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h2 className="text-base font-semibold text-slate-900">System type list</h2>
                  <p className="text-sm text-slate-500" aria-live="polite">
                    {data ? (
                      <>
                        <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {filtered ? 'matching ' : ''}
                        {data.total === 1 ? 'system type' : 'system types'}
                      </>
                    ) : (
                      'Loading…'
                    )}
                  </p>
                </div>
                {canExport && (
                  <ExportButtons what="system types" fileStem="system-types" size="sm" path={(format) => `/masters/system-types/export?${filterParams().toString()}&format=${format}`} onError={setExportError} />
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
                    placeholder="Code, name or description"
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
                    <option value="all">All</option>
                    <option value="active">{STATUS_LABELS.active}</option>
                    <option value="inactive">{STATUS_LABELS.inactive}</option>
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

            {list.isPending && <Spinner label="Loading system types" />}

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
                title={filtered ? 'No system types match your search' : 'No system types yet'}
                description={filtered ? 'Try a different search or status filter.' : 'System types you add here classify AMC contracts, for example FA — Fire Alarm.'}
                action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>Add System Type</Button> : undefined}
              />
            )}

            {data && data.items.length > 0 && (
              <>
                <TableScroll label="System types">
                  <table className={TABLE.table}>
                    <caption className="sr-only">System types</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={TABLE.snHead}>
                          #
                        </th>
                        <th scope="col" className={TABLE.th}>
                          System type
                        </th>
                        {show('code') && (
                          <th scope="col" className={TABLE.th}>
                            Code
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
                        {show('contracts') && (
                          <th scope="col" className={`${TABLE.th} text-right`}>
                            Linked AMC
                          </th>
                        )}
                        <th scope="col" className={`${TABLE.th} pr-5 text-right`}>
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.items.map((type, index) => (
                        <tr key={type.id} className={`${TABLE.row} hover:shadow-[inset_3px_0_0_#1479BD]`}>
                          <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                          <td className={`${TABLE.td} min-w-56`}>
                            <span className={`block font-semibold leading-snug ${type.isActive ? 'text-slate-900' : 'text-slate-500'}`}>{type.name}</span>
                            {type.description && <span className="mt-0.5 block max-w-md break-words text-xs text-slate-500">{type.description}</span>}
                          </td>
                          {show('code') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs font-semibold text-slate-600`}>{type.code}</td>}
                          {show('sortOrder') && <td className={`${TABLE.td} text-right tabular-nums`}>{type.sortOrder}</td>}
                          {show('status') && (
                            <td className={`${TABLE.td} whitespace-nowrap`}>
                              {canEdit ? (
                                <StatusCell key={`${type.id}-${type.isActive}`} type={type} busy={toggle.isPending && toggle.variables?.id === type.id} onApply={(target) => toggle.mutate(target)} />
                              ) : (
                                <Badge tone={type.isActive ? 'green' : 'slate'}>{STATUS_LABELS[type.isActive ? 'active' : 'inactive']}</Badge>
                              )}
                            </td>
                          )}
                          {show('contracts') && (
                            <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>
                              {type.contractCount > 0 && canViewContracts ? (
                                <button
                                  type="button"
                                  onClick={() => setDialog({ kind: 'contracts', type })}
                                  aria-label={`View the ${type.contractCount} AMC ${type.contractCount === 1 ? 'contract' : 'contracts'} using ${type.name}`}
                                  className="font-semibold text-[#1479BD] hover:underline"
                                >
                                  {type.contractCount}
                                </button>
                              ) : (
                                type.contractCount
                              )}
                            </td>
                          )}
                          <td className={`${TABLE.td} whitespace-nowrap pr-5 text-right`}>
                            <span className="inline-flex gap-2">
                              {canEdit && (
                                <Button size="sm" variant="secondary" onClick={() => setDialog({ kind: 'edit', type })} aria-label={`Edit ${type.name}`}>
                                  Edit
                                </Button>
                              )}
                              {canDelete && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setDialog(type.contractCount > 0 ? { kind: 'in-use', type } : { kind: 'delete', type })}
                                  aria-label={`Delete ${type.name}`}
                                >
                                  Delete
                                </Button>
                              )}
                            </span>
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
        <MasterFormModal
          tab="system-types"
          record={dialog.kind === 'edit' ? (dialog.type as AnyRecord) : null}
          onClose={closeDialog}
          onSaved={(message) => {
            setNotice(message)
            closeDialog()
          }}
        />
      )}

      {dialog.kind === 'contracts' && <LinkedContractsModal type={dialog.type} onClose={closeDialog} />}

      {dialog.kind === 'delete' && (
        <DeleteSystemTypeModal
          type={dialog.type}
          onClose={closeDialog}
          onDeleted={(message) => {
            setNotice(message)
            closeDialog()
          }}
        />
      )}

      {dialog.kind === 'in-use' && (
        <Modal
          title="This system type cannot be deleted"
          onClose={closeDialog}
          footer={
            <>
              {canViewContracts && (
                <Button variant="secondary" onClick={() => setDialog({ kind: 'contracts', type: dialog.type })}>
                  View contracts
                </Button>
              )}
              <Button onClick={closeDialog}>Close</Button>
            </>
          }
        >
          <div className="space-y-3 text-sm text-slate-700">
            <p>
              <strong>
                {dialog.type.code} — {dialog.type.name}
              </strong>{' '}
              is used by {dialog.type.contractCount} AMC {dialog.type.contractCount === 1 ? 'contract' : 'contracts'}. Deleting it would remove the classification from {dialog.type.contractCount === 1 ? 'that contract' : 'those contracts'}, so it is not allowed.
            </p>
            <p>
              {dialog.type.isActive
                ? 'Disable it instead, using the Status column: the contracts keep it, and it is no longer offered for new contracts.'
                : 'It is already disabled: the contracts keep it, and it is not offered for new contracts.'}
            </p>
          </div>
        </Modal>
      )}
    </>
  )
}
