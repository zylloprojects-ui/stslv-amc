import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TABLE } from '../../components/table'
import { cx, formatCount } from '../../lib/format'
import { formatDate, monthLabel } from '../amc/amcFormat'
import { ContractStatusPill } from '../amc/components'
import { CONTRACT_STATUS_LABELS } from '../amc/types'
import type { OperationsDashboard, Unavailable, WorkloadMonth } from './operationsTypes'

const shortMonth = (month: string) => monthLabel(month).slice(0, 3)

/** Visits planned per month as bars, with the same figures in a table. One series, so no legend. */
export function WorkloadChart({ months }: { months: WorkloadMonth[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const max = Math.max(1, ...months.map((entry) => entry.planned))
  const active = months.find((entry) => entry.month === hover)

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2 text-xs font-semibold">
        <span className="rounded-full bg-sky-50 px-3 py-1 text-[#0b3b66] ring-1 ring-inset ring-sky-200">{`Planned: ${months.reduce((sum, entry) => sum + entry.planned, 0)}`}</span>
        <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-800 ring-1 ring-inset ring-emerald-200">{`Completed: ${months.reduce((sum, entry) => sum + entry.completed, 0)}`}</span>
        <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-800 ring-1 ring-inset ring-amber-200">{`Open: ${months.reduce((sum, entry) => sum + entry.open, 0)}`}</span>
      </div>

      <div className="flex gap-3">
        <div className="relative h-56 w-6 shrink-0 text-right text-[11px] font-medium tabular-nums text-slate-500" aria-hidden="true">
          <span className="absolute right-0 top-6 -translate-y-1/2">{max}</span>
          <span className="absolute bottom-0 right-0 translate-y-1/2">0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-56">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-6 flex flex-col justify-between" aria-hidden="true">
              <span className="border-t border-dashed border-slate-300" />
              <span className="border-t border-dashed border-slate-300" />
              <span className="border-t border-slate-400" />
            </div>
            <div className="absolute inset-x-0 bottom-0 top-6 flex items-end gap-3 px-2" role="img" aria-label="Visits planned per month; the same figures are in the table below.">
              {months.map((entry) => (
                <div
                  key={entry.month}
                  className={cx('flex h-full flex-1 items-end justify-center rounded-t-lg transition-colors', hover === entry.month && 'bg-sky-50')}
                  onMouseEnter={() => setHover(entry.month)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className="relative w-full max-w-10 rounded-t-lg bg-gradient-to-t from-[#0e5a96] to-[#2f9bd8] shadow-sm"
                    style={{ height: `${(entry.planned / max) * 100}%`, minHeight: entry.planned > 0 ? 6 : 3 }}
                  >
                    <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-xs font-bold tabular-nums text-[#0b3b66]">{entry.planned}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-3 px-2">
            {months.map((entry) => (
              <span key={entry.month} className={cx('flex-1 text-center text-xs font-semibold', hover === entry.month ? 'text-[#0b3b66]' : 'text-slate-600')}>
                {shortMonth(entry.month)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-3 min-h-5 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-200" aria-hidden="true">
        {active ? `${monthLabel(active.month)}: ${active.planned} planned · ${active.completed} completed · ${active.open} open` : 'Point at a bar to see its month in detail.'}
      </p>
      <details className="mt-3">
        <summary className="inline-block cursor-pointer rounded-lg bg-sky-50 px-3 py-1 text-xs font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200 hover:bg-sky-100">Show as table</summary>
        <div className={cx(TABLE.wrapper, 'mt-2')}>
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
              {months.map((entry) => (
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
      </details>
    </div>
  )
}

/** The payment trend cannot be drawn: STSLV AMC records no payments. Says so instead of drawing zeros. */
export function PaymentTrend({ payments }: { payments: Unavailable }) {
  return (
    <div className="relative flex flex-1 min-h-72 items-center justify-center overflow-hidden rounded-xl border border-slate-300 bg-slate-50 p-6">
      <div className="pointer-events-none absolute inset-x-6 inset-y-8 flex flex-col justify-between" aria-hidden="true">
        {[0, 1, 2, 3].map((line) => (
          <span key={line} className="border-t border-dashed border-slate-300" />
        ))}
      </div>
      <div className="relative max-w-md rounded-2xl border border-slate-300 bg-white px-6 py-5 text-center shadow-sm">
        <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-[#1479BD]" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 19V9m6 10V5m6 14v-7m4 7H3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <p className="text-sm font-bold text-slate-800">Payment data not available</p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{payments.reason}</p>
        <p className="mt-2 border-t border-slate-200 pt-2 text-xs leading-relaxed text-slate-600">Invoice dates are not payment dates, so they are not used for this chart.</p>
      </div>
    </div>
  )
}

// A status keeps its meaning: green for live, amber for ended, red for cancelled, blue otherwise.
const STATUS_BAR: Record<string, string> = {
  ACTIVE: 'from-emerald-600 to-emerald-400',
  DRAFT: 'from-[#0e5a96] to-[#2f9bd8]',
  EXPIRED: 'from-amber-600 to-amber-400',
  CANCELLED: 'from-red-600 to-red-400',
}

export function PortfolioStatus({ portfolio }: { portfolio: NonNullable<OperationsDashboard['portfolio']> }) {
  const max = Math.max(1, ...portfolio.statuses.map((entry) => entry.count))

  if (portfolio.total === 0) {
    return <p className="py-6 text-center text-sm text-slate-600">No AMC contracts recorded yet.</p>
  }

  return (
    <div>
      <p className="mb-3 inline-block rounded-full bg-sky-50 px-3 py-1 text-xs font-bold text-[#0b3b66] ring-1 ring-inset ring-sky-200">{formatCount(portfolio.total)} contracts in total</p>
      <table className="w-full text-sm">
        <caption className="sr-only">Contracts by status</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Contracts</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {portfolio.statuses.map((entry) => (
            <tr key={entry.status} className="border-b border-slate-200 align-middle last:border-0">
              <th scope="row" className="w-28 py-2 pr-3 text-left font-normal">
                <ContractStatusPill status={entry.status} />
              </th>
              <td className="py-2" aria-hidden="true">
                <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                  <div className={cx('h-3 rounded-full bg-gradient-to-r', STATUS_BAR[entry.status] ?? 'from-[#0e5a96] to-[#2f9bd8]')} style={{ width: `${(entry.count / max) * 100}%` }} />
                </div>
              </td>
              <td className="w-32 py-2 pl-3 text-right font-semibold tabular-nums text-slate-800">
                <span className="sr-only">{CONTRACT_STATUS_LABELS[entry.status]}: </span>
                {formatCount(entry.count)} · {entry.percent ?? '0.0'}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function daysText(days: number) {
  if (days < 0) return `Ended ${-days} ${days === -1 ? 'day' : 'days'} ago`
  if (days === 0) return 'Ends today'
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

export function ExpiringContracts({ expiring }: { expiring: NonNullable<OperationsDashboard['expiring']> }) {
  if (expiring.total === 0) {
    return <p className="flex flex-1 min-h-40 items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-6 py-8 text-center text-sm font-semibold text-emerald-800">✓ No active AMC ends in the next {expiring.days} days.</p>
  }

  return (
    <div>
      <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">
        {formatCount(expiring.total)} active {expiring.total === 1 ? 'contract' : 'contracts'}
        {expiring.pastValidity > 0 && `, of which ${formatCount(expiring.pastValidity)} already past validity and still marked Active`}
        {expiring.total > expiring.items.length && ` · showing the first ${expiring.items.length}`}
      </p>
      <div className={TABLE.wrapper}>
        <table className={TABLE.table}>
          <caption className="sr-only">Contracts ending within {expiring.days} days</caption>
          <thead>
            <tr>
              <th scope="col" className={TABLE.th}>
                AMC reference
              </th>
              <th scope="col" className={TABLE.th}>
                Client
              </th>
              <th scope="col" className={TABLE.th}>
                System
              </th>
              <th scope="col" className={TABLE.th}>
                Expiry
              </th>
              <th scope="col" className={`${TABLE.th} text-right`}>
                Days left
              </th>
              <th scope="col" className={TABLE.th}>
                Renewal
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {expiring.items.map((row) => (
              <tr key={row.id} className={TABLE.row}>
                <td className={TABLE.td}>
                  <Link to={`/amc/contracts/${row.id}`} className="font-medium text-[#1479BD] hover:underline">
                    Record {row.id}
                  </Link>
                </td>
                <td className={cx(TABLE.td, TABLE.text)}>{row.client.name}</td>
                <td className={cx(TABLE.td, TABLE.text)}>{row.systemDescription}</td>
                <td className={cx(TABLE.td, 'whitespace-nowrap')}>{formatDate(row.validTo)}</td>
                <td className={cx(TABLE.td, 'whitespace-nowrap text-right tabular-nums', row.daysLeft < 0 && 'font-semibold text-red-700')}>{daysText(row.daysLeft)}</td>
                <td className={TABLE.td}>
                  {!expiring.renewalsInstalled ? (
                    <span className="text-xs text-slate-600">Renewals not installed</span>
                  ) : row.renewal ? (
                    <Link to={`/amc/contracts/${row.renewal.id}`} className="inline-flex items-center gap-1 text-xs text-[#1479BD] hover:underline">
                      Renewal <ContractStatusPill status={row.renewal.status} />
                    </Link>
                  ) : (
                    <span className="text-xs text-slate-600">None</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
