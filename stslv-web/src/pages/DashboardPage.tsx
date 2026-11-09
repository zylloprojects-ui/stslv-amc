import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/context'
import { usePageTitle } from '../components/hooks'
import { Alert, Spinner } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { cx, formatTime } from '../lib/format'
import type { Module } from '../lib/types'
import { formatDate } from './amc/amcFormat'
import { Icon, type IconName } from './dashboard/icons'
import { KpiStrip } from './dashboard/KpiStrip'
import { MaintenanceCalendar } from './dashboard/MaintenanceCalendar'
import type { OperationsDashboard } from './dashboard/operationsTypes'
import { RecentInvoices } from './dashboard/RecentInvoices'
import { ExpiringContracts, PaymentTrend, PortfolioStatus, WorkloadChart } from './dashboard/Widgets'
import { businessToday, formatBusinessDayLong } from '../lib/businessDate'

// AMC Portfolio Status, Expiring Contracts and Recent Invoices are hidden on the dashboard by default. Set VITE_SHOW_DASHBOARD_DETAIL_PANELS=true to bring them back.
// Read on each render (not once at load) so tests can check both settings.
const showDetailPanels = () => import.meta.env.VITE_SHOW_DASHBOARD_DETAIL_PANELS === 'true'

const SECTION_HEADING = 'mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[#0b3b66]'

function SectionHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className={SECTION_HEADING}>
      <span className="h-4 w-1 rounded-full bg-[#1479BD]" aria-hidden="true" />
      {children}
    </h2>
  )
}

