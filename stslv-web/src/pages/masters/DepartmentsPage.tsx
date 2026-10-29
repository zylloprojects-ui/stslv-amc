import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState } from 'react'
import { useAuth } from '../../auth/context'
import { ActionButton, ActionGroup } from '../../components/IconActions'
import { ExportButtons } from '../../components/ExportButtons'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { ColumnsMenu, type ColumnOption } from '../clients/ColumnsMenu'
import { DepartmentFormModal, DisableDepartmentModal, LinkedEngineersModal, type DepartmentRecord } from './departmentDialogs'
import { isFeatureUnavailable, type MasterList } from './masterTypes'

// Departments (migration 0070): the team a sales engineer belongs to. An
// engineer refers to a department by id, so editing its code or name never
// breaks the link. A disabled department stays on the engineers already in it
// but is not offered for new assignments. Departments are never deleted.

type StatusFilter = 'active' | 'inactive' | 'all'
type StatusValue = 'active' | 'inactive'

// The stored flag in words. Archived needs a database update (not built).
const STATUS_LABELS: Record<StatusValue, string> = { active: 'Active', inactive: 'Disabled' }

// The list's order, as the API's sort and direction. Name is the API's default: ties fall back to the code.
const SORTS: Record<string, { label: string; sort?: string; direction: 'asc' | 'desc' }> = {
  name: { label: 'Name (A–Z)', direction: 'asc' },
  'name-desc': { label: 'Name (Z–A)', sort: 'name', direction: 'desc' },
  'code-asc': { label: 'Code (A–Z)', sort: 'code', direction: 'asc' },
  'code-desc': { label: 'Code (Z–A)', sort: 'code', direction: 'desc' },
  'engineers-desc': { label: 'Most engineers', sort: 'engineers', direction: 'desc' },
  'created-desc': { label: 'Newest first', sort: 'createdAt', direction: 'desc' },
}

const PAGE_SIZE = 25

// The columns a user may hide. The name always shows, so every row stays identifiable.
type ColumnKey = 'code' | 'status' | 'engineers'
const COLUMN_OPTIONS: ColumnOption<ColumnKey>[] = [
  { key: 'code', label: 'Code' },
  { key: 'status', label: 'Status' },
  { key: 'engineers', label: 'Linked engineers' },
]

// Remembered in this browser only. Storage may be blocked; the choice then lasts for this visit.
const COLUMNS_KEY = 'stslev.departments.hidden-columns'

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
  | { kind: 'edit'; department: DepartmentRecord }
  | { kind: 'engineers'; department: DepartmentRecord }
  | { kind: 'disable'; department: DepartmentRecord }
  | { kind: 'reactivate'; department: DepartmentRecord }

