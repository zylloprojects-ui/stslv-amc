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
