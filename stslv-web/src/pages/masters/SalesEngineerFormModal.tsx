import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Alert, Button, Modal, SelectField, TextAreaField, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { ENGINEER_STATUS_LABELS, isFeatureUnavailable, type Department, type EngineerUserOption, type EngineerRecord } from './masterTypes'

// Add or edit one sales engineer. No sign-in account is created here: the
// User Account list offers existing accounts only, and the API checks again
// that a newly linked account is active, approved and not linked to another
// engineer.

type Values = Record<'name' | 'employeeNo' | 'userId' | 'email' | 'phone' | 'departmentId' | 'notes' | 'status', string>
type FieldName = keyof Values

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function initialValues(engineer: EngineerRecord | null): Values {
  return {
    name: engineer?.name ?? '',
    employeeNo: engineer?.employeeNo ?? '',
    userId: engineer?.user?.id ?? '',
    email: engineer?.email ?? '',
    phone: engineer?.phone ?? '',
    departmentId: engineer?.department?.id ?? '',
    notes: engineer?.notes ?? '',
    status: engineer && !engineer.isActive ? 'inactive' : 'active',
  }
}

function validate(values: Values): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {}

  if (!values.name.trim()) errors.name = 'Engineer name is required.'
  if (values.email.trim() && !EMAIL.test(values.email.trim())) errors.email = 'Enter a valid email address.'

  return errors
}

/**
 * The warning shown before an engineer with active AMC contracts is disabled.
 * Nothing is reassigned: the contracts keep the engineer.
 */
export function AssignmentWarning({ engineer }: { engineer: Pick<EngineerRecord, 'name' | 'activeContractCount'> }) {
  const count = engineer.activeContractCount

  return (
    <div role="note" className="rounded-lg border border-amber-200 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      {count > 0 ? (
        <>
          <strong className="font-semibold">
            {engineer.name} is assigned to {count} active AMC {count === 1 ? 'contract' : 'contracts'}.
          </strong>{' '}
          {count === 1 ? 'It keeps' : 'They keep'} this engineer; nothing is reassigned. A disabled engineer is not offered for new assignments.
        </>
      ) : (
        <>{engineer.name} has no active AMC contracts. A disabled engineer is not offered for new assignments; past contracts keep the link.</>
      )}
    </div>
  )
}

export function SalesEngineerFormModal({ engineer, onClose, onSaved }: { engineer: EngineerRecord | null; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient()
  const initial = initialValues(engineer)
  const [values, setValues] = useState<Values>(initial)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})

  const departments = useQuery({ queryKey: ['masters', 'departments', 'options'], queryFn: () => api.get<Department[]>('/masters/departments/options') })
  const users = useQuery({
    queryKey: ['masters', 'sales-engineers', 'user-options', engineer?.id ?? 'new'],
    queryFn: () => api.get<EngineerUserOption[]>(`/masters/sales-engineers/user-options${engineer ? `?engineerId=${engineer.id}` : ''}`),
    retry: false,
  })

  const save = useMutation({
    mutationFn: async () => {
      const text = (name: FieldName) => values[name].trim()
      const fields: Record<string, string> = {
        name: text('name'),
        employeeNo: text('employeeNo'),
        userId: values.userId,
        email: text('email'),
        phone: text('phone'),
        departmentId: values.departmentId,
        notes: text('notes'),
      }

      if (!engineer) {
        return api.post<EngineerRecord>('/masters/sales-engineers', { ...fields, isActive: values.status === 'active' })
      }

      // Only what changed is sent, so the history records real changes. The status has its own route, which logs it.
      const changed = Object.fromEntries(Object.entries(fields).filter(([name]) => fields[name] !== initial[name as FieldName].trim()))
      let saved = engineer

      if (Object.keys(changed).length > 0) {
        saved = await api.patch<EngineerRecord>(`/masters/sales-engineers/${engineer.id}`, changed)
      }
      if (values.status !== initial.status) {
        saved = await api.post<EngineerRecord>(`/masters/sales-engineers/${engineer.id}/status`, { isActive: values.status === 'active' })
      }

      return saved
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['masters'] })
      onSaved(engineer ? `${saved.name} was updated.` : `${saved.name} was added as ${saved.code}.`)
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details.length > 0) {
        setErrors(Object.fromEntries(error.details.map((detail) => [detail.field, detail.message])))
      }
    },
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const found = validate(values)
    setErrors(found)
    if (Object.keys(found).length === 0) save.mutate()
  }

  const set = (name: FieldName) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [name]: event.target.value }))
  const field = (name: FieldName) => ({ value: values[name], onChange: set(name), error: errors[name] })

  // An inactive department or a since-disabled account stays shown while it is the current link.
  const departmentOptions = (departments.data ?? []).filter((item) => item.isActive || item.id === values.departmentId)
  const currentDepartment = engineer?.department && !departmentOptions.some((item) => item.id === engineer.department?.id) ? engineer.department : null
  const userOptions = users.data ?? []
  const currentUser = engineer?.user && !userOptions.some((item) => item.id === engineer.user?.id) ? engineer.user : null

  const formId = 'sales-engineer-form'
  const title = engineer ? `Edit ${engineer.name}` : 'Add sales engineer'
  const unavailable = save.isError && isFeatureUnavailable(save.error)

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={save.isPending}>
            {engineer ? 'Save changes' : 'Add sales engineer'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        {unavailable && <Alert>Sales engineers cannot be saved until the database update (migration 0070) is applied.</Alert>}
        {save.isError && !unavailable && !(save.error instanceof ApiError && save.error.details.length > 0) && <Alert>{errorMessage(save.error)}</Alert>}
        {engineer && <p className="text-sm text-slate-600">Engineer code {engineer.code}. The code is fixed and cannot be changed.</p>}

        <TextField label="Engineer name" required maxLength={150} autoComplete="off" {...field('name')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Employee number" maxLength={50} autoComplete="off" {...field('employeeNo')} />
          <SelectField label="Department" hint={departments.isError ? 'The department list could not be loaded.' : undefined} {...field('departmentId')}>
            <option value="">None</option>
            {currentDepartment && (
              <option value={currentDepartment.id}>
                {currentDepartment.code} — {currentDepartment.name} (inactive)
              </option>
            )}
            {departmentOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} — {item.name}
                {item.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </SelectField>
          <TextField label="Email" type="email" maxLength={254} autoComplete="off" {...field('email')} />
          <TextField label="Phone" type="tel" maxLength={50} autoComplete="off" {...field('phone')} />
        </div>
        <SelectField
          label="User account"
          hint={
            users.isError
              ? 'The account list could not be loaded; the current link is kept.'
              : 'Optional. An existing, active, approved account not linked to another engineer. No account is created here.'
          }
          disabled={users.isError}
          {...field('userId')}
        >
          <option value="">Not linked</option>
          {currentUser && (
            <option value={currentUser.id}>
              {currentUser.fullName} ({currentUser.email}) — current link
            </option>
          )}
          {userOptions.map((user) => (
            <option key={user.id} value={user.id}>
              {user.fullName} ({user.email})
            </option>
          ))}
        </SelectField>
        <SelectField label="Status" hint="Archived is not available yet: it needs a database update." {...field('status')}>
          <option value="active">{ENGINEER_STATUS_LABELS.active}</option>
          <option value="inactive">{ENGINEER_STATUS_LABELS.inactive}</option>
        </SelectField>
        {engineer && engineer.isActive && values.status === 'inactive' && <AssignmentWarning engineer={engineer} />}
        <TextAreaField label="Notes" maxLength={2000} {...field('notes')} />
      </form>
    </Modal>
  )
}
