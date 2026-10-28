import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { LoadError } from '../../../components/records'
import { ExportButtons } from '../../../components/ExportButtons'
import { Card, Spinner } from '../../../components/ui'
import { api } from '../../../lib/api'
import { cx } from '../../../lib/format'
import { queryString } from '../amcApi'
import { currentMonth, formatMoney, monthLabel, monthRange } from '../amcFormat'
import type { CalendarFilters, VisitYearFigures, VisitYearSummary } from './calendarTypes'

const pad = (value: number) => String(value).padStart(2, '0')
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

interface YearViewProps {
  year: number
  filters: CalendarFilters
  canExport: boolean
  onOpenMonth: (month: string) => void
  onExportError: (message: string | null) => void
}

/** Twelve months of one year: the year's figures on top, then one card per month. Every figure comes from the API. */
export function YearView({ year, filters, canExport, onOpenMonth, onExportError }: YearViewProps) {
  const summary = useQuery({
    queryKey: ['amc', 'visits', 'year-summary', { year, ...filters }],
    queryFn: () => api.get<VisitYearSummary>(`/amc/visits/year-summary${queryString({ year, ...filters })}`),
    placeholderData: keepPreviousData,
  })

  if (summary.isPending) return <Spinner label="Loading the year" />
  if (summary.isError) return <LoadError error={summary.error} onRetry={() => void summary.refetch()} />

  const { totals, months } = summary.data
  const thisMonth = currentMonth()

  return (
    <>
      <YearKpis year={year} totals={totals} />

      <section aria-label={`Months of ${year}`} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {months.map((figures) => {
          const month = `${year}-${pad(figures.month)}`

          return (
            <MonthCard
              key={month}
              month={month}
              figures={figures}
              isCurrent={month === thisMonth}
              onOpen={() => onOpenMonth(month)}
              download={
                canExport && figures.services + figures.cancelled > 0 ? (
                  <ExportButtons
                    what={`${monthLabel(month)} visits`}
                    fileStem={`monthly-calendar-${month}`}
                    size="sm"
                    path={(format) => `/amc/visits/export${queryString({ format, ...monthRange(month), ...filters })}`}
                    onError={onExportError}
                  />
                ) : null
              }
            />
          )
        })}
      </section>
    </>
  )
}

function Kpi({ label, value, note, warn = false, tone }: { label: string; value: string; note: string; warn?: boolean; tone: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-white py-3.5 pl-5 pr-4 shadow-sm">
      <span className={cx('absolute inset-y-0 left-0 w-1.5', tone)} aria-hidden="true" />
      <dt className="text-xs font-semibold uppercase tracking-wider text-slate-600">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
      <dd className={cx('mt-0.5 text-xs', warn ? 'font-medium text-amber-800' : 'text-slate-500')}>{note}</dd>
    </div>
  )
}

function YearKpis({ year, totals }: { year: number; totals: VisitYearFigures }) {
  const valueNote =
    totals.amountMissing > 0
      ? `${plural(totals.amountMissing, 'service')} without an amount, not included`
      : 'Visit amounts, cancelled visits excluded'

  return (
    <dl aria-label={`Figures for ${year}`} className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label="Services in year"
        value={String(totals.services)}
        note={totals.cancelled > 0 ? `${plural(totals.cancelled, 'cancelled visit')} not counted` : 'Scheduled service visits'}
        tone="bg-[#1479BD]"
      />
      <Kpi label="Scheduled value" value={formatMoney(totals.scheduledValue)} note={valueNote} warn={totals.amountMissing > 0} tone="bg-[#00A6C8]" />
      <Kpi
        label="Invoiced"
        value={String(totals.invoiced)}
        note={`Visit value ${formatMoney(totals.invoicedValue)} · an invoice is not proof of payment`}
        tone="bg-emerald-600"
      />
      <Kpi
        label="Not yet invoiced"
        value={String(totals.notYetInvoiced)}
        note={`Completed, no active invoice · visit value ${formatMoney(totals.notYetInvoicedValue)}${
          totals.noInvoiceRequired > 0 ? ` · ${totals.noInvoiceRequired} with a zero amount need no invoice` : ''
        }`}
        warn={totals.notYetInvoiced > 0}
        tone="bg-amber-500"
      />
    </dl>
  )
}

/** One operational figure of a month, with its word, so colour is never the only signal. */
function StatusCount({ label, count, className }: { label: string; count: number; className: string }) {
  if (count === 0) return null

  return (
    <li className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset', className)}>
      <span className="tabular-nums">{count}</span> {label}
    </li>
  )
}

interface MonthCardProps {
  month: string
  figures: VisitYearFigures
  isCurrent: boolean
  onOpen: () => void
  download: ReactNode
}

function MonthCard({ month, figures, isCurrent, onOpen, download }: MonthCardProps) {
  const name = monthLabel(month).split(' ')[0]
  const open = figures.scheduled + figures.inProgress + figures.postponed

  return (
    <Card className={cx('flex flex-col', isCurrent && 'ring-2 ring-[#1479BD]')}>
      <article aria-label={monthLabel(month)} className="flex flex-1 flex-col p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-base font-semibold text-slate-900">
            <button
              type="button"
              onClick={onOpen}
              aria-label={`Open ${monthLabel(month)} in month view`}
              className="rounded text-left hover:text-[#1479BD] hover:underline focus-visible:outline-2 focus-visible:outline-[#1479BD]"
            >
              {name}
            </button>
          </h3>
          {isCurrent && <span className="text-xs font-semibold text-[#1479BD]">This month</span>}
        </div>

        <p className="mt-1 text-sm text-slate-700">
          <span className="text-xl font-semibold tabular-nums text-slate-900">{figures.services}</span> {figures.services === 1 ? 'service' : 'services'}
        </p>

        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-500">Scheduled value</dt>
          <dd className="text-right font-semibold tabular-nums text-slate-900">
            {formatMoney(figures.scheduledValue)}
            {figures.amountMissing > 0 && <span className="block text-xs font-medium text-amber-800">{figures.amountMissing} without amount</span>}
          </dd>
          <dt className="text-slate-500">Invoiced</dt>
          <dd className="text-right tabular-nums text-emerald-800">{figures.invoiced}</dd>
          <dt className="text-slate-500">Not yet invoiced</dt>
          <dd className={cx('text-right tabular-nums', figures.notYetInvoiced > 0 ? 'font-semibold text-amber-800' : 'text-slate-700')}>{figures.notYetInvoiced}</dd>
        </dl>

        <ul aria-label={`Visit status in ${monthLabel(month)}`} className="mt-3 flex flex-wrap gap-1">
          <StatusCount label="completed" count={figures.completed} className="bg-emerald-50 text-emerald-900 ring-emerald-200" />
          <StatusCount label="open" count={open} className="bg-sky-50 text-sky-900 ring-sky-200" />
          <StatusCount label="overdue" count={figures.overdue} className="bg-red-50 text-red-800 ring-red-200" />
          <StatusCount label="cancelled" count={figures.cancelled} className="bg-slate-100 text-slate-600 ring-slate-200" />
        </ul>
        {figures.services + figures.cancelled === 0 && <p className="mt-2 text-xs text-slate-500">No visits</p>}

        {download && <div className="mt-auto flex justify-end pt-3">{download}</div>}
      </article>
    </Card>
  )
}
