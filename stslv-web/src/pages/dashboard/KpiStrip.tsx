import { useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '../../lib/format'
import type { Module } from '../../lib/types'
import { KPIS, type KpiDefinition, type KpiReading } from './kpis'
import { DASHBOARD_LABEL } from './style'
import type { OperationsDashboard } from './operationsTypes'

type CardState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; reading: KpiReading }

interface KpiStripProps {
  data: OperationsDashboard | undefined
  failed: boolean
  canView: (module: Module) => boolean
  order: string[]
  arranging: boolean
  onReorder: (order: string[]) => void
}

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
    <ul aria-label="Key figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
      {cards.map(({ kpi, state }, index) => {
        const link = kpi.link && canView(kpi.link.module) ? kpi.link : null

        return (
          <li
            key={kpi.id}
            data-kpi={kpi.id}
            draggable={arranging}
            onDragStart={() => setDragging(kpi.id)}
            onDragOver={(event) => arranging && event.preventDefault()}
            onDrop={(event) => drop(event, kpi.id)}
            className={cx(
              'surface relative flex min-w-0 flex-col rounded-2xl p-4',
              arranging && 'cursor-move ring-2 ring-dashed ring-sky-300',
              dragging === kpi.id && 'opacity-60',
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className={cx(DASHBOARD_LABEL, 'min-w-0')}>{kpi.label}</h3>
              <span className="shrink-0 rounded bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-[#0b3b66] ring-1 ring-inset ring-sky-200" aria-hidden="true">
                {kpi.code}
              </span>
            </div>

            {state.kind === 'loading' && <p className="mt-3 h-8 w-20 animate-pulse rounded bg-slate-100" aria-label="Loading" />}
            {state.kind === 'failed' && <p className="mt-3 text-sm font-medium text-red-700">Could not be loaded</p>}
            {state.kind === 'ready' && state.reading.kind === 'value' && (
              <>
                <p className="mt-2 break-words text-2xl font-bold tabular-nums text-[#0b3b66]">{state.reading.value}</p>
                <p className="mt-1 text-xs text-slate-600">{state.reading.detail}</p>
              </>
            )}
            {state.kind === 'ready' && state.reading.kind === 'unavailable' && (
              <>
                <p className="mt-2 text-base font-semibold text-slate-500">Not available</p>
                <p className="mt-1 text-xs text-slate-600">{state.reading.reason}</p>
              </>
            )}

            <div className="mt-auto flex items-center justify-between gap-2 pt-3">
              {link && !arranging ? (
                <Link to={link.to} className="text-xs font-medium text-[#1479BD] hover:underline">
                  {link.label} →
                </Link>
              ) : (
                <span />
              )}
              {arranging && (
                <span className="flex gap-1">
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-40"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${kpi.label} earlier`}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-0.5 text-xs disabled:opacity-40"
                    onClick={() => move(index, 1)}
                    disabled={index === cards.length - 1}
                    aria-label={`Move ${kpi.label} later`}
                  >
                    →
                  </button>
                </span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
