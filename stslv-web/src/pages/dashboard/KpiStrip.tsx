import { useState, type CSSProperties, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '../../lib/format'
import type { Module } from '../../lib/types'
import { KPIS, type KpiDefinition, type KpiReading } from './kpis'
import { Icon, IconTile, type IconName } from './icons'
import { ACCENTS, DASHBOARD_CARD, DASHBOARD_LABEL } from './style'
import type { OperationsDashboard } from './operationsTypes'

// The icon of each figure, the same family as the other dashboard figure cards.
const KPI_ICONS: Record<string, IconName> = {
  active: 'contract',
  value: 'wallet',
  credit: 'chart',
  services: 'calendar',
  unpaid: 'invoice',
  paid: 'invoice',
  expiring: 'shield',
}

const FIGURE = 'break-words font-bold tabular-nums text-[#0b3b66]'

type CardState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; reading: KpiReading }

interface KpiStripProps {
  data: OperationsDashboard | undefined
  failed: boolean
  canView: (module: Module) => boolean
  order: string[]
  arranging: boolean
  onReorder: (order: string[]) => void
}

/** The key figures, drawn exactly like the dashboard's other figure cards: label and icon on top, the figure, and one line with its link. */
export function KpiStrip({ data, failed, canView, order, arranging, onReorder }: KpiStripProps) {
  const [dragging, setDragging] = useState<string | null>(null)

  const cards = order
    .map((id) => KPIS.find((kpi) => kpi.id === id))
    .filter((kpi): kpi is KpiDefinition => kpi !== undefined && kpi.visible(canView))
    .flatMap((kpi) => {
      if (!data) return [{ kpi, state: (failed ? { kind: 'failed' } : { kind: 'loading' }) as CardState }]
      const reading = kpi.read(data)

      return reading ? [{ kpi, state: { kind: 'ready', reading } as CardState }] : []
    })

  if (cards.length === 0) return null

  // Swaps a card with its visible neighbour, so cards this user cannot see never get in the way.
  const move = (index: number, by: -1 | 1) => {
    const a = cards[index]?.kpi.id
    const b = cards[index + by]?.kpi.id

    if (!a || !b) return
    onReorder(order.map((id) => (id === a ? b : id === b ? a : id)))
  }

  const drop = (event: DragEvent, target: string) => {
    event.preventDefault()
    if (!dragging || dragging === target) return
    const next = order.filter((id) => id !== dragging)
    next.splice(next.indexOf(target), 0, dragging)
    onReorder(next)
    setDragging(null)
  }

  return (
    <ul aria-label="Key figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map(({ kpi, state }, index) => {
        const link = kpi.link && canView(kpi.link.module) ? kpi.link : null
        const icon = KPI_ICONS[kpi.id] ?? 'pulse'
        const from = ACCENTS[index % ACCENTS.length] as string
        const to = ACCENTS[(index + 1) % ACCENTS.length] as string
        const reading = state.kind === 'ready' ? state.reading : null
        const value = reading?.kind === 'value' ? reading.value : null
        // A short line on the card; the full wording is on hover.
        const note = reading ? (reading.kind === 'value' ? reading.detail : (reading.reason.split(/(?<=\.)\s/)[0] ?? reading.reason)) : null
        const hint = reading ? (reading.kind === 'value' ? reading.hint : reading.reason) : undefined
        const entrance: CSSProperties = { animationDelay: `${Math.min(index, 8) * 0.06}s` }

        return (
          <li
            key={kpi.id}
            data-kpi={kpi.id}
            draggable={arranging}
            onDragStart={() => setDragging(kpi.id)}
            onDragOver={(event) => arranging && event.preventDefault()}
            onDrop={(event) => drop(event, kpi.id)}
            style={entrance}
            className={cx(DASHBOARD_CARD, arranging && 'cursor-move ring-2 ring-dashed ring-sky-300', dragging === kpi.id && 'opacity-60')}
          >
            <span className="card-dots" aria-hidden="true" />
            <Icon name={icon} className="card-watermark" />
            <IconTile icon={icon} from={from} to={to} className="absolute right-5 top-5" />
            <h3 className={cx(DASHBOARD_LABEL, 'min-h-9 pr-12')}>{kpi.label}</h3>

            {state.kind === 'loading' && (
              <div role="status" className="mt-4">
                <span className="sr-only">Loading {kpi.label}</span>
                <span className="skeleton block h-9 w-24 rounded-lg" aria-hidden="true" />
                <span className="skeleton mt-4 block h-3.5 w-32 rounded" aria-hidden="true" />
              </div>
            )}
            {state.kind === 'failed' && <p className="mt-3 text-sm font-medium text-red-700">Could not be loaded</p>}
            {state.kind === 'ready' && (
              <>
                {value !== null ? (
                  <p className={cx(FIGURE, 'mt-3', value.length > 9 ? 'text-3xl' : 'text-4xl')}>{value}</p>
                ) : (
                  <p className="mt-3 text-3xl font-bold text-slate-300">Not available</p>
                )}
                <p className="mt-3 break-words text-sm text-slate-600" title={hint}>
                  <span>{note}</span>
                  {link && !arranging && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <Link to={link.to} className="font-medium text-[#1479BD] hover:underline">
                        {link.label}
                      </Link>
                    </>
                  )}
                </p>
              </>
            )}

            {arranging && (
              <span className="relative mt-3 flex justify-end gap-1">
                <button
                  type="button"
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs disabled:opacity-40"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${kpi.label} earlier`}
                >
                  ←
                </button>
                <button
                  type="button"
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs disabled:opacity-40"
                  onClick={() => move(index, 1)}
                  disabled={index === cards.length - 1}
                  aria-label={`Move ${kpi.label} later`}
                >
                  →
                </button>
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
