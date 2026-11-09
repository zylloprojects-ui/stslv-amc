import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { describeDevice, type SessionSummary } from '../../lib/sessions'

interface OpenSessions {
  items: (SessionSummary & { user: { id: string; fullName: string; email: string } })[]
  idleTimeoutMinutes: number
  /** False on a database without migration 0108: there are no server-side sessions to list. */
  enabled: boolean
}

const KEY = ['security', 'sessions'] as const

/**
 * Every open session, for administrators (Security Center). Signing a session or a user out needs USERS:EDIT; the
 * API also applies the user-management rules (Admin cannot act on Super Admin or Admin accounts) and says so.
 */
export function ActiveSessionsPanel() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const canEnd = auth.can('USERS', 'EDIT')
  const sessions = useQuery({ queryKey: KEY, queryFn: () => api.get<OpenSessions>('/security/sessions'), refetchInterval: 60_000 })
  const [signOutUser, setSignOutUser] = useState<{ id: string; name: string } | null>(null)

  const endOne = useMutation({
    mutationFn: (session: { userId: string; id: string }) => api.delete(`/users/${session.userId}/sessions/${session.id}`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  })
  const endAll = useMutation({
    mutationFn: (userId: string) => api.post(`/users/${userId}/sessions/revoke`),
    onSuccess: () => setSignOutUser(null),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  })

  const data = sessions.data

  return (
    <Card className="rounded-2xl">
      <h2 className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-3 text-base font-bold text-[#0b3b66]">
        Active sessions
        {data?.enabled && <span className="text-xs font-medium text-slate-500">Ends after {data.idleTimeoutMinutes} minutes without use</span>}
        {data && <span className="ml-auto rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-semibold text-sky-900 ring-1 ring-inset ring-sky-200">{data.items.length} open</span>}
      </h2>

      {sessions.isPending && <div className="p-5"><Spinner label="Loading sessions" size="sm" /></div>}
      {sessions.isError && <div className="p-5"><Alert>{errorMessage(sessions.error)}</Alert></div>}
      {endOne.isError && <div className="px-5 pt-4"><Alert>{errorMessage(endOne.error)}</Alert></div>}
      {data && !data.enabled && <EmptyState title="Server-side sessions are not enabled" description="This database does not have the sessions update yet (migration 0108)." />}
      {data?.enabled && data.items.length === 0 && <EmptyState title="No open sessions" />}

      {data?.enabled && data.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <tr>
                <th scope="col" className="px-5 py-2">User</th>
                <th scope="col" className="px-3 py-2">Device</th>
                <th scope="col" className="px-3 py-2">Address</th>
                <th scope="col" className="px-3 py-2">Signed in</th>
                <th scope="col" className="px-3 py-2">Last active</th>
                {canEnd && <th scope="col" className="px-5 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.items.map((session) => (
                <tr key={session.id}>
                  <td className="px-5 py-2">
                    <span className="font-semibold text-slate-900">{session.user.fullName}</span>
                    <span className="block text-xs text-slate-500">{session.user.email}</span>
                  </td>
                  <td className="px-3 py-2">
                    {describeDevice(session.userAgent)} {session.current && <Badge tone="green">You</Badge>} {session.passwordChange && <Badge tone="amber">Temporary password</Badge>}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{session.ipAddress ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-700">{formatDateTime(session.createdAt)}</td>
                  <td className="px-3 py-2 text-slate-700">{formatDateTime(session.lastActivityAt)}</td>
                  {canEnd && (
                    <td className="space-x-2 whitespace-nowrap px-5 py-2 text-right">
                      {!session.current && (
                        <Button size="sm" variant="secondary" loading={endOne.isPending && endOne.variables?.id === session.id} onClick={() => endOne.mutate({ userId: session.user.id, id: session.id })}>
                          Sign out
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setSignOutUser({ id: session.user.id, name: session.user.fullName })}>
                        All devices
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {signOutUser && (
        <ConfirmDialog
          title="Sign out of all devices"
          message={`Every session of ${signOutUser.name} ends at once. They will need to sign in again.`}
          confirmLabel="Sign out everywhere"
          danger
          loading={endAll.isPending}
          error={endAll.isError ? errorMessage(endAll.error) : null}
          onConfirm={() => endAll.mutate(signOutUser.id)}
          onCancel={() => {
            endAll.reset()
            setSignOutUser(null)
          }}
        />
      )}
    </Card>
  )
}
