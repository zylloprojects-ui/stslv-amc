import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { useAuth } from '../../auth/context'
import { usePageTitle } from '../../components/hooks'
import { Alert, Button, Spinner } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { passwordRule } from '../../lib/password'
import { AlertIcon, AuthNotice, AuthPrimaryLink, AuthSecondaryLink, AuthSubmitButton, PasswordField } from './authUi'

type LinkStatus = 'valid' | 'invalid' | 'expired' | 'used'

const resetSchema = z
  .object({
    password: passwordRule,
    confirmation: z.string().min(1, 'Confirm your new password.'),
  })
  .refine((value) => value.password === value.confirmation, { path: ['confirmation'], message: 'The two passwords do not match.' })

type ResetForm = z.infer<typeof resetSchema>

const DEAD_LINKS: Record<Exclude<LinkStatus, 'valid'>, { title: string; text: string }> = {
  invalid: {
    title: 'This link is not valid',
    text: 'The reset link is incomplete, was replaced by a newer one, or does not exist. Request a new link to continue.',
  },
  expired: {
    title: 'This link has expired',
    text: 'Reset links only work for a short time. Request a new link to continue.',
  },
  used: {
    title: 'This link has already been used',
    text: 'Each reset link works once. If you still need to change your password, request a new link.',
  },
}

// What the API says about a link that can no longer be used.
const REFUSALS: Record<string, Exclude<LinkStatus, 'valid'>> = {
  RESET_TOKEN_INVALID: 'invalid',
  RESET_TOKEN_EXPIRED: 'expired',
  RESET_TOKEN_USED: 'used',
}

/** The token is carried after "#" in the link, which the browser never sends to a server. */
function tokenFrom(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token')?.trim() || null
}

/** Opened from the emailed link: checks the link, then lets the person choose a new password. */
export function ResetPasswordPage() {
  const auth = useAuth()
  const navigate = useNavigate()
  const token = tokenFrom(useLocation().hash)
  // Set when the API refuses the link at the moment the new password is sent.
  const [refused, setRefused] = useState<Exclude<LinkStatus, 'valid'> | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({ resolver: zodResolver(resetSchema), defaultValues: { password: '', confirmation: '' } })

  usePageTitle('Reset password')

  const link = useQuery({
    queryKey: ['auth', 'reset-link', token],
    queryFn: () => api.post<{ status: LinkStatus }>('/auth/reset-password/check', { token }),
    enabled: token !== null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null)

    try {
      await api.post<null>('/auth/reset-password', { token, password: values.password })

      // Every earlier session of this account is now invalid, including one on this browser.
      if (auth.status !== 'anonymous') {
        auth.logout()
      }
      // The sign in page confirms the reset (see LoginPage).
      navigate('/login', { replace: true, state: { passwordReset: true } })
    } catch (error) {
      const refusal = error instanceof ApiError ? REFUSALS[error.code] : undefined

      if (refusal) {
        setRefused(refusal)
        return
      }

      setFailure(applyApiErrors<ResetForm>(error, ['password'], setError))
      setAttempts((count) => count + 1)
    }
  })

  const status: LinkStatus | null = refused ?? (token === null ? 'invalid' : (link.data?.status ?? null))

  if (status === null && link.isError) {
    return (
      <div className="login-rise space-y-4">
        <Alert>{errorMessage(link.error)}</Alert>
        <Button variant="secondary" className="w-full" onClick={() => void link.refetch()}>
          Try again
        </Button>
        <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
      </div>
    )
  }

  if (status === null) {
    return <Spinner label="Checking your reset link" />
  }

  if (status !== 'valid') {
    return (
      <div className="login-rise space-y-4">
        <AuthNotice icon={<AlertIcon />} tone="warning" title={DEAD_LINKS[status].title}>
          <p>{DEAD_LINKS[status].text}</p>
        </AuthNotice>
        <AuthPrimaryLink to="/forgot-password">Request a new link</AuthPrimaryLink>
        <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="login-rise relative space-y-3.5">
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
        error={errors.password?.message}
        {...register('password')}
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
      <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
    </form>
  )
}
