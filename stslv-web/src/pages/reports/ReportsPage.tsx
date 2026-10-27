import { useQuery } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { LoadError } from '../../components/records'
import { TABLE } from '../../components/table'
import { Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api, ApiError } from '../../lib/api'
import { cx } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { formatDate, formatMoney, monthLabel } from '../amc/amcFormat'
import { ContractStatusPill, VisitStatusPill } from '../amc/components'
import type { ContractStatus, VisitList } from '../amc/types'

// Management reporting over the stored AMC and invoice data. Every figure is
// read from the API, which computes it from the records on each request; no
// total is calculated here. "Invoiced" means an invoice was recorded; payment
// is not tracked, so nothing is described as paid.

interface AmcSummary {
  asOf: string
  contracts: { active: number; activePastValidity: number; draft: number; expired: number; cancelled: number } | null
  visits: { due: number; overdue: number; upcoming: number; upcomingDays: number; dueThisMonth: number; completedThisMonth: number; completedTotal: number } | null
  invoicing: { readyForInvoice: { count: number; amount: string }; amountRequired: { count: number }; noInvoiceRequired: { count: number } } | null
}

interface InvoiceSummary {
  issued: { count: number; amountExclVat: string; vatAmount: string; totalAmount: string }
  cancelled: { count: number }
  amc: { pending: { count: number; amount: string }; invoiced: { count: number; invoicedAmount: string } } | null
  projects: { pending: { count: number; uninvoicedValue: string }; partlyInvoiced: { count: number }; invoiced: { count: number }; invoicedValue: string } | null
}

interface ExpiringList {
  asOf: string
  days: number
  items: { id: string; client: { id: string; name: string }; systemDescription: string; responsibleEngineer: string | null; validTo: string; daysLeft: number; contractValue: string }[]
  total: number
  pastValidity: number
}

interface RenewalHistory {
  items: {
    renewal: { id: string; client: { id: string; name: string }; systemDescription: string; validFrom: string; validTo: string; status: ContractStatus; createdAt: string }
    source: { id: string; validFrom: string; validTo: string; status: ContractStatus }
  }[]
  total: number
}

interface Workload {
  months: { month: string; planned: number; completed: number; open: number }[]
}

const WINDOWS = [30, 60, 90, 180]
const LIST_SIZE = 20
const UPCOMING_DAYS = 14

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 id={id} className="text-base font-semibold text-slate-900">
            {title}
          </h2>
          {description && <p className="mt-0.5 text-sm text-slate-600">{description}</p>}
        </div>
        {children}
      </section>
    </Card>
  )
}

function Figure({ label, value, hint, to }: { label: string; value: ReactNode; hint?: string; to?: string }) {
  const body = (
    <>
      <dt className="text-sm font-medium text-slate-600">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </>
  )

  return to ? (
    <Link to={to} className="block rounded-md border border-slate-200 px-4 py-3 hover:border-[#1479BD] hover:bg-sky-50/40">
      {body}
    </Link>
  ) : (
    <div className="rounded-md border border-slate-200 px-4 py-3">{body}</div>
  )
}

function daysText(days: number) {
  if (days < 0) return `Ended ${-days} day${days === -1 ? '' : 's'} ago`
  if (days === 0) return 'Ends today'

  return `${days} day${days === 1 ? '' : 's'} left`
}

/** "2026-10-26" + n days, as YYYY-MM-DD, without any time zone shift. */
function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + n)

  return date.toISOString().slice(0, 10)
}

