import { useQuery } from '@tanstack/react-query'
import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { TABLE } from '../../components/table'
import { Alert, Button, PageHeader, Spinner } from '../../components/ui'
import { api, errorMessage } from '../../lib/api'
import { cx, formatCount, formatTime } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import type { Module } from '../../lib/types'
import { formatDate } from '../amc/amcFormat'
import { ContractStatusPill } from '../amc/components'
import { ContractFormModal } from '../amc/ContractFormModal'
import type { SavedContract } from '../amc/types'
import { Icon, type IconName } from '../dashboard/icons'
import { KpiGroup } from './KpiGroup'
import { KPI_GROUPS } from './managementKpis'
import { MANAGEMENT_QUERY_KEY, type AmcManagementSummary, type ExpiryBand } from './managementTypes'

// AMC Management: the administrative control center of the AMC system. Every
// figure comes from GET /api/amc/management/summary, which leaves out what the
// user may not see. Nothing on this page writes, except "+ New AMC", which
// opens the same contract form as AMC Contracts.

const ACTION =
  'inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm font-medium transition-colors bn-chip'

function Panel({ title, description, link, children, id }: { id?: string; title: string; description: string; link?: { to: string; label: string } | null; children: ReactNode }) {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} id={id} className="flex min-w-0 flex-col">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-bold leading-tight tracking-tight text-[#0b3b66]">
            {title}
          </h2>
          <p className="mt-0.5 text-xs text-slate-600">{description}</p>
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

function RecentContracts({ recent }: { recent: AmcManagementSummary['recentContracts'] }) {
  if (recent.items.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-600">No AMC contracts have been added yet.</p>
  }

  return (
    <div className={TABLE.wrapper}>
      <table className={TABLE.table}>
        <caption className="sr-only">Latest AMC contracts, newest first</caption>
        <thead>
          <tr>
            <th scope="col" className={TABLE.th}>AMC reference</th>
            <th scope="col" className={TABLE.th}>Client</th>
            <th scope="col" className={TABLE.th}>System</th>
            <th scope="col" className={TABLE.th}>Status</th>
            <th scope="col" className={`${TABLE.th} text-right`}>Contract value</th>
            <th scope="col" className={TABLE.th}><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {recent.items.map((row) => (
            <tr key={row.id} className={TABLE.row}>
              <td className={cx(TABLE.td, 'whitespace-nowrap font-medium')}>{row.reference}</td>
              <td className={cx(TABLE.td, TABLE.text)}>{row.client.name}</td>
              <td className={cx(TABLE.td, TABLE.text)}>{row.systemDescription}</td>
              <td className={TABLE.td}>
                <ContractStatusPill status={row.status} />
              </td>
              <td className={cx(TABLE.td, 'whitespace-nowrap text-right tabular-nums')}>{formatMoney(row.contractValue)}</td>
              <td className={cx(TABLE.td, 'text-right')}>
                <Link to={`/amc/contracts/${row.id}`} aria-label={`View ${row.reference}`} className="font-medium text-[#1479BD] hover:underline">
                  View
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const BAND_TONE: Record<ExpiryBand, string> = {
  90: 'border-sky-200 bg-sky-50 text-sky-900',
  60: 'border-sky-200 bg-sky-50 text-sky-900',
  45: 'border-amber-300 bg-amber-50 text-amber-900',
  30: 'border-amber-300 bg-amber-50 text-amber-900',
  15: 'border-red-300 bg-red-50 text-red-900',
}

const daysText = (days: number) => (days < 0 ? `${formatCount(-days)} days ago` : days === 0 ? 'Today' : `${formatCount(days)} ${days === 1 ? 'day' : 'days'}`)

function ExpiryFigure({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: 'red' | 'amber' }) {
  return (
    <div className={cx('rounded-xl border p-4', tone === 'red' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50')}>
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">{label}</h3>
      <p className={cx('mt-2 text-3xl font-bold tabular-nums', tone === 'red' ? 'text-red-800' : 'text-amber-900')}>{formatCount(value)}</p>
      <p className="mt-1 text-xs text-slate-700">{detail}</p>
    </div>
  )
}

function ExpiryRenewal({ expiry }: { expiry: AmcManagementSummary['expiry'] }) {
  const { critical, notRenewedExpired, renewalWarning, bands, list } = expiry

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <ExpiryFigure
          label={`Critical — expiring within ${critical.days} days`}
          value={critical.count}
          tone="red"
          detail={`Active contracts · ${formatCount(critical.notRenewed)} not renewed`}
        />
        <ExpiryFigure
          label="Not Renewed & Expired"
          value={notRenewedExpired.count}
          tone="amber"
          detail={`${formatCount(notRenewedExpired.expiredStatus)} with status Expired · ${formatCount(notRenewedExpired.activePastValidity)} still Active past validity`}
        />
      </div>

      {/* Always shown while it applies: reading or clearing other warnings never hides it. */}
      <p role="note" className={cx('rounded-lg border px-3 py-2 text-sm font-medium', renewalWarning.count > 0 ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-800')}>
        {renewalWarning.count > 0
          ? `Renewal warning: ${formatCount(renewalWarning.count)} active ${renewalWarning.count === 1 ? 'contract ends' : 'contracts end'} within ${renewalWarning.days} days without a renewal.`
          : `No active contract ends within ${renewalWarning.days} days without a renewal.`}
      </p>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">Expiry warning bands (active contracts)</h3>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Expiry warning bands">
          {bands.map((band) => (
            <li key={band.days} className={cx('rounded-lg border px-3 py-2', BAND_TONE[band.days])}>
              <p className="text-xs font-semibold">
                {band.days} days
                <span className="block font-normal">{band.fromDays}–{band.days} days left</span>
              </p>
              <p className="mt-1 text-xl font-bold tabular-nums">{formatCount(band.count)}</p>
              <p className="text-xs">{formatCount(band.notRenewed)} not renewed</p>
            </li>
          ))}
        </ul>
      </div>

      {list.total === 0 ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm font-semibold text-emerald-800">
          ✓ No active AMC ends in the next {list.days} days.
        </p>
      ) : (
        <div>
          <p className="mb-2 text-xs text-slate-600">
            {formatCount(list.total)} active {list.total === 1 ? 'contract ends' : 'contracts end'} within {list.days} days or {list.total === 1 ? 'is' : 'are'} past validity
            {list.total > list.items.length && ` · showing the first ${list.items.length}`}
          </p>
          <div className={TABLE.wrapper}>
            <table className={TABLE.table}>
              <caption className="sr-only">Active contracts ending within {list.days} days</caption>
              <thead>
                <tr>
                  <th scope="col" className={TABLE.th}>AMC reference</th>
                  <th scope="col" className={TABLE.th}>Client</th>
                  <th scope="col" className={TABLE.th}>Expiry</th>
                  <th scope="col" className={`${TABLE.th} text-right`}>Days left</th>
                  <th scope="col" className={TABLE.th}>Renewal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.items.map((row) => (
                  <tr key={row.id} className={TABLE.row}>
                    <td className={cx(TABLE.td, 'whitespace-nowrap')}>
                      <Link to={`/amc/contracts/${row.id}`} className="font-medium text-[#1479BD] hover:underline">
                        {row.reference}
                      </Link>
                    </td>
                    <td className={cx(TABLE.td, TABLE.text)}>
                      {row.client.name}
                      <span className="block text-xs text-slate-600">{row.systemDescription}</span>
                    </td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap')}>
                      {formatDate(row.validTo)}
                      {row.band !== null && <span className="block text-xs text-slate-600">{row.band}-day band</span>}
                    </td>
                    <td className={cx(TABLE.td, 'whitespace-nowrap text-right tabular-nums', row.daysLeft < 0 && 'font-semibold text-red-700')}>{daysText(row.daysLeft)}</td>
                    <td className={TABLE.td}>
                      {!expiry.renewalsInstalled ? (
                        <span className="text-xs text-slate-600">Renewals not installed</span>
                      ) : row.renewal ? (
                        <Link to={`/amc/contracts/${row.renewal.id}`} className="inline-flex items-center gap-1 text-xs text-[#1479BD] hover:underline">
                          Renewal <ContractStatusPill status={row.renewal.status} />
                        </Link>
                      ) : (
                        <Link to={`/amc/contracts/${row.id}`} className="text-xs font-medium text-[#1479BD] hover:underline">
                          Not renewed · open to renew
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-xs text-slate-600">
        A renewal is added from the contract page as a new contract linked to the original, which stays unchanged. Contracts are not expired automatically: there is no daily expiry job, so an Active contract past its validity is changed to Expired by a user.
      </p>
    </div>
  )
}

interface ActionSpec {
  label: string
  to: string
  icon: IconName
  module: Module
}

const ACTIONS: ActionSpec[] = [
  { label: 'Schedule Engine', to: '/amc/schedule', icon: 'calendar', module: 'AMC_SCHEDULE' },
  { label: 'Invoices', to: '/invoices', icon: 'invoice', module: 'INVOICES' },
]

export function AmcManagementPage() {
  const auth = useAuth()
  const userId = auth.user?.id ?? 'anonymous'
  const canView = (module: Module) => auth.can(module, 'VIEW')
  const canCreate = auth.can('AMC_CONTRACTS', 'CREATE')
  const [creating, setCreating] = useState(false)
  const [saved, setSaved] = useState<SavedContract | null>(null)

  const summary = useQuery({ queryKey: MANAGEMENT_QUERY_KEY, queryFn: () => api.get<AmcManagementSummary>('/amc/management/summary') })
  const data = summary.data

  return (
    <>
      <PageHeader
        title="AMC Management"
        description="Contract master and automatic schedule control center"
        actions={
          <>
            {ACTIONS.filter((action) => canView(action.module)).map((action) => (
              <Link key={action.label} to={action.to} className={ACTION}>
                <Icon name={action.icon} className="h-4 w-4" />
                {action.label}
              </Link>
            ))}
            <Link to="/notifications" className={ACTION}>
              <Icon name="shield" className="h-4 w-4" />
              Alerts
            </Link>
            {/* No Reports page exists yet: shown as unavailable, never as a working link. */}
            <span className={cx(ACTION, 'cursor-not-allowed opacity-60')} aria-disabled="true" title="A Reports page has not been built yet. Exports are available on AMC Schedule, Service Status and Invoice Tracking.">
              <Icon name="chart" className="h-4 w-4" />
              Reports
              <span className="text-xs">(not built yet)</span>
            </span>
            {canCreate && (
              <Button onClick={() => setCreating(true)}>
                + New AMC
              </Button>
            )}
          </>
        }
      />

      {saved && (
        <div className="mb-4">
          <Alert tone="success" onDismiss={() => setSaved(null)}>
            The contract for {saved.client.name} {saved.systemDescription} was added.{' '}
            <Link to={`/amc/contracts/${saved.id}`} className="font-medium underline">
              Open the contract
            </Link>
          </Alert>
        </div>
      )}

      {summary.isError && (
        <div className="mb-5">
          <Alert>
            The AMC Management figures could not be loaded. {errorMessage(summary.error)}{' '}
            <button type="button" className="font-medium underline" onClick={() => void summary.refetch()}>
              Try again
            </button>
          </Alert>
        </div>
      )}

      {KPI_GROUPS.filter((group) => group.visible(canView)).map((group) => (
        <KpiGroup key={group.id} group={group} userId={userId} data={data} failed={summary.isError} canView={canView} />
      ))}

      {summary.isPending && <Spinner label="Loading AMC Management" />}

      {data && (
        <div className="mb-6 grid gap-6 xl:grid-cols-2">
          <Panel title="Recent AMC Contracts" description={`Latest contracts added, newest first · ${formatCount(data.recentContracts.total)} in total`} link={{ to: '/amc/contracts', label: 'View All' }}>
            <RecentContracts recent={data.recentContracts} />
          </Panel>
          <Panel id="expiry" title="Expiry & Renewal" description="Warnings at 90, 60, 45, 30 and 15 days before the end of validity." link={{ to: '/amc/contracts', label: 'AMC Contracts' }}>
            <ExpiryRenewal expiry={data.expiry} />
          </Panel>
        </div>
      )}

      {data && (
        <p className="text-xs text-slate-600">
          Figures as of {formatTime(summary.dataUpdatedAt)}, for {formatDate(data.asOf)} ({data.timeZone}).
        </p>
      )}

      {creating && (
        <ContractFormModal
          contract={null}
          onClose={() => setCreating(false)}
          onSaved={(contract) => {
            setSaved(contract)
            setCreating(false)
          }}
        />
      )}
    </>
  )
}
