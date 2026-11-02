import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, Card, EmptyState, Modal, PageHeader, SelectField, Spinner, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import type { Module } from '../../lib/types'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { isFeatureUnavailable, type Department, type MaintenanceFrequency, type MasterList, type SalesEngineer, type SystemType } from './masterTypes'

// Master lists of the Master Data Center: departments, sales engineers, system
// types and maintenance frequencies. Records are deactivated, never deleted, so
// the contracts that refer to them stay intact.

const PAGE_SIZE = 25

export type Tab = 'sales-engineers' | 'system-types' | 'departments' | 'maintenance-frequencies'

// Sales engineers have their own pages; this page serves the other lists, one route each.
export type ListTab = Exclude<Tab, 'sales-engineers'>

/** The permission module that governs each list (migration 0080). */
const TAB_MODULE: Record<Tab, Module> = {
  'sales-engineers': 'SALES_ENGINEERS',
  'system-types': 'SYSTEM_TYPES',
  departments: 'DEPARTMENTS',
  'maintenance-frequencies': 'MAINTENANCE_FREQUENCIES',
}

interface TabSpec {
  key: Tab
  label: string
  singular: string
  description: string
  /** The migration that creates the list's table. */
  migration: string
  /** False for a fixed list: records can be edited and deactivated, never added. */
  canAdd: boolean
  searchHint: string
}

const ALL_TABS: TabSpec[] = [
  {
    key: 'sales-engineers',
    label: 'Sales Engineers',
    singular: 'sales engineer',
    description: 'Engineers assigned to AMC contracts.',
    migration: '0070',
    canAdd: true,
    searchHint: 'Name, employee no., email or phone',
  },
  {
    key: 'system-types',
    label: 'System Types',
    singular: 'system type',
    description: 'The kinds of system an AMC contract covers. Records are deactivated, never deleted, so the contracts that use them stay intact.',
    migration: '0070',
    canAdd: true,
    searchHint: 'Code or name',
  },
  {
    key: 'maintenance-frequencies',
    label: 'Maintenance Frequencies',
    singular: 'maintenance frequency',
    description:
      'The four scheduling frequencies. Only the label and status can change: the code and interval used by the schedule stay fixed, and existing contracts and their visits are never changed. An inactive frequency is not offered for new contracts.',
    migration: '0075',
    canAdd: false,
    searchHint: 'Code or label',
  },
  {
    key: 'departments',
    label: 'Departments',
    singular: 'department',
    description: 'The departments sales engineers belong to. Not the same as user roles, which are managed in Roles & Permissions.',
    migration: '0070',
    canAdd: true,
    searchHint: 'Code or name',
  },
]

interface FieldSpec {
  name: string
  label: string
  kind: 'text' | 'email' | 'number' | 'textarea' | 'department' | 'user'
  required?: boolean
  hint?: string
}

const FIELDS: Record<Tab, FieldSpec[]> = {
  'sales-engineers': [
    { name: 'name', label: 'Name', kind: 'text', required: true },
    { name: 'employeeNo', label: 'Employee number', kind: 'text' },
    { name: 'email', label: 'Email', kind: 'email' },
    { name: 'phone', label: 'Phone', kind: 'text' },
    { name: 'departmentId', label: 'Department', kind: 'department' },
    { name: 'userId', label: 'Sign-in account', kind: 'user', hint: 'The engineer’s own user account, when they have one.' },
    { name: 'notes', label: 'Notes', kind: 'textarea' },
  ],
  'system-types': [
    { name: 'code', label: 'Code', kind: 'text', required: true, hint: 'A short code, for example FA or CCTV.' },
    { name: 'name', label: 'Name', kind: 'text', required: true },
    { name: 'sortOrder', label: 'Sort order', kind: 'number', hint: 'Lower numbers are listed first.' },
    { name: 'description', label: 'Description', kind: 'textarea' },
  ],
  'maintenance-frequencies': [{ name: 'label', label: 'Label', kind: 'text', required: true, hint: 'How the frequency is shown. Its code and interval never change.' }],
  departments: [
    { name: 'code', label: 'Code', kind: 'text', required: true },
    { name: 'name', label: 'Name', kind: 'text', required: true },
    { name: 'description', label: 'Description', kind: 'textarea' },
  ],
}

