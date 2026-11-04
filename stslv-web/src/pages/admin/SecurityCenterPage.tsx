import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Pager } from '../../components/records'
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { IconTile, type IconName } from '../dashboard/icons'
import { actionLabel } from './auditTypes'

interface EventList {
  items: { id: string; action: string; description: string | null; user: string | null; ip: string | null; createdAt: string }[]
  total: number
  page: number
  pageSize: number
  actions: string[]
}

const CHECK_TONE = { OK: 'bg-emerald-100 text-emerald-800 ring-emerald-200', ATTENTION: 'bg-amber-100 text-amber-900 ring-amber-200', UNAVAILABLE: 'bg-slate-200 text-slate-800 ring-slate-300' }
const CHECK_STYLE = {
  OK: { card: 'border-emerald-200 bg-emerald-50', badge: 'bg-emerald-500', icon: 'm4.5 10.5 3.5 3.5 7.5-8' },
  ATTENTION: { card: 'border-amber-300 bg-amber-50', badge: 'bg-amber-500', icon: 'M10 5v6M10 14.5v.5' },
  UNAVAILABLE: { card: 'border-slate-200 bg-slate-50', badge: 'bg-slate-400', icon: 'M6 10h8' },
}
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
    /** Which kind of store: a private Supabase Storage or Cloudflare R2 bucket, a local folder, or none. Absent from older APIs. */
    attachmentsStorage?: 'SUPABASE' | 'R2' | 'LOCAL' | 'NONE'
    backupsAvailable: boolean
  }
}

type Tone = { from: string; to: string }
const BLUE: Tone = { from: '#1479BD', to: '#4aa3df' }
const GREEN: Tone = { from: '#059669', to: '#34D399' }
const AMBER: Tone = { from: '#EA580C', to: '#FBBF24' }
const SLATE: Tone = { from: '#64748B', to: '#94A3B8' }

function Figure({ label, value, icon, tone, attention = false }: { label: string; value: number; icon: IconName; tone: Tone; attention?: boolean }) {
  // A count that needs someone's attention is shown in the warning colour once it is above zero.
  const warn = attention && value > 0
  const colour = warn ? AMBER : tone

  return (
    <div className={cx('relative min-w-0 overflow-hidden rounded-2xl border bg-white p-4 pt-5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md', warn ? 'border-amber-300 bg-amber-50' : 'border-slate-200')}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundImage: `linear-gradient(90deg, ${colour.from}, ${colour.to})` }} aria-hidden="true" />
      <div className="flex items-center justify-between gap-3">
        <IconTile icon={icon} from={colour.from} to={colour.to} className="h-10 w-10 shrink-0 rounded-xl" />
        <dd className={cx('text-4xl font-extrabold leading-none tabular-nums', warn ? 'text-amber-800' : 'text-[#0b3b66]')}>{value}</dd>
      </div>
      <dt className="mt-3 text-xs font-bold uppercase leading-snug tracking-[0.1em] text-slate-500">{label}</dt>
    </div>
  )
}

const LINK =
  'group flex items-center gap-4 rounded-xl border-[1.5px] border-slate-300 bg-white px-4 py-3.5 text-sm font-semibold text-[#0b3b66] shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#1479BD] hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1479BD]'

const LINKS: { to: string; label: string; icon: IconName; tone: Tone }[] = [
  { to: '/admin/users', label: 'Users & Access', icon: 'users', tone: BLUE },
  { to: '/admin/roles', label: 'Roles & Permissions', icon: 'shield', tone: { from: '#7C3AED', to: '#A78BFA' } },
  { to: '/admin/login-history', label: 'Login History', icon: 'pulse', tone: GREEN },
  { to: '/admin/audit-log', label: 'Audit Log', icon: 'contract', tone: { from: '#0891B2', to: '#22D3EE' } },
  { to: '/admin/deletion-log', label: 'Recycle Bin', icon: 'project', tone: { from: '#DC2626', to: '#F87171' } },
  { to: '/settings/backups', label: 'Backup & Restore', icon: 'settings', tone: SLATE },
]

