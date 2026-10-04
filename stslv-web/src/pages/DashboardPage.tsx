import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { usePageTitle } from '../components/hooks'
import { Alert, Card, EmptyState } from '../components/ui'
import { NAVIGATION } from '../layout/navigation'
import { api, errorMessage } from '../lib/api'
import { cx, formatCount, formatTime } from '../lib/format'
import type { Module } from '../lib/types'
import { IconTile, type IconName } from './dashboard/icons'
import { MetricCard, type MetricState } from './dashboard/MetricCard'
import { METRIC_GROUPS, type DashboardSummary, type MetricDefinition } from './dashboard/metrics'
import { DASHBOARD_CARD, DASHBOARD_LABEL } from './dashboard/style'

const SECTION_HEADING = 'mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[#0b3b66]'

// One accent for every section heading: structure, not meaning.
const SECTION_ACCENTS = ['#1479BD']

const MODULE_ICONS: Record<Module, IconName> = {
  DASHBOARD: 'pulse',
  CLIENTS: 'users',
  AMC_CONTRACTS: 'contract',
  AMC_SCHEDULE: 'calendar',
  AMC_EXECUTION: 'execution',
  PROJECTS: 'project',
  PROCUREMENT: 'cart',
  EXPENSES: 'wallet',
  INVOICES: 'invoice',
  REPORTS: 'chart',
  USERS: 'shield',
  SETTINGS: 'settings',
  HISTORICAL_DATA: 'contract',
}

