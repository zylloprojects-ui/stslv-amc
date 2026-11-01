import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Pager } from '../../components/records'
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { actionLabel } from './auditTypes'

interface EventList {
  items: { id: string; action: string; description: string | null; user: string | null; ip: string | null; createdAt: string }[]
  total: number
  page: number
  pageSize: number
  actions: string[]
}

const CHECK_TONE = { OK: 'bg-emerald-100 text-emerald-800 ring-emerald-200', ATTENTION: 'bg-amber-100 text-amber-900 ring-amber-200', UNAVAILABLE: 'bg-slate-200 text-slate-800 ring-slate-300' }
const CHECK_LABEL = { OK: 'OK', ATTENTION: 'Attention', UNAVAILABLE: 'Not available' }

interface Overview {
  users: { total: number; active: number; inactive: number; pendingApproval: number; mustChangePassword: number; activeWithoutRole: number; administrators: number }
  roles: { id: string; code: string; name: string; isActive: boolean; activeUsers: number }[]
  signIns30Days: { succeeded: number; failed: number }
  checks: { id: string; label: string; state: 'OK' | 'ATTENTION' | 'UNAVAILABLE'; detail: string }[]
  configuration: {
    sessionHours: number
    passwordHashRounds: number
    loginRequestsPer15Min: number
    failedLoginsPer15Min: number
    signUpRequestsPer15Min: number
    temporaryPasswordsPer15Min: number
    allowedWebOrigins: number
    attachmentsConfigured: boolean
    backupsAvailable: boolean
  }
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="mt-1 text-2xl font-bold tabular-nums text-[#0b3b66]">{value}</dd>
    </div>
  )
}

const LINK = 'rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-[#0b3b66] shadow-sm hover:border-[#1479BD] hover:text-[#1479BD]'

