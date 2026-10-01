import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { usePageTitle } from '../../components/hooks'
import { Alert } from '../../components/ui'
import { api } from '../../lib/api'
import { applyApiErrors } from '../../lib/formErrors'
import { passwordRule } from '../../lib/password'
import { AuthNotice, AuthSecondaryLink, AuthSubmitButton, CheckIcon, LoginField, MailIcon, PasswordField, UserIcon } from './authUi'

const signUpSchema = z
  .object({
    fullName: z.string().trim().min(1, 'Full name is required.').max(200, 'Full name must be at most 200 characters.'),
    email: z.string().trim().min(1, 'Email is required.').pipe(z.email('Enter a valid email address.')),
    password: passwordRule,
    confirmation: z.string().min(1, 'Confirm your password.'),
  })
  .refine((value) => value.password === value.confirmation, { path: ['confirmation'], message: 'The two passwords do not match.' })

type SignUpForm = z.infer<typeof signUpSchema>

/**
 * Asks for an account. The request is stored as pending: the person cannot sign
 * in until an administrator assigns a role and activates it in Users & Access.
 * No role or permission can be chosen here.
 */
export function SignUpPage() {
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [attempts, setAttempts] = useState(0)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignUpForm>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { fullName: '', email: '', password: '', confirmation: '' },
  })

  usePageTitle('Sign up')

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null)

    try {
      const result = await api.post<{ message: string }>('/auth/signup', {
        fullName: values.fullName,
        email: values.email,
        password: values.password,
      })

      setSubmitted(result.message)
    } catch (error) {
      setFailure(applyApiErrors<SignUpForm>(error, ['fullName', 'email', 'password'], setError))
      setAttempts((count) => count + 1)
    }
  })

  if (submitted !== null) {
    return (
      <div className="login-rise space-y-4" role="tabpanel">
        <AuthNotice icon={<CheckIcon />} tone="success" title="Registration submitted">
          <p>{submitted}</p>
          <p>If this email already has an account, nothing was changed. Use Forgot password instead.</p>
        </AuthNotice>
        <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="login-rise relative space-y-3.5" role="tabpanel">
      {failure && (
        <div key={attempts} className="login-shake">
          <Alert>{failure}</Alert>
        </div>
      )}

      <LoginField
        label="Full name"
        autoComplete="name"
        placeholder="Your full name"
        icon={<UserIcon />}
        autoFocus
        required
        error={errors.fullName?.message}
        {...register('fullName')}
      />
      <LoginField
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="name@company.com"
        icon={<MailIcon />}
        required
        error={errors.email?.message}
        {...register('email')}
      />
      <PasswordField
        label="Password"
        autoComplete="new-password"
        placeholder="At least 10 characters"
        required
        error={errors.password?.message}
        {...register('password')}
      />
      <PasswordField
        label="Confirm password"
        autoComplete="new-password"
        placeholder="Repeat your password"
        required
        error={errors.confirmation?.message}
        {...register('confirmation')}
      />

      <AuthSubmitButton busy={isSubmitting}>{isSubmitting ? 'Submitting' : 'Request account'}</AuthSubmitButton>
      <AuthSecondaryLink to="/login">← Back to sign in</AuthSecondaryLink>
    </form>
  )
}
