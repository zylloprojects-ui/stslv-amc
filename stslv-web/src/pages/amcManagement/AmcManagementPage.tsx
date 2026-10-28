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
import { Icon, IconTile, type IconName } from '../dashboard/icons'
import { KpiGroup } from './KpiGroup'
import { KPI_GROUPS } from './managementKpis'
import { MANAGEMENT_QUERY_KEY, type AmcManagementSummary, type ExpiryBand } from './managementTypes'

// AMC Management: the administrative control center of the AMC system. Every
// figure comes from GET /api/amc/management/summary, which leaves out what the
// user may not see. Nothing on this page writes, except "+ New AMC", which
// opens the same contract form as AMC Contracts.

const ACTION =
  'inline-flex items-center justify-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold shadow-sm transition-all hover:-translate-y-px hover:shadow-md bn-chip'

interface PanelProps {
  id?: string
  title: string
  description: string
  icon: IconName
  accent: [string, string]
  link?: { to: string; label: string } | null
  children: ReactNode
}

function Panel({ title, description, link, children, id, icon, accent }: PanelProps) {
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} id={id} className="flex min-w-0 flex-col">
      <div className="surface flex flex-1 flex-col overflow-hidden rounded-2xl">
        <div className="h-1" style={{ backgroundImage: `linear-gradient(90deg, ${accent[0]}, ${accent[1]})` }} aria-hidden="true" />
        <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 bg-gradient-to-r from-sky-50/80 to-transparent px-4 py-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <IconTile icon={icon} from={accent[0]} to={accent[1]} className="h-10 w-10 rounded-xl" />
            <div className="min-w-0">
              <h2 id={headingId} className="text-lg font-bold leading-tight tracking-tight text-[#0b3b66]">
                {title}
              </h2>
              <p className="mt-0.5 text-xs text-slate-600">{description}</p>
            </div>
          </div>
          {link && (
            <Link to={link.to} className="shrink-0 whitespace-nowrap rounded-full border border-sky-200 bg-white px-3 py-1 text-xs font-bold text-[#0b3b66] shadow-sm transition-colors hover:border-[#1479BD] hover:bg-[#1479BD] hover:text-white">
              {link.label} →
            </Link>
          )}
        </div>
        <div className="flex flex-1 flex-col p-4 sm:p-5">{children}</div>
      </div>
    </section>
  )
}

function RecentContracts({ recent }: { recent: AmcManagementSummary['recentContracts'] }) {
  if (recent.items.length === 0) {
    return <p className="py-8 text-center text-sm text-slate-600">No AMC contracts have been added yet.</p>
  }

  // Bar widths compare each value with the largest one shown; display only.
  const largest = Math.max(1, ...recent.items.map((row) => Number(row.contractValue) || 0))

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
              <td className={cx(TABLE.td, 'whitespace-nowrap')}>
                <span className="rounded-md bg-sky-50 px-2 py-1 font-mono text-xs font-bold text-[#0b3b66] ring-1 ring-sky-200">{row.reference}</span>
              </td>
              <td className={cx(TABLE.td, TABLE.text)}>
                <span className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white shadow-md ring-2 ring-white" style={{ backgroundImage: tint(row.client.name) }} aria-hidden="true">
                    {initials(row.client.name)}
                  </span>
                  <span className="font-semibold text-[#0b3b66]">{row.client.name}</span>
                </span>
              </td>
              <td className={cx(TABLE.td, TABLE.text)}>
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tint(row.systemDescription, true) }} aria-hidden="true" />
                  {row.systemDescription}
                </span>
              </td>
              <td className={TABLE.td}>
                <ContractStatusPill status={row.status} />
              </td>
              <td className={cx(TABLE.td, 'whitespace-nowrap text-right')}>
                <span className="block font-bold tabular-nums text-[#0b3b66]">{formatMoney(row.contractValue)}</span>
                <span className="mt-1 ml-auto block h-1 w-24 overflow-hidden rounded-full bg-slate-200/80" aria-hidden="true">
                  <span className="block h-full rounded-full bg-gradient-to-r from-[#1479BD] to-[#00A6C8]" style={{ width: `${Math.max(6, ((Number(row.contractValue) || 0) / largest) * 100)}%` }} />
                </span>
              </td>
              <td className={cx(TABLE.td, 'text-right')}>
                <Link to={`/amc/contracts/${row.id}`} aria-label={`View ${row.reference}`} className="inline-flex rounded-full border border-sky-200 bg-sky-50 px-3 py-0.5 text-xs font-bold text-[#0b3b66] transition-colors hover:border-[#1479BD] hover:bg-[#1479BD] hover:text-white">
                  View →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const TINTS: [string, string][] = [
  ['#1479BD', '#00A6C8'],
  ['#7C3AED', '#A78BFA'],
  ['#059669', '#34D399'],
  ['#EA580C', '#FBBF24'],
  ['#DB2777', '#F472B6'],
  ['#0F766E', '#2DD4BF'],
]

// The same name always gets the same colour, so a client is recognisable at a glance.
const tint = (name: string, solid = false) => {
  const pair = TINTS[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TINTS.length] as [string, string]

  return solid ? pair[0] : `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`
}

