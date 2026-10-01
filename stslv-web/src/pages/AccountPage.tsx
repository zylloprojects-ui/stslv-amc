import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useAuth } from '../auth/context'
import { Alert, Badge, Button, Card, PageHeader, TextField } from '../components/ui'
import { api, ApiError, errorMessage } from '../lib/api'
import { passwordRule } from '../lib/password'

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required.'),
    newPassword: passwordRule,
    confirmation: z.string(),
  })
  .refine((value) => value.newPassword === value.confirmation, {
    path: ['confirmation'],
    message: 'The two passwords do not match.',
  })

type ChangePasswordForm = z.infer<typeof changePasswordSchema>

export function AccountPage() {
  const auth = useAuth()
  const [done, setDone] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmation: '' },
  })

  const change = useMutation({
    mutationFn: (values: ChangePasswordForm) =>
      api.post<{ token: string }>('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
    onSuccess: (result) => {
      // Older tokens are now invalid; continue this session with the new one.
      auth.replaceToken(result.token)
      reset()
      setDone(true)
    },
    onError: (error) => {
      let shownOnField = false

      if (error instanceof ApiError) {
        for (const detail of error.details) {
          if (detail.field === 'currentPassword' || detail.field === 'newPassword') {
            setError(detail.field, { message: detail.message })
            shownOnField = true
          }
        }
      }

      setFailure(shownOnField ? null : errorMessage(error))
    },
  })

  return (
    <>
      <PageHeader title="My Account" />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="self-start p-6">
          <h2 className="text-base font-semibold text-slate-900">Account information</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="font-medium text-slate-500">Name</dt>
              <dd className="mt-0.5 break-words text-slate-900">{auth.user?.fullName}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Email</dt>
              <dd className="mt-0.5 break-all text-slate-900">{auth.user?.email}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-500">Roles</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {auth.user?.roles.length === 0 && <span className="text-slate-500">No role assigned</span>}
                {auth.user?.roles.map((role) => (
                  <Badge key={role.id} tone="blue">
                    {role.name}
                  </Badge>
                ))}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-slate-500">Your name and roles are managed by an administrator.</p>
        </Card>

        <Card className="p-6">
          <h2 className="text-base font-semibold text-slate-900">Change password</h2>
          <form
            noValidate
            className="mt-4 space-y-4"
            onSubmit={handleSubmit((values) => {
              setDone(false)
              setFailure(null)
              change.mutate(values)
            })}
          >
            {done && (
              <Alert tone="success" onDismiss={() => setDone(false)}>
                Your password was changed. Other devices have been signed out.
              </Alert>
            )}
            {failure && <Alert>{failure}</Alert>}
            <TextField
              label="Current password"
              type="password"
              required
              autoComplete="current-password"
              error={errors.currentPassword?.message}
              {...register('currentPassword')}
            />
            <TextField
              label="New password"
              type="password"
              required
              autoComplete="new-password"
              hint="At least 10 characters."
              error={errors.newPassword?.message}
              {...register('newPassword')}
            />
            <TextField
              label="Repeat new password"
              type="password"
              required
              autoComplete="new-password"
              error={errors.confirmation?.message}
              {...register('confirmation')}
            />
            <Button type="submit" loading={change.isPending}>
              Change password
            </Button>
          </form>
        </Card>
      </div>
    </>
  )
}
