import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../../components/ui'
import { cx } from '../../lib/format'
import { Icon, IconTile, type IconName } from './icons'
import { ACCENTS, DASHBOARD_CARD, DASHBOARD_LABEL } from './style'
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
  /** Position of the card on the page: picks its accent colours and staggers its entrance. */
  index?: number
  /**
   * For a card that carries a ring in the corner instead of an icon: the share (0 to 1) that the
   * figure is of its whole, or null until the API has returned it. Decorative only; the numbers
   * are always shown as text beside it.
   */
  ring?: number | null | undefined
}

// The icon of each figure. A figure not listed here gets the general one.
const METRIC_ICONS: Record<string, IconName> = {
  'clients.active': 'users',
  'amc.activeContracts': 'contract',
  'amc.visitsDue': 'calendar',
  'amc.readyForInvoice': 'invoice',
  'projects.active': 'project',
  'projects.readyForInvoice': 'invoice',
  'finance.trackedExpenses': 'wallet',
  'finance.readyForInvoiceValue': 'invoice',
}

const FIGURE = 'break-words font-bold tabular-nums text-[#0b3b66]'

/** Ring showing a share of a whole. Decorative; the numbers are shown as text beside it. */
function ShareRing({ share }: { share: number }) {
  const circumference = 2 * Math.PI * 26

  return (
    <div className="relative h-16 w-16" aria-hidden="true">
    <span className="absolute inset-0 flex items-center justify-center text-[13px] font-bold tabular-nums text-[#0b3b66]">{Math.round(Math.min(Math.max(share, 0), 1) * 100)}%</span>
    <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r="26" fill="none" stroke="#E2E8F0" strokeWidth="8" />
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke="url(#metric-ring-gradient)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeDasharray={`${circumference * Math.min(Math.max(share, 0), 1)} ${circumference}`}
      />
      <defs>
        <linearGradient id="metric-ring-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1B8AD3" />
          <stop offset="100%" stopColor="#4aa3df" />
        </linearGradient>
      </defs>
    </svg>
    </div>
  )
}

/** One dashboard figure. A card never shows a number it did not receive from the API. */
export function MetricCard({ metric, state, link = null, index = 0, ring }: MetricCardProps) {
  const from = ACCENTS[index % ACCENTS.length] as string
  const to = ACCENTS[(index + 1) % ACCENTS.length] as string
  const entrance: CSSProperties = { animationDelay: `${Math.min(index, 8) * 0.06}s` }
  const icon = METRIC_ICONS[metric.id] ?? 'pulse'

  if (state.kind === 'unavailable') {
    return (
      <div
        data-metric-card
        className="login-rise relative rounded-2xl border border-dashed border-slate-300 bg-white/70 p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-[#1B8AD3] hover:bg-white hover:shadow-md"
        style={entrance}
      >
        <IconTile icon={icon} from={from} to={to} className="absolute right-5 top-5" />
        <h3 className={cx(DASHBOARD_LABEL, 'pr-12')}>{metric.label}</h3>
        <div className="mt-2">
          <Badge tone="amber">Not yet available</Badge>
        </div>
        <p className="mt-3 text-3xl font-bold text-slate-300" aria-hidden="true">
          —
        </p>
        <p className="mt-2 text-xs text-slate-600">No figure yet. It will come from {metric.source}, which is not connected to the dashboard.</p>
      </div>
    )
  }

  const reading = state.kind === 'ready' ? state.reading : null
  const detail = reading && 'value' in reading ? reading.detail : undefined
  const hasRing = ring !== undefined

  return (
    <div
      data-metric-card
      className={cx(DASHBOARD_CARD, metric.attention && state.kind === 'ready' && 'border-l-4 border-l-amber-500')}
      style={entrance}
    >
      <span className="card-dots" aria-hidden="true" />
      <Icon name={icon} className="card-watermark" />
      {hasRing ? (
        ring !== null &&
        state.kind === 'ready' && (
          <div className="absolute right-4 top-4">
            <ShareRing share={ring} />
          </div>
        )
      ) : (
        <IconTile icon={icon} from={from} to={to} className="absolute right-5 top-5" />
      )}

      {/* Beside an icon the label keeps the icon's height, so every card in a row lines up. */}
      <h3 className={cx(DASHBOARD_LABEL, hasRing ? 'pr-20' : 'min-h-9 pr-12')}>{metric.label}</h3>

      {state.kind === 'loading' && (
        <div role="status" className="mt-4">
          <span className="sr-only">Loading {metric.label}</span>
          <span className="skeleton block h-9 w-24 rounded-lg" aria-hidden="true" />
          <span className="skeleton mt-4 block h-3.5 w-32 rounded" aria-hidden="true" />
        </div>
      )}

      {state.kind === 'failed' && (
        <>
          <p className="mt-3 text-4xl font-bold text-slate-300" aria-hidden="true">
            —
          </p>
          <p className="mt-3 text-sm font-medium text-red-700">Could not be loaded.</p>
        </>
      )}

      {reading && 'parts' in reading && (
        <>
          <dl className="mt-3 divide-y divide-slate-200">
            {reading.parts.map((part) => (
              <div key={part.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0">
                <dt className="text-sm text-slate-700">
                  <span className="font-semibold">{part.label}</span> <span className="whitespace-nowrap text-xs text-slate-600">{part.basis}</span>
                </dt>
                <dd className={cx(FIGURE, 'min-w-0 text-xl')}>{part.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-slate-600">{reading.note}</p>
        </>
      )}

      {reading && 'value' in reading && (
        <>
          {/* A long amount takes a smaller size, so it fits the card. */}
          <p className={cx(FIGURE, 'mt-3', reading.value.length > 9 ? 'text-3xl' : 'text-4xl')}>{reading.value}</p>
          {(detail || link) && (
            <p className="mt-3 break-words text-sm text-slate-600">
              {detail && <span>{detail}</span>}
              {detail && link && <span aria-hidden="true"> · </span>}
              {link && (
                <Link to={link.to} className="font-medium text-[#1479BD] hover:underline">
                  {link.label}
                </Link>
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}
