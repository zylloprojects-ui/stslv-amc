import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TABLE } from '../../components/table'
import { cx, formatCount } from '../../lib/format'
import { formatDate, monthLabel } from '../amc/amcFormat'
import { ContractStatusPill } from '../amc/components'
import { CONTRACT_STATUS_LABELS } from '../amc/types'
import type { OperationsDashboard, Unavailable, WorkloadMonth } from './operationsTypes'

const shortMonth = (month: string) => monthLabel(month).slice(0, 3)

/** Visits planned per month as stacked bars (completed below, still open above), with the same figures in a table. */
export function WorkloadChart({ months }: { months: WorkloadMonth[] }) {
  const [hover, setHover] = useState<string | null>(null)
  const [asTable, setAsTable] = useState(false)
  const max = Math.max(1, ...months.map((entry) => entry.planned))
  const active = months.find((entry) => entry.month === hover)
  const sum = (key: 'planned' | 'completed' | 'open') => months.reduce((total, entry) => total + entry[key], 0)

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2 text-xs font-semibold">
        <span className="inline-flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1 text-slate-800 ring-1 ring-inset ring-slate-300">
          <span className="h-2 w-2 rounded-full bg-slate-700" aria-hidden="true" />
          {`Planned: ${sum('planned')}`}
        </span>
        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-emerald-800 ring-1 ring-inset ring-emerald-200">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
          {`Completed: ${sum('completed')}`}
        </span>
        <span className="inline-flex items-center gap-2 rounded-full bg-sky-50 px-3 py-1 text-[#0b3b66] ring-1 ring-inset ring-sky-200">
          <span className="h-2 w-2 rounded-full bg-[#1479BD]" aria-hidden="true" />
          {`Open: ${sum('open')}`}
        </span>
      </div>

      {!asTable && (
      <>
      <div className="flex gap-3">
        <div className="relative h-60 w-6 shrink-0 text-right text-[11px] font-medium tabular-nums text-slate-500" aria-hidden="true">
          <span className="absolute right-0 top-7 -translate-y-1/2">{max}</span>
          <span className="absolute bottom-0 right-0 translate-y-1/2">0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-60">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-7 flex flex-col justify-between" aria-hidden="true">
              <span className="border-t border-dashed border-slate-300" />
              <span className="border-t border-dashed border-slate-300" />
              <span className="border-t-2 border-slate-400" />
            </div>
            <div className="absolute inset-x-0 bottom-0 top-7 flex items-end gap-2 px-1" role="img" aria-label="Visits planned per month; the same figures are available as a table.">
              {months.map((entry) => (
                <div
                  key={entry.month}
                  className={cx('flex h-full flex-1 items-end justify-center rounded-t-xl transition-colors', hover === entry.month ? 'bg-sky-100/80' : 'bg-sky-50/60')}
                  onMouseEnter={() => setHover(entry.month)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className="relative flex w-full max-w-11 flex-col justify-end overflow-hidden rounded-t-xl shadow-sm"
                    style={{ height: `${(entry.planned / max) * 100}%`, minHeight: entry.planned > 0 ? 8 : 3 }}
                  >
                    {entry.planned === 0 ? (
                      <span className="h-full w-full bg-slate-300" />
                    ) : (
                      <>
                        <span className="w-full bg-gradient-to-b from-[#2f9bd8] to-[#1479BD]" style={{ flexGrow: entry.open }} />
                        <span className="w-full bg-gradient-to-b from-emerald-400 to-emerald-600" style={{ flexGrow: entry.completed }} />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 top-7 flex items-end gap-2 px-1" aria-hidden="true">
              {months.map((entry) => (
                <div key={entry.month} className="relative flex h-full flex-1 items-end justify-center">
                  <span className="absolute left-1/2 -translate-x-1/2 text-xs font-bold tabular-nums text-[#0b3b66]" style={{ bottom: `calc(${(entry.planned / max) * 100}% + 4px)` }}>
                    {entry.planned}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 flex gap-2 px-1">
            {months.map((entry, index) => (
              <span key={entry.month} className={cx('flex-1 text-center text-xs font-semibold', hover === entry.month ? 'text-[#0b3b66]' : 'text-slate-600')}>
                {shortMonth(entry.month)}
                {index === 0 && <span className="mx-auto mt-1 block h-1 w-5 rounded-full bg-[#1479BD]" title="This month" />}
              </span>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-3 min-h-5 rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600 ring-1 ring-inset ring-slate-200" aria-hidden="true">
        {active ? `${monthLabel(active.month)}: ${active.planned} planned · ${active.completed} completed · ${active.open} open` : 'Point at a bar to see its month in detail.'}
      </p>
      </>
      )}

      {asTable && (
          <div className={TABLE.wrapper}>
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
      )}

      <button
        type="button"
        onClick={() => setAsTable((value) => !value)}
        className="mt-3 inline-block cursor-pointer rounded-lg bg-sky-50 px-3 py-1 text-xs font-semibold text-[#0b3b66] ring-1 ring-inset ring-sky-200 hover:bg-sky-100"
      >
        {asTable ? 'Show as graph' : 'Show as table'}
      </button>
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

// A status keeps its meaning: green for live, blue for draft, amber for ended, red for cancelled.
const STATUS_COLOR: Record<string, string> = { ACTIVE: '#10b981', DRAFT: '#1479BD', EXPIRED: '#f59e0b', CANCELLED: '#ef4444' }

export function PortfolioStatus({ portfolio }: { portfolio: NonNullable<OperationsDashboard['portfolio']> }) {
  if (portfolio.total === 0) {
    return <p className="py-6 text-center text-sm text-slate-600">No AMC contracts recorded yet.</p>
  }

  const live = portfolio.statuses.filter((entry) => entry.count > 0)

  return (
    <div>
      {/* The total, then the whole portfolio as one thin bar split by status. */}
      <div className="flex items-baseline gap-2.5" aria-hidden="true">
        <span className="text-3xl font-extrabold leading-none tabular-nums text-[#0b3b66]">{formatCount(portfolio.total)}</span>
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">AMC contracts in total</span>
      </div>
      <p className="sr-only">{formatCount(portfolio.total)} AMC contracts in total</p>

      <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        {live.map((entry) => (
          <span
            key={entry.status}
            className="h-full"
            style={{ width: `${(entry.count / portfolio.total) * 100}%`, backgroundColor: STATUS_COLOR[entry.status] ?? '#1479BD' }}
            title={`${CONTRACT_STATUS_LABELS[entry.status]}: ${entry.count}`}
          />
        ))}
      </div>

      {/* A table for assistive technology, drawn as one slim line per status: a colour dot, the status and its figure. */}
      <table className="mt-3 block w-full text-sm">
        <caption className="sr-only">Contracts by status</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Contracts</th>
          </tr>
        </thead>
        <tbody className="flex flex-col divide-y divide-slate-100">
          {portfolio.statuses.map((entry) => (
            <tr key={entry.status} className={cx('flex items-center justify-between gap-3 py-2', entry.count === 0 && 'opacity-50')}>
              <th scope="row" className="flex items-center gap-2.5 text-left font-normal">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: STATUS_COLOR[entry.status] ?? '#1479BD' }} aria-hidden="true" />
                <ContractStatusPill status={entry.status} />
              </th>
              <td className="whitespace-nowrap text-right text-sm font-bold tabular-nums text-slate-800">
                <span className="sr-only">{CONTRACT_STATUS_LABELS[entry.status]}: </span>
                {formatCount(entry.count)}
                <span className="font-semibold text-slate-400"> · </span>
                <span className="font-semibold text-slate-600">{entry.percent ?? '0.0'}%</span>
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
