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

/** The API's message when a request names no role or several: each user holds exactly one role. */
export const ONE_ROLE_MESSAGE = 'Select exactly one role.'

/** Exactly one role per user (approved 2026-10-29), chosen from the active roles. The API enforces the same rule. */
function RolePicker({ roles, selected, onChange, error }: { roles: Role[]; selected: string; onChange: (id: string) => void; error?: string }) {
  return (
    <fieldset aria-describedby={error ? 'role-picker-error' : undefined}>
      <legend className="mb-1.5 text-sm font-bold text-slate-800">
        Role <span className="font-normal text-slate-500">(one per user)</span>
      </legend>
      <div className={cx('divide-y divide-slate-200 overflow-hidden rounded-lg border', error ? 'border-red-400' : 'border-slate-300')}>
        {roles.map((role) => {
          const on = selected === role.id

          return (
            <label
              key={role.id}
              className={cx(
                'flex items-start gap-3 px-3.5 py-2',
                role.isActive ? 'cursor-pointer hover:bg-sky-50/60' : 'cursor-not-allowed opacity-60',
                on && 'bg-sky-50',
              )}
            >
              <input
                type="radio"
                name="role"
                className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-[#1479BD]"
                checked={on}
                disabled={!role.isActive}
                onChange={() => onChange(role.id)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900">
                  {role.name}
                  {!role.isActive && <span className="ml-1.5 text-xs font-normal">(inactive)</span>}
                </span>
                {role.description && <span className="block text-xs text-slate-500">{role.description}</span>}
              </span>
            </label>
          )
        })}
      </div>
      {error && (
        <p id="role-picker-error" className="mt-1.5 text-sm text-red-700">
          {error}
        </p>
      )}
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
  const [roleId, setRoleId] = useState('')
  const [roleError, setRoleError] = useState<string | undefined>()
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
    mutationFn: (values: CreateUserForm) => api.post<User>('/users', { ...values, roleIds: [roleId] }),
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
          } else if (detail.field === 'roleIds') {
            setRoleError(detail.message)
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
          if (!roleId) {
            setRoleError(ONE_ROLE_MESSAGE)
            return
          }
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
        <RolePicker
          roles={roles}
          selected={roleId}
          error={roleError}
          onChange={(id) => {
            setRoleId(id)
            setRoleError(undefined)
          }}
        />
      </form>
    </Modal>
  )
}

export function EditRolesModal({ user, roles, onClose, onSaved }: { user: User; roles: Role[]; onClose: () => void; onSaved: (user: User) => void }) {
  const queryClient = useQueryClient()
  // Preselected only when the user holds exactly one role; several (from before the rule) must be resolved by a choice.
  const current = user.roles.length === 1 ? (user.roles[0]?.id ?? '') : ''
  const [roleId, setRoleId] = useState(current)
  const unchanged = roleId === current && user.roles.length === 1

  const save = useMutation({
    mutationFn: () => api.put<User>(`/users/${user.id}/roles`, { roleIds: [roleId] }),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      onSaved(updated)
    },
  })

  return (
    <Modal
      title={`Role for ${user.fullName}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!roleId || unchanged}>
            Save role
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        <p className="text-sm text-slate-700">
          Current role:{' '}
          <strong>{user.roles.length === 0 ? 'none' : user.roles.map((role) => role.name).join(', ')}</strong>
        </p>
        {user.roles.length > 1 && (
          <Alert tone="info">This user holds {user.roles.length} roles from before the one-role rule. Choose one: it replaces all of them.</Alert>
        )}
        <RolePicker roles={roles} selected={roleId} onChange={setRoleId} />
        <p className="text-xs text-slate-500">The chosen role replaces the current one. Changes apply immediately.</p>
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
