import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useAuth } from '../../auth/context'
import { Alert, Badge, Button, ConfirmDialog, EmptyState, Modal, SelectField, TableScroll, TextAreaField, TextField } from '../../components/ui'
import { TABLE } from '../../components/table'
import { api, ApiError, errorMessage } from '../../lib/api'
import type { Role, RolesResponse } from '../../lib/types'

const FORM_ID = 'department-form'

const codeRule = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Use 2 to 40 capital letters, digits or underscores, starting with a letter.')

const schema = z.object({
  code: z.string(),
  name: z.string().trim().min(1, 'Name is required.').max(80, 'Name must be at most 80 characters.'),
  description: z.string().trim().max(300, 'Description must be at most 300 characters.'),
  status: z.enum(['active', 'inactive']),
})

type Values = z.infer<typeof schema>

type Dialog = { kind: 'none' } | { kind: 'add' } | { kind: 'edit'; role: Role } | { kind: 'delete'; role: Role }

function DepartmentForm({ role, onClose, onSaved }: { role: Role | null; onClose: () => void; onSaved: (message: string) => void }) {
  const queryClient = useQueryClient()
  const editing = role !== null
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { code: role?.code ?? '', name: role?.name ?? '', description: role?.description ?? '', status: role?.isActive === false ? 'inactive' : 'active' },
  })
  const [failure, setFailure] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (values: Values) =>
      editing
        ? api.patch<Role>(`/roles/${role.id}`, { name: values.name, description: values.description, isActive: values.status === 'active' })
        : api.post<Role>('/roles', { code: values.code, name: values.name, description: values.description }),
    onSuccess: async (saved) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['roles'] }), queryClient.invalidateQueries({ queryKey: ['users'] })])
      onSaved(editing ? `${saved.name} was updated.` : `${saved.name} was added.`)
    },
    onError: (error) => {
      let onField = false

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          if (detail.field === 'code' || detail.field === 'name' || detail.field === 'description') {
            setError(detail.field, { message: detail.message })
            onField = true
          }
        }
      }

      setFailure(onField ? null : errorMessage(error))
    },
  })

  return (
    <Modal
      title={editing ? 'Edit department' : 'Add department'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={save.isPending}>
            {editing ? 'Save changes' : 'Add department'}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit((values) => {
          setFailure(null)

          if (!editing) {
            const parsed = codeRule.safeParse(values.code)

            if (!parsed.success) {
              setError('code', { message: parsed.error.issues[0]?.message ?? 'Enter a valid code.' })
              return
            }

            values = { ...values, code: parsed.data }
          }

          save.mutate(values)
        })}
      >
        {failure && <Alert>{failure}</Alert>}
        <TextField
          label="Department code"
          required={!editing}
          disabled={editing}
          autoCapitalize="characters"
          hint={editing ? 'The code never changes: permissions and history refer to it.' : 'Short capital letters, for example WORKSHOP. It cannot be changed later.'}
          error={errors.code?.message}
          {...register('code')}
        />
        <TextField label="Department name" required error={errors.name?.message} {...register('name')} />
        <TextAreaField label="Description" hint="What this department does." error={errors.description?.message} {...register('description')} />
        {editing && (
          <SelectField label="Status" hint="An inactive department cannot be given to new users. A department that still has people cannot be made inactive." {...register('status')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </SelectField>
        )}
      </form>
    </Modal>
  )
}

const iconButton = 'inline-flex h-8 w-9 items-center justify-center text-slate-500 transition-colors hover:bg-sky-50 hover:text-[#1479BD] focus-visible:relative focus-visible:z-10'