function greeting(date: Date) {
  const hour = date.getHours()

  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

function SectionHeading({ id, accent, children }: { id: string; accent: string; children: string }) {
  return (
    <h2 id={id} className={SECTION_HEADING}>
      <span className="h-4 w-1 rounded-full" style={{ backgroundColor: accent }} aria-hidden="true" />
      {children}
    </h2>
  )
}

export function DashboardPage() {
  const auth = useAuth()
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary') })
  const [now] = useState(() => new Date())

  usePageTitle('Dashboard')

  const canView = (module: Module) => auth.can(module, 'VIEW')

  /** Null when the API left the figure out: the card is then not shown at all, never as a zero. */
  const stateOf = (metric: MetricDefinition): MetricState | null => {
    if (!metric.read) {
      return { kind: 'unavailable' }
    }
    if (summary.data) {
      const reading = metric.read(summary.data, canView)

      return reading ? { kind: 'ready', reading } : null
    }

    return summary.isError ? { kind: 'failed' } : { kind: 'loading' }
  }

  // A user sees a figure only where their role includes it, and only if the API returned it.
  const groups = METRIC_GROUPS.map((group) => ({
    ...group,
    cards: group.metrics
      .filter((metric) => metric.visible(canView))
      .flatMap((metric) => {
        const state = stateOf(metric)

        return state ? [{ metric, state, link: metric.links?.find((link) => canView(link.module)) ?? null }] : []
      }),
  })).filter((group) => group.cards.length > 0)

  const pending = groups.flatMap((group) => group.cards).filter((card) => card.state.kind === 'unavailable').length

  // The share of clients that are active, for the ring on that card. Drawn only from what the API returned.
  const clients = summary.data?.clients
  const activeShare = clients && clients.active + clients.inactive > 0 ? clients.active / (clients.active + clients.inactive) : clients ? 0 : null
  const ringOf = (metric: MetricDefinition) => (metric.id === 'clients.active' ? activeShare : undefined)

  // The modules this user may open, straight from the navigation: nothing here is a fixed number or a fixed list.
  const modules = NAVIGATION.flatMap((section) => section.items).filter((item) => canView(item.module))
  const rollout = modules.filter((item) => item.module !== 'DASHBOARD')
  const roleNames = auth.user?.roles.map((role) => role.name).join(', ') || 'No role assigned'

  const quickLinks = [
    { label: 'Clients', to: '/clients', show: canView('CLIENTS') },
    { label: 'Users & Access', to: '/admin/users', show: canView('USERS') },
  ].filter((link) => link.show)

  // The Clients section holds a single card, so it sits beside the workspace cards as one row of three.
  // Only that section moves: the others keep their place whatever the API returns, so no card jumps when the figures arrive.
  const lead = groups.find((group) => group.id === 'clients' && group.cards.length === 1) ?? null
  const sections = groups.filter((group) => group !== lead)
  // Cards are numbered across the whole page, so their accent colours and entrance follow one sequence.
  const offsetOf = (position: number) => (lead ? 3 : 2) + sections.slice(0, position).reduce((count, group) => count + group.cards.length, 0)

  const workspace = (
    <section aria-labelledby="dashboard-workspace" className={cx('flex flex-col', lead && 'xl:col-span-2')}>
      <SectionHeading id="dashboard-workspace" accent={SECTION_ACCENTS[0] as string}>
        Workspace
      </SectionHeading>
      <div className="grid flex-1 gap-4 sm:grid-cols-2">
        <div className={DASHBOARD_CARD} style={{ animationDelay: '0.06s' }}>
          <span className="card-dots" aria-hidden="true" />
          <IconTile icon="shield" from="#1479BD" to="#4aa3df" className="absolute right-5 top-5" />
          <p className={cx(DASHBOARD_LABEL, 'min-h-9 pr-12')}>Modules Available</p>
          <p className="mt-3 text-4xl font-bold tabular-nums text-[#0b3b66]">{formatCount(modules.length)}</p>
          <p className="mt-3 truncate text-sm text-slate-600">{roleNames}</p>
        </div>

        <div className={DASHBOARD_CARD} style={{ animationDelay: '0.12s' }}>
          <span className="card-dots" aria-hidden="true" />
          <IconTile icon="pulse" from="#1479BD" to="#4aa3df" className="absolute right-5 top-5" />
          <p className={cx(DASHBOARD_LABEL, 'min-h-9 pr-12')}>System Status</p>
          {/* Says only whether the dashboard's own request to the API succeeded. */}
          <p className="mt-3 flex items-center gap-2 text-xl font-bold text-[#0b3b66]">
            <span
              className={cx('h-2.5 w-2.5 rounded-full', summary.isError ? 'bg-red-500' : summary.isSuccess ? 'bg-emerald-500' : 'bg-amber-400')}
              aria-hidden="true"
            />
            {summary.isError ? 'Unreachable' : summary.isSuccess ? 'Connected' : 'Checking…'}
          </p>
          <p className="mt-3 text-sm text-slate-600">API and database</p>
        </div>
      </div>
    </section>
  )

  return (
    <>
      <div className="login-rise relative mb-7 overflow-hidden rounded-2xl app-banner shadow-lg shadow-sky-900/10">
        <div className="flex flex-wrap items-center justify-between gap-6 px-6 py-6 sm:px-8">
          <div className="min-w-0">
            <p className="bn-eyebrow text-xs font-semibold uppercase tracking-[0.2em]">
              {now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </p>
            <h1 className="bn-strong mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Dashboard</h1>
            <p className="bn-sub mt-1 break-words text-sm">{`${greeting(now)}, ${auth.user?.fullName ?? ''}.`}</p>

            <div className="mt-5 flex flex-wrap gap-2">
              {quickLinks.map((link) => (
                <Link key={link.to} to={link.to} className="bn-chip rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors">
                  {link.label}
                </Link>
              ))}
              <button
                type="button"
                onClick={() => void summary.refetch()}
                disabled={summary.isFetching}
                aria-busy={summary.isFetching || undefined}
                className="bn-chip inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70"
              >
                <svg
                  viewBox="0 0 24 24"
                  className={cx('h-4 w-4', summary.isFetching && 'animate-spin motion-reduce:animate-none')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M20 11a8 8 0 0 0-14.3-4.5M4 13a8 8 0 0 0 14.3 4.5M5 3.5v3.5h3.5M19 20.5V17h-3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Refresh
              </button>
            </div>
          </div>

          <div className="bn-panel flex items-center gap-4 rounded-xl px-5 py-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white shadow-md">
              <img src="/stslv-logo.png" alt="" className="h-10 w-10 object-contain" />
            </span>
            <div className="leading-tight">
              <p className="bn-strong text-base font-semibold">Smart Technical Service LLC</p>
              <p className="bn-sub mt-1 text-xs">STSLEV AMC · Operations Suite</p>
            </div>
          </div>
        </div>
        <div className="flex h-[3px]" aria-hidden="true">
          <span className="flex-1 bg-gradient-to-r from-white/30 via-white/80 to-white/30" />
        </div>
      </div>

      {summary.isError && (
        <div className="mb-6">
          <Alert>
            The dashboard figures could not be loaded. {errorMessage(summary.error)}{' '}
            <button type="button" className="font-medium underline" onClick={() => void summary.refetch()}>
              Try again
            </button>
          </Alert>
        </div>
      )}

      {lead ? (
        <div className="mb-8 grid gap-x-4 gap-y-8 xl:grid-cols-3">
          <section aria-labelledby={`dashboard-${lead.id}`} className="flex flex-col">
            <SectionHeading id={`dashboard-${lead.id}`} accent={SECTION_ACCENTS[0] as string}>
              {lead.title}
            </SectionHeading>
            <div className="grid flex-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
              {lead.cards.map(({ metric, state, link }) => (
                <MetricCard key={metric.id} metric={metric} state={state} link={link} index={0} ring={ringOf(metric)} />
              ))}
            </div>
          </section>
          {workspace}
        </div>
      ) : (
        <div className="mb-8">{workspace}</div>
      )}

      {rollout.length > 0 && (
        <section aria-labelledby="dashboard-rollout" className="mb-8">
          <SectionHeading id="dashboard-rollout" accent={SECTION_ACCENTS[0] as string}>
            Module rollout
          </SectionHeading>
          <div className="surface login-rise rounded-2xl p-4 sm:p-5">
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {rollout.map((item) => {
                const live = !item.pending

                return (
                  <li
                    key={item.path}
                    className={cx(
                      'flex items-center gap-3 rounded-xl border p-3 transition-colors',
                      live ? 'border-slate-200 bg-slate-50/70 hover:border-sky-300 hover:bg-sky-50' : 'border-dashed border-slate-300',
                    )}
                  >
                    <IconTile icon={MODULE_ICONS[item.module]} from={live ? '#1479BD' : '#94A3B8'} to={live ? '#4aa3df' : '#CBD5E1'} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-900">{item.label}</p>
                      <p className={cx('flex items-center gap-1.5 text-xs font-medium', live ? 'text-emerald-700' : 'text-slate-600')}>
                        <span className={cx('h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden="true" />
                        {live ? 'Live' : 'Planned'}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        </section>
      )}

      {groups.length === 0 && (
        <Card className="mb-8 rounded-2xl">
          <EmptyState
            title="No figures to show"
            description="Your role does not include any module that reports to the dashboard. If you need one, ask an administrator to update your role."
          />
        </Card>
      )}

      {sections.map((group, position) => (
        <section key={group.id} aria-labelledby={`dashboard-${group.id}`} className="mb-8">
          <SectionHeading id={`dashboard-${group.id}`} accent={SECTION_ACCENTS[0] as string}>
            {group.title}
          </SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {group.cards.map(({ metric, state, link }, index) => (
              <MetricCard key={metric.id} metric={metric} state={state} link={link} index={offsetOf(position) + index} ring={ringOf(metric)} />
            ))}
          </div>
        </section>
      ))}

      {groups.length > 0 && (
        <p className="text-xs text-slate-600">
          {summary.data && !summary.isError && <>Figures as of {formatTime(summary.dataUpdatedAt)}. </>}
          {pending > 0 && (
            <>
              Figures marked “Not yet available” have no data source yet. They are left empty on purpose, so nothing here can be mistaken
              for real operational data.
            </>
          )}
        </p>
      )}
    </>
  )
}
