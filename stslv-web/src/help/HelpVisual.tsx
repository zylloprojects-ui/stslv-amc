import { useId, useState } from 'react'
import { cx } from '../lib/format'

/** One numbered pointer on a help screenshot. Coordinates are CSS pixels of the captured frame. */
export interface HelpCallout {
  text: string
  /** The control pointed at: x, y, width, height. */
  box: [number, number, number, number]
  /** Where the numbered marker sits; an arrow runs from it to the box. */
  badge: [number, number]
}

/** An annotated screenshot of a page, captured from sample data by scripts/capture-help-visuals.mjs. */
export interface HelpVisualData {
  src: string
  width: number
  height: number
  alt: string
  callouts: HelpCallout[]
}

const ACCENT = '#ea580c'

/** The point of the box's edge nearest to the marker, so the arrow stops at the control instead of covering it. */
function arrowEnd([bx, by]: [number, number], [x, y, w, h]: [number, number, number, number]): [number, number] {
  const gap = 4
  const px = Math.min(Math.max(bx, x), x + w)
  const py = Math.min(Math.max(by, y), y + h)
  const inside = px === bx && py === by
  if (inside) return [bx, by]
  const dx = px - bx
  const dy = py - by
  const length = Math.hypot(dx, dy) || 1
  return [px - (dx / length) * gap, py - (dy / length) * gap]
}

/**
 * The screenshot with numbered markers and arrows, and below it the same numbers with what each control does.
 * Pointing at (or focusing) a line of the legend highlights its control on the picture.
 */
export function HelpVisual({ visual, compact = false }: { visual: HelpVisualData; compact?: boolean }) {
  const [active, setActive] = useState<number | null>(null)
  const markerId = `help-arrow-${useId().replace(/:/g, '')}`
  const legendId = `${markerId}-legend`
  const { width, height } = visual

  return (
    <figure className="space-y-3" aria-describedby={legendId}>
      <div className="relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm">
        <img src={visual.src} alt={visual.alt} width={width} height={height} loading="lazy" decoding="async" className="block h-auto w-full" />
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="22" markerHeight="22" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill={ACCENT} />
            </marker>
          </defs>
          {visual.callouts.map((callout, index) => {
            const [x, y, w, h] = callout.box
            const [ex, ey] = arrowEnd(callout.badge, callout.box)
            const on = active === index
            return (
              <g key={index} opacity={active === null || on ? 1 : 0.35}>
                <rect x={x - 3} y={y - 3} width={w + 6} height={h + 6} rx="8" fill={on ? 'rgba(234,88,12,0.14)' : 'rgba(234,88,12,0.06)'} stroke={ACCENT} strokeWidth={on ? 3 : 2} vectorEffect="non-scaling-stroke" />
                <line x1={callout.badge[0]} y1={callout.badge[1]} x2={ex} y2={ey} stroke={ACCENT} strokeWidth={on ? 3 : 2} vectorEffect="non-scaling-stroke" markerEnd={`url(#${markerId})`} />
              </g>
            )
          })}
        </svg>
        {visual.callouts.map((callout, index) => (
          <span
            key={index}
            aria-hidden="true"
            style={{ left: `${(callout.badge[0] / width) * 100}%`, top: `${(callout.badge[1] / height) * 100}%`, backgroundColor: ACCENT }}
            className={cx(
              'absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full font-bold text-white shadow-md ring-2 ring-white',
              compact ? 'h-5 w-5 text-[10px]' : 'h-7 w-7 text-xs',
              active === index && 'scale-125 motion-safe:transition-transform',
            )}
          >
            {index + 1}
          </span>
        ))}
      </div>
      <figcaption id={legendId}>
        <ol className="space-y-1.5" aria-label="What the numbers on the picture show">
          {visual.callouts.map((callout, index) => (
            <li
              key={index}
              tabIndex={0}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className={cx('flex items-start gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-orange-400', active === index ? 'bg-orange-50' : 'hover:bg-slate-50')}
            >
              <span aria-hidden="true" style={{ backgroundColor: ACCENT }} className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white">
                {index + 1}
              </span>
              <span>
                <span className="sr-only">{index + 1}. </span>
                {callout.text}
              </span>
            </li>
          ))}
        </ol>
        <a href={visual.src} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-[#0b5d8f] hover:underline">
          Open the picture full size ↗
        </a>
      </figcaption>
    </figure>
  )
}
