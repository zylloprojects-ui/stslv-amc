import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { ColumnsMenu, type ColumnOption } from '../clients/ColumnsMenu'
import { AssignmentWarning, SalesEngineerFormModal } from './SalesEngineerFormModal'
import { ENGINEER_STATUS_LABELS, isFeatureUnavailable, type Department, type MasterList, type EngineerRecord } from './masterTypes'

// Master Data Center → Sales Engineers: search, filter, sort, page and export;
// add, view (Engineer 360), edit and disable. Engineers are never deleted, so
// the AMC contracts they are on stay intact.

type StatusFilter = 'active' | 'inactive' | 'all'
type StatusValue = 'active' | 'inactive'

const PAGE_SIZE = 25

// The list's sort choices, as the API's sort and direction.
const SORTS: Record<string, { label: string; sort: string; direction: 'asc' | 'desc' }> = {
  'name-asc': { label: 'Name (A–Z)', sort: 'name', direction: 'asc' },
  'name-desc': { label: 'Name (Z–A)', sort: 'name', direction: 'desc' },
  'code-asc': { label: 'Engineer code', sort: 'code', direction: 'asc' },
  'employee-asc': { label: 'Employee no.', sort: 'employeeNo', direction: 'asc' },
  'department-asc': { label: 'Department', sort: 'department', direction: 'asc' },
  'created-desc': { label: 'Newest first', sort: 'createdAt', direction: 'desc' },
  'updated-desc': { label: 'Recently updated', sort: 'updatedAt', direction: 'desc' },
}

// The columns a user may hide. Engineer name always shows, so every row stays identifiable.
type ColumnKey = 'code' | 'employeeNo' | 'department' | 'email' | 'phone' | 'user' | 'status'
const COLUMN_OPTIONS: ColumnOption<ColumnKey>[] = [
  { key: 'code', label: 'Engineer code' },
  { key: 'employeeNo', label: 'Employee no.' },
  { key: 'department', label: 'Department' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'user', label: 'User account' },
  { key: 'status', label: 'Status' },
]

// The hidden columns, remembered in this browser only. Storage may be blocked; the choice then lasts for this visit.
const COLUMNS_KEY = 'stslev.sales-engineers.hidden-columns'

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
const ICON_BUTTON =
  'inline-flex h-8 w-9 items-center justify-center text-slate-500 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10'
const NONE = <span className="text-slate-400">—</span>

const ICONS = {
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  edit: <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14 8l3 3" strokeLinecap="round" strokeLinejoin="round" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" strokeLinecap="round" />
    </>
  ),
}

