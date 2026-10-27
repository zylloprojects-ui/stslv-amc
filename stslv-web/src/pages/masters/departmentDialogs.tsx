import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Button, EmptyState, Modal, Spinner, TableScroll, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import type { Department, EngineerRecord, MasterList } from './masterTypes'

// The dialogs of the Departments page: the add / edit form, the confirmation
// before a department is disabled, and its linked engineers (read only).

/** A department as the Departments list returns it: with the count of its active engineers too. */
export interface DepartmentRecord extends Department {
  activeEngineerCount?: number
}

const engineers = (count: number) => `${count} sales ${count === 1 ? 'engineer' : 'engineers'}`

// The API's rules (masters.schemas.ts), checked here first for a quicker answer. The API checks them again.
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _./&-]*$/
const LIMITS = { code: 20, name: 100, description: 500 } as const
type FieldName = keyof typeof LIMITS

function validate(values: Record<FieldName, string>): Record<string, string> {
  const errors: Record<string, string> = {}
  const code = values.code.trim()
  const name = values.name.trim()

  if (!code) errors.code = 'Department code is required.'
  else if (code.length > LIMITS.code) errors.code = `Department code must be at most ${LIMITS.code} characters.`
  else if (!CODE_PATTERN.test(code)) errors.code = 'Department code may use letters, digits, spaces and - _ . / & only.'

  if (!name) errors.name = 'Department name is required.'
  else if (name.length > LIMITS.name) errors.name = `Department name must be at most ${LIMITS.name} characters.`

  if (values.description.trim().length > LIMITS.description) errors.description = `Description must be at most ${LIMITS.description} characters.`

  return errors
}

export function DepartmentFormModal({ department, onClose, onSaved }: { department: DepartmentRecord | null; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient()
  const [values, setValues] = useState<Record<FieldName, string>>({
    code: department?.code ?? '',
    name: department?.name ?? '',
    description: department?.description ?? '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const save = useMutation({
    mutationFn: () => {
      const body = { code: values.code, name: values.name, description: values.description }

      return department ? api.patch<Department>(`/masters/departments/${department.id}`, body) : api.post<Department>('/masters/departments', body)
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      onSaved(`The department "${saved.name}" was ${department ? 'updated' : 'added'}.`)
    },
    onError: (error) => {
      if (error instanceof ApiError) setErrors(Object.fromEntries(error.details.map((detail) => [detail.field, detail.message])))
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = validate(values)
    setErrors(found)
    if (Object.keys(found).length === 0) save.mutate()
  }

  const set = (name: FieldName) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [name]: event.target.value }))
  // Engineers refer to a department by id, so a new code is safe; it still changes what they and every export show.
  const codeChanged = department !== null && values.code.trim() !== department.code
  const linked = department?.engineerCount ?? 0

  return (
    <Modal
      title={department ? 'Edit department' : 'Add department'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="department-form" loading={save.isPending}>
            {department ? 'Save changes' : 'Add department'}
          </Button>
        </>
      }
    >
      <form id="department-form" onSubmit={submit} noValidate className="space-y-4">
        {save.isError && !(save.error instanceof ApiError && save.error.details.length > 0) && <Alert>{errorMessage(save.error)}</Alert>}
        <TextField
          label="Department code"
          required
          value={values.code}
          onChange={set('code')}
          error={errors.code}
          maxLength={LIMITS.code}
          hint="A short, unique business code, for example AMC or FIN. Treat it as permanent."
        />
        {codeChanged && linked > 0 && (
          <Alert tone="info">
            {engineers(linked)} {linked === 1 ? 'is' : 'are'} linked to this department. They stay linked, because they refer to the department itself rather than its code, but they and every
            export will show the new code from now on.
          </Alert>
        )}
        <TextField label="Department name" required value={values.name} onChange={set('name')} error={errors.name} maxLength={LIMITS.name} />
        <TextAreaField label="Description" value={values.description} onChange={set('description')} error={errors.description} maxLength={LIMITS.description} />
      </form>
    </Modal>
  )
}

/** Shown before a department is disabled: what changes, and what does not. */
export function DisableDepartmentModal({
  department,
  loading,
  error,
  onConfirm,
  onCancel,
  onViewEngineers,
}: {
  department: DepartmentRecord
  loading: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  onViewEngineers: () => void
}) {
  const linked = department.engineerCount
  const active = department.activeEngineerCount

  return (
    <Modal
      title={`Disable ${department.code} — ${department.name}?`}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={onConfirm} loading={loading}>
            Disable department
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        {linked > 0 ? (
          <p>
            <strong>{engineers(linked)}</strong> {linked === 1 ? 'is' : 'are'} linked to this department
            {active !== undefined && linked > 0 ? ` (${active} active)` : ''}.{' '}
            <button type="button" className="font-medium text-[#1479BD] underline" onClick={onViewEngineers}>
              View linked engineers
            </button>
          </p>
        ) : (
          <p>No sales engineers are linked to this department.</p>
        )}
        <ul className="list-disc space-y-1 pl-5">
          <li>It will no longer be offered when a sales engineer is added or moved to a department.</li>
          {linked > 0 && <li>Engineers already in it keep it. None is moved or reassigned.</li>}
          <li>It can be made active again at any time.</li>
        </ul>
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  )
}

const PAGE_SIZE = 10

/** The engineers linked to a department, from the Sales Engineers list filtered by it. Read only. */
export function LinkedEngineersModal({ department, onClose }: { department: DepartmentRecord; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const list = useQuery({
    queryKey: ['masters', 'departments', department.id, 'engineers', page],
    queryFn: () => api.get<MasterList<EngineerRecord>>(`/masters/sales-engineers?departmentId=${department.id}&status=all&page=${page}&pageSize=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const data = list.data

  return (
    <Modal
      title={`Sales engineers in ${department.code} — ${department.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {list.isPending && <Spinner label="Loading engineers" />}
      {list.isError && <Alert>{errorMessage(list.error)}</Alert>}
      {data && data.items.length === 0 && <EmptyState title="No sales engineers are linked to this department" />}
      {data && data.items.length > 0 && (
        <>
          <TableScroll label="Linked sales engineers">
            <table className={TABLE.table}>
              <caption className="sr-only">Sales engineers in {department.name}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.th}>
                    Engineer
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Code
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Employee no.
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map((engineer) => (
                  <tr key={engineer.id} className={TABLE.row}>
                    <td className={`${TABLE.td} ${TABLE.text}`}>
                      <Link to={`/master-data/sales-engineers/${engineer.id}`} className="font-semibold text-slate-900 hover:text-[#1479BD] hover:underline">
                        {engineer.name}
                      </Link>
                    </td>
                    <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs font-semibold text-slate-600`}>{engineer.code}</td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>{engineer.employeeNo ?? '—'}</td>
                    <td className={`${TABLE.td} whitespace-nowrap`}>
                      <Badge tone={engineer.isActive ? 'green' : 'slate'}>{engineer.isActive ? 'Active' : 'Disabled'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <Pager page={data.page} pageSize={data.pageSize} shown={data.items.length} total={data.total} onPage={setPage} />
        </>
      )}
    </Modal>
  )
}
