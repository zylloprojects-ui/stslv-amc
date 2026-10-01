import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation } from 'react-router-dom'
import { z } from 'zod'
import { useAuth } from '../auth/context'
import { usePageTitle } from '../components/hooks'
import { Alert, Button, Spinner, TextField } from '../components/ui'
import { errorMessage } from '../lib/api'

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required.').pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Password is required.'),
})

type LoginForm = z.infer<typeof loginSchema>

export function LoginPage() {
  const auth = useAuth()
  const location = useLocation()
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })

  usePageTitle('Sign in')

  if (auth.status === 'authenticated') {
    const from = (location.state as { from?: string } | null)?.from

    return <Navigate to={from && from !== '/login' ? from : '/dashboard'} replace />
  }

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null)

    try {
      await auth.login(values.email, values.password)
    } catch (error) {
      setFailure(errorMessage(error))
    }
  })

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-blue-700 text-xl font-bold text-white" aria-hidden="true">
            S
          </span>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight text-slate-900">STSLV AMC</h1>
          <p className="mt-1 text-sm text-slate-600">Sign in to your account</p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          {auth.status === 'loading' ? (
            <Spinner label="Checking your session" />
          ) : (
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              {failure && <Alert>{failure}</Alert>}

              <TextField label="Email" type="email" autoComplete="username" autoFocus required error={errors.email?.message} {...register('email')} />
              <TextField
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                error={errors.password?.message}
                {...register('password')}
              />

              <Button type="submit" loading={isSubmitting} className="w-full">
                {isSubmitting ? 'Signing in' : 'Login'}
              </Button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-slate-600">Accounts are created by an administrator.</p>
      </div>
    </main>
  )
}
