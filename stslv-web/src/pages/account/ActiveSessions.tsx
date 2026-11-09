import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Badge, Button, Card, ConfirmDialog, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { describeDevice, type SessionSummary } from '../../lib/sessions'

const SESSIONS_KEY = ['auth', 'sessions'] as const

/**
 * The signed-in user's open sessions (one per sign-in), with "Sign out" for each other device and
 * "Sign out of all devices". The API enforces everything; an older API without sessions shows a note instead.
 */
export function ActiveSessions() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => api.get<SessionSummary[]>('/auth/sessions'), retry: false })

  const revokeOne = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY }),
  })
  const revokeAll = useMutation({
    mutationFn: () => api.post<{ sessionsEnded: number }>('/auth/logout-all'),
    // This device is signed out too.
    onSuccess: () => auth.logout(),
  })

  const items = sessions.data ?? []
  const others = items.filter((session) => !session.current).length

  return (
    <Card className="p-6 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Active sessions</h2>
          <p className="mt-1 text-sm text-slate-600">
            Each place you are signed in. A session ends when you sign out, after a period without use, or when your password changes.
          </p>
        </div>
        <Button variant="danger" disabled={items.length === 0} onClick={() => setConfirming(true)}>
          Sign out of all devices
        </Button>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Sign out of all devices"
          message="Every session of your account ends, including this one. You will need to sign in again."
          confirmLabel="Sign out everywhere"
          danger
          loading={revokeAll.isPending}
          error={revokeAll.isError ? errorMessage(revokeAll.error) : null}
          onConfirm={() => revokeAll.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {revokeOne.isError && (
        <div className="mt-4">
          <Alert>{errorMessage(revokeOne.error)}</Alert>
        </div>
      )}

      <div className="mt-4">
        {sessions.isPending && <Spinner label="Loading sessions" size="sm" />}
        {sessions.isError && <Alert>{errorMessage(sessions.error)}</Alert>}
        {sessions.isSuccess && items.length === 0 && <p className="text-sm text-slate-600">The session list is not available on this server yet.</p>}
        {items.length > 0 && (
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200" aria-label="Active sessions">
            {items.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">
                    {describeDevice(session.userAgent)}
                    {session.current && <Badge tone="green">This device</Badge>}
                  </p>
                  <p className="mt-0.5 text-slate-600">
                    {session.ipAddress ?? 'Unknown address'} · Signed in {formatDateTime(session.createdAt)} · Last active {formatDateTime(session.lastActivityAt)}
                  </p>
                </div>
                {!session.current && (
                  <Button variant="secondary" size="sm" loading={revokeOne.isPending && revokeOne.variables === session.id} onClick={() => revokeOne.mutate(session.id)}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {others > 0 && <p className="mt-2 text-xs text-slate-500">Signing out another device ends its session at once; it must sign in again.</p>}
      </div>
    </Card>
  )
}
