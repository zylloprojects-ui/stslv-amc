import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { isAdmin } from '../auth/roles'
import { usePageTitle } from '../components/hooks'
import { LoadError } from '../components/records'
import { Alert, Button, Spinner } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { cx, formatTime } from '../lib/format'
import { NAVIGATION, navItemVisible } from '../layout/navigation'
import type { Module } from '../lib/types'
import { formatDate } from './amc/amcFormat'
import { DEFAULT_KPI_ORDER } from './dashboard/kpis'
import { KpiStrip } from './dashboard/KpiStrip'
import { MaintenanceCalendar } from './dashboard/MaintenanceCalendar'
import { MetricCard, type MetricState } from './dashboard/MetricCard'
import { METRIC_GROUPS, type DashboardSummary, type MetricDefinition } from './dashboard/metrics'
import type { OperationsDashboard, Readiness } from './dashboard/operationsTypes'
import { RecentInvoices } from './dashboard/RecentInvoices'
import { ExpiringContracts, PaymentTrend, PortfolioStatus, ReadinessChecks, WorkloadChart } from './dashboard/Widgets'
import { useKpiOrder, useStoredFlag } from './dashboard/dashboardPreferences'

// STSLV has no Security Center or Backup & Restore module; these are the security views it does have.
const SECURITY_PAGES = ['Login History', 'Audit Log']

const SECTION_HEADING = 'mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[#0b3b66]'

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className={SECTION_HEADING}>
      <span className="h-4 w-1 rounded-full bg-[#1479BD]" aria-hidden="true" />
      {children}
    </h2>
  )
}

