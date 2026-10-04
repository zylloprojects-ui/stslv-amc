import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { useAuth } from '../../auth/context'
import { Alert, TextField } from '../../components/ui'
import { api, ApiError, errorMessage } from '../../lib/api'
import { passwordRule } from '../../lib/password'

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

type Values = z.infer<typeof changePasswordSchema>

interface ChangePasswordFormProps {
  /** The id of the <form>, so a button elsewhere (a dialog's footer) can submit it with form="...". */
  id: string
  /** Tells the parent whether the request is running, to show a busy button. */
  onPending?: (pending: boolean) => void
  /** Called once the password was changed. */
  onChanged?: () => void
}

/**
 * The change-password form, used by the My Account page and by the pop-up in Settings.
 * The submit button is left to the parent, so the form fits both a page and a dialog.
 */
export function ChangePasswordForm({ id, onPending, onChanged }: ChangePasswordFormProps) {
  const auth = useAuth()
  const [done, setDone] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmation: '' },
  })

  const change = useMutation({
    mutationFn: (values: Values) =>
      api.post<{ token: string }>('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
    onSuccess: (result) => {
      // Older tokens are now invalid; continue this session with the new one.
      auth.replaceToken(result.token)
      reset()
      setDone(true)
      onChanged?.()
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

  useEffect(() => {
    onPending?.(change.isPending)
  }, [change.isPending, onPending])

  return (
    <form
      id={id}
      noValidate
      className="space-y-4"
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
      <TextField label="Current password" type="password" required autoComplete="current-password" error={errors.currentPassword?.message} {...register('currentPassword')} />
      <TextField
        label="New password"
        type="password"
        required
        autoComplete="new-password"
        hint="At least 10 characters."
        error={errors.newPassword?.message}
        {...register('newPassword')}
      />
      <TextField label="Repeat new password" type="password" required autoComplete="new-password" error={errors.confirmation?.message} {...register('confirmation')} />
    </form>
  )
}