const initials = (name: string) =>
  name
    .replace(/^DEMO\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')

const BAND_BAR: Record<ExpiryBand, string> = { 90: 'bg-sky-400', 60: 'bg-sky-500', 45: 'bg-amber-400', 30: 'bg-amber-500', 15: 'bg-red-500' }

const BAND_TONE: Record<ExpiryBand, string> = {
  90: 'border-sky-200 bg-sky-50 text-sky-900 border-t-sky-400',
  60: 'border-sky-200 bg-sky-50 text-sky-900 border-t-sky-500',
  45: 'border-amber-200 bg-amber-50 text-amber-900 border-t-amber-400',
  30: 'border-amber-300 bg-amber-50 text-amber-900 border-t-amber-500',
  15: 'border-red-300 bg-red-50 text-red-900 border-t-red-500',
}

const daysText = (days: number) => (days < 0 ? `${formatCount(-days)} days ago` : days === 0 ? 'Today' : `${formatCount(days)} ${days === 1 ? 'day' : 'days'}`)

function ExpiryFigure({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: 'red' | 'amber' }) {
  const red = tone === 'red'

  return (
    <div className={cx('relative overflow-hidden rounded-2xl border p-5 pl-6 shadow-md transition-transform duration-300 hover:-translate-y-0.5', red ? 'border-red-200 bg-gradient-to-br from-red-100 via-red-50 to-white' : 'border-amber-200 bg-gradient-to-br from-amber-100 via-amber-50 to-white')}>
      <span className={cx('absolute inset-y-0 left-0 w-1.5', red ? 'bg-red-500' : 'bg-amber-500')} aria-hidden="true" />
      <Icon name={red ? 'shield' : 'calendar'} className={cx('pointer-events-none absolute right-4 top-4 h-14 w-14 opacity-25', red ? 'text-red-500' : 'text-amber-500')} />
      <h3 className="relative text-xs font-semibold uppercase tracking-[0.14em] text-slate-700">{label}</h3>
      <p className={cx('relative mt-2 text-5xl font-extrabold tabular-nums', red ? 'text-red-700' : 'text-amber-800')}>{formatCount(value)}</p>
      <p className="mt-1 text-xs text-slate-700">{detail}</p>
    </div>
  )
}

function ExpiryRenewal({ expiry }: { expiry: AmcManagementSummary['expiry'] }) {
  const { critical, notRenewedExpired, renewalWarning, bands, list } = expiry

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
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
        {/* Always shown while it applies: reading or clearing other warnings never hides it. */}
        <p
          role="note"
          className={cx(
            'flex items-center gap-4 rounded-2xl border p-5 text-base font-semibold shadow-md',
            renewalWarning.count > 0 ? 'border-amber-300 bg-gradient-to-br from-amber-100 to-amber-50 text-amber-900' : 'border-emerald-200 bg-gradient-to-br from-emerald-100 via-emerald-50 to-white text-emerald-800',
          )}
        >
          <span
            className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-2xl font-bold text-white shadow-lg ring-4', renewalWarning.count > 0 ? 'bg-amber-500 ring-amber-200' : 'bg-emerald-500 ring-emerald-200')}
            aria-hidden="true"
          >
            {renewalWarning.count > 0 ? '!' : '✓'}
          </span>
          {renewalWarning.count > 0
            ? `Renewal warning: ${formatCount(renewalWarning.count)} active ${renewalWarning.count === 1 ? 'contract ends' : 'contracts end'} within ${renewalWarning.days} days without a renewal.`
            : `No active contract ends within ${renewalWarning.days} days without a renewal.`}
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">Expiry warning bands (active contracts)</h3>
        {/* Time runs left to right: far ahead in blue, about to expire in red. */}
        <div className="mb-3 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500" aria-hidden="true">
          <span>90 days out</span>
          <span className="h-1.5 flex-1 rounded-full bg-gradient-to-r from-sky-400 via-amber-400 to-red-500" />
          <span>Expiry</span>
        </div>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Expiry warning bands">
          {bands.map((band) => {
            const top = Math.max(1, ...bands.map((b) => b.count))

            return (
              <li key={band.days} className={cx('rounded-2xl border border-t-4 px-4 py-3.5 shadow-md transition-transform duration-300 hover:-translate-y-0.5', BAND_TONE[band.days])}>
                <p className="text-sm font-bold">
                  {band.days} days
                  <span className="block text-xs font-normal">{band.fromDays}–{band.days} days left</span>
                </p>
                <p className="mt-2 text-4xl font-extrabold tabular-nums">{formatCount(band.count)}</p>
                <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-black/10" aria-hidden="true">
                  <span className={cx('block h-full rounded-full', BAND_BAR[band.days])} style={{ width: `${(band.count / top) * 100}%` }} />
                </span>
                <p className="mt-1.5 text-xs">{formatCount(band.notRenewed)} not renewed</p>
              </li>
            )
          })}
        </ul>
      </div>

      {list.total === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-50 px-4 py-8 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white shadow-lg ring-8 ring-emerald-100" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </span>
          <p className="text-base font-bold text-emerald-800">✓ No active AMC ends in the next {list.days} days.</p>
          <p className="text-xs text-emerald-700/80">Every active contract is covered. Warnings appear here as validity dates approach.</p>
        </div>
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

      <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
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
        <div className="mb-6 grid gap-6">
          <Panel icon="contract" accent={['#1479BD', '#00A6C8']} title="Recent AMC Contracts" description={`Latest contracts added, newest first · ${formatCount(data.recentContracts.total)} in total`} link={{ to: '/amc/contracts', label: 'View All' }}>
            <RecentContracts recent={data.recentContracts} />
          </Panel>
          <Panel id="expiry" icon="calendar" accent={['#F59E0B', '#EF4444']} title="Expiry & Renewal" description="Warnings at 90, 60, 45, 30 and 15 days before the end of validity." link={{ to: '/amc/contracts', label: 'AMC Contracts' }}>
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
