import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { usePageTitle } from '../../components/hooks'
import { Alert } from '../../components/ui'
import { api } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { AuthNotice, AuthSecondaryLink, AuthSubmitButton, LockIcon, LoginField, MailIcon } from './authUi'

const forgotSchema = z.object({
  email: z.string().trim().min(1, 'Email is required.').pipe(z.email('Enter a valid email address.')),
})

type ForgotForm = z.infer<typeof forgotSchema>

/**
 * Asks for a password reset link. The answer is the same whether or not the
 * email has an account, so the page cannot be used to find out who has one.
 */
export function ForgotPasswordPage() {
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotForm>({ resolver: zodResolver(forgotSchema), defaultValues: { email: '' } })

  usePageTitle('Forgot password')

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null)

    try {
      const result = await api.post<{ message: string }>('/auth/forgot-password', { email: values.email })

      setConfirmation(result.message)
    } catch (error) {
      setFailure(applyApiErrors<ForgotForm>(error, ['email'], setError))
      setAttempts((count) => count + 1)
    }
  })

  if (confirmation !== null) {
    return (
      <div className="login-rise space-y-4">
        <AuthNotice icon={<MailIcon />} tone="success" title="Check your email">
          <p>{confirmation}</p>
          <p>The link works once and expires after a short time. If nothing arrives, check the address or ask your STSLEV administrator to reset your password.</p>
        </AuthNotice>
        <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="login-rise relative space-y-4">
      <AuthNotice icon={<LockIcon />}>
        <p>Enter the email you sign in with. We will send a link to choose a new password.</p>
      </AuthNotice>

      {failure && (
        <div key={attempts} className="login-shake">
          <Alert>{failure}</Alert>
        </div>
      )}

      <LoginField
        label="Email"
        type="email"
        autoComplete="username"
        placeholder="name@company.com"
        icon={<MailIcon />}
        autoFocus
        required
        error={errors.email?.message}
        {...register('email')}
      />

      <AuthSubmitButton busy={isSubmitting}>{isSubmitting ? 'Sending' : 'Send reset link'}</AuthSubmitButton>
      <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
    </form>
  )
}
