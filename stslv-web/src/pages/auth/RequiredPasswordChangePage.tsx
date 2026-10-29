import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate } from 'react-router-dom'
import { z } from 'zod'
import { useAuth } from '../../auth/context'
import { usePageTitle } from '../../components/hooks'
import { Alert } from '../../components/ui'
import { api } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { passwordRule } from '../../lib/password'
import { AuthNotice, AuthSubmitButton, LockIcon, PasswordField } from './authUi'

const changeSchema = z
  .object({
    newPassword: passwordRule,
    confirmation: z.string().min(1, 'Confirm your new password.'),
  })
  .refine((value) => value.newPassword === value.confirmation, { path: ['confirmation'], message: 'The two passwords do not match.' })

type ChangeForm = z.infer<typeof changeSchema>

/**
 * Shown to a user who signed in with a temporary password, instead of every other
 * page, until they choose their own password. The API refuses every other request
 * of such a session, so this screen cannot be skipped by typing an address.
 */
export function RequiredPasswordChangePage() {
  const auth = useAuth()
  const [changed, setChanged] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ChangeForm>({ resolver: zodResolver(changeSchema), defaultValues: { newPassword: '', confirmation: '' } })

  usePageTitle('Change your password')

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null)

    try {
      await api.post<null>('/auth/complete-password-change', { newPassword: values.newPassword })

      // Every session of the account has ended, this one too: sign in again with the new password.
      setChanged(true)
      auth.logout()
    } catch (error) {
      setFailure(applyApiErrors<ChangeForm>(error, ['newPassword'], setError))
      setAttempts((count) => count + 1)
    }
  })

  // Without a session (signed out, or just changed) there is nothing to do here.
  if (auth.status === 'anonymous') {
    return <Navigate to="/login" replace state={changed ? { passwordChanged: true } : null} />
  }

  return (
    <form onSubmit={onSubmit} noValidate className="login-rise relative space-y-3.5">
      <AuthNotice icon={<LockIcon />} tone="warning" title="Choose a new password">
        <p>
          You signed in with a temporary password{auth.user ? ` for ${auth.user.email}` : ''}. Choose your own password to continue. The
          temporary password then stops working.
        </p>
      </AuthNotice>

      {failure && (
        <div key={attempts} className="login-shake">
          <Alert>{failure}</Alert>
        </div>
      )}

      <PasswordField
        label="New password"
        autoComplete="new-password"
        placeholder="At least 10 characters"
        autoFocus
        required
        error={errors.newPassword?.message}
        {...register('newPassword')}
      />
      <PasswordField
        label="Confirm new password"
        autoComplete="new-password"
        placeholder="Repeat your new password"
        required
        error={errors.confirmation?.message}
        {...register('confirmation')}
      />

      <AuthSubmitButton busy={isSubmitting}>{isSubmitting ? 'Saving' : 'Set new password'}</AuthSubmitButton>
      <button
        type="button"
        onClick={auth.logout}
        className="w-full rounded text-center text-sm font-medium text-slate-600 transition-colors hover:text-slate-900 hover:underline"
      >
        Sign out
      </button>
    </form>
  )
}
