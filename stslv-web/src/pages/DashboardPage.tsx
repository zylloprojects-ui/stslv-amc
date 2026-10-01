import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { Alert, Badge } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { NAVIGATION } from '../layout/navigation'

interface DashboardSummary {
  clients: { active: number; inactive: number }
}

// Accent colours taken from the STSLEV logo.
const ACCENTS = ['#1B8AD3', '#00A6C8', '#5BAF48', '#F5C622', '#FF8212', '#D1428C']

type IconName = 'users' | 'contract' | 'calendar' | 'invoice' | 'project' | 'wallet' | 'shield' | 'clock' | 'pulse'

const ICONS: Record<IconName, ReactNode> = {
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19c0-3.2 2.7-5 6-5s6 1.8 6 5" strokeLinecap="round" />
      <path d="M16 5.2a3 3 0 0 1 0 5.6M18.5 14.4c1.6.7 2.5 2.1 2.5 4.6" strokeLinecap="round" />
    </>
  ),
  contract: (
    <>
      <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5Z" strokeLinejoin="round" />
      <path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5" strokeLinecap="round" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
    </>
  ),
  invoice: (
    <>
      <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2v-17Z" strokeLinejoin="round" />
      <path d="M9.5 8.5h5M9.5 12h5" strokeLinecap="round" />
    </>
  ),
  project: (
    <>
      <rect x="3.5" y="7" width="17" height="12.5" rx="2.5" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17" strokeLinecap="round" />
    </>
  ),
  wallet: (
    <>
      <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" strokeLinecap="round" />
      <rect x="3.5" y="8" width="17" height="11.5" rx="2.5" />
      <circle cx="16.5" cy="13.75" r="1" fill="currentColor" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.2 7 9 4.2-1.8 7-4.8 7-9V6l-7-2.5Z" strokeLinejoin="round" />
      <path d="m9 12 2.2 2.2L15.2 10" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 4 12 2.5-6H21" strokeLinecap="round" strokeLinejoin="round" />,
}

