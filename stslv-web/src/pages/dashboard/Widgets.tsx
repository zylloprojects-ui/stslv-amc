import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TABLE } from '../../components/table'
import { cx, formatCount, formatDateTime } from '../../lib/format'
import { formatDate, monthLabel } from '../amc/amcFormat'
import { ContractStatusPill } from '../amc/components'
import { CONTRACT_STATUS_LABELS } from '../amc/types'
import type { OperationsDashboard, Readiness, Unavailable, WorkloadMonth } from './operationsTypes'

const shortMonth = (month: string) => monthLabel(month).slice(0, 3)

/** Visits planned per month as bars, with the same figures in a table. One series, so no legend. */
export function WorkloadChart({ months }: { months: WorkloadMonth[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const max = Math.max(1, ...months.map((entry) => entry.planned))
  const active = months.find((entry) => entry.month === hover)

  return (
    <div>
      <div className="relative">
        <div className="flex h-40 items-end gap-2 border-b border-slate-300" role="img" aria-label="Visits planned per month; the same figures are in the table below.">
          {months.map((entry) => (
            <div
              key={entry.month}
              className="flex h-full flex-1 flex-col items-center justify-end gap-1 px-1"
              onMouseEnter={() => setHover(entry.month)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="text-xs font-semibold tabular-nums text-slate-700">{entry.planned}</span>
              <div
                className={cx('w-full max-w-12 rounded-t bg-[#1479BD]', hover === entry.month && 'opacity-80')}
                style={{ height: `${(entry.planned / max) * 100}%`, minHeight: entry.planned > 0 ? 4 : 0 }}
              />
            </div>
          ))}
        </div>
        {active && (
          <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow" aria-hidden="true">
            {monthLabel(active.month)}: {active.planned} planned · {active.completed} completed · {active.open} open
          </div>
        )}
        <div className="mt-1 flex gap-2">
          {months.map((entry) => (
            <span key={entry.month} className="flex-1 text-center text-xs text-slate-600">
              {shortMonth(entry.month)}
            </span>
          ))}
        </div>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-[#1479BD]">Show as table</summary>
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
    <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 px-4 text-center">
      <p className="text-sm font-semibold text-slate-700">Payment data not available</p>
      <p className="mt-1 max-w-md text-xs text-slate-600">{payments.reason}</p>
      <p className="mt-2 max-w-md text-xs text-slate-600">Invoice dates are not payment dates, so they are not used for this chart.</p>
    </div>
  )
}

export function PortfolioStatus({ portfolio }: { portfolio: NonNullable<OperationsDashboard['portfolio']> }) {
  const max = Math.max(1, ...portfolio.statuses.map((entry) => entry.count))

  if (portfolio.total === 0) {
    return <p className="py-6 text-center text-sm text-slate-600">No AMC contracts recorded yet.</p>
  }

  return (
    <div>
      <p className="mb-3 text-xs text-slate-600">{formatCount(portfolio.total)} contracts in total</p>
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
            <tr key={entry.status} className="align-middle">
              <th scope="row" className="w-28 py-1.5 pr-3 text-left font-normal">
                <ContractStatusPill status={entry.status} />
              </th>
              <td className="py-1.5" aria-hidden="true">
                <div className="h-2.5 rounded bg-slate-100">
                  <div className="h-2.5 rounded bg-[#1479BD]" style={{ width: `${(entry.count / max) * 100}%` }} />
                </div>
              </td>
              <td className="w-32 py-1.5 pl-3 text-right tabular-nums text-slate-700">
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
    return <p className="py-6 text-center text-sm text-slate-600">✓ No active AMC ends in the next {expiring.days} days.</p>
  }

  return (
    <div>
      <p className="mb-2 text-xs text-slate-600">
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

const STATE_STYLE = {
  OK: { dot: 'bg-emerald-500', label: 'OK' },
  ATTENTION: { dot: 'bg-amber-500', label: 'Needs attention' },
  UNAVAILABLE: { dot: 'bg-slate-400', label: 'Not available' },
} as const

/** Each verified check on its own line. There is no overall score. */
export function ReadinessChecks({ readiness }: { readiness: Readiness }) {
  return (
    <div>
      <ul className="divide-y divide-slate-100">
        {readiness.checks.map((check) => (
          <li key={check.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-slate-900">{check.label}</span>
              <span className="block text-xs text-slate-600">{check.detail}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-slate-700">
              <span className={cx('h-2 w-2 rounded-full', STATE_STYLE[check.state].dot)} aria-hidden="true" />
              {STATE_STYLE[check.state].label}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-slate-600">Checked {formatDateTime(readiness.checkedAt)}.</p>
    </div>
  )
}