/** The departments of the business. They are the roles of Users & Access, so adding one here adds a role, and its permissions are set under Roles & access. */
export function DepartmentsPanel() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })
  const [notice, setNotice] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const allowed = auth.can('USERS', 'VIEW')
  const canAdd = auth.can('USERS', 'CREATE')
  const canEdit = auth.can('USERS', 'EDIT')
  const canDelete = auth.can('USERS', 'DELETE')
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles'), enabled: allowed })

  const remove = useMutation({
    mutationFn: (role: Role) => api.delete(`/roles/${role.id}`),
    onSuccess: async (_data, role) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['roles'] }), queryClient.invalidateQueries({ queryKey: ['users'] })])
      setNotice(`${role.name} was deleted.`)
      setDialog({ kind: 'none' })
    },
    onError: (error) => setDeleteError(errorMessage(error)),
  })

  if (!allowed) {
    return <p className="text-sm text-slate-600">The list of departments is visible to people who may view Users &amp; Access.</p>
  }
  if (roles.isPending) {
    return (
      <p className="text-sm text-slate-500" role="status">
        Loading departments…
      </p>
    )
  }
  if (roles.isError) {
    return <Alert>{errorMessage(roles.error)}</Alert>
  }

  const items = roles.data.roles
  const close = () => {
    setDialog({ kind: 'none' })
    setDeleteError(null)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          <span className="font-semibold tabular-nums text-slate-900">{items.length}</span> {items.length === 1 ? 'department' : 'departments'}
        </p>
        {canAdd && (
          <Button onClick={() => setDialog({ kind: 'add' })}>
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
              <path d="M10 4v12M4 10h12" strokeLinecap="round" />
            </svg>
            Add department
          </Button>
        )}
      </div>

      {notice && (
        <Alert tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200">
        {items.length === 0 ? (
          <EmptyState title="No departments yet" description="Add the first department to get started." />
        ) : (
          <TableScroll label="Departments">
            <table className={TABLE.table}>
              <caption className="sr-only">Departments</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.snHead}>
                    #
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Code
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Department
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Status
                  </th>
                  <th scope="col" className={`${TABLE.th} text-center`}>
                    People
                  </th>
                  <th scope="col" className={`${TABLE.th} text-right`}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((role, index) => (
                  <tr key={role.id} className={TABLE.row}>
                    <td className={TABLE.sn}>{index + 1}</td>
                    <td className={TABLE.td}>
                      <span className="inline-block rounded-md bg-slate-100 px-2 py-1 font-mono text-[11px] font-semibold tracking-wide text-slate-700 ring-1 ring-inset ring-slate-200">{role.code}</span>
                    </td>
                    <td className={`${TABLE.td} min-w-56`}>
                      <span className="block font-semibold text-slate-900">{role.name}</span>
                      <span className="block text-xs text-slate-500">{role.description ?? 'No description'}</span>
                    </td>
                    <td className={TABLE.td}>{role.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                    <td className={`${TABLE.td} text-center font-semibold tabular-nums text-[#0b3b66]`}>{role.userCount}</td>
                    <td className={`${TABLE.td} whitespace-nowrap text-right`}>
                      <div className="inline-flex items-center divide-x divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                        {canEdit && (
                          <button type="button" aria-label={`Edit ${role.name}`} title={`Edit ${role.name}`} onClick={() => setDialog({ kind: 'edit', role })} className={iconButton}>
                            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                              <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3ZM14 8l3 3" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            aria-label={`Delete ${role.name}`}
                            title={`Delete ${role.name}`}
                            onClick={() => {
                              setDeleteError(null)
                              setDialog({ kind: 'delete', role })
                            }}
                            className={`${iconButton} hover:!bg-red-50 hover:!text-red-700`}
                          >
                            <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                              <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        )}
                        {!canEdit && !canDelete && <span className="px-3 py-1.5 text-xs text-slate-400">—</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </div>

      <p className="text-xs text-slate-500">
        A department is a role. What it may do is set under Roles &amp; access. A new department starts with no permissions. A department that still has people, and the Admin department, cannot be deleted.
      </p>

      {dialog.kind === 'add' && (
        <DepartmentForm
          role={null}
          onClose={close}
          onSaved={(message) => {
            setNotice(message)
            close()
          }}
        />
      )}
      {dialog.kind === 'edit' && (
        <DepartmentForm
          role={dialog.role}
          onClose={close}
          onSaved={(message) => {
            setNotice(message)
            close()
          }}
        />
      )}
      {dialog.kind === 'delete' && (
        <ConfirmDialog
          title="Delete department"
          message={
            <>
              Delete <strong>{dialog.role.name}</strong> ({dialog.role.code})? Its permissions are removed with it. This cannot be undone.
            </>
          }
          confirmLabel="Delete department"
          danger
          loading={remove.isPending}
          error={deleteError}
          onConfirm={() => remove.mutate(dialog.role)}
          onCancel={close}
        />
      )}
    </div>
  )
}