function Icon({ name, className = 'h-5 w-5' }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

function IconTile({ icon, from, to, size = 'md' }: { icon: IconName; from: string; to: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center text-white shadow-md ${size === 'sm' ? 'h-9 w-9 rounded-lg' : 'h-11 w-11 rounded-xl'}`}
      style={{ backgroundImage: `linear-gradient(135deg, ${from}, ${to})` }}
      aria-hidden="true"
    >
      <Icon name={icon} className={size === 'sm' ? 'h-[18px] w-[18px]' : 'h-5 w-5'} />
    </span>
  )
}

// Metrics that depend on modules which are not built yet. They show no number
// at all, so nothing here can be mistaken for real operational data.
const PENDING_METRICS: { group: string; items: { label: string; icon: IconName; reason: string }[] }[] = [
  {
    group: 'AMC',
    items: [
      { label: 'Active AMC Contracts', icon: 'contract', reason: 'the AMC Contracts module is not implemented yet' },
      { label: 'Visits Due', icon: 'calendar', reason: 'the AMC Schedule module is not implemented yet' },
      { label: 'Ready for Invoice', icon: 'invoice', reason: 'the AMC Execution and Invoice Tracking modules are not implemented yet' },
    ],
  },
  {
    group: 'Projects and finance',
    items: [
      { label: 'Active Projects', icon: 'project', reason: 'the Projects module is not implemented yet' },
      { label: 'Project Costs', icon: 'wallet', reason: 'the Expenses module is not implemented yet' },
      { label: 'Pending Invoices', icon: 'invoice', reason: 'the Invoice Tracking module is not implemented yet' },
    ],
  },
]

// Which modules exist today. Everything not listed as live is still to be built.
const ROLLOUT: { name: string; icon: IconName; live: boolean }[] = [
  { name: 'Access control', icon: 'shield', live: true },
  { name: 'Clients', icon: 'users', live: true },
  { name: 'Contracts', icon: 'contract', live: false },
  { name: 'Schedule', icon: 'calendar', live: false },
  { name: 'Execution', icon: 'pulse', live: false },
  { name: 'Projects', icon: 'project', live: false },
  { name: 'Expenses', icon: 'wallet', live: false },
  { name: 'Invoicing', icon: 'invoice', live: false },
]

function greeting(date: Date) {
  const hour = date.getHours()

  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

const SECTION_HEADING = 'mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[#0b3b66]'
const CARD = 'login-rise relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-sky-200/50'

/** Ring showing how many clients are active. Decorative; the numbers are shown as text beside it. */
function ClientRing({ active, inactive }: { active: number; inactive: number }) {
  const total = active + inactive
  const circumference = 2 * Math.PI * 26
  const share = total === 0 ? 0 : active / total

  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r="26" fill="none" stroke="#E2E8F0" strokeWidth="8" />
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke="url(#ring-gradient)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={`${circumference * share} ${circumference}`}
      />
      <defs>
        <linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1B8AD3" />
          <stop offset="100%" stopColor="#5BAF48" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export function DashboardPage() {
  const auth = useAuth()
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary') })
  const [now] = useState(() => new Date())

  const modules = NAVIGATION.flatMap((section) => section.items).filter((item) => auth.can(item.module, 'VIEW')).length
  const quickLinks = [
    { label: 'Clients', to: '/clients', show: auth.can('CLIENTS', 'VIEW') },
    { label: 'Users & Access', to: '/admin/users', show: auth.can('USERS', 'VIEW') },
  ].filter((link) => link.show)

  return (
    <>
      <div className="login-rise relative mb-7 overflow-hidden rounded-2xl app-banner shadow-lg shadow-sky-900/10">
        <div className="flex flex-wrap items-center justify-between gap-6 px-6 py-6 sm:px-8">
          <div className="min-w-0">
            <p className="bn-eyebrow text-xs font-semibold uppercase tracking-[0.2em]">
              {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
            <h1 className="bn-strong mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Dashboard</h1>
            <p className="bn-sub mt-1 text-sm">{`${greeting(now)}, ${auth.user?.fullName ?? ''}.`}</p>

            {quickLinks.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-2">
                {quickLinks.map((link) => (
                  <Link
                    key={link.to}
                    to={link.to}
                    className="bn-chip rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors"
                  >
                    {link.label}
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 bn-panel rounded-xl px-5 py-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white shadow-md">
              <img src="/stslv-logo.png" alt="" className="h-10 w-10 object-contain" />
            </span>
            <div className="leading-tight">
              <p className="bn-strong text-base font-semibold">Smart Technical Service LLC</p>
              <p className="bn-sub mt-1 text-xs">STSLEV ERP · Operations Suite</p>
            </div>
          </div>
        </div>
        <div className="flex h-1" aria-hidden="true">
          {ACCENTS.map((color) => (
            <span key={color} className="flex-1" style={{ backgroundColor: color }} />
          ))}
        </div>
      </div>

      {summary.isError && (
        <div className="mb-6">
          <Alert>{errorMessage(summary.error)}</Alert>
        </div>
      )}

      <section aria-labelledby="live-heading" className="mb-8">
        <h2 id="live-heading" className={SECTION_HEADING}>
          <span className="h-4 w-1 rounded-full bg-[#1B8AD3]" aria-hidden="true" />
          Master data
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className={`${CARD} border-sky-200`}>
            <div className="absolute right-4 top-4">
              <ClientRing active={summary.data?.clients.active ?? 0} inactive={summary.data?.clients.inactive ?? 0} />
            </div>
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-600">Active Clients</p>
            <p className="mt-3 text-4xl font-bold text-[#0b3b66]" aria-live="polite">
              {summary.isPending ? <span className="text-slate-300">…</span> : (summary.data?.clients.active ?? '—')}
            </p>
            <p className="mt-3 text-sm text-slate-600">
              {summary.data ? `${summary.data.clients.inactive} inactive` : ' '}
              {auth.can('CLIENTS', 'VIEW') && (
                <>
                  {' · '}
                  <Link to="/clients" className="font-medium text-[#1479BD] hover:underline">
                    View clients
                  </Link>
                </>
              )}
            </p>
          </div>

          <div className={CARD} style={{ animationDelay: '0.08s' }}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-600">Modules Available</p>
              <IconTile icon="shield" from="#00A6C8" to="#5BAF48" size="sm" />
            </div>
            <p className="mt-3 text-4xl font-bold text-[#0b3b66]">{modules}</p>
            <p className="mt-3 truncate text-sm text-slate-600">{auth.user?.roles.map((role) => role.name).join(', ') || 'No role assigned'}</p>
          </div>

          <div className={CARD} style={{ animationDelay: '0.16s' }}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-600">System Status</p>
              <IconTile icon="pulse" from="#D1428C" to="#FF8212" size="sm" />
            </div>
            <p className="mt-3 flex items-center gap-2 text-xl font-bold text-[#0b3b66]">
              <span
                className={`h-2.5 w-2.5 rounded-full ${summary.isError ? 'bg-red-500' : summary.isSuccess ? 'bg-emerald-500' : 'bg-amber-400'}`}
                aria-hidden="true"
              />
              {summary.isError ? 'Unreachable' : summary.isSuccess ? 'Connected' : 'Checking…'}
            </p>
            <p className="mt-3 text-sm text-slate-600">API and database</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="rollout-heading" className="mb-8">
        <h2 id="rollout-heading" className={SECTION_HEADING}>
          <span className="h-4 w-1 rounded-full bg-[#5BAF48]" aria-hidden="true" />
          Module rollout
        </h2>
        <div className="login-rise rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ROLLOUT.map((module) => (
              <li
                key={module.name}
                className={`flex items-center gap-3 rounded-xl border p-3 ${module.live ? 'border-emerald-200 bg-emerald-50/60' : 'border-dashed border-slate-300'}`}
              >
                <IconTile icon={module.icon} from={module.live ? '#5BAF48' : '#94A3B8'} to={module.live ? '#00A6C8' : '#CBD5E1'} size="sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-900">{module.name}</p>
                  <p className={`text-xs font-medium ${module.live ? 'text-emerald-700' : 'text-slate-600'}`}>{module.live ? 'Live' : 'Planned'}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {PENDING_METRICS.map((group, groupIndex) => (
        <section key={group.group} aria-label={group.group} className="mb-8">
          <h2 className={SECTION_HEADING}>
            <span className="h-4 w-1 rounded-full" style={{ backgroundColor: ACCENTS[groupIndex === 0 ? 4 : 5] }} aria-hidden="true" />
            {group.group}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.items.map((metric, index) => (
              <div
                key={metric.label}
                className="login-rise relative rounded-2xl border border-dashed border-slate-300 bg-white/70 p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-[#1B8AD3] hover:bg-white hover:shadow-md"
                style={{ animationDelay: `${0.1 + index * 0.08}s` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.15em] text-slate-600">{metric.label}</p>
                    <div className="mt-2">
                      <Badge tone="amber">Not yet available</Badge>
                    </div>
                  </div>
                  <IconTile
                    icon={metric.icon}
                    from={ACCENTS[(groupIndex * 3 + index) % ACCENTS.length] as string}
                    to={ACCENTS[(groupIndex * 3 + index + 1) % ACCENTS.length] as string}
                    size="sm"
                  />
                </div>
                <p className="mt-3 text-3xl font-bold text-slate-300" aria-hidden="true">
                  —
                </p>
                <p className="mt-2 text-xs text-slate-600">No data: {metric.reason}.</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
