import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Alert, Button, Modal, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx } from '../../lib/format'
import { passwordRule } from '../../lib/password'
import type { Role, User } from '../../lib/types'

const PASSWORD_HINT = 'At least 10 characters. Give it to the user privately; they can change it under My account.'

function RoleCheckboxes({ roles, selected, onChange }: { roles: Role[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-bold text-slate-800">Roles</legend>
      <div className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-300">
        {roles.map((role) => {
          const on = selected.includes(role.id)

          return (
            <label
              key={role.id}
              title={role.description ?? undefined}
              className={cx(
                'flex items-center gap-3 px-3.5 py-2',
                role.isActive ? 'cursor-pointer hover:bg-sky-50/60' : 'cursor-not-allowed opacity-60',
                on && 'bg-sky-50',
              )}
            >
              <input
                type="checkbox"
                className="h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-slate-300 accent-[#1479BD]"
                checked={on}
                disabled={!role.isActive}
                onChange={(event) => onChange(event.target.checked ? [...selected, role.id] : selected.filter((id) => id !== role.id))}
              />
              <span className="text-sm font-semibold text-slate-900">{role.name}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

const createUserSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required.').max(200, 'Full name must be at most 200 characters.'),
  email: z.string().trim().min(1, 'Email is required.').pipe(z.email('Enter a valid email address.')),
  password: passwordRule,
})

type CreateUserForm = z.infer<typeof createUserSchema>

export function CreateUserModal({ roles, onClose, onSaved }: { roles: Role[]; onClose: () => void; onSaved: (user: User) => void }) {
  const queryClient = useQueryClient()
  const [roleIds, setRoleIds] = useState<string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<CreateUserForm>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { fullName: '', email: '', password: '' },
  })

  const save = useMutation({
    mutationFn: (values: CreateUserForm) => api.post<User>('/users', { ...values, roleIds }),
    onSuccess: async (user) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      onSaved(user)
    },
    onError: (error) => {
      let shownOnField = false

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          if (detail.field === 'fullName' || detail.field === 'email' || detail.field === 'password') {
            setError(detail.field, { message: detail.message })
            shownOnField = true
          }
        }
      }

      setFailure(shownOnField ? null : errorMessage(error))
    },
  })

  return (
    <Modal
      title="Create User"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="create-user-form" loading={save.isPending}>
            Create user
          </Button>
        </>
      }
    >
      <form
        id="create-user-form"
        noValidate
        className="space-y-4"
        onSubmit={handleSubmit((values) => {
          setFailure(null)
          save.mutate(values)
        })}
      >
        {failure && <Alert>{failure}</Alert>}
        <TextField label="Full name" required autoComplete="off" error={errors.fullName?.message} {...register('fullName')} />
        <TextField label="Email" type="email" required autoComplete="off" error={errors.email?.message} {...register('email')} />
        <TextField
          label="Temporary password"
          type="password"
          required
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          error={errors.password?.message}
          {...register('password')}
        />
        <RoleCheckboxes roles={roles} selected={roleIds} onChange={setRoleIds} />
      </form>
    </Modal>
  )
}

export function EditRolesModal({ user, roles, onClose, onSaved }: { user: User; roles: Role[]; onClose: () => void; onSaved: (user: User) => void }) {
  const queryClient = useQueryClient()
  const [roleIds, setRoleIds] = useState<string[]>(() => user.roles.map((role) => role.id))

  const save = useMutation({
    mutationFn: () => api.put<User>(`/users/${user.id}/roles`, { roleIds }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      onSaved(updated)
    },
  })

  return (
    <Modal
      title={`Roles for ${user.fullName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save roles
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        <RoleCheckboxes roles={roles} selected={roleIds} onChange={setRoleIds} />
        <p className="text-xs text-slate-500">Changes apply immediately.</p>
      </div>
    </Modal>
  )
}

const resetSchema = z
  .object({ password: passwordRule, confirmation: z.string() })
  .refine((value) => value.password === value.confirmation, { path: ['confirmation'], message: 'The two passwords do not match.' })

type ResetForm = z.infer<typeof resetSchema>

export function ResetPasswordModal({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ResetForm>({ resolver: zodResolver(resetSchema), defaultValues: { password: '', confirmation: '' } })

  const save = useMutation({
    mutationFn: (values: ResetForm) => api.post<null>(`/users/${user.id}/reset-password`, { password: values.password }),
    onSuccess: onSaved,
  })

  return (
    <Modal
      title={`Reset password for ${user.fullName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="reset-password-form" loading={save.isPending}>
            Reset password
          </Button>
        </>
      }
    >
      <form id="reset-password-form" noValidate className="space-y-4" onSubmit={handleSubmit((values) => save.mutate(values))}>
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        <p className="text-sm text-slate-600">The user is signed out of every device and must use the new password.</p>
        <TextField
          label="New password"
          type="password"
          required
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          error={errors.password?.message}
          {...register('password')}
        />
        <TextField
          label="Repeat new password"
          type="password"
          required
          autoComplete="new-password"
          error={errors.confirmation?.message}
          {...register('confirmation')}
        />
      </form>
    </Modal>
  )
}
