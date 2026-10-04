import type { ReactNode } from 'react'
import { CountUp } from './CountUp'

interface StatTileProps {
  label: string
  /** A whole number; it counts up when the tile appears. */
  count: number
  /** A second line under the label, for example "2 past their validity". */
  hint?: string
  /** Show the hint in amber, as a warning. */
  warn?: boolean
  /** A figure shown beside the count, for example an amount. */
  extra?: string
  icon: ReactNode
  /** Gradient classes of the icon tile. */
  tone: string
  /** The colour of the tile's accent bar, outline and soft tint. */
  edge: string
  /** Position in the row: staggers the entrance. */
  position?: number
  /** Makes the tile a toggle button (a filter). Leave out for a tile that only shows a figure. */
  selected?: boolean
  onSelect?: () => void
}

/** One figure of a summary strip: icon, big number, label and an optional note. Shared by the AMC pages. */
export function StatTile({ label, count, hint, warn = false, extra, icon, tone, edge, position = 0, selected = false, onSelect }: StatTileProps) {
  const style = {
    animationDelay: `${position * 70}ms`,
    borderColor: selected ? edge : `${edge}40`,
    backgroundImage: `linear-gradient(135deg, ${edge}12, transparent 60%)`,
  }
  const className = `contract-tile login-rise group relative flex w-full items-center gap-3.5 overflow-hidden rounded-xl border bg-white py-4 pl-5 pr-4 text-left shadow-sm transition-all duration-300 ${
    onSelect ? 'hover:-translate-y-1 hover:shadow-xl' : ''
  } ${selected ? 'ring-2 ring-offset-1' : ''}`

  const body = (
    <>
      {/* The accent bar is drawn inside the tile, so the tile's rounded corners stay clean. */}
      <span className="absolute inset-y-0 left-0 w-1.5" style={{ backgroundColor: edge }} aria-hidden="true" />
      <span
        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md transition-transform duration-300 ${onSelect ? 'group-hover:scale-110 group-hover:-rotate-6' : ''} ${tone}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-600">{label}</span>
        <span className="mt-0.5 flex items-baseline gap-2">
          <span className="text-3xl font-bold leading-none tabular-nums tracking-tight text-[#0b3b66]">
            <CountUp value={count} />
          </span>
          {extra && <span className="truncate text-sm font-semibold tabular-nums text-slate-500">{extra}</span>}
        </span>
        {hint && <span className={`mt-1.5 block text-xs font-medium ${warn ? 'text-amber-700' : 'text-slate-500'}`}>{hint}</span>}
      </span>
      {selected && (
        <span className="absolute right-3 top-3 flex h-2.5 w-2.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none" style={{ backgroundColor: edge }} />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ backgroundColor: edge }} />
        </span>
      )}
    </>
  )

  return onSelect ? (
    <button type="button" aria-pressed={selected} onClick={onSelect} style={style} className={className}>
      {body}
    </button>
  ) : (
    <div style={style} className={className}>
      {body}
    </div>
  )
}
