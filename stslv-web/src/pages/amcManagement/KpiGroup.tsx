import { useId, useState, type CSSProperties, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui'
import { cx } from '../../lib/format'
import type { Module } from '../../lib/types'
import { Icon, IconTile } from '../dashboard/icons'
import type { KpiReading } from '../dashboard/kpis'
import { ACCENTS, DASHBOARD_CARD, DASHBOARD_LABEL } from '../dashboard/style'
import type { KpiGroupDefinition, ManagementKpi } from './managementKpis'
import { displayName, KPI_NAME_MAX, useKpiCustomization } from './managementPreferences'
import type { AmcManagementSummary } from './managementTypes'

const FIGURE = 'break-words font-bold tabular-nums text-[#0b3b66]'

type CardState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; reading: KpiReading }

interface KpiGroupProps<T> {
  group: KpiGroupDefinition<T>
  userId: string
  data: T | undefined
  failed: boolean
  canView: (module: Module) => boolean
  /** Where the names and order are remembered; AMC Management's store unless another page gives its own. */
  storagePrefix?: string
}

/**
 * One KPI group, drawn like the dashboard's figure cards. The user may rename
 * and reorder its cards; both are remembered per group, per user, in this browser.
 */
export function KpiGroup<T = AmcManagementSummary>({ group, userId, data, failed, canView, storagePrefix }: KpiGroupProps<T>) {
  const headingId = useId()
  const [customizing, setCustomizing] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [defaults] = useState(() => group.kpis.map((kpi) => kpi.id))
  const prefs = useKpiCustomization(userId, group.id, defaults, storagePrefix)

  const cards = prefs.order
    .map((id) => group.kpis.find((kpi) => kpi.id === id))
    .filter((kpi): kpi is ManagementKpi<T> => kpi !== undefined && kpi.visible(canView))
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
    prefs.setOrder(prefs.order.map((id) => (id === a ? b : id === b ? a : id)))
  }

  const drop = (event: DragEvent, target: string) => {
    event.preventDefault()
    if (!dragging || dragging === target) return
    const next = prefs.order.filter((id) => id !== dragging)
    next.splice(next.indexOf(target), 0, dragging)
    prefs.setOrder(next)
    setDragging(null)
  }

  return (
    <section aria-labelledby={headingId} className="mb-7" data-kpi-group={group.id}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[#0b3b66]">
            <span className="h-4 w-1 rounded-full bg-[#1479BD]" aria-hidden="true" />
            {group.title}
          </h2>
          <p className="mt-1 text-xs text-slate-600">{group.description}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" aria-pressed={customizing} aria-label={`Customize ${group.title}`} onClick={() => setCustomizing(!customizing)}>
            {customizing ? 'Done' : 'Customize'}
          </Button>
          <Button variant="secondary" size="sm" aria-label={`Reset KPI Names of ${group.title}`} onClick={prefs.resetNames} disabled={!prefs.namesChanged}>
            Reset KPI Names
          </Button>
          <Button variant="secondary" size="sm" aria-label={`Reset KPI Order of ${group.title}`} onClick={prefs.resetOrder} disabled={!prefs.orderChanged}>
            Reset KPI Order
          </Button>
        </div>
      </div>
      {customizing && (
        <p className="mb-2 text-xs text-slate-600">
          Rename a card or change its place with the arrow buttons (or drag it). A renamed card still shows the same figure. Names and order are remembered in this browser for your account.
        </p>
      )}

      <ul aria-label={group.title} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ kpi, state }, index) => {
          const name = displayName(prefs.names, kpi.id, kpi.label)
          const renamed = name !== kpi.label
          const link = kpi.link && canView(kpi.link.module) ? kpi.link : null
          const from = ACCENTS[index % ACCENTS.length] as string
          const to = ACCENTS[(index + 1) % ACCENTS.length] as string
          const reading = state.kind === 'ready' ? state.reading : null
          const value = reading?.kind === 'value' ? reading.value : null
          // A short line on the card; the full wording is on hover.
          const note = reading ? (reading.kind === 'value' ? reading.detail : (reading.reason.split(/(?<=\.)\s/)[0] ?? reading.reason)) : null
          const hint = reading ? (reading.kind === 'value' ? reading.hint : reading.reason) : undefined
          const entrance: CSSProperties = { animationDelay: `${Math.min(index, 8) * 0.06}s` }
          const inputId = `${headingId}-${kpi.id}-name`

          return (
            <li
              key={kpi.id}
              data-kpi={kpi.id}
              draggable={customizing}
              onDragStart={() => setDragging(kpi.id)}
              onDragOver={(event) => customizing && event.preventDefault()}
              onDrop={(event) => drop(event, kpi.id)}
              style={entrance}
              className={cx(DASHBOARD_CARD, customizing && 'cursor-move ring-2 ring-dashed ring-sky-300', dragging === kpi.id && 'opacity-60')}
            >
              <span className="card-dots" aria-hidden="true" />
              <Icon name={kpi.icon} className="card-watermark" />
              <IconTile icon={kpi.icon} from={from} to={to} className="absolute right-5 top-5" />
              <h3 className={cx(DASHBOARD_LABEL, 'min-h-9 pr-12')} title={renamed ? `Standard name: ${kpi.label}` : undefined}>
                {name}
                {renamed && <span className="sr-only"> (standard name: {kpi.label})</span>}
              </h3>

              {state.kind === 'loading' && (
                <div role="status" className="mt-4">
                  <span className="sr-only">Loading {name}</span>
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
                    <p className="mt-3 text-3xl font-bold text-slate-400">Not available</p>
                  )}
                  <p className="mt-3 break-words text-sm text-slate-600" title={hint}>
                    <span>{note}</span>
                    {link && !customizing && (
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

              {customizing && (
                <div className="relative mt-3 space-y-2">
                  <label htmlFor={inputId} className="block text-xs font-medium text-slate-700">
                    Display name for {kpi.label}
                  </label>
                  <input
                    id={inputId}
                    type="text"
                    value={prefs.names[kpi.id] ?? ''}
                    placeholder={kpi.label}
                    maxLength={KPI_NAME_MAX}
                    onChange={(event) => prefs.rename(kpi.id, event.target.value)}
                    className="block w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-500"
                  />
                  <span className="flex justify-end gap-1">
                    <button
                      type="button"
                      className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs disabled:opacity-40"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${name} earlier`}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs disabled:opacity-40"
                      onClick={() => move(index, 1)}
                      disabled={index === cards.length - 1}
                      aria-label={`Move ${name} later`}
                    >
                      →
                    </button>
                  </span>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
