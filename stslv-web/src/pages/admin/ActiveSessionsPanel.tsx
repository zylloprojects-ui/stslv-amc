import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/context'
import { ActionButton, ActionGroup } from '../../components/IconActions'
import { Alert, Badge, Card, ConfirmDialog, EmptyState, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { describeDevice, type SessionSummary } from '../../lib/sessions'
import { TABLE } from '../../components/table'

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
        // The shared table styles, so this table looks like every other one (headings on one line, scrolls in its card).
        <div className={TABLE.wrapper}>
          <table className={TABLE.table}>
            <thead>
              <tr>
                <th scope="col" className={TABLE.th}>User</th>
                <th scope="col" className={TABLE.th}>Device</th>
                <th scope="col" className={TABLE.th}>Address</th>
                <th scope="col" className={TABLE.th}>Signed In</th>
                <th scope="col" className={TABLE.th}>Last Active</th>
                {canEnd && <th scope="col" className={`${TABLE.th} text-right`}>Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((session) => (
                <tr key={session.id} className={TABLE.row}>
                  <td className={`${TABLE.td} ${TABLE.unbroken}`}>
                    <span className="font-semibold text-slate-900">{session.user.fullName}</span>
                    <span className="block text-xs text-slate-500">{session.user.email}</span>
                  </td>
                  <td className={TABLE.td}>
                    {describeDevice(session.userAgent)} {session.current && <Badge tone="green">You</Badge>} {session.passwordChange && <Badge tone="amber">Temporary password</Badge>}
                  </td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{session.ipAddress ?? '—'}</td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{formatDateTime(session.createdAt)}</td>
                  <td className={`${TABLE.td} whitespace-nowrap`}>{formatDateTime(session.lastActivityAt)}</td>
                  {canEnd && (
                    <td className={`${TABLE.td} space-x-2 whitespace-nowrap text-right`}>
                      <ActionGroup>
                        {!session.current && (
                          <ActionButton
                            icon="signOut"
                            label="Sign out"
                            hint={`Sign out this session of ${session.user.fullName}`}
                            loading={endOne.isPending && endOne.variables?.id === session.id}
                            onClick={() => endOne.mutate({ userId: session.user.id, id: session.id })}
                          />
                        )}
                        <ActionButton
                          icon="devices"
                          label="All devices"
                          hint={`Sign ${session.user.fullName} out of all devices`}
                          onClick={() => setSignOutUser({ id: session.user.id, name: session.user.fullName })}
                        />
                      </ActionGroup>
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