/** What is in force and what has been recorded. Read-only; changes are made on the linked pages. */
export function SecurityCenterPage() {
  const overview = useQuery({ queryKey: ['security', 'overview'], queryFn: () => api.get<Overview>('/security/overview') })
  const data = overview.data
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const events = useQuery({ queryKey: ['security', 'events', action, page], queryFn: () => api.get<EventList>(`/security/events${queryString({ action, page, pageSize: 20 })}`), placeholderData: keepPreviousData })

  return (
    <>
      <PageHeader title="Security Center" description="Access, sign-in activity and the security settings in force. Read only." />

      {overview.isPending && <Spinner label="Loading security overview" />}
      {overview.isError && <Alert>{errorMessage(overview.error)}</Alert>}

      {data && (
        <div className="space-y-5">
          <nav aria-label="Security pages" className="flex flex-wrap gap-2">
            <Link to="/admin/users" className={LINK}>Users & Access</Link>
            <Link to="/admin/roles" className={LINK}>Roles & Permissions</Link>
            <Link to="/admin/login-history" className={LINK}>Login History</Link>
            <Link to="/admin/audit-log" className={LINK}>Audit Log</Link>
            <Link to="/admin/deletion-log" className={LINK}>Deletion Log</Link>
            <Link to="/admin/backups" className={LINK}>Backup & Restore</Link>
          </nav>

          <Card>
            <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">Health checks</h2>
            <ul className="divide-y divide-slate-100">
              {data.checks.map((check) => (
                <li key={check.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-2.5 text-sm">
                  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${CHECK_TONE[check.state]}`}>{CHECK_LABEL[check.state]}</span>
                  <span className="font-medium text-slate-900">{check.label}</span>
                  <span className="min-w-0 break-words text-slate-600">{check.detail}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">User access</h2>
            <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
              <Figure label="Active users" value={data.users.active} />
              <Figure label="Inactive users" value={data.users.inactive} />
              <Figure label="Administrators" value={data.users.administrators} />
              <Figure label="Awaiting approval" value={data.users.pendingApproval} />
              <Figure label="Must change password" value={data.users.mustChangePassword} />
              <Figure label="Active without a role" value={data.users.activeWithoutRole} />
            </dl>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">Roles</h2>
              <ul className="divide-y divide-slate-100">
                {data.roles.map((role) => (
                  <li key={role.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                    <span className="min-w-0 break-words font-medium text-slate-800">
                      {role.name}
                      {!role.isActive && <span className="ml-2 text-xs font-normal text-slate-500">Inactive</span>}
                    </span>
                    <span className="shrink-0 tabular-nums text-slate-600">
                      {role.activeUsers} {role.activeUsers === 1 ? 'user' : 'users'}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">Settings in force</h2>
              <dl className="divide-y divide-slate-100 text-sm">
                {[
                  ['Sign-in lasts', `${data.configuration.sessionHours} hours`],
                  ['Password hashing', `bcrypt, ${data.configuration.passwordHashRounds} rounds`],
                  ['Sign-in requests per address', `${data.configuration.loginRequestsPer15Min} per 15 minutes`],
                  ['Failed sign-ins per email and address', `${data.configuration.failedLoginsPer15Min} per 15 minutes`],
                  ['Sign-up requests per address', `${data.configuration.signUpRequestsPer15Min} per 15 minutes`],
                  ['Temporary passwords per administrator', `${data.configuration.temporaryPasswordsPer15Min} per 15 minutes`],
                  ['Allowed web addresses', String(data.configuration.allowedWebOrigins)],
                  ['Document storage', data.configuration.attachmentsConfigured ? 'Configured' : 'Not configured'],
                  ['Backups from this application', data.configuration.backupsAvailable ? 'Available' : 'Not available'],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-4 px-5 py-2.5">
                    <dt className="text-slate-600">{label}</dt>
                    <dd className="text-right font-medium text-slate-900">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="border-t border-slate-200 px-5 py-3 text-xs text-slate-600">
                Deactivating a user or changing a role takes effect on their next request. Open sessions are not listed, and there is no sign-out for other users. Both are done from Users & Access.
              </p>
            </Card>
          </div>

          <Card>
            <h2 className="border-b border-slate-200 px-5 py-3 text-base font-semibold text-slate-900">Security events</h2>
            <p className="border-b border-slate-200 px-5 py-3 text-sm text-slate-600">
              Last 30 days: <span className="font-semibold text-slate-900">{data.signIns30Days.succeeded}</span> successful sign-ins, <span className="font-semibold text-slate-900">{data.signIns30Days.failed}</span> failed.
            </p>
            <div className="border-b border-slate-200 p-4 sm:max-w-sm sm:px-5">
              <Filter label="Event type">
                {(id, className) => (
                  <select
                    id={id}
                    value={action}
                    onChange={(event) => {
                      setAction(event.target.value)
                      setPage(1)
                    }}
                    className={className}
                  >
                    <option value="">All events</option>
                    {(events.data?.actions ?? []).map((value) => (
                      <option key={value} value={value}>
                        {actionLabel(value)}
                      </option>
                    ))}
                  </select>
                )}
              </Filter>
            </div>
            {events.isError && <div className="p-4"><Alert>{errorMessage(events.error)}</Alert></div>}
            {events.data?.items.length === 0 ? (
              <EmptyState title="No security events recorded" />
            ) : (
              <ol className="divide-y divide-slate-100" aria-label="Security events, newest first">
                {(events.data?.items ?? []).map((event) => (
                  <li key={event.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <p className="text-sm font-semibold text-slate-900">{actionLabel(event.action)}</p>
                      <p className="text-xs text-slate-500">
                        <time dateTime={event.createdAt}>{formatDateTime(event.createdAt)}</time> · {event.user ?? 'System'}
                        {event.ip ? ` · ${event.ip}` : ''}
                      </p>
                    </div>
                    {event.description && <p className="mt-1 break-words text-sm text-slate-700">{event.description}</p>}
                  </li>
                ))}
              </ol>
            )}
            {events.data && events.data.total > events.data.pageSize && <Pager page={events.data.page} pageSize={events.data.pageSize} total={events.data.total} shown={events.data.items.length} onPage={setPage} />}
          </Card>
        </div>
      )}
    </>
  )
}