/** A dashboard widget: a heading in the same style as every section heading, what it measures, and an optional link, above a plain card. */
function Panel({ id, icon, eyebrow, title, description, link, className, children }: { id: string; icon: IconName; eyebrow: string; title: string; description: string; link?: { to: string; label: string } | null; className?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cx('flex min-w-0 flex-col lg:grid-cols-[minmax(0,1fr)]', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0e5a96] to-[#2f9bd8] text-white shadow-sm"
            aria-hidden="true"
          >
            <Icon name={icon} className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <h2 id={id} title={description}>
              <span className="flex items-center gap-2.5 text-[10px] font-bold uppercase tracking-[0.18em] text-[#1479BD]" aria-hidden="true">
                <span className="h-1.5 w-1.5 rounded-full bg-[#1479BD]" />
                {eyebrow}
                <span className="h-px w-8 bg-gradient-to-r from-[#1479BD]/50 to-transparent" />
              </span>
              <span className="block text-lg font-bold leading-tight tracking-tight text-[#0b3b66]">
                {title}
              </span>
            </h2>
                      </div>
        </div>
        {link && (
          <Link to={link.to} className="shrink-0 whitespace-nowrap rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-bold text-[#0b3b66] hover:border-[#1479BD] hover:bg-white">
            {link.label} →
          </Link>
        )}
      </div>
      <div className="surface flex flex-1 flex-col rounded-2xl p-4 sm:p-5">{children}</div>
    </section>
  )
}

/** The AMC Operations Dashboard. Every figure comes from the API, which leaves out what the user may not see. */
function greeting() {
  const hour = new Date().getHours()

  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

export function DashboardPage() {
  const auth = useAuth()
  const userId = auth.user?.id ?? 'anonymous'
  const canView = (module: Module) => auth.can(module, 'VIEW')
  const canSchedule = canView('AMC_SCHEDULE')

  usePageTitle('Dashboard')

  const operations = useQuery({ queryKey: ['dashboard', 'operations'], queryFn: () => api.get<OperationsDashboard>('/dashboard/operations') })

  const data = operations.data
  const refreshing = operations.isFetching
  const refresh = () => void operations.refetch()

  const online = operations.isSuccess && !operations.isError

  return (
    <>
      <div className="login-rise relative mb-7 overflow-hidden rounded-2xl app-banner shadow-lg shadow-sky-900/10">
        <div className="flex flex-wrap items-center justify-between gap-6 px-6 py-6 sm:px-8">
          <div className="min-w-0">
            <p className="bn-eyebrow text-xs font-semibold uppercase tracking-[0.2em]">
              {formatBusinessDayLong(data ? data.asOf : businessToday())}
            </p>
            <h1 className="bn-strong mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">AMC Operations Dashboard</h1>
            <p className="bn-sub mt-1 break-words text-sm">{`${greeting()}, ${auth.user?.fullName ?? ''}. Contracts, scheduled maintenance, invoicing and renewals at a glance.`}</p>

            <div className="mt-5 flex flex-wrap gap-2">
              {auth.can('AMC_CONTRACTS', 'CREATE') && (
                <Link to="/amc/contracts" className="bn-chip rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors">
                  + New AMC
                </Link>
              )}
              {/* Says only whether the dashboard's own request to the API succeeded. */}
              <span className="bn-chip inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium" role="status">
                <span className={cx('h-2.5 w-2.5 rounded-full', operations.isError ? 'bg-red-500' : online ? 'bg-emerald-500' : 'bg-amber-400')} aria-hidden="true" />
                {operations.isError ? 'System unreachable' : online ? 'System online' : 'Checking…'}
              </span>
              <button
                type="button"
                onClick={refresh}
                disabled={refreshing}
                aria-busy={refreshing || undefined}
                className="bn-chip inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70"
              >
                <svg viewBox="0 0 24 24" className={cx('h-4 w-4', refreshing && 'animate-spin motion-reduce:animate-none')} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M20 11a8 8 0 0 0-14.3-4.5M4 13a8 8 0 0 0 14.3 4.5M5 3.5v3.5h3.5M19 20.5V17h-3.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>

          <div className="bn-panel flex items-center gap-4 rounded-xl px-5 py-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white shadow-md">
              <img src="/stslv-logo.png" alt="" className="h-10 w-10 object-contain" />
            </span>
            <div className="leading-tight">
              <p className="bn-strong text-base font-semibold">Smart Technical Service LLC</p>
              <p className="bn-sub mt-1 text-xs">STS-ELV AMC · Operations Suite</p>
            </div>
          </div>
        </div>
        <div className="flex h-[3px]" aria-hidden="true">
          <span className="flex-1 bg-gradient-to-r from-white/30 via-white/80 to-white/30" />
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
        <SectionHeading id="dashboard-kpis">Key figures</SectionHeading>
        {/* Twelve cards in a fixed order (the client's reference). Cards saved by the old Arrange KPIs are no longer read; nothing stored is deleted. */}
        <KpiStrip data={data} failed={operations.isError} canView={canView} />
      </section>

      {operations.isPending && <Spinner label="Loading dashboard" />}

      {data?.schedule && (
        <Panel
          id="dashboard-calendar"
          icon="calendar"
          eyebrow="Daily operations"
          title="AMC Maintenance Calendar"
          description={`Today’s scheduled work and the open service obligations ahead. Dates are counted in the server time zone (${data.timeZone}).`}
          className="mb-6"
        >
          <MaintenanceCalendar
            schedule={data.schedule}
            asOf={data.asOf}
            canSchedule={canSchedule}
            canInvoices={canView('INVOICES')}
          />
        </Panel>
      )}

      {data && (data.workload || data.paymentTrend) && (
        <div className="mb-6 grid gap-x-6 lg:grid-cols-2 lg:grid-rows-[auto_1fr]">
          {data.workload && (
            <Panel
              id="dashboard-workload"
              className="max-lg:mb-6 lg:row-span-2 lg:grid lg:grid-rows-subgrid"
              icon="execution"
              eyebrow="Maintenance"
              title="Upcoming Service Workload"
              description="Visits planned per month from this month. Cancelled visits and cancelled contracts are not counted."
              link={canSchedule ? { to: '/amc/schedule', label: 'Schedule' } : null}
            >
              <WorkloadChart months={data.workload.months} />
            </Panel>
          )}
          {data.paymentTrend && (
            <Panel
              id="dashboard-payments"
              className="max-lg:mb-6 lg:row-span-2 lg:grid lg:grid-rows-subgrid"
              icon="wallet"
              eyebrow="Billing"
              title="Payment Trend"
              description="Value of services marked Paid · last six months"
              link={{ to: '/finance/accounts', label: 'Accounts' }}
            >
              <PaymentTrend months={data.paymentTrend.months} />
            </Panel>
          )}
        </div>
      )}

      {showDetailPanels() && data && (data.portfolio || data.expiring) && (
        <div className="mb-6 grid gap-x-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-rows-[auto_1fr]">
          {data.portfolio && (
            <Panel id="dashboard-portfolio" className="max-lg:mb-6 lg:row-span-2 lg:grid lg:grid-rows-subgrid" icon="chart"
              eyebrow="Portfolio" title="AMC Portfolio Status" description="Contracts by status, all statuses STSLV supports." link={{ to: '/amc/contracts', label: 'AMC Contracts' }}>
              <PortfolioStatus portfolio={data.portfolio} />
            </Panel>
          )}
          {data.expiring && (
            <Panel
              id="dashboard-expiring"
              className="max-lg:mb-6 lg:row-span-2 lg:grid lg:grid-rows-subgrid"
              icon="contract"
              eyebrow="Renewals"
              title="Expiring Contracts"
              description={`Active contracts ending in the next ${data.expiring.days} days. Nothing is renewed or expired automatically.`}
              link={canView('REPORTS') ? { to: '/reports?report=expiry-renewal', label: 'Expiry report' } : { to: '/amc/contracts', label: 'AMC Contracts' }}
            >
              <ExpiringContracts expiring={data.expiring} />
            </Panel>
          )}
        </div>
      )}

      {showDetailPanels() && canView('INVOICES') && (
        <Panel id="dashboard-invoices" icon="invoice"
          eyebrow="Finance" title="Recent Invoices (Zoho)" description="Latest invoices recorded from Zoho, newest invoice date first." link={{ to: '/invoices', label: 'Invoice Tracking' }} className="mb-6">
          <RecentInvoices userId={userId} canExport={auth.can('INVOICES', 'EXPORT')} />
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