function SectionTitle({ icon, tone, children }: { icon: IconName; tone: Tone; children: ReactNode }) {
  return (
    <h2 className="flex items-center gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-3 text-base font-bold text-[#0b3b66]">
      <IconTile icon={icon} from={tone.from} to={tone.to} className="h-8 w-8 rounded-lg" />
      {children}
    </h2>
  )
}

const ROLE_TONES: Tone[] = [BLUE, { from: '#7C3AED', to: '#A78BFA' }, GREEN, { from: '#0891B2', to: '#22D3EE' }, AMBER, { from: '#DB2777', to: '#F472B6' }]

const EVENT_DOT = (action: string) => (/(fail|lock|denied|reject)/i.test(action) ? 'bg-red-500' : /(login|success|approve|created)/i.test(action) ? 'bg-emerald-500' : 'bg-sky-500')

/** What is in force and what has been recorded. Read-only; changes are made on the linked pages. */
export function SecurityCenterPage() {
  const overview = useQuery({ queryKey: ['security', 'overview'], queryFn: () => api.get<Overview>('/security/overview') })
  const data = overview.data
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const events = useQuery({ queryKey: ['security', 'events', action, page], queryFn: () => api.get<EventList>(`/security/events${queryString({ action, page, pageSize: 20 })}`), placeholderData: keepPreviousData })
  const totalRoleUsers = data?.roles.reduce((sum, role) => sum + role.activeUsers, 0) ?? 0
  const maxUsers = Math.max(1, ...(data?.roles.map((role) => role.activeUsers) ?? [1]))
  const attention = data ? data.checks.filter((check) => check.state === 'ATTENTION').length : 0
  const config = data?.configuration
  const settingGroups: { title: string; colour: string; items: { label: string; value: string; state?: 'on' | 'off' }[] }[] = config
    ? [
        {
          title: 'Sign-in',
          colour: '#1479BD',
          items: [
            { label: 'Sign-in lasts', value: `${config.sessionHours} hours` },
            { label: 'Password hashing', value: `bcrypt, ${config.passwordHashRounds} rounds` },
          ],
        },
        {
          title: 'Request limits',
          colour: '#EA580C',
          items: [
            { label: 'Sign-in requests per address', value: `${config.loginRequestsPer15Min} per 15 minutes` },
            { label: 'Failed sign-ins per email and address', value: `${config.failedLoginsPer15Min} per 15 minutes` },
            { label: 'Sign-up requests per address', value: `${config.signUpRequestsPer15Min} per 15 minutes` },
            { label: 'Temporary passwords per administrator', value: `${config.temporaryPasswordsPer15Min} per 15 minutes` },
          ],
        },
        {
          title: 'Access and storage',
          colour: '#059669',
          items: [
            { label: 'Allowed web addresses', value: String(config.allowedWebOrigins) },
            { label: 'Document storage', value: !config.attachmentsConfigured ? 'Not configured' : config.attachmentsStorage === 'SUPABASE' ? 'Supabase Storage (private)' : config.attachmentsStorage === 'R2' ? 'Cloudflare R2 (private)' : config.attachmentsStorage === 'LOCAL' ? 'Local folder' : 'Configured', state: config.attachmentsConfigured ? 'on' : 'off' },
            { label: 'Backups from this application', value: config.backupsAvailable ? 'Available' : 'Not available', state: config.backupsAvailable ? 'on' : 'off' },
          ],
        },
      ]
    : []
  const total = data?.checks.length ?? 0
  const passed = data ? data.checks.filter((check) => check.state === 'OK').length : 0

  return (
    <>
      <PageHeader title="Security Center" description="Access, sign-in activity and the security settings in force. Read only." />

      {overview.isPending && <Spinner label="Loading security overview" />}
      {overview.isError && <Alert>{errorMessage(overview.error)}</Alert>}

      {data && (
        <div className="space-y-6">
          <nav aria-label="Security pages" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {LINKS.map((link) => (
              <Link key={link.to} to={link.to} className={LINK} aria-label={link.label}>
                <IconTile icon={link.icon} from={link.tone.from} to={link.tone.to} className="h-11 w-11 shrink-0 rounded-xl" />
                <span className="min-w-0 flex-1 text-[15px] leading-snug" aria-hidden="true">{link.label}</span>
                <span className="shrink-0 text-lg text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-[#1479BD]" aria-hidden="true">→</span>
              </Link>
            ))}
          </nav>

          <Card className="rounded-2xl">
            <SectionTitle icon="shield" tone={attention > 0 ? AMBER : GREEN}>
              Health checks
              <span className={cx('ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', attention > 0 ? 'bg-amber-100 text-amber-900 ring-amber-200' : 'bg-emerald-100 text-emerald-800 ring-emerald-200')}>
                {attention > 0 ? `${attention} need attention` : 'No issues'}
              </span>
            </SectionTitle>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-3">
              <div className="relative h-14 w-14 shrink-0" role="img" aria-label={`${passed} of ${total} checks passed`}>
                <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                  <circle cx="60" cy="60" r="50" fill="none" stroke="#e2e8f0" strokeWidth="14" />
                  <circle cx="60" cy="60" r="50" fill="none" stroke={attention > 0 ? '#f59e0b' : '#10b981'} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${(passed / Math.max(1, total)) * 314.16} 314.16`} />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-sm font-extrabold tabular-nums text-[#0b3b66]">{Math.round((passed / Math.max(1, total)) * 100)}%</span>
              </div>
              <p className="text-sm text-slate-600">
                <span className="font-bold text-[#0b3b66]">{passed} of {total}</span> checks passed
              </p>
              <ul className="flex flex-wrap gap-2 text-xs font-semibold" aria-label="Check results">
                <li className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-800 ring-1 ring-inset ring-emerald-200">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                  {passed} OK
                </li>
                <li className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-amber-900 ring-1 ring-inset ring-amber-200">
                  <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
                  {attention} Attention
                </li>
                <li className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 ring-1 ring-inset ring-slate-200">
                  <span className="h-2 w-2 rounded-full bg-slate-400" aria-hidden="true" />
                  {total - passed - attention} Not available
                </li>
              </ul>
            </div>
            <ul className="grid gap-3 p-4 md:grid-cols-2 2xl:grid-cols-3">
              {data.checks.map((check) => {
                const style = CHECK_STYLE[check.state]

                return (
                  <li key={check.id} className={cx('flex min-w-0 items-start gap-3 rounded-xl border px-3 py-2.5 transition-shadow hover:shadow-md', style.card)}>
                    <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white', style.badge)} aria-hidden="true">
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.6">
                        <path d={style.icon} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-bold text-slate-900">{check.label}</p>
                        <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${CHECK_TONE[check.state]}`}>{CHECK_LABEL[check.state]}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 break-words text-xs leading-snug text-slate-600" title={check.detail}>{check.detail}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Card>

          <Card className="rounded-2xl">
            <SectionTitle icon="users" tone={BLUE}>User access</SectionTitle>
            <dl className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
              <Figure label="Active users" value={data.users.active} icon="users" tone={GREEN} />
              <Figure label="Inactive users" value={data.users.inactive} icon="users" tone={SLATE} />
              <Figure label="Administrators" value={data.users.administrators} icon="shield" tone={BLUE} />
              <Figure label="Awaiting approval" value={data.users.pendingApproval} icon="calendar" tone={BLUE} attention />
              <Figure label="Must change password" value={data.users.mustChangePassword} icon="settings" tone={BLUE} attention />
              <Figure label="Active without a role" value={data.users.activeWithoutRole} icon="execution" tone={BLUE} attention />
            </dl>
          </Card>

          <div className="grid gap-6 2xl:grid-cols-2">
            <Card className="rounded-2xl">
              <SectionTitle icon="shield" tone={{ from: '#7C3AED', to: '#A78BFA' }}>
                Roles
                <span className="ml-auto rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-semibold text-violet-800 ring-1 ring-inset ring-violet-200">
                  {data.roles.length} {data.roles.length === 1 ? 'role' : 'roles'} · {totalRoleUsers} {totalRoleUsers === 1 ? 'user' : 'users'}
                </span>
              </SectionTitle>
              <ul className="grid gap-3 p-4 sm:grid-cols-2">
                {data.roles.map((role, index) => {
                  const tone = ROLE_TONES[index % ROLE_TONES.length] as Tone

                  return (
                    <li key={role.id} className={cx('flex min-w-0 items-center gap-3 rounded-xl border bg-white px-3 py-2.5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md', role.isActive ? 'border-slate-200' : 'border-dashed border-slate-300 opacity-75')}>
                      <span
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-md"
                        style={{ backgroundImage: `linear-gradient(135deg, ${tone.from}, ${tone.to})` }}
                        aria-hidden="true"
                      >
                        {role.name.slice(0, 2).toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-slate-900" title={role.name}>
                          {role.name}
                          {!role.isActive && <span className="ml-2 text-xs font-normal text-slate-500">Inactive</span>}
                        </p>
                        <p className="text-xs tabular-nums text-slate-500">
                          {role.activeUsers} {role.activeUsers === 1 ? 'user' : 'users'}
                        </p>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                          <div className="h-full rounded-full" style={{ width: `${Math.round((role.activeUsers / maxUsers) * 100)}%`, backgroundImage: `linear-gradient(90deg, ${tone.from}, ${tone.to})` }} />
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>

            <Card className="rounded-2xl">
              <SectionTitle icon="settings" tone={SLATE}>Settings in force</SectionTitle>
              <div className="space-y-5 p-5">
                {settingGroups.map((group) => (
                  <section key={group.title} aria-label={group.title}>
                    <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: group.colour }} aria-hidden="true" />
                      {group.title}
                    </h3>
                    <dl className="grid gap-3 sm:grid-cols-2">
                      {group.items.map((item) => (
                        <div key={item.label} className="min-w-0 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm" style={{ boxShadow: `inset 3px 0 0 ${group.colour}` }}>
                          <dt className="text-xs leading-snug text-slate-500">{item.label}</dt>
                          <dd className="mt-0.5 flex items-center gap-2 text-sm font-bold text-[#0b3b66]">
                            {item.state && <span className={cx('h-2 w-2 shrink-0 rounded-full', item.state === 'on' ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden="true" />}
                            {item.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
              <p className="flex gap-2 border-t border-slate-200 bg-slate-50/70 px-5 py-3 text-xs text-slate-600">
                <span className="mt-px font-bold text-[#1479BD]" aria-hidden="true">i</span>
                <span>Deactivating a user or changing a role takes effect on their next request. Open sessions are not listed, and there is no sign-out for other users. Both are done from Users & Access.</span>
              </p>
            </Card>
          </div>

          <Card className="rounded-2xl">
            <SectionTitle icon="pulse" tone={{ from: '#0891B2', to: '#22D3EE' }}>Security events</SectionTitle>
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3 text-sm text-slate-600">
              <span className="font-semibold text-slate-500">Last 30 days:</span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 ring-1 ring-inset ring-emerald-200">
                <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
                <span className="font-bold text-emerald-800">{data.signIns30Days.succeeded}</span> successful sign-ins
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 ring-1 ring-inset ring-red-200">
                <span className="h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
                <span className="font-bold text-red-800">{data.signIns30Days.failed}</span> failed
              </span>
            </div>
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
                  <li key={event.id} className="relative px-5 py-3 pl-6 transition-colors hover:bg-sky-50/60">
                    <span className={cx('absolute inset-y-0 left-0 w-1', EVENT_DOT(event.action))} aria-hidden="true" />
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