function Icon({ name, className = 'h-[18px] w-[18px]' }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

export function EngineerStatusBadge({ active }: { active: boolean }) {
  return <Badge tone={active ? 'green' : 'slate'}>{ENGINEER_STATUS_LABELS[active ? 'active' : 'inactive']}</Badge>
}

/**
 * The status of one row as a select. Choosing a different status does nothing
 * by itself: Apply saves it (after a warning when an engineer with active
 * contracts is disabled), Cancel puts the select back.
 */
function StatusCell({ engineer, busy, onApply }: { engineer: EngineerRecord; busy: boolean; onApply: (engineer: EngineerRecord) => void }) {
  // The list keys this cell by the stored status, so a saved change starts it afresh.
  const current: StatusValue = engineer.isActive ? 'active' : 'inactive'
  const [chosen, setChosen] = useState<StatusValue>(current)
  const changed = chosen !== current

  return (
    <div className="flex items-center gap-1.5">
      <select
        aria-label={`Status of ${engineer.name}`}
        value={chosen}
        disabled={busy}
        onChange={(event) => setChosen(event.target.value as StatusValue)}
        className={`rounded-lg border px-2 py-1.5 text-xs font-semibold shadow-sm focus:border-[#1479BD] focus:outline-none focus:ring-4 focus:ring-sky-200/60 ${
          chosen === 'active' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-slate-300 bg-slate-100 text-slate-700'
        }`}
      >
        <option value="active">{ENGINEER_STATUS_LABELS.active}</option>
        <option value="inactive">{ENGINEER_STATUS_LABELS.inactive}</option>
      </select>
      {changed && (
        <>
          <Button size="sm" loading={busy} onClick={() => onApply(engineer)} aria-label={`Apply ${ENGINEER_STATUS_LABELS[chosen]} to ${engineer.name}`}>
            Apply
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => setChosen(current)} aria-label={`Keep ${engineer.name} ${ENGINEER_STATUS_LABELS[current]}`}>
            Cancel
          </Button>
        </>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId()

  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      {children(id)}
    </div>
  )
}

export function SalesEngineersPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusFilter>('active')
  const [departmentId, setDepartmentId] = useState('')
  const [sortKey, setSortKey] = useState('name-asc')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<{ engineer: EngineerRecord | null } | null>(null)
  const [disabling, setDisabling] = useState<EngineerRecord | null>(null)
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

  const order = SORTS[sortKey] ?? { sort: 'name', direction: 'asc' as const }

  // The list's filters and order, shared by the list and its export.
  const filterParams = () => {
    const params = new URLSearchParams({ status, sort: order.sort, direction: order.direction })
    if (search) params.set('search', search)
    if (departmentId) params.set('departmentId', departmentId)
    return params
  }

  const list = useQuery({
    queryKey: ['masters', 'sales-engineers', 'list', { search, status, departmentId, sortKey, page }],
    queryFn: () => {
      const params = filterParams()
      params.set('page', String(page))
      params.set('pageSize', String(PAGE_SIZE))
      return api.get<MasterList<EngineerRecord>>(`/masters/sales-engineers?${params.toString()}`)
    },
    placeholderData: keepPreviousData,
    retry: false,
  })
  // Every department, inactive ones too: an engineer may still belong to one.
  const departments = useQuery({
    queryKey: ['masters', 'departments', 'filter'],
    queryFn: () => api.get<MasterList<Department>>('/masters/departments?status=all&pageSize=100'),
    retry: false,
  })

  // Applies the status chosen in a row. The only change a row can ask for is the opposite of the stored status.
  const toggle = useMutation({
    mutationFn: (engineer: EngineerRecord) => api.post<EngineerRecord>(`/masters/sales-engineers/${engineer.id}/status`, { isActive: !engineer.isActive }),
    onMutate: () => setNotice(null),
    onSuccess: async (saved) => {
      setDisabling(null)
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      setNotice(`${saved.name} is now ${ENGINEER_STATUS_LABELS[saved.isActive ? 'active' : 'inactive']}.`)
    },
  })

  // Disabling an engineer who still has active contracts asks first; anything else applies at once.
  const apply = (engineer: EngineerRecord) => {
    if (engineer.isActive && engineer.activeContractCount > 0) setDisabling(engineer)
    else toggle.mutate(engineer)
  }

  const canCreate = auth.can('SETTINGS', 'CREATE')
  const canEdit = auth.can('SETTINGS', 'EDIT')
  const canExport = auth.can('SETTINGS', 'EXPORT')
  const unavailable = list.isError && isFeatureUnavailable(list.error)
  const data = list.data
  const filtered = search !== '' || status !== 'active' || departmentId !== ''
  const departmentList = departments.data?.items ?? []

  return (
    <>
      <PageHeader
        title="Sales Engineers"
        description="Engineers assigned to AMC contracts. Engineers are disabled, never deleted, so the contracts they are on stay intact."
        actions={canCreate && !unavailable && <Button onClick={() => setEditing({ engineer: null })}>Add sales engineer</Button>}
      />

      {notice && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Alert>
        </div>
      )}
      {toggle.isError && !disabling && (
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
            <Alert tone="info">
              Sales engineers need a database update that has not been applied to this database yet (migration 0070). Until then they can be neither listed nor saved; contracts
              keep their typed engineer names.
            </Alert>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-4 sm:px-5">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <h2 className="text-base font-semibold text-slate-900">Engineer directory</h2>
                  <p className="text-sm text-slate-500" aria-live="polite">
                    {data ? (
                      <>
                        <span className="font-semibold tabular-nums text-slate-800">{data.total}</span> {filtered ? 'matching ' : ''}
                        {data.total === 1 ? 'engineer' : 'engineers'}
                      </>
                    ) : (
                      'Loading…'
                    )}
                  </p>
                </div>
                {canExport && (
                  <ExportButtons
                    what="sales engineers"
                    fileStem="sales-engineers"
                    size="sm"
                    path={(format) => `/masters/sales-engineers/export?${filterParams().toString()}&format=${format}`}
                    onError={setExportError}
                  />
                )}
              </div>
              <div className="flex flex-wrap items-end gap-4 p-4 sm:p-5">
                <div className="min-w-56 flex-1">
                  <Field label="Search">
                    {(id) => (
                      <div className="relative">
                        <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
                        <input
                          id={id}
                          type="search"
                          value={searchInput}
                          onChange={(event) => setSearchInput(event.target.value)}
                          placeholder="Name, code, employee no. or email"
                          className={`block w-full py-2.5 pl-10 pr-3 placeholder:text-slate-500 ${FIELD}`}
                        />
                      </div>
                    )}
                  </Field>
                </div>
                <Field label="Status">
                  {(id) => (
                    <select
                      id={id}
                      value={status}
                      onChange={(event) => {
                        setStatus(event.target.value as StatusFilter)
                        setPage(1)
                      }}
                      className={`block px-3 py-2.5 ${FIELD}`}
                    >
                      <option value="active">{ENGINEER_STATUS_LABELS.active}</option>
                      <option value="inactive">{ENGINEER_STATUS_LABELS.inactive}</option>
                      <option value="all">All</option>
                    </select>
                  )}
                </Field>
                <Field label="Department">
                  {(id) => (
                    <select
                      id={id}
                      value={departmentId}
                      onChange={(event) => {
                        setDepartmentId(event.target.value)
                        setPage(1)
                      }}
                      className={`block px-3 py-2.5 ${FIELD}`}
                    >
                      <option value="">All departments</option>
                      {departmentList.map((department) => (
                        <option key={department.id} value={department.id}>
                          {department.code} — {department.name}
                          {department.isActive ? '' : ' (inactive)'}
                        </option>
                      ))}
                      <option value="none">No department</option>
                    </select>
                  )}
                </Field>
                <Field label="Sort">
                  {(id) => (
                    <select
                      id={id}
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
                  )}
                </Field>
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

            {list.isPending && <Spinner label="Loading sales engineers" />}
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
                title={filtered ? 'No sales engineers match your filters' : 'No sales engineers yet'}
                description={
                  filtered ? 'Try a different search, status or department.' : 'Engineers you add here can be assigned to AMC contracts. Each gets an engineer code such as SE-0001.'
                }
                action={!filtered && canCreate ? <Button onClick={() => setEditing({ engineer: null })}>Add sales engineer</Button> : undefined}
              />
            )}

            {data && data.items.length > 0 && (
              <>
                <TableScroll label="Sales engineers">
                  <table className={TABLE.table}>
                    <caption className="sr-only">Sales engineers</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={TABLE.snHead}>
                          #
                        </th>
                        {show('code') && (
                          <th scope="col" className={TABLE.th}>
                            Code
                          </th>
                        )}
                        <th scope="col" className={TABLE.th}>
                          Engineer name
                        </th>
                        {show('employeeNo') && (
                          <th scope="col" className={TABLE.th}>
                            Employee no.
                          </th>
                        )}
                        {show('department') && (
                          <th scope="col" className={TABLE.th}>
                            Department
                          </th>
                        )}
                        {show('email') && (
                          <th scope="col" className={TABLE.th}>
                            Email
                          </th>
                        )}
                        {show('phone') && (
                          <th scope="col" className={TABLE.th}>
                            Phone
                          </th>
                        )}
                        {show('user') && (
                          <th scope="col" className={TABLE.th}>
                            User account
                          </th>
                        )}
                        {show('status') && (
                          <th scope="col" className={TABLE.th}>
                            Status
                          </th>
                        )}
                        <th scope="col" className={`${TABLE.th} pr-5 text-right`}>
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.items.map((engineer, index) => (
                        <tr key={engineer.id} className={`${TABLE.row} hover:shadow-[inset_3px_0_0_#1479BD]`}>
                          <td className={TABLE.sn}>{(data.page - 1) * data.pageSize + index + 1}</td>
                          {show('code') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs font-semibold text-slate-600`}>{engineer.code}</td>}
                          <td className={`${TABLE.td} min-w-48 py-3`}>
                            <Link
                              to={`/master-data/sales-engineers/${engineer.id}`}
                              className={`block max-w-64 break-words text-sm font-semibold leading-snug hover:text-[#1479BD] hover:underline ${engineer.isActive ? 'text-slate-900' : 'text-slate-500'}`}
                            >
                              {engineer.name}
                            </Link>
                            <span className="mt-0.5 block text-xs text-slate-500">
                              {engineer.activeContractCount} active {engineer.activeContractCount === 1 ? 'contract' : 'contracts'}
                            </span>
                          </td>
                          {show('employeeNo') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs`}>{engineer.employeeNo ?? NONE}</td>}
                          {show('department') && <td className={TABLE.td}>{engineer.department ? `${engineer.department.code} — ${engineer.department.name}` : NONE}</td>}
                          {show('email') && (
                            <td className={`${TABLE.td} ${TABLE.text}`}>
                              {engineer.email ? (
                                <a href={`mailto:${engineer.email}`} className="text-sm text-slate-700 [overflow-wrap:anywhere] hover:text-[#1479BD] hover:underline">
                                  {engineer.email}
                                </a>
                              ) : (
                                NONE
                              )}
                            </td>
                          )}
                          {show('phone') && <td className={`${TABLE.td} whitespace-nowrap`}>{engineer.phone ?? NONE}</td>}
                          {show('user') && <td className={TABLE.td}>{engineer.user ? engineer.user.fullName : <span className="text-slate-500">Not linked</span>}</td>}
                          {show('status') && (
                            <td className={`${TABLE.td} whitespace-nowrap`}>
                              {canEdit ? (
                                <StatusCell
                                  key={`${engineer.id}-${engineer.isActive}`}
                                  engineer={engineer}
                                  busy={toggle.isPending && toggle.variables?.id === engineer.id}
                                  onApply={apply}
                                />
                              ) : (
                                <EngineerStatusBadge active={engineer.isActive} />
                              )}
                            </td>
                          )}
                          <td className={`${TABLE.td} whitespace-nowrap pr-5 text-right`}>
                            <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                              <Link to={`/master-data/sales-engineers/${engineer.id}`} aria-label={`View ${engineer.name}`} title={`View ${engineer.name}`} className={ICON_BUTTON}>
                                <Icon name="eye" />
                              </Link>
                              {canEdit && (
                                <button type="button" aria-label={`Edit ${engineer.name}`} title={`Edit ${engineer.name}`} onClick={() => setEditing({ engineer })} className={ICON_BUTTON}>
                                  <Icon name="edit" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
                <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
              </>
            )}
          </>
        )}
      </div>

      {editing && (
        <SalesEngineerFormModal
          engineer={editing.engineer}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setNotice(message)
            setEditing(null)
          }}
        />
      )}
      {disabling && (
        <ConfirmDialog
          title="Disable sales engineer"
          message={<AssignmentWarning engineer={disabling} />}
          confirmLabel="Disable"
          danger
          loading={toggle.isPending}
          error={toggle.isError ? errorMessage(toggle.error) : null}
          onConfirm={() => toggle.mutate(disabling)}
          onCancel={() => {
            toggle.reset()
            setDisabling(null)
          }}
        />
      )}
    </>
  )
}
