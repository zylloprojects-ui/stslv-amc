import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Badge, Card, EmptyState, TableScroll } from '../../components/ui'
import { CountUp } from '../../components/CountUp'
import { StatTile } from '../../components/StatTile'
import { TABLE } from '../../components/table'
import { api, errorMessage } from '../../lib/api'
import { cx, formatDateTime, initialsOf } from '../../lib/format'
import { ACTION_LABELS, MODULE_LABELS, type Action, type Module, type Role, type RolesResponse, type User } from '../../lib/types'

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    {path}
  </svg>
)

const ICONS = {
  shield: icon(
    <>
      <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6l-7-2.5Z" strokeLinejoin="round" />
      <path d="m9 12 2.2 2.2L15.2 10" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  door: icon(<path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9M15 8l4 4-4 4M19 12H9" strokeLinecap="round" strokeLinejoin="round" />),
  clock: icon(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  people: icon(
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.4-3.2 2.6-5 5.5-5s5.1 1.8 5.5 5M16 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.3c1.7.6 2.8 2.2 3 4.7" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
  grid: icon(<path d="M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z" strokeLinejoin="round" />),
  key: icon(
    <>
      <circle cx="8.5" cy="14.5" r="3.5" />
      <path d="m11 12 8-8M16 7l2.5 2.5M14 9l2 2" strokeLinecap="round" strokeLinejoin="round" />
    </>,
  ),
}

const ACTION_ORDER: Action[] = ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'APPROVE', 'EXPORT']
const DAY = 24 * 60 * 60 * 1000

/** "3 hours ago", "yesterday", "12 days ago": how long it is since a moment. */
function ago(value: string | null, now: number): string {
  if (!value) {
    return 'Never'
  }

  const minutes = Math.max(0, Math.round((now - new Date(value).getTime()) / 60000))

  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`
  if (minutes < 60 * 24 * 2) return 'Yesterday'
  if (minutes < 60 * 24 * 60) return `${Math.round(minutes / (60 * 24))} days ago`

  return `${Math.round(minutes / (60 * 24 * 30))} months ago`
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </Card>
  )
}

const linkButton = 'rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-[#1479BD] shadow-sm hover:bg-sky-50'

const AVATARS = ['from-[#1479BD] to-[#4aa3df]', 'from-emerald-600 to-emerald-400', 'from-violet-600 to-violet-400', 'from-amber-600 to-amber-400', 'from-rose-600 to-rose-400', 'from-teal-600 to-teal-400']
const avatarOf = (name: string) => AVATARS[[...name].reduce((sum, character) => sum + character.charCodeAt(0), 0) % AVATARS.length]

function Person({ user }: { user: User }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-xs font-bold text-white shadow-sm ring-2 ring-white', avatarOf(user.fullName))} aria-hidden="true">
        {initialsOf(user.fullName)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-900">{user.fullName}</span>
        <span className="block truncate text-xs text-slate-500">{user.email}</span>
      </span>
    </div>
  )
}

function Roles({ user }: { user: User }) {
  return user.roles.length === 0 ? (
    <span className="text-slate-400">No role</span>
  ) : (
    <span className="flex flex-wrap gap-1">
      {user.roles.map((role) => (
        <Badge key={role.id} tone="blue">
          {role.name}
        </Badge>
      ))}
    </span>
  )
}

interface Slice {
  key: string
  label: string
  count: number
  color: string
  note: string
}

/** A ring split into the states of the accounts, with the total in the middle. */
function Donut({ total, slices }: { total: number; slices: Slice[] }) {
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const starts = slices.map((_, index) => slices.slice(0, index).reduce((sum, slice) => sum + slice.count, 0))

  return (
    <div className="relative mx-auto h-44 w-44 shrink-0" role="img" aria-label={slices.map((slice) => `${slice.count} ${slice.label}`).join(', ')}>
      <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="16" />
        {slices.map((slice, index) => {
          if (slice.count === 0 || total === 0) {
            return null
          }

          const length = (slice.count / total) * circumference
          const dash = `${Math.max(length - 2, 0.5)} ${circumference}`

          return <circle key={slice.key} cx="70" cy="70" r={radius} fill="none" stroke={slice.color} strokeWidth="16" strokeDasharray={dash} strokeDashoffset={-((starts[index] ?? 0) / total) * circumference} strokeLinecap="butt" />
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-extrabold leading-none tabular-nums text-[#0b3b66]">
          <CountUp value={total} />
        </span>
        <span className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-500">{total === 1 ? 'user' : 'users'}</span>
      </div>
    </div>
  )
}

/** The headline of the Users section: the total in a ring, and each state with its count and share. */
function UserSummary({ total, slices }: { total: number; slices: Slice[] }) {
  return (
    <div className="surface login-rise relative overflow-hidden rounded-2xl p-5 sm:p-6">
      <span className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#4aa3df] via-[#1479BD] to-[#4aa3df]" aria-hidden="true" />
      <div className="grid items-center gap-6 md:grid-cols-[11rem_minmax(0,1fr)]">
        <Donut total={total} slices={slices} />
        <ul className="grid gap-3 sm:grid-cols-2">
          {slices.map((slice) => (
            <li key={slice.key} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm">
              <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-700">{slice.label}</span>
                  <span className="text-xs font-medium text-slate-500">{total > 0 ? `${Math.round((slice.count / total) * 100)}%` : '0%'}</span>
                </span>
                <span className="block text-3xl font-bold leading-tight tabular-nums text-[#0b3b66]">
                  <CountUp value={slice.count} />
                </span>
                <span className="block text-xs text-slate-500">{slice.note}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** What an administrator should look at first. */
function Attention({ items }: { items: { key: string; tone: 'amber' | 'rose' | 'sky'; text: string; detail: string }[] }) {
  const tones = { amber: 'bg-amber-100 text-amber-700', rose: 'bg-rose-100 text-rose-700', sky: 'bg-sky-100 text-[#0b3b66]' }

  return (
    <Section
      title="Needs attention"
      subtitle="Things an administrator may want to deal with"
      action={
        <Link to="/admin/users" className={linkButton}>
          Open Users &amp; Access
        </Link>
      }
    >
      {items.length === 0 ? (
        <EmptyState title="Everything is in order" description="No requests are waiting, every user has a role and every active account has been used." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-3 px-5 py-3.5">
              <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold', tones[item.tone])} aria-hidden="true">
                !
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900">{item.text}</span>
                <span className="block text-xs text-slate-500">{item.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

type Level = 'FULL' | 'PARTIAL' | 'VIEW' | 'NONE'

function levelOf(role: Role, module: Module, actions: Action[]): { level: Level; count: number } {
  const held = new Set(role.permissions.filter((permission) => permission.module === module).map((permission) => permission.action))
  const count = actions.filter((action) => held.has(action)).length
  const level: Level = count === 0 ? 'NONE' : count === actions.length ? 'FULL' : count === 1 && held.has('VIEW') ? 'VIEW' : 'PARTIAL'

  return { level, count }
}

const LEVEL_STYLE: Record<Level, { label: string; cell: string }> = {
  FULL: { label: 'Full', cell: 'bg-emerald-100 text-emerald-800 ring-emerald-200' },
  PARTIAL: { label: 'Partial', cell: 'bg-sky-100 text-[#0b3b66] ring-sky-200' },
  VIEW: { label: 'View', cell: 'bg-slate-100 text-slate-700 ring-slate-200' },
  NONE: { label: '—', cell: 'bg-white text-slate-300 ring-slate-100' },
}

/** Every role against every module on one grid: who can do how much, at a glance. */
function CoverageGrid({ catalogue, actions }: { catalogue: RolesResponse; actions: Action[] }) {
  const roles = catalogue.roles.filter((role) => role.isActive)

  return (
    <Section
      title="Access at a glance"
      subtitle="How much of each module every role may use"
      action={
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
          {(['FULL', 'PARTIAL', 'VIEW', 'NONE'] as Level[]).map((level) => (
            <span key={level} className={cx('rounded-full px-2 py-0.5 ring-1 ring-inset', LEVEL_STYLE[level].cell)}>
              {level === 'NONE' ? 'None' : LEVEL_STYLE[level].label}
            </span>
          ))}
        </span>
      }
    >
      <TableScroll label="Access of every role by module">
        <table className={TABLE.table}>
          <caption className="sr-only">Access of every role in every module</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                Module
              </th>
              {roles.map((role) => (
                <th key={role.id} scope="col" className={cx(TABLE.th, 'text-center')}>
                  {role.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {catalogue.modules.map((module) => (
              <tr key={module} className={TABLE.row}>
                <th scope="row" className={cx(TABLE.td, 'whitespace-nowrap text-left font-semibold text-slate-900')}>
                  {MODULE_LABELS[module]}
                </th>
                {roles.map((role) => {
                  const { level, count } = levelOf(role, module, actions)

                  return (
                    <td key={role.id} className={cx(TABLE.td, 'text-center')}>
                      <span
                        title={`${role.name}: ${count} of ${actions.length} actions in ${MODULE_LABELS[module]}`}
                        className={cx('inline-block min-w-16 rounded-md px-2 py-1 text-xs font-bold ring-1 ring-inset', LEVEL_STYLE[level].cell)}
                      >
                        {LEVEL_STYLE[level].label}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Section>
  )
}

function AccessMatrix({ catalogue }: { catalogue: RolesResponse }) {
  const [selectedId, setSelectedId] = useState<string>(catalogue.roles[0]?.id ?? '')
  const role = catalogue.roles.find((candidate) => candidate.id === selectedId) ?? catalogue.roles[0]
  const actions = ACTION_ORDER.filter((action) => catalogue.actions.includes(action))
  const totalPairs = catalogue.modules.length * actions.length

  if (!role) {
    return <EmptyState title="No roles" />
  }

  const held = new Set(role.permissions.map((permission) => `${permission.module}:${permission.action}`))
  const members = role.userCount

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="group" aria-label="Access figures">
        <StatTile label="Roles" count={catalogue.roles.length} hint={`${catalogue.roles.filter((candidate) => candidate.isActive).length} active`} icon={ICONS.key} tone="from-[#1479BD] to-[#4aa3df]" edge="#1B8AD3" position={0} />
        <StatTile label="Modules" count={catalogue.modules.length} hint="Areas of the system" icon={ICONS.grid} tone="from-violet-600 to-violet-400" edge="#8b5cf6" position={1} />
        <StatTile label="Permissions" count={totalPairs} hint={`${actions.length} actions per module`} icon={ICONS.shield} tone="from-emerald-600 to-emerald-400" edge="#10b981" position={2} />
      </div>

      <CoverageGrid catalogue={catalogue} actions={actions} />

      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">Look at one role</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="group" aria-label="Choose a role">
          {catalogue.roles.map((candidate) => {
            const count = candidate.permissions.length
            const share = totalPairs > 0 ? Math.round((count / totalPairs) * 100) : 0
            const on = candidate.id === role.id

            return (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={on}
                onClick={() => setSelectedId(candidate.id)}
                className={cx('surface relative overflow-hidden rounded-xl p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg', on && 'ring-2 ring-[#1479BD] ring-offset-1')}
              >
                <span className="absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-[#4aa3df] to-[#1479BD]" aria-hidden="true" />
                <span className="flex items-start justify-between gap-3 pl-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-[#0b3b66]">{candidate.name}</span>
                    <span className="block text-xs text-slate-500">
                      {candidate.userCount} {candidate.userCount === 1 ? 'user' : 'users'}
                    </span>
                  </span>
                  {!candidate.isActive ? <Badge>Inactive</Badge> : !candidate.permissionsEditable ? <Badge tone="blue">Full access</Badge> : null}
                </span>
                <span className="mt-3 block pl-2">
                  <span className="flex items-baseline justify-between text-xs text-slate-500">
                    <span>
                      <span className="text-lg font-bold tabular-nums text-slate-900">{count}</span> of {totalPairs} permissions
                    </span>
                    <span className="font-semibold">{share}%</span>
                  </span>
                  <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                    <span className="block h-full rounded-full bg-gradient-to-r from-[#1479BD] to-[#4aa3df] transition-all duration-500" style={{ width: `${share}%` }} />
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <Section
        title={`${role.name}: what it may do`}
        subtitle={role.description ?? `Access of this role, module by module. ${members} ${members === 1 ? 'user has' : 'users have'} it.`}
        action={
          <Link to="/admin/roles" className={linkButton}>
            Change in Roles &amp; Permissions
          </Link>
        }
      >
        <TableScroll label={`${role.name} access`}>
          <table className={TABLE.table}>
            <caption className="sr-only">What the {role.name} role may do in each module</caption>
            <thead>
              <tr>
                <th scope="col" className={TABLE.th}>
                  Module
                </th>
                {actions.map((action) => (
                  <th key={action} scope="col" className={cx(TABLE.th, 'text-center')}>
                    {ACTION_LABELS[action]}
                  </th>
                ))}
                <th scope="col" className={cx(TABLE.th, 'text-right')}>
                  Level
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {catalogue.modules.map((module) => {
                const { level } = levelOf(role, module, actions)

                return (
                  <tr key={module} className={TABLE.row}>
                    <th scope="row" className={cx(TABLE.td, 'whitespace-nowrap text-left font-semibold text-slate-900')}>
                      {MODULE_LABELS[module]}
                    </th>
                    {actions.map((action) => {
                      const yes = held.has(`${module}:${action}`)

                      return (
                        <td key={action} className={cx(TABLE.td, 'text-center')}>
                          {yes ? (
                            <span
                              className={cx(
                                'inline-flex h-6 w-6 items-center justify-center rounded-full',
                                action === 'DELETE' ? 'bg-rose-100 text-rose-600' : action === 'VIEW' ? 'bg-sky-100 text-[#1479BD]' : 'bg-emerald-100 text-emerald-600',
                              )}
                            >
                              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                                <path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              <span className="sr-only">Allowed</span>
                            </span>
                          ) : (
                            <span className="text-slate-300">
                              —<span className="sr-only">Not allowed</span>
                            </span>
                          )}
                        </td>
                      )
                    })}
                    <td className={cx(TABLE.td, 'text-right')}>
                      <span className={cx('inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', LEVEL_STYLE[level].cell)}>{level === 'VIEW' ? 'View only' : level === 'NONE' ? 'None' : LEVEL_STYLE[level].label}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableScroll>
      </Section>
    </div>
  )
}

export type OverviewPart = 'overview' | 'access' | 'activity'

type StatusFilter = 'all' | 'active' | 'pending' | 'inactive' | 'rejected'

/** One group of the activity list: a heading, and the people last seen in that period. */
function SeenGroup({ title, hint, tone, users, now }: { title: string; hint: string; tone: string; users: User[]; now: number }) {
  if (users.length === 0) {
    return null
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-y border-slate-100 bg-slate-50/70 px-5 py-2">
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
          <span className={cx('h-2.5 w-2.5 rounded-full', tone)} aria-hidden="true" />
          {title}
        </span>
        <span className="text-xs text-slate-500">
          {users.length} · {hint}
        </span>
      </div>
      <ul className="divide-y divide-slate-100">
        {users.map((user) => (
          <li key={user.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
            <Person user={user} />
            <span className="flex items-center gap-4 text-right">
              <Roles user={user} />
              <span className="min-w-24">
                <span className="block text-sm font-semibold text-slate-800">{ago(user.lastLoginAt, now)}</span>
                <span className="block text-[11px] text-slate-500">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : `Created ${formatDateTime(user.createdAt)}`}</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * What an administrator needs to know about people and access: how many users there are and in which state,
 * what each role may do, and who has signed in. Everything comes from the Users and Roles data the Users & Access
 * page already uses; nothing here is entered by hand.
 */
export function UserOverview({ part = 'overview' }: { part?: OverviewPart }) {
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [now] = useState(() => Date.now())
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') })
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RolesResponse>('/roles') })

  if (users.isPending || roles.isPending) {
    return (
      <Card className="p-6">
        <p className="text-sm text-slate-500" role="status">
          Loading users and access…
        </p>
      </Card>
    )
  }
  if (users.isError || roles.isError) {
    return <Alert>{errorMessage(users.error ?? roles.error)}</Alert>
  }

  const all = users.data
  const catalogue = roles.data
  const total = all.length
  const active = all.filter((user) => user.isActive).length
  const pending = all.filter((user) => user.approvalStatus === 'PENDING')
  const rejected = all.filter((user) => user.approvalStatus === 'REJECTED').length
  const inactive = all.filter((user) => !user.isActive && user.approvalStatus === 'APPROVED').length
  const neverSignedIn = all.filter((user) => user.isActive && !user.lastLoginAt)
  const withoutRole = all.filter((user) => user.approvalStatus === 'APPROVED' && user.roles.length === 0)
  const activeRoles = catalogue.roles.filter((role) => role.isActive)
  const stateOf = (user: User): StatusFilter => (user.approvalStatus === 'PENDING' ? 'pending' : user.approvalStatus === 'REJECTED' ? 'rejected' : user.isActive ? 'active' : 'inactive')
  const needle = search.trim().toLowerCase()
  const shown = all.filter((user) => (filter === 'all' || stateOf(user) === filter) && (needle === '' || `${user.fullName} ${user.email}`.toLowerCase().includes(needle)))
  const filters: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: total },
    { key: 'active', label: 'Active', count: active },
    { key: 'pending', label: 'Awaiting approval', count: pending.length },
    { key: 'inactive', label: 'Deactivated', count: inactive },
    { key: 'rejected', label: 'Rejected', count: rejected },
  ]

  const slices: Slice[] = [
    { key: 'active', label: 'Active', count: active, color: '#10b981', note: 'Can sign in now' },
    { key: 'inactive', label: 'Deactivated', count: inactive, color: '#64748b', note: 'Cannot sign in' },
    { key: 'pending', label: 'Awaiting approval', count: pending.length, color: '#f59e0b', note: pending.length > 0 ? 'Sign-up requests to decide' : 'No requests waiting' },
    { key: 'rejected', label: 'Rejected', count: rejected, color: '#f43f5e', note: 'Requests that were refused' },
  ]

  const attention: { key: string; tone: 'amber' | 'rose' | 'sky'; text: string; detail: string }[] = []

  if (pending.length > 0) {
    attention.push({ key: 'pending', tone: 'amber', text: `${pending.length} sign-up ${pending.length === 1 ? 'request is' : 'requests are'} waiting for approval`, detail: pending.map((user) => user.fullName).join(', ') })
  }
  if (withoutRole.length > 0) {
    attention.push({ key: 'role', tone: 'rose', text: `${withoutRole.length} approved ${withoutRole.length === 1 ? 'user has' : 'users have'} no role`, detail: `${withoutRole.map((user) => user.fullName).join(', ')} cannot open any page until a role is given.` })
  }
  if (neverSignedIn.length > 0) {
    attention.push({ key: 'never', tone: 'sky', text: `${neverSignedIn.length} active ${neverSignedIn.length === 1 ? 'account has' : 'accounts have'} never signed in`, detail: neverSignedIn.map((user) => user.fullName).join(', ') })
  }

  const signedIn = all.filter((user) => user.lastLoginAt).sort((a, b) => (b.lastLoginAt ?? '').localeCompare(a.lastLoginAt ?? ''))
  const within = (days: number) => signedIn.filter((user) => now - new Date(user.lastLoginAt as string).getTime() < days * DAY)
  const today = within(1)
  const week = within(7).filter((user) => !today.includes(user))
  const month = within(30).filter((user) => !today.includes(user) && !week.includes(user))
  const earlier = signedIn.filter((user) => !today.includes(user) && !week.includes(user) && !month.includes(user))
  const lastWeek = today.length + week.length

  return (
    <div className="space-y-6">
      {part === 'overview' && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-100 bg-gradient-to-r from-sky-50 to-white px-5 py-3.5">
            <p className="text-sm text-slate-600">
              This is an overview. Create users, give roles, approve requests and reset passwords in <strong className="text-[#0b3b66]">Users &amp; Access</strong>.
            </p>
            <Link to="/admin/users" className="inline-flex items-center gap-2 rounded-lg bg-[#1479BD] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#0f62a3]">
              Manage users
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m8 4 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </div>

          <UserSummary total={total} slices={slices} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="group" aria-label="More user figures">
            <StatTile
              label="Roles in use"
              count={activeRoles.length}
              hint={withoutRole.length > 0 ? `${withoutRole.length} user(s) have no role` : 'Every user has a role'}
              warn={withoutRole.length > 0}
              icon={ICONS.shield}
              tone="from-[#1479BD] to-[#4aa3df]"
              edge="#1B8AD3"
              position={0}
            />
            <StatTile label="Signed in, last 7 days" count={lastWeek} hint={`of ${total} accounts`} icon={ICONS.clock} tone="from-emerald-600 to-emerald-400" edge="#10b981" position={1} />
            <StatTile label="Never signed in" count={neverSignedIn.length} hint="Active accounts not used yet" warn={neverSignedIn.length > 0} icon={ICONS.door} tone="from-rose-600 to-rose-400" edge="#f43f5e" position={2} />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <Attention items={attention} />

            <Section title="Users by role" subtitle="How many accounts hold each role">
              <ul className="divide-y divide-slate-100">
                {activeRoles.map((role) => {
                  const members = all.filter((user) => user.approvalStatus === 'APPROVED' && user.roles.some((candidate) => candidate.id === role.id)).length
                  const share = total > 0 ? Math.round((members / total) * 100) : 0

                  return (
                    <li key={role.id} className="px-5 py-3">
                      <span className="flex items-baseline justify-between text-sm">
                        <span className="font-semibold text-slate-800">{role.name}</span>
                        <span className="text-xs text-slate-500">
                          <span className="font-bold tabular-nums text-slate-800">{members}</span> {members === 1 ? 'user' : 'users'}
                        </span>
                      </span>
                      <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                        <span className="block h-full rounded-full bg-gradient-to-r from-[#1479BD] to-[#4aa3df]" style={{ width: `${share}%` }} />
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Section>
          </div>

          <Section title="Newest accounts" subtitle="The latest people added to the system">
            <ul className="grid divide-y divide-slate-100 sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-3">
              {[...all]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .slice(0, 3)
                .map((user) => (
                  <li key={user.id} className="space-y-2 px-5 py-4 sm:border-r sm:border-slate-100 sm:last:border-r-0">
                    <Person user={user} />
                    <span className="flex flex-wrap items-center gap-2 pl-[3.25rem] text-xs text-slate-500">
                      <Roles user={user} />
                      <span>Added {ago(user.createdAt, now)}</span>
                    </span>
                  </li>
                ))}
            </ul>
          </Section>

          <Section
            title="All users"
            subtitle="Every account in the system"
            action={
              <span className="rounded-full bg-sky-100 px-3 py-1 text-xs font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200">
                {total} {total === 1 ? 'user' : 'users'}
              </span>
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Show users">
                {filters.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={filter === item.key}
                    onClick={() => setFilter(item.key)}
                    className={cx(
                      'rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset transition-colors',
                      filter === item.key ? 'bg-[#1479BD] text-white ring-[#1479BD]' : 'bg-white text-slate-600 ring-slate-200 hover:bg-sky-50 hover:text-[#0b3b66]',
                    )}
                  >
                    {item.label} <span className="tabular-nums opacity-80">{item.count}</span>
                  </button>
                ))}
              </div>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name or email"
                aria-label="Search users"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm shadow-sm placeholder:text-slate-400 focus:border-[#1479BD] focus:outline-none focus:ring-2 focus:ring-sky-200 sm:w-64"
              />
            </div>
            {shown.length === 0 ? (
              <EmptyState title="No users match" description="Change the filter or the search text." />
            ) : (
              <TableScroll label="All users">
                <table className={TABLE.table}>
                  <caption className="sr-only">All users</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TABLE.snHead}>
                        #
                      </th>
                      <th scope="col" className={TABLE.th}>
                        User
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Role
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Status
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Last sign-in
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {shown.map((user, index) => (
                      <tr key={user.id} className={TABLE.row}>
                        <td className={TABLE.sn}>{index + 1}</td>
                        <td className={`${TABLE.td} min-w-52`}>
                          <Person user={user} />
                        </td>
                        <td className={TABLE.td}>
                          <Roles user={user} />
                        </td>
                        <td className={TABLE.td}>
                          {user.approvalStatus === 'PENDING' ? (
                            <Badge tone="amber">Awaiting approval</Badge>
                          ) : user.approvalStatus === 'REJECTED' ? (
                            <Badge>Rejected</Badge>
                          ) : user.isActive ? (
                            <Badge tone="green">Active</Badge>
                          ) : (
                            <Badge>Deactivated</Badge>
                          )}
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>
                          {user.lastLoginAt ? (
                            <span>
                              <span className="block font-medium text-slate-800">{ago(user.lastLoginAt, now)}</span>
                              <span className="block text-xs text-slate-500">{formatDateTime(user.lastLoginAt)}</span>
                            </span>
                          ) : (
                            <span className="text-slate-400">Never</span>
                          )}
                        </td>
                        <td className={`${TABLE.td} whitespace-nowrap`}>{formatDateTime(user.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            )}
          </Section>
        </>
      )}

      {part === 'access' && <AccessMatrix catalogue={catalogue} />}

      {part === 'activity' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="group" aria-label="Account activity figures">
            <StatTile label="Signed in today" count={today.length} hint="In the last 24 hours" icon={ICONS.clock} tone="from-emerald-600 to-emerald-400" edge="#10b981" position={0} />
            <StatTile label="Signed in, last 7 days" count={lastWeek} hint={`of ${total} accounts`} icon={ICONS.people} tone="from-[#1479BD] to-[#4aa3df]" edge="#1B8AD3" position={1} />
            <StatTile label="Never signed in" count={neverSignedIn.length} hint="Active accounts not used yet" warn={neverSignedIn.length > 0} icon={ICONS.door} tone="from-rose-600 to-rose-400" edge="#f43f5e" position={2} />
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <Section title="Recent sign-ins" subtitle="Everyone who has signed in, latest first">
              {signedIn.length === 0 ? (
                <EmptyState title="No sign-ins yet" description="Sign-ins will be listed here as people use their accounts." />
              ) : (
                <div>
                  <SeenGroup title="Today" hint="last 24 hours" tone="bg-emerald-500" users={today} now={now} />
                  <SeenGroup title="This week" hint="last 7 days" tone="bg-[#1479BD]" users={week} now={now} />
                  <SeenGroup title="This month" hint="last 30 days" tone="bg-amber-500" users={month} now={now} />
                  <SeenGroup title="Earlier" hint="over 30 days ago" tone="bg-slate-400" users={earlier} now={now} />
                </div>
              )}
            </Section>

            <div className="space-y-6">
              <Section title="Accounts not used yet" subtitle="Active, but never signed in">
                {neverSignedIn.length === 0 ? (
                  <EmptyState title="Everyone has signed in" />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {neverSignedIn.map((user) => (
                      <li key={user.id} className="space-y-1.5 px-5 py-3">
                        <Person user={user} />
                        <span className="block pl-[3.25rem] text-xs text-slate-500">Created {formatDateTime(user.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Use by role" subtitle="Users of each role who signed in this week">
                <ul className="divide-y divide-slate-100">
                  {activeRoles.map((role) => {
                    const members = all.filter((user) => user.roles.some((candidate) => candidate.id === role.id))
                    const recent = members.filter((user) => user.lastLoginAt && now - new Date(user.lastLoginAt).getTime() < 7 * DAY).length
                    const share = members.length > 0 ? Math.round((recent / members.length) * 100) : 0

                    return (
                      <li key={role.id} className="px-5 py-3">
                        <span className="flex items-baseline justify-between text-sm">
                          <span className="font-semibold text-slate-800">{role.name}</span>
                          <span className="text-xs text-slate-500">
                            <span className="font-bold tabular-nums text-slate-800">{recent}</span> of {members.length}
                          </span>
                        </span>
                        <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-slate-200" aria-hidden="true">
                          <span className="block h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400" style={{ width: `${share}%` }} />
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </Section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