export type AnyRecord = (SalesEngineer | SystemType | Department | MaintenanceFrequency) & Record<string, unknown>

/** The form's starting values for a record (empty for a new one). */
function initialValues(tab: Tab, record: AnyRecord | null): Record<string, string> {
  const values: Record<string, string> = {}

  for (const field of FIELDS[tab]) {
    if (field.kind === 'department') values[field.name] = (record as SalesEngineer | null)?.department?.id ?? ''
    else if (field.kind === 'user') values[field.name] = (record as SalesEngineer | null)?.user?.id ?? ''
    else values[field.name] = record && record[field.name] !== null && record[field.name] !== undefined ? String(record[field.name]) : field.kind === 'number' ? '0' : ''
  }

  return values
}

export function MasterFormModal({ tab, record, onClose, onSaved }: { tab: Tab; record: AnyRecord | null; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient()
  const auth = useAuth()
  const spec = ALL_TABS.find((item) => item.key === tab) as TabSpec
  const [values, setValues] = useState(() => initialValues(tab, record))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const needsDepartments = FIELDS[tab].some((field) => field.kind === 'department')
  const needsUsers = FIELDS[tab].some((field) => field.kind === 'user') && auth.can('USERS', 'VIEW')
  const departments = useQuery({ queryKey: ['masters', 'departments', 'options'], queryFn: () => api.get<Department[]>('/masters/departments/options'), enabled: needsDepartments })
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ id: string; fullName: string; email: string }[]>('/users'),
    enabled: needsUsers,
  })

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {}
      for (const field of FIELDS[tab]) {
        if (field.kind === 'user' && !needsUsers) continue
        const value = values[field.name] ?? ''
        body[field.name] = field.kind === 'number' ? Number(value || 0) : value
      }

      return record ? api.patch(`/masters/${tab}/${record.id}`, body) : api.post(`/masters/${tab}`, body)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      onSaved(`The ${spec.singular} "${values.name ?? values.label ?? ''}" was ${record ? 'updated' : 'added'}.`)
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        setErrors(Object.fromEntries(error.details.map((detail) => [detail.field, detail.message])))
      }
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const missing = Object.fromEntries(
      FIELDS[tab].filter((field) => field.required && !(values[field.name] ?? '').trim()).map((field) => [field.name, `${field.label} is required.`]),
    )
    setErrors(missing)
    if (Object.keys(missing).length === 0) save.mutate()
  }

  const set = (name: string) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [name]: event.target.value }))
  const formId = `master-form-${tab}`
  const departmentOptions = (departments.data ?? []).filter((item) => item.isActive || item.id === values.departmentId)

  return (
    <Modal
      title={`${record ? 'Edit' : 'Add'} ${spec.singular}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {record ? 'Save changes' : `Add ${spec.singular}`}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {save.isError && !(save.error instanceof ApiError && save.error.details.length > 0) && <Alert>{errorMessage(save.error)}</Alert>}
        {FIELDS[tab].map((field) => {
          const common = { label: field.label, required: field.required, error: errors[field.name], hint: field.hint, value: values[field.name] ?? '', onChange: set(field.name) }

          if (field.kind === 'textarea') return <TextAreaField key={field.name} {...common} />
          if (field.kind === 'department')
            return (
              <SelectField key={field.name} {...common}>
                <option value="">No department</option>
                {departmentOptions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} — {item.name}
                  </option>
                ))}
              </SelectField>
            )
          if (field.kind === 'user') {
            if (!needsUsers) return null

            return (
              <SelectField key={field.name} {...common}>
                <option value="">Not linked</option>
                {(users.data ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.fullName} ({user.email})
                  </option>
                ))}
              </SelectField>
            )
          }

          return <TextField key={field.name} {...common} type={field.kind === 'number' ? 'number' : field.kind === 'email' ? 'email' : 'text'} min={field.kind === 'number' ? 0 : undefined} />
        })}
      </form>
    </Modal>
  )
}

function intervalText(months: number | null): string {
  if (months === null) return '—'
  return months === 1 ? 'Every month' : `Every ${months} months`
}

function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cx(TABLE.td, className)}>{children}</td>
}

function MasterTable({ tab, items, canEdit, onEdit, onToggle }: { tab: Tab; items: AnyRecord[]; canEdit: boolean; onEdit: (record: AnyRecord) => void; onToggle: (record: AnyRecord) => void }) {
  const head = (labels: string[]) => (
    <tr>
      {labels.map((label) => (
        <th key={label} scope="col" className={cx(TABLE.th, label === 'Actions' && 'text-right')}>
          {label}
        </th>
      ))}
    </tr>
  )
  const actions = (record: AnyRecord) => (
    <Cell className="whitespace-nowrap text-right">
      {canEdit && (
        <span className="inline-flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => onEdit(record)} aria-label={`Edit ${String(record.name)}`}>
            Edit
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onToggle(record)} aria-label={`${record.isActive ? 'Deactivate' : 'Reactivate'} ${String(record.name)}`}>
            {record.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </span>
      )}
    </Cell>
  )
  const status = (record: AnyRecord) => (
    <Cell>
      <Badge tone={record.isActive ? 'green' : 'slate'}>{record.isActive ? 'Active' : 'Inactive'}</Badge>
    </Cell>
  )

  return (
    <div className={TABLE.wrapper}>
      <table className={TABLE.table}>
        <caption className="sr-only">{ALL_TABS.find((item) => item.key === tab)?.label}</caption>
        <thead>
          {tab === 'sales-engineers' && head(['Name', 'Employee no.', 'Department', 'Contact', 'Sign-in account', 'Contracts', 'Status', 'Actions'])}
          {tab === 'system-types' && head(['Code', 'Name', 'Description', 'Order', 'Contracts', 'Status', 'Actions'])}
          {tab === 'departments' && head(['Code', 'Name', 'Description', 'Engineers', 'Status', 'Actions'])}
          {tab === 'maintenance-frequencies' && head(['Label', 'Code', 'Interval', 'Contracts', 'Status', 'Actions'])}
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((record) => (
            <tr key={record.id}>
              {tab === 'sales-engineers' &&
                (() => {
                  const engineer = record as SalesEngineer
                  return (
                    <>
                      <Cell className="font-medium text-slate-900">{engineer.name}</Cell>
                      <Cell>{engineer.employeeNo ?? '—'}</Cell>
                      <Cell>{engineer.department ? `${engineer.department.code} — ${engineer.department.name}` : '—'}</Cell>
                      <Cell>
                        <span className="block">{engineer.email ?? '—'}</span>
                        {engineer.phone && <span className="block text-xs text-slate-500">{engineer.phone}</span>}
                      </Cell>
                      <Cell>{engineer.user ? engineer.user.fullName : 'Not linked'}</Cell>
                      <Cell className="tabular-nums">{engineer.contractCount}</Cell>
                    </>
                  )
                })()}
              {tab === 'system-types' &&
                (() => {
                  const type = record as SystemType
                  return (
                    <>
                      <Cell className="font-semibold text-slate-900">{type.code}</Cell>
                      <Cell>{type.name}</Cell>
                      <Cell>{type.description ?? '—'}</Cell>
                      <Cell className="tabular-nums">{type.sortOrder}</Cell>
                      <Cell className="tabular-nums">{type.contractCount}</Cell>
                    </>
                  )
                })()}
              {tab === 'departments' &&
                (() => {
                  const department = record as Department
                  return (
                    <>
                      <Cell className="font-semibold text-slate-900">{department.code}</Cell>
                      <Cell>{department.name}</Cell>
                      <Cell>{department.description ?? '—'}</Cell>
                      <Cell className="tabular-nums">{department.engineerCount}</Cell>
                    </>
                  )
                })()}
              {tab === 'maintenance-frequencies' &&
                (() => {
                  const frequency = record as MaintenanceFrequency
                  return (
                    <>
                      <Cell className="font-medium text-slate-900">{frequency.label}</Cell>
                      <Cell className="font-mono text-xs">{frequency.code}</Cell>
                      <Cell>{intervalText(frequency.intervalMonths)}</Cell>
                      <Cell className="tabular-nums">{frequency.contractCount}</Cell>
                    </>
                  )
                })()}
              {status(record)}
              {actions(record)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One master list of the Master Data Center: search, status filter, paging, and add / edit / deactivate / reactivate. */
export function MasterListPage({ tab }: { tab: ListTab }) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<{ record: AnyRecord | null } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const spec = ALL_TABS.find((item) => item.key === tab) as TabSpec
  const canCreate = spec.canAdd && auth.can(TAB_MODULE[tab], 'CREATE')
  const canEdit = auth.can(TAB_MODULE[tab], 'EDIT')
  const list = useQuery({
    queryKey: ['masters', tab, { search, status, page }],
    queryFn: () => api.get<MasterList<AnyRecord>>(`/masters/${tab}${queryString({ search, status, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const toggle = useMutation({
    mutationFn: (record: AnyRecord) => api.post<AnyRecord>(`/masters/${tab}/${record.id}/status`, { isActive: !record.isActive }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      setNotice(`"${String(saved.name)}" is now ${saved.isActive ? 'active' : 'inactive'}.`)
    },
  })

  const unavailable = list.isError && isFeatureUnavailable(list.error)
  const data = list.data
  const filtered = search !== '' || status !== 'all'
  return (
    <>
      <PageHeader
        title={spec.label}
        description={spec.description}
        actions={canCreate && !unavailable && <Button onClick={() => setEditing({ record: null })}>Add {spec.singular}</Button>}
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
          <Alert>{errorMessage(toggle.error)}</Alert>
        </div>
      )}

      <Card>
        {unavailable ? (
          <div className="p-5">
            <Alert tone="info">
              Database update required: {spec.label} needs migration {spec.migration}, which has not been applied to this database yet.
            </Alert>
          </div>
        ) : (
          <>
            <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 sm:px-5">
              <Filter label="Search">
                {(id, className) => <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={spec.searchHint} className={className} />}
              </Filter>
              <Filter label="Status">
                {(id, className) => (
                  <select
                    id={id}
                    value={status}
                    onChange={(event) => {
                      setStatus(event.target.value)
                      setPage(1)
                    }}
                    className={className}
                  >
                    <option value="all">All</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                )}
              </Filter>
            </div>

            {list.isPending && <Spinner label={`Loading ${spec.label.toLowerCase()}`} />}
            {list.isError && <LoadError error={list.error} onRetry={() => void list.refetch()} />}
            {data && data.items.length === 0 && (
              <EmptyState
                title={filtered ? `No ${spec.label.toLowerCase()} match your filters` : `No ${spec.label.toLowerCase()} yet`}
                action={!filtered && canCreate ? <Button onClick={() => setEditing({ record: null })}>Add {spec.singular}</Button> : undefined}
              />
            )}
            {data && data.items.length > 0 && (
              <>
                <MasterTable tab={tab} items={data.items} canEdit={canEdit} onEdit={(record) => setEditing({ record })} onToggle={(record) => toggle.mutate(record)} />
                <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
              </>
            )}
          </>
        )}
      </Card>

      {editing && (
        <MasterFormModal
          tab={tab}
          record={editing.record}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setNotice(message)
            setEditing(null)
          }}
        />
      )}
    </>
  )
}
