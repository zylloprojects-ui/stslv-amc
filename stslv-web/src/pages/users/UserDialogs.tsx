import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Alert, Button, Modal, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { passwordRule } from '../../lib/password'
import type { Role, User } from '../../lib/types'

const PASSWORD_HINT = 'At least 10 characters. Give it to the user privately; they can change it under My account.'

/** The API's message when a request names no role or several: each user holds exactly one role. */
export const ONE_ROLE_MESSAGE = 'Select exactly one role.'

/** Whether the signed-in user may give this role: active and within their authority (Super Admin and Admin only by Super Admin). */
const canAssign = (role: Role) => role.assignable ?? role.isActive

/**
 * Exactly one role per user (approved 2026-10-29), chosen from the roles the signed-in user may assign.
 * The user's current role is listed too, even when it cannot be chosen again. The API enforces the same rules.
 */
function RolePicker({
  roles,
  selected,
  onChange,
  error,
  currentIds = [],
}: {
  roles: Role[]
  selected: string
  onChange: (id: string) => void
  error?: string
  currentIds?: string[]
}) {
  const listed = roles.filter((role) => canAssign(role) || currentIds.includes(role.id))

  return (
    <fieldset aria-describedby={error ? 'role-picker-error' : undefined}>
      <legend className="mb-1.5 text-sm font-bold text-slate-800">
        Role <span className="font-normal text-slate-500">(one per user)</span>
      </legend>
      <div className={cx('divide-y divide-slate-200 overflow-hidden rounded-lg border', error ? 'border-red-400' : 'border-slate-300')}>
        {listed.map((role) => {
          const on = selected === role.id
          const choosable = canAssign(role)

          return (
            <label
              key={role.id}
              className={cx(
                'flex items-start gap-3 px-3.5 py-2',
                choosable ? 'cursor-pointer hover:bg-sky-50/60' : 'cursor-not-allowed opacity-60',
                on && 'bg-sky-50',
              )}
            >
              <input
                type="radio"
                name="role"
                className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer accent-[#1479BD]"
                checked={on}
                disabled={!choosable}
                onChange={() => onChange(role.id)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900">
                  {role.name}
                  {!role.isActive && <span className="ml-1.5 text-xs font-normal">(inactive)</span>}
                  {currentIds.includes(role.id) && <span className="ml-1.5 text-xs font-normal text-slate-500">(current)</span>}
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
        <RolePicker roles={roles} selected={roleId} onChange={setRoleId} currentIds={user.roles.map((role) => role.id)} />
        <p className="text-xs text-slate-500">The chosen role replaces the current one. Changes apply immediately.</p>
      </div>
    </Modal>
  )
}

interface IssuedTemporaryPassword {
  temporaryPassword: string
  expiresAt: string
}

/**
 * Issues a temporary password in two steps: the administrator confirms they have
 * verified who is asking, then the password is shown once to be passed on privately.
 * It lives only in this dialog: closing it discards the password for good.
 */
export function TemporaryPasswordModal({ user, onClose, onIssued }: { user: User; onClose: () => void; onIssued: () => void }) {
  const queryClient = useQueryClient()
  const [verified, setVerified] = useState(false)
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)

  const issue = useMutation({
    mutationFn: () => api.post<IssuedTemporaryPassword>(`/users/${user.id}/temporary-password`, { identityVerified: true }),
    // Not kept in the mutation cache after the dialog closes.
    gcTime: 0,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['users'] })
      onIssued()
    },
  })

  const issued = issue.data

  const copy = async () => {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.temporaryPassword)
      setCopied('yes')
    } catch {
      setCopied('failed')
    }
  }

  if (issued) {
    return (
      <Modal
        title="Temporary password issued"
        onClose={onClose}
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="space-y-4 text-sm text-slate-700">
          <p>
            Give this password privately to <strong>{user.fullName}</strong> ({user.email}). It is shown only now: once this window is
            closed it cannot be displayed again.
          </p>
          <div className="flex items-center gap-2">
            <output
              aria-label="Temporary password"
              className="flex-1 select-all rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-center font-mono text-lg tracking-wider text-slate-900"
            >
              {issued.temporaryPassword}
            </output>
            <Button variant="secondary" onClick={() => void copy()}>
              {copied === 'yes' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {copied === 'failed' && <Alert>The password could not be copied. Select it and copy it by hand.</Alert>}
          <ul className="list-disc space-y-1 pl-5">
            <li>It expires at {formatDateTime(issued.expiresAt)} (15 minutes) and works for one sign-in.</li>
            <li>At sign-in, {user.fullName} must choose a new password before using the system.</li>
            <li>Their previous password and every open session have stopped working.</li>
          </ul>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="Generate temporary password"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={issue.isPending}>
            Cancel
          </Button>
          <Button onClick={() => issue.mutate()} loading={issue.isPending} disabled={!verified}>
            Generate temporary password
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-700">
        {issue.isError && <Alert>{errorMessage(issue.error)}</Alert>}
        <p>
          <strong>{user.fullName}</strong>
          <span className="block break-all">{user.email}</span>
        </p>
        <p>
          A random temporary password replaces their current password at once and signs them out everywhere. It works for 15 minutes,
          and they must choose a new password when they sign in with it.
        </p>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-[18px] w-[18px] shrink-0 cursor-pointer rounded border-slate-300 accent-[#1479BD]"
            checked={verified}
            onChange={(event) => setVerified(event.target.checked)}
          />
          <span>I have verified that the person asking is {user.fullName}, the owner of this account.</span>
        </label>
      </div>
    </Modal>
  )
}