function WorkloadChart({ data }: { data: Workload }) {
  const max = Math.max(1, ...data.months.map((entry) => entry.planned))

  return (
    <div className="px-5 py-4">
      <div className="flex h-48 items-end gap-3" role="img" aria-label="Visits planned per month; the same figures are in the table below.">
        {data.months.map((entry) => (
          <div key={entry.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <span className="text-xs font-semibold tabular-nums text-slate-700">{entry.planned}</span>
            <div
              className="w-full max-w-14 rounded-t bg-[#1479BD] transition-opacity hover:opacity-80"
              style={{ height: `${(entry.planned / max) * 100}%`, minHeight: entry.planned > 0 ? 4 : 0 }}
              title={`${monthLabel(entry.month)}: ${entry.planned} planned, ${entry.completed} completed, ${entry.open} open`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-3 border-t border-slate-300 pt-1">
        {data.months.map((entry) => (
          <span key={entry.month} className="flex-1 text-center text-xs text-slate-600">
            {monthLabel(entry.month).replace(/ \d{4}$/, '')}
          </span>
        ))}
      </div>
      <div className={cx(TABLE.wrapper, 'mt-4')}>
        <table className={TABLE.table}>
          <caption className="sr-only">Visits per month</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                Month
              </th>
              <th scope="col" className={`${TABLE.th} text-right`}>
                Planned
              </th>
              <th scope="col" className={`${TABLE.th} text-right`}>
                Completed
              </th>
              <th scope="col" className={`${TABLE.th} text-right`}>
                Open
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.months.map((entry) => (
              <tr key={entry.month}>
                <td className={TABLE.td}>{monthLabel(entry.month)}</td>
                <td className={`${TABLE.td} text-right tabular-nums`}>{entry.planned}</td>
                <td className={`${TABLE.td} text-right tabular-nums`}>{entry.completed}</td>
                <td className={`${TABLE.td} text-right tabular-nums`}>{entry.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function VisitTable({ caption, data }: { caption: string; data: VisitList }) {
  return (
    <>
      <div className={TABLE.wrapper}>
        <table className={TABLE.table}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                Planned
              </th>
              <th scope="col" className={TABLE.th}>
                Client and system
              </th>
              <th scope="col" className={TABLE.th}>
                Engineer
              </th>
              <th scope="col" className={TABLE.th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.items.map((visit) => (
              <tr key={visit.id}>
                <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(visit.scheduledDate)}</td>
                <td className={TABLE.td}>
                  <Link to={`/amc/contracts/${visit.contract.id}`} className="font-medium text-blue-700 hover:underline">
                    {visit.client.name} — {visit.contract.systemDescription}
                  </Link>
                  <span className="block text-xs text-slate-500">Visit {visit.sequenceNo}</span>
                </td>
                <td className={TABLE.td}>{visit.assignedTo ?? '—'}</td>
                <td className={TABLE.td}>
                  <VisitStatusPill status={visit.status} overdue={visit.isOverdue} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.total > data.items.length && (
        <p className="border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
          Showing {data.items.length} of {data.total}. The full list is in{' '}
          <Link to="/amc/schedule" className="font-medium text-blue-700 hover:underline">
            AMC Schedule
          </Link>
          .
        </p>
      )}
    </>
  )
}

/** Reports: AMC portfolio, expiring contracts, workload, upcoming and overdue visits, billing. Each section needs its module's permission. */
export function ReportsPage() {
  const auth = useAuth()
  const [windowDays, setWindowDays] = useState(90)

  const canContracts = auth.can('AMC_CONTRACTS', 'VIEW')
  const canSchedule = auth.can('AMC_SCHEDULE', 'VIEW')
  const canAmcSummary = canContracts || canSchedule || auth.can('AMC_EXECUTION', 'VIEW')
  const canInvoices = auth.can('INVOICES', 'VIEW')

  const summary = useQuery({ queryKey: ['amc', 'summary', 'reports'], queryFn: () => api.get<AmcSummary>('/amc/summary?upcomingDays=30'), enabled: canAmcSummary })
  const expiring = useQuery({
    queryKey: ['amc', 'reports', 'expiring', windowDays],
    queryFn: () => api.get<ExpiringList>(`/amc/reports/expiring${queryString({ days: windowDays, pageSize: 50 })}`),
    enabled: canContracts,
  })
  const renewals = useQuery({
    queryKey: ['amc', 'reports', 'renewals'],
    queryFn: () => api.get<RenewalHistory>('/amc/reports/renewals?pageSize=25'),
    enabled: canContracts,
    retry: false,
  })
  const renewalsUnavailable = renewals.error instanceof ApiError && renewals.error.code === 'FEATURE_UNAVAILABLE'
  const workload = useQuery({ queryKey: ['amc', 'reports', 'workload'], queryFn: () => api.get<Workload>('/amc/reports/workload?months=6'), enabled: canSchedule })
  const asOf = summary.data?.asOf
  const upcoming = useQuery({
    queryKey: ['amc', 'visits', 'reports', 'upcoming', asOf],
    queryFn: () =>
      api.get<VisitList>(
        `/amc/visits${queryString({ from: addDays(asOf as string, 1), to: addDays(asOf as string, UPCOMING_DAYS), status: 'SCHEDULED,IN_PROGRESS,POSTPONED', pageSize: LIST_SIZE })}`,
      ),
    enabled: canSchedule && Boolean(asOf),
  })
  const overdue = useQuery({
    queryKey: ['amc', 'visits', 'reports', 'overdue'],
    queryFn: () => api.get<VisitList>(`/amc/visits${queryString({ overdue: 'true', pageSize: LIST_SIZE })}`),
    enabled: canSchedule,
  })
  const invoices = useQuery({ queryKey: ['invoices', 'summary', 'reports'], queryFn: () => api.get<InvoiceSummary>('/invoices/summary'), enabled: canInvoices })

  const nothing = !canAmcSummary && !canInvoices

  return (
    <>
      <PageHeader title="Reports" description="AMC portfolio, contract expiry, service workload and invoicing, from the current records." />

      {nothing && (
        <Card>
          <EmptyState title="No reports for your role" description="The reports show AMC and invoice figures. Your role does not include either." />
        </Card>
      )}

      <div className="space-y-6">
        {canContracts && (
          <Section id="report-portfolio" title="AMC portfolio" description="Contracts by status.">
            {summary.isPending && <Spinner size="sm" label="Loading portfolio" />}
            {summary.isError && <LoadError error={summary.error} onRetry={() => void summary.refetch()} />}
            {summary.data?.contracts && (
              <dl className="grid gap-3 p-5 sm:grid-cols-3 xl:grid-cols-5">
                <Figure label="Active" value={summary.data.contracts.active} hint={`${summary.data.contracts.activePastValidity} past their validity`} to="/amc/contracts" />
                <Figure label="Draft" value={summary.data.contracts.draft} />
                <Figure label="Expired" value={summary.data.contracts.expired} />
                <Figure label="Cancelled" value={summary.data.contracts.cancelled} />
                <Figure
                  label="All contracts"
                  value={summary.data.contracts.active + summary.data.contracts.draft + summary.data.contracts.expired + summary.data.contracts.cancelled}
                />
              </dl>
            )}
          </Section>
        )}

        {canContracts && (
          <Section id="report-expiring" title="Expiring contracts" description="Active contracts whose validity ends within the chosen period, and active contracts already past their validity.">
            <div className="flex flex-wrap items-center gap-2 px-5 pt-4" role="group" aria-label="Period">
              {WINDOWS.map((days) => (
                <button
                  key={days}
                  type="button"
                  aria-pressed={windowDays === days}
                  onClick={() => setWindowDays(days)}
                  className={cx(
                    'rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset',
                    windowDays === days ? 'bg-[#1479BD] text-white ring-[#1479BD]' : 'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50',
                  )}
                >
                  Next {days} days
                </button>
              ))}
            </div>
            {expiring.isPending && <Spinner size="sm" label="Loading expiring contracts" />}
            {expiring.isError && <LoadError error={expiring.error} onRetry={() => void expiring.refetch()} />}
            {expiring.data && expiring.data.items.length === 0 && <EmptyState title={`No active contract ends within ${windowDays} days`} />}
            {expiring.data && expiring.data.items.length > 0 && (
              <>
                <p className="px-5 pt-3 text-sm text-slate-600">
                  {expiring.data.total} contract{expiring.data.total === 1 ? '' : 's'}
                  {expiring.data.pastValidity > 0 && `, of which ${expiring.data.pastValidity} already past validity and still marked Active`}.
                </p>
                <div className={cx(TABLE.wrapper, 'mt-2')}>
                  <table className={TABLE.table}>
                    <caption className="sr-only">Expiring contracts</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={TABLE.th}>
                          Client and system
                        </th>
                        <th scope="col" className={TABLE.th}>
                          Engineer
                        </th>
                        <th scope="col" className={TABLE.th}>
                          Valid to
                        </th>
                        <th scope="col" className={TABLE.th}>
                          Time left
                        </th>
                        <th scope="col" className={`${TABLE.th} text-right`}>
                          Contract value
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {expiring.data.items.map((contract) => (
                        <tr key={contract.id}>
                          <td className={TABLE.td}>
                            <Link to={`/amc/contracts/${contract.id}`} className="font-medium text-blue-700 hover:underline">
                              {contract.client.name} — {contract.systemDescription}
                            </Link>
                          </td>
                          <td className={TABLE.td}>{contract.responsibleEngineer ?? '—'}</td>
                          <td className={`${TABLE.td} whitespace-nowrap`}>{formatDate(contract.validTo)}</td>
                          <td className={cx(TABLE.td, 'whitespace-nowrap', contract.daysLeft < 0 && 'font-medium text-amber-700')}>{daysText(contract.daysLeft)}</td>
                          <td className={`${TABLE.td} whitespace-nowrap text-right tabular-nums`}>{formatMoney(contract.contractValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {expiring.data.total > expiring.data.items.length && (
                  <p className="border-t border-slate-200 px-5 py-3 text-sm text-slate-600">
                    Showing the first {expiring.data.items.length} of {expiring.data.total}.
                  </p>
                )}
              </>
            )}
          </Section>
        )}

        {canContracts && (
          <Section id="report-renewals" title="Renewal history" description="Renewals created, newest first. Each renewal is a separate contract; the contract it renews is unchanged.">
            {renewals.isPending && <Spinner size="sm" label="Loading renewals" />}
            {renewalsUnavailable && <p className="px-5 py-4 text-sm text-slate-600">Renewals need a database update that has not been applied to this database yet (migration 0072).</p>}
            {renewals.isError && !renewalsUnavailable && <LoadError error={renewals.error} onRetry={() => void renewals.refetch()} />}
            {renewals.data && renewals.data.items.length === 0 && <EmptyState title="No renewals created yet" />}
            {renewals.data && renewals.data.items.length > 0 && (
              <div className={TABLE.wrapper}>
                <table className={TABLE.table}>
                  <caption className="sr-only">Renewal history</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TABLE.th}>
                        Client and system
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Renews
                      </th>
                      <th scope="col" className={TABLE.th}>
                        Renewal
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {renewals.data.items.map(({ renewal, source }) => (
                      <tr key={renewal.id}>
                        <td className={TABLE.td}>
                          {renewal.client.name} — {renewal.systemDescription}
                        </td>
                        <td className={TABLE.td}>
                          <Link to={`/amc/contracts/${source.id}`} className="text-blue-700 hover:underline">
                            {formatDate(source.validFrom)} to {formatDate(source.validTo)}
                          </Link>{' '}
                          <ContractStatusPill status={source.status} />
                        </td>
                        <td className={TABLE.td}>
                          <Link to={`/amc/contracts/${renewal.id}`} className="font-medium text-blue-700 hover:underline">
                            {formatDate(renewal.validFrom)} to {formatDate(renewal.validTo)}
                          </Link>{' '}
                          <ContractStatusPill status={renewal.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        )}

        {canSchedule && (
          <Section id="report-workload" title="Service workload" description="Visits planned per month from this month, by planned date. Cancelled visits and cancelled contracts are not counted.">
            {workload.isPending && <Spinner size="sm" label="Loading workload" />}
            {workload.isError && <LoadError error={workload.error} onRetry={() => void workload.refetch()} />}
            {workload.data && <WorkloadChart data={workload.data} />}
          </Section>
        )}

        {canSchedule && (
          <div className="grid gap-6 xl:grid-cols-2">
            <Section id="report-upcoming" title="Upcoming visits" description={`Outstanding visits planned in the next ${UPCOMING_DAYS} days.`}>
              {upcoming.isPending && <Spinner size="sm" label="Loading upcoming visits" />}
              {upcoming.isError && <LoadError error={upcoming.error} onRetry={() => void upcoming.refetch()} />}
              {upcoming.data && upcoming.data.items.length === 0 && <EmptyState title="No visits planned in the next 14 days" />}
              {upcoming.data && upcoming.data.items.length > 0 && <VisitTable caption="Upcoming visits" data={upcoming.data} />}
            </Section>
            <Section id="report-overdue" title="Overdue visits" description="Scheduled or postponed visits whose planned date has passed.">
              {overdue.isPending && <Spinner size="sm" label="Loading overdue visits" />}
              {overdue.isError && <LoadError error={overdue.error} onRetry={() => void overdue.refetch()} />}
              {overdue.data && overdue.data.items.length === 0 && <EmptyState title="No overdue visits" />}
              {overdue.data && overdue.data.items.length > 0 && <VisitTable caption="Overdue visits" data={overdue.data} />}
            </Section>
          </div>
        )}

        {(canInvoices || canSchedule) && (
          <Section
            id="report-billing"
            title="Billing and invoices"
            description="Work waiting for an invoice and invoices recorded from Zoho. Amounts are shown on their own basis and never added together. Payment is not tracked."
          >
            {(summary.isError || invoices.isError) && (
              <LoadError error={summary.error ?? invoices.error} onRetry={() => void Promise.all([summary.refetch(), invoices.refetch()])} />
            )}
            <dl className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
              {summary.data?.invoicing && (
                <Figure
                  label="AMC visits ready for invoice"
                  value={summary.data.invoicing.readyForInvoice.count}
                  hint={`Visit amounts ${formatMoney(summary.data.invoicing.readyForInvoice.amount)} (as entered on the visits)`}
                  to="/invoices"
                />
              )}
              {summary.data?.invoicing && summary.data.invoicing.amountRequired.count > 0 && (
                <Figure label="Completed visits without an amount" value={summary.data.invoicing.amountRequired.count} hint="An amount is needed before invoicing" />
              )}
              {invoices.data?.amc && (
                <Figure label="AMC visits invoiced" value={invoices.data.amc.invoiced.count} hint={`Allocated ${formatMoney(invoices.data.amc.invoiced.invoicedAmount)} excl. VAT`} />
              )}
              {invoices.data?.projects && (
                <Figure
                  label="Projects waiting for an invoice"
                  value={invoices.data.projects.pending.count}
                  hint={`Not yet invoiced ${formatMoney(invoices.data.projects.pending.uninvoicedValue)} excl. VAT · ${invoices.data.projects.partlyInvoiced.count} partly invoiced`}
                  to="/invoices"
                />
              )}
              {invoices.data && (
                <Figure
                  label="Invoices recorded"
                  value={invoices.data.issued.count}
                  hint={`Total ${formatMoney(invoices.data.issued.totalAmount)} incl. VAT · ${invoices.data.cancelled.count} cancelled`}
                  to="/invoices"
                />
              )}
            </dl>
          </Section>
        )}
      </div>
    </>
  )
}
