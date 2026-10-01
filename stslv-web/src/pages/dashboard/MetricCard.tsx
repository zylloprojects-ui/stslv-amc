import { Link } from 'react-router-dom'
import { Badge, Card } from '../../components/ui'
import { cx } from '../../lib/format'
import type { MetricDefinition, MetricLink, MetricReading } from './metrics'

export type MetricState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; reading: MetricReading }
  /** The metric has no data source yet. */
  | { kind: 'unavailable' }

interface MetricCardProps {
  metric: MetricDefinition
  state: MetricState
  /** The page to open from the card, already chosen for what the user may open. */
  link?: MetricLink | null
}

/** One dashboard figure. A card never shows a number it did not receive from the API. */
export function MetricCard({ metric, state, link = null }: MetricCardProps) {
  if (state.kind === 'unavailable') {
    return (
      <Card className="border-dashed p-5 shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-sm font-medium text-slate-600">{metric.label}</h3>
          <Badge tone="amber">Not yet available</Badge>
        </div>
        <p className="mt-2 text-3xl font-semibold text-slate-300" aria-hidden="true">
          —
        </p>
        <p className="mt-2 text-xs text-slate-600">No figure yet. It will come from {metric.source}, which is not connected to the dashboard.</p>
      </Card>
    )
  }

  const reading = state.kind === 'ready' ? state.reading : null
  const detail = reading && 'value' in reading ? reading.detail : undefined

  return (
    <Card className={cx('p-5', metric.attention && state.kind === 'ready' && 'border-l-4 border-l-amber-500')}>
      <h3 className="text-sm font-medium text-slate-600">{metric.label}</h3>

      {state.kind === 'loading' && (
        <div role="status" className="mt-3">
          <span className="sr-only">Loading {metric.label}</span>
          <span className="block h-8 w-20 animate-pulse rounded bg-slate-200 motion-reduce:animate-none" aria-hidden="true" />
          <span className="mt-3 block h-3 w-28 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" aria-hidden="true" />
        </div>
      )}

      {state.kind === 'failed' && (
        <>
          <p className="mt-2 text-3xl font-semibold text-slate-300" aria-hidden="true">
            —
          </p>
          <p className="mt-2 text-xs font-medium text-red-700">Could not be loaded.</p>
        </>
      )}

      {reading && 'parts' in reading && (
        <>
          <dl className="mt-3 divide-y divide-slate-200">
            {reading.parts.map((part) => (
              <div key={part.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0">
                <dt className="text-sm text-slate-700">
                  <span className="font-medium">{part.label}</span> <span className="whitespace-nowrap text-xs text-slate-600">{part.basis}</span>
                </dt>
                <dd className="min-w-0 break-words text-xl font-semibold tabular-nums text-slate-900">{part.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-slate-600">{reading.note}</p>
        </>
      )}

      {reading && 'value' in reading && (
        <>
          <p className="mt-2 break-words text-3xl font-semibold tabular-nums text-slate-900">{reading.value}</p>
          {(detail || link) && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
              {detail && <span>{detail}</span>}
              {detail && link && <span aria-hidden="true">·</span>}
              {link && (
                <Link to={link.to} className="font-medium text-blue-700 hover:underline">
                  {link.label}
                </Link>
              )}
            </p>
          )}
        </>
      )}
    </Card>
  )
}