export function DepartmentsPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const searchId = useId()
  const statusId = useId()
  const sortId = useId()

  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sortKey, setSortKey] = useState('name')
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

  const order = SORTS[sortKey] ?? SORTS.name

  // The list's filters and order, shared by the list and its export.
  const filterParams = () => {
    const params = new URLSearchParams({ status, direction: order.direction })
    if (order.sort) params.set('sort', order.sort)
    if (search) params.set('search', search)
    return params
  }

  const list = useQuery({
    queryKey: ['masters', 'departments', 'list', { search, status, sortKey, page }],
    queryFn: () => {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      return api.get<MasterList<DepartmentRecord>>(`/masters/departments?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
    retry: false,
  })

  // Applies a status. The only change a row can ask for is the opposite of the stored status.
  const toggle = useMutation({
    mutationFn: (department: DepartmentRecord) => api.post<DepartmentRecord>(`/masters/departments/${department.id}/status`, { isActive: !department.isActive }),
    onMutate: () => setNotice(null),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      setDialog({ kind: 'none' })
      setNotice(
        saved.isActive
          ? `${saved.name} is now Active and can be chosen for sales engineers again.`
          : `${saved.name} is now Disabled. Engineers already in it keep it; it is no longer offered for new assignments.`,
      )
    },
  })

  // A status change from the row icon is confirmed first; disabling also shows the linked engineers.
  const apply = (department: DepartmentRecord) => {
    toggle.reset()
    setDialog({ kind: department.isActive ? 'disable' : 'reactivate', department })
  }

  const cancelDisable = () => {
    setDialog({ kind: 'none' })
    toggle.reset()
  }

  const canCreate = auth.can('DEPARTMENTS', 'CREATE')
  const canEdit = auth.can('DEPARTMENTS', 'EDIT')
  const canExport = auth.can('DEPARTMENTS', 'EXPORT')
  const closeDialog = () => setDialog({ kind: 'none' })

  const unavailable = list.isError && isFeatureUnavailable(list.error)
  const data = list.data
  const filtered = search !== '' || status !== 'all'

  return (
    <>
      <PageHeader
        title="Departments"
        description="The teams sales engineers belong to. Only active departments are offered for engineer assignments; disabling one never moves the engineers already in it. Not the same as user roles, which are managed in Roles & Permissions."
        actions={canCreate && !unavailable && <Button onClick={() => setDialog({ kind: 'create' })}>Add Department</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}
      {toggle.isError && dialog.kind !== 'disable' && dialog.kind !== 'reactivate' && (
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
            <Alert tone="info">Database update required: Departments needs migration 0070, which has not been applied to this database yet.</Alert>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h2 className="text-base font-semibold text-slate-900">Department list</h2>
                  <p className="text-sm text-slate-500" aria-live="polite">
                    {data ? (
                      <>
                        <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {filtered ? 'matching ' : ''}
                        {data.total === 1 ? 'department' : 'departments'}
                      </>
                    ) : (
                      'Loading…'
                    )}
                  </p>
                </div>
                {canExport && (
                  <ExportButtons what="departments" fileStem="departments" size="sm" path={(format) => `/masters/departments/export?${filterParams().toString()}&format=${format}`} onError={setExportError} />
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

            {list.isPending && <Spinner label="Loading departments" />}

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
                title={filtered ? 'No departments match your search' : 'No departments yet'}
                description={filtered ? 'Try a different search or status filter.' : 'Departments you add here can be chosen for sales engineers, for example AMC — Annual Maintenance Contract operations.'}
                action={!filtered && canCreate ? <Button onClick={() => setDialog({ kind: 'create' })}>Add Department</Button> : undefined}
              />
            )}

            {data && data.items.length > 0 && (
              <>
                <TableScroll label="Departments">
                  <table className={TABLE.table}>
                    <caption className="sr-only">Departments</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={TABLE.snHead}>
                          #
                        </th>
                        <th scope="col" className={TABLE.th}>
                          Department
                        </th>
                        {show('code') && (
                          <th scope="col" className={TABLE.th}>
                            Code
                          </th>
                        )}
                        {show('status') && (
                          <th scope="col" className={TABLE.th}>
                            Status
                          </th>
                        )}
                        {show('engineers') && (
                          <th scope="col" className={`${TABLE.th} text-right`}>
                            Linked engineers
                          </th>
                        )}
                        <th scope="col" className={`${TABLE.th} pr-5 text-right`}>
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.items.map((department, index) => (
                        <tr key={department.id} className={`${TABLE.row} hover:shadow-[inset_3px_0_0_#1479BD]`}>
                          <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                          <td className={`${TABLE.td} min-w-56`}>
                            <span className={`block font-semibold leading-snug ${department.isActive ? 'text-slate-900' : 'text-slate-500'}`}>{department.name}</span>
                            {department.description && <span className="mt-0.5 block max-w-md break-words text-xs text-slate-500">{department.description}</span>}
                          </td>
                          {show('code') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs font-semibold text-slate-600`}>{department.code}</td>}
                          {show('status') && (
                            <td className={`${TABLE.td} whitespace-nowrap`}>
                              <Badge tone={department.isActive ? 'green' : 'slate'}>{STATUS_LABELS[department.isActive ? 'active' : 'inactive']}</Badge>
                            </td>
                          )}
                          {show('engineers') && (
                            <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>
                              {department.engineerCount > 0 ? (
                                <button
                                  type="button"
                                  onClick={() => setDialog({ kind: 'engineers', department })}
                                  aria-label={`View the ${department.engineerCount} sales ${department.engineerCount === 1 ? 'engineer' : 'engineers'} in ${department.name}`}
                                  className="font-semibold text-[#1479BD] hover:underline"
                                >
                                  {department.engineerCount}
                                </button>
                              ) : (
                                department.engineerCount
                              )}
                            </td>
                          )}
                          <td className={`${TABLE.td} whitespace-nowrap pr-5 text-right`}>
                            {canEdit && (
                              <ActionGroup>
                                <ActionButton label={`Edit ${department.name}`} icon="edit" onClick={() => setDialog({ kind: 'edit', department })} />
                                <ActionButton
                                  danger={department.isActive}
                                  label={`${department.isActive ? 'Deactivate' : 'Reactivate'} ${department.name}`}
                                  icon={department.isActive ? 'deactivate' : 'reactivate'}
                                  disabled={toggle.isPending && toggle.variables?.id === department.id}
                                  onClick={() => apply(department)}
                                />
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
        <DepartmentFormModal
          department={dialog.kind === 'edit' ? dialog.department : null}
          onClose={closeDialog}
          onSaved={(message) => {
            setNotice(message)
            closeDialog()
          }}
        />
      )}

      {dialog.kind === 'disable' && (
        <DisableDepartmentModal
          department={dialog.department}
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(dialog.department)}
          onCancel={cancelDisable}
          onViewEngineers={() => {
            setDialog({ kind: 'engineers', department: dialog.department })
          }}
        />
      )}

      {dialog.kind === 'reactivate' && (
        <ConfirmDialog
          title="Reactivate department"
          message={`${dialog.department.name} can be chosen for sales engineers again.`}
          confirmLabel="Reactivate"
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(dialog.department)}
          onCancel={cancelDisable}
        />
      )}

      {dialog.kind === 'engineers' && <LinkedEngineersModal department={dialog.department} onClose={closeDialog} />}
    </>
  )
}