/** A dashboard widget: title, what it measures, an optional link to the module behind it. */
function Panel({ id, title, description, link, className, children }: { id: string; title: string; description: string; link?: { to: string; label: string } | null; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cx('surface min-w-0 rounded-2xl p-4 sm:p-5', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          <p className="text-xs text-slate-600">{description}</p>
        </div>
        {link && (
          <Link to={link.to} className="shrink-0 text-sm font-medium text-[#1479BD] hover:underline">
            {link.label} →
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

/** The AMC Operations Dashboard. Every figure comes from the API, which leaves out what the user may not see. */
export function DashboardPage() {
  const auth = useAuth()
  const userId = auth.user?.id ?? 'anonymous'
  const admin = isAdmin(auth.user)
  const canView = (module: Module) => auth.can(module, 'VIEW')
  const canSchedule = canView('AMC_SCHEDULE')

  usePageTitle('Dashboard')

  const operations = useQuery({ queryKey: ['dashboard', 'operations'], queryFn: () => api.get<OperationsDashboard>('/dashboard/operations') })
  const summary = useQuery({ queryKey: ['dashboard', 'summary'], queryFn: () => api.get<DashboardSummary>('/dashboard/summary') })
  const readiness = useQuery({ queryKey: ['dashboard', 'readiness'], queryFn: () => api.get<Readiness>('/dashboard/readiness'), enabled: admin })

  const kpiOrder = useKpiOrder(userId, DEFAULT_KPI_ORDER)
  const [arranging, setArranging] = useState(false)
  const [calendarOpen, setCalendarOpen] = useStoredFlag(userId, 'calendar-open', true)

  const data = operations.data
  const refreshing = operations.isFetching || summary.isFetching
  const refresh = () => {
    void operations.refetch()
    void summary.refetch()
    if (admin) void readiness.refetch()
  }

  // The other modules' figures, under the permission each module already requires.
  const stateOf = (metric: MetricDefinition): MetricState | null => {
    if (!metric.read) return { kind: 'unavailable' }
    if (summary.data) {
      const reading = metric.read(summary.data, canView)

      return reading ? { kind: 'ready', reading } : null
    }

    return summary.isError ? { kind: 'failed' } : { kind: 'loading' }
  }
  const moreCards = METRIC_GROUPS.flatMap((group) => group.metrics)
    .filter((metric) => metric.visible(canView))
    .flatMap((metric) => {
      const state = stateOf(metric)

      return state ? [{ metric, state, link: metric.links?.find((link) => canView(link.module)) ?? null }] : []
    })

  const online = operations.isSuccess && !operations.isError
  // The security pages that exist, taken from the navigation so a link is offered only where the page is.
  const securityLinks = NAVIGATION.flatMap((section) => section.items).filter(
    (item) => SECURITY_PAGES.includes(item.label) && navItemVisible(item, canView, admin),
  )

  return (
    <>
      <div className="login-rise relative mb-6 overflow-hidden rounded-2xl app-banner shadow-lg shadow-sky-900/10">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 sm:px-8">
          <div className="min-w-0">
            <p className="bn-eyebrow text-xs font-semibold uppercase tracking-[0.2em]">{data ? formatDate(data.asOf) : 'Smart Technical Service LLC'}</p>
            <h1 className="bn-strong mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">AMC Operations Dashboard</h1>
            <p className="bn-sub mt-1 text-sm">Contracts, scheduled maintenance, invoicing and renewals at a glance.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* Says only whether the dashboard's own request to the API succeeded. */}
            <span className="bn-chip inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium" role="status">
              <span
                className={cx('h-2.5 w-2.5 rounded-full', operations.isError ? 'bg-red-500' : online ? 'bg-emerald-500' : 'bg-amber-400')}
                aria-hidden="true"
              />
              {operations.isError ? 'System unreachable' : online ? 'System online' : 'Checking…'}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              aria-busy={refreshing || undefined}
              className="bn-chip rounded-lg px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-70"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            {auth.can('AMC_CONTRACTS', 'CREATE') && (
              <Link to="/amc/contracts" className="bn-chip rounded-lg px-3 py-1.5 text-sm font-semibold">
                + New AMC
              </Link>
            )}
          </div>
        </div>
      </div>

      {operations.isError && (
        <div className="mb-5">
          <Alert>
            The dashboard figures could not be loaded. {errorMessage(operations.error)}{' '}
            <button type="button" className="font-medium underline" onClick={() => void operations.refetch()}>
              Try again
            </button>
          </Alert>
        </div>
      )}

      <section aria-labelledby="dashboard-kpis" className="mb-7">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <SectionHeading id="dashboard-kpis">Key figures</SectionHeading>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
              {arranging ? 'Done arranging' : 'Arrange KPIs'}
            </Button>
            <Button variant="secondary" size="sm" onClick={kpiOrder.reset}>
              Reset KPI Layout
            </Button>
          </div>
        </div>
        {arranging && <p className="mb-2 text-xs text-slate-600">Drag a card, or use its arrow buttons. The order is remembered in this browser for your account.</p>}
        <KpiStrip data={data} failed={operations.isError} canView={canView} order={kpiOrder.order} arranging={arranging} onReorder={kpiOrder.setOrder} />
      </section>

      {operations.isPending && <Spinner label="Loading dashboard" />}

      {data?.schedule && (
        <Panel
          id="dashboard-calendar"
          title="Daily operations — AMC Maintenance Calendar"
          description={`Today’s scheduled work and the open service obligations ahead. Dates are counted in the server time zone (${data.timeZone}).`}
          className="mb-6"
        >
          <MaintenanceCalendar
            schedule={data.schedule}
            asOf={data.asOf}
            canSchedule={canSchedule}
            canInvoices={canView('INVOICES')}
            expanded={calendarOpen}
            onToggle={setCalendarOpen}
          />
        </Panel>
      )}

      {data && (data.workload || data.payments) && (
        <div className="mb-6 grid gap-6 lg:grid-cols-2">
          {data.workload && (
            <Panel
              id="dashboard-workload"
              title="Upcoming Service Workload"
              description="Visits planned per month from this month. Cancelled visits and cancelled contracts are not counted."
              link={canSchedule ? { to: '/amc/schedule', label: 'Schedule' } : null}
            >
              <WorkloadChart months={data.workload.months} />
            </Panel>
          )}
          {data.payments && (
            <Panel
              id="dashboard-payments"
              title="Payment Trend"
              description="Paid invoice value · last six months"
              link={{ to: '/invoices', label: 'Invoice Tracking' }}
            >
              <PaymentTrend payments={data.payments} />
            </Panel>
          )}
        </div>
      )}

      {data && (data.portfolio || data.expiring) && (
        <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          {data.portfolio && (
            <Panel id="dashboard-portfolio" title="AMC Portfolio Status" description="Contracts by status, all statuses STSLV supports." link={{ to: '/amc/contracts', label: 'AMC Contracts' }}>
              <PortfolioStatus portfolio={data.portfolio} />
            </Panel>
          )}
          {data.expiring && (
            <Panel
              id="dashboard-expiring"
              title="Expiring Contracts"
              description={`Active contracts ending in the next ${data.expiring.days} days. Nothing is renewed or expired automatically.`}
              link={canView('REPORTS') ? { to: '/reports', label: 'Expiry and renewal reports' } : null}
            >
              <ExpiringContracts expiring={data.expiring} />
            </Panel>
          )}
        </div>
      )}

      {canView('INVOICES') && (
        <Panel id="dashboard-invoices" title="Recent Invoices" description="Latest invoices recorded from Zoho, newest invoice date first." link={{ to: '/invoices', label: 'Invoice Tracking' }} className="mb-6">
          <RecentInvoices userId={userId} canExport={auth.can('INVOICES', 'EXPORT')} />
        </Panel>
      )}

      {moreCards.length > 0 && (
        <section aria-labelledby="dashboard-more" className="mb-6">
          <SectionHeading id="dashboard-more">Waiting for an invoice and other figures</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {moreCards.map(({ metric, state, link }, index) => (
              <MetricCard key={metric.id} metric={metric} state={state} link={link} index={index} />
            ))}
          </div>
        </section>
      )}

      {admin && (
        <Panel
          id="dashboard-readiness"
          title="Production Readiness"
          description="Checks the API can verify itself. There is no overall score."
          className="mb-6"
        >
          {readiness.isPending && <Spinner size="sm" label="Checking" />}
          {readiness.isError && <LoadError error={readiness.error} onRetry={() => void readiness.refetch()} />}
          {readiness.data && <ReadinessChecks readiness={readiness.data} />}
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            {securityLinks.map((item) => (
              <Link key={item.path} to={item.path} className="font-medium text-[#1479BD] hover:underline">
                {item.label} →
              </Link>
            ))}
          </div>
        </Panel>
      )}

      {data && (
        <p className="text-xs text-slate-600">
          Figures as of {formatTime(operations.dataUpdatedAt)}, for {formatDate(data.asOf)} ({data.timeZone}).
        </p>
      )}
    </>
  )
}
