import { useState, type CSSProperties, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '../../lib/format'
import type { Module } from '../../lib/types'
import { KPIS, type KpiDefinition, type KpiReading } from './kpis'
import { Icon, type IconName } from './icons'
import type { OperationsDashboard } from './operationsTypes'

// The icon and the colour of each figure. A figure keeps its colour wherever it is moved.
const KPI_STYLE: Record<string, { icon: IconName; main: string; soft: string }> = {
  active: { icon: 'contract', main: '#1479BD', soft: '#EAF3FB' },
  value: { icon: 'wallet', main: '#1479BD', soft: '#EAF3FB' },
  credit: { icon: 'chart', main: '#1479BD', soft: '#EAF3FB' },
  services: { icon: 'calendar', main: '#1479BD', soft: '#EAF3FB' },
  unpaid: { icon: 'invoice', main: '#1479BD', soft: '#EAF3FB' },
  paid: { icon: 'invoice', main: '#1479BD', soft: '#EAF3FB' },
  expiring: { icon: 'shield', main: '#1479BD', soft: '#EAF3FB' },
}
const FALLBACK_STYLE = { icon: 'pulse' as IconName, main: '#1479BD', soft: '#EAF3FB' }

type CardState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; reading: KpiReading }

interface KpiStripProps {
  data: OperationsDashboard | undefined
  failed: boolean
  canView: (module: Module) => boolean
  order: string[]
  arranging: boolean
  onReorder: (order: string[]) => void
}

/** The key figures: one card each, with its own colour edge, icon tile and code tag, the figure, and a line saying what it is. */
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
    <ul aria-label="Key figures" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ kpi, state }, index) => {
        const link = kpi.link && canView(kpi.link.module) ? kpi.link : null
        const style = KPI_STYLE[kpi.id] ?? FALLBACK_STYLE
        const reading = state.kind === 'ready' ? state.reading : null
        const value = reading?.kind === 'value' ? reading.value : null
        // A short line on the card; the full wording is on hover.
        const note = reading ? (reading.kind === 'value' ? reading.detail : (reading.reason.split(/(?<=\.)\s/)[0] ?? reading.reason)) : null
        const hint = reading ? (reading.kind === 'value' ? reading.hint : reading.reason) : undefined
        const card: CSSProperties = {
          animationDelay: `${Math.min(index, 8) * 0.06}s`,
          backgroundImage: `radial-gradient(circle at 100% 100%, ${style.soft}, transparent 50%)`,
        }

        return (
          <li
            key={kpi.id}
            data-kpi={kpi.id}
            draggable={arranging}
            onDragStart={() => setDragging(kpi.id)}
            onDragOver={(event) => arranging && event.preventDefault()}
            onDrop={(event) => drop(event, kpi.id)}
            style={card}
            className={cx(
              'login-rise group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-4 pl-5 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg',
              arranging && 'cursor-move ring-2 ring-dashed ring-sky-300',
              dragging === kpi.id && 'opacity-60',
            )}
          >
            <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: style.main }} aria-hidden="true" />
            <span className="absolute inset-x-0 top-0 h-[3px] opacity-70" style={{ backgroundImage: `linear-gradient(90deg, ${style.main}, transparent 70%)` }} aria-hidden="true" />

            <div className="relative flex items-center gap-2.5">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform duration-300 group-hover:scale-105"
                style={{ backgroundColor: style.soft, color: style.main, boxShadow: `inset 0 0 0 1px ${style.main}26` }}
                aria-hidden="true"
              >
                <Icon name={style.icon} className="h-[18px] w-[18px]" />
              </span>
              <h3 className="min-w-0 flex-1 text-xs font-bold uppercase leading-tight tracking-wide text-[#0b3b66]">{kpi.label}</h3>
              <span
                className="shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold tracking-wider"
                style={{ backgroundColor: style.soft, color: style.main, borderColor: style.main + '40' }}
                aria-hidden="true"
              >
                {kpi.code}
              </span>
            </div>

            {state.kind === 'loading' && (
              <div role="status" className="mt-3">
                <span className="sr-only">Loading {kpi.label}</span>
                <span className="skeleton block h-8 w-24 rounded-lg" aria-hidden="true" />
                <span className="skeleton mt-3 block h-3 w-32 rounded" aria-hidden="true" />
              </div>
            )}
            {state.kind === 'failed' && <p className="mt-3 text-sm font-medium text-red-700">Could not be loaded</p>}
            {state.kind === 'ready' && (
              <>
                {value !== null ? (
                  <p className={cx('relative mt-3 break-words font-extrabold tabular-nums leading-none text-[#0f2a43]', value.length > 9 ? 'text-2xl' : 'text-3xl')}>{value}</p>
                ) : (
                  <p className="relative mt-3 text-xl font-extrabold leading-none text-slate-400">Not available</p>
                )}
                <p className="relative mt-1.5 break-words text-xs leading-snug text-slate-600" title={hint}>
                  {note}
                </p>
                {link && !arranging && (
                  <Link to={link.to} className="relative mt-auto inline-flex items-center gap-1 pt-2 text-xs font-semibold hover:underline" style={{ color: style.main }}>
                    {link.label}
                    <span aria-hidden="true">→</span>
                  </Link>
                )}
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
