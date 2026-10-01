import { Link } from 'react-router-dom'
import { Badge, Card } from '../../components/ui'
import { cx } from '../../lib/format'
import type { MetricDefinition, MetricReading } from './metrics'

export type MetricState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; reading: MetricReading }
  /** The metric has no data source yet. */
  | { kind: 'unavailable' }

/** One dashboard figure. A card never shows a number it did not receive from the API. */
export function MetricCard({ metric, state }: { metric: MetricDefinition; state: MetricState }) {
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

  const link = metric.link ?? null

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

      {state.kind === 'ready' && (
        <>
          <p className="mt-2 break-words text-3xl font-semibold tabular-nums text-slate-900">{state.reading.value}</p>
          {(state.reading.detail || link) && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
              {state.reading.detail && <span>{state.reading.detail}</span>}
              {state.reading.detail && link && <span aria-hidden="true">·</span>}
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
