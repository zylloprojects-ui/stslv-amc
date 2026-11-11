import type { CSSProperties, ReactNode } from 'react'
import { cx } from '../../lib/format'
import type { Module } from '../../lib/types'
import { KPI_ROWS, KPIS, kpiColumn, type DashboardReading, type KpiDefinition, type KpiRow } from './kpis'
import { Icon, IconTile } from './icons'
import { accentOf, accentStyle, DASHBOARD_CARD, DASHBOARD_LABEL } from './style'
import type { OperationsDashboard } from './operationsTypes'

const FIGURE = 'break-words font-bold tabular-nums text-[#0b3b66]'

type CardState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; reading: DashboardReading }

interface KpiStripProps {
  data: OperationsDashboard | undefined
  failed: boolean
  canView: (module: Module) => boolean
}

/** The cards of one row this user may see, with what each shows now. A card whose section the API left out is not shown. */
function cardsOf(row: KpiRow, data: OperationsDashboard | undefined, failed: boolean, canView: (module: Module) => boolean) {
  return KPIS.filter((kpi) => kpi.row === row.id && kpi.visible(canView)).flatMap((kpi): { kpi: KpiDefinition; state: CardState }[] => {
    if (!data) return [{ kpi, state: failed ? { kind: 'failed' } : { kind: 'loading' } }]
    const reading = kpi.read(data)

    return reading ? [{ kpi, state: { kind: 'ready', reading } }] : []
  })
}

/**
 * The figure and the line under it, the same on every KPI card: the Dashboard's, and the KPI groups of AMC Management
 * (whose shared cards must look exactly like the Dashboard's) and AMC Renewal.
 */
export function KpiFigure({ value, unit, detail, hint, children }: { value: string; unit?: string; detail: ReactNode; hint?: string; children?: ReactNode }) {
  // A long amount takes a smaller size, so it fits a quarter-width card. The "OMR" unit counts towards the length.
  const length = value.length + (unit ? unit.length + 1 : 0)
  const size = length > 16 ? 'text-xl' : length > 12 ? 'text-2xl' : length > 9 ? 'text-3xl' : 'text-4xl'

  return (
    <>
      <p className={cx(FIGURE, 'mt-3', size)}>
        {unit && <span className="mr-1.5 align-baseline text-sm font-semibold text-slate-500">{unit}</span>}
        {/* An amount never breaks inside its digits; on a very narrow card it moves under the unit instead. */}
        <span className="whitespace-nowrap">{value}</span>
      </p>
      <p className="mt-3 break-words text-sm text-slate-600" title={hint}>
        {detail}
        {children}
      </p>
    </>
  )
}

/** One figure card. Not a link and not a button: the dashboard's KPI cards do not navigate. */
function KpiCard({ kpi, state, column, order }: { kpi: KpiDefinition; state: CardState; column: number; order: number }) {
  const { from, to } = accentOf(column)
  const reading = state.kind === 'ready' ? state.reading : null
  const entrance: CSSProperties = { animationDelay: `${Math.min(order, 11) * 0.04}s`, ...accentStyle(column) }

  return (
    <li data-kpi={kpi.id} style={entrance} className={cx(DASHBOARD_CARD, 'min-w-0')}>
      <span className="card-dots" aria-hidden="true" />
      <Icon name={kpi.icon} className="card-watermark" />
      <IconTile icon={kpi.icon} from={from} to={to} className="absolute right-5 top-5" />
      <h4 className={cx(DASHBOARD_LABEL, 'min-h-9 pr-12')}>{kpi.label}</h4>

      {state.kind === 'loading' && (
        <div role="status" className="mt-4">
          <span className="sr-only">Loading {kpi.label}</span>
          <span className="skeleton block h-9 w-24 rounded-lg" aria-hidden="true" />
          <span className="skeleton mt-4 block h-3.5 w-32 rounded" aria-hidden="true" />
        </div>
      )}
      {state.kind === 'failed' && <p className="mt-3 text-sm font-medium text-red-700">Could not be loaded</p>}
      {reading && <KpiFigure value={reading.value} unit={reading.unit} detail={reading.detail} hint={reading.hint} />}
    </li>
  )
}

/**
 * The twelve key figures in three fixed rows: AMC Portfolio, Current Month and Overall, then the three-card
 * Current Year (YTD) row. Four cards a row on a wide screen, two on a tablet, one on a phone. Rows share card
 * names, so each row carries its own heading. A row with no card this user may see is left out.
 */
export function KpiStrip({ data, failed, canView }: KpiStripProps) {
  let order = 0

  return (
    <div className="space-y-5">
      {KPI_ROWS.map((row) => {
        const cards = cardsOf(row, data, failed, canView)
        if (cards.length === 0) return null
        const headingId = `kpi-row-${row.id}`

        return (
          <section key={row.id} aria-labelledby={headingId} data-kpi-row={row.id}>
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <h3 id={headingId} className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#1479BD]">
                {row.title}
              </h3>
              <p className="text-xs text-slate-600">{row.subtitle(data)}</p>
            </div>
            <ul aria-labelledby={headingId} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {cards.map(({ kpi, state }) => {
                // Each column keeps one colour down the rows, so the same figure lines up month against overall.
                const column = kpiColumn(kpi)

                return <KpiCard key={kpi.id} kpi={kpi} state={state} column={column} order={order++} />
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
