import type { CSSProperties } from 'react'

// Figure cards take their colours from the STS-ELV logo (blue, green, orange, magenta, cyan, gold), one
// colour per card by position. The colour only tells the cards apart; status (amber for attention,
// red for a failure) is still shown by its own marks.
export const ACCENT_PAIRS: [string, string][] = [
  ['#1479BD', '#4aa3df'],
  ['#3E9A2E', '#7BC96B'],
  ['#F26B00', '#FFB04D'],
  ['#B02275', '#E86FB0'],
  ['#0088A8', '#35C9E3'],
  ['#D99100', '#FFD04D'],
]

/** The two colours of the card at a position. */
export const accentOf = (index: number): { from: string; to: string } => {
  const [from, to] = ACCENT_PAIRS[index % ACCENT_PAIRS.length] as [string, string]

  return { from, to }
}

/** Sets the card's accent for its top strip, corner glow, dots and watermark (see .metric-card in index.css). */
export const accentStyle = (index: number): CSSProperties => {
  const { from, to } = accentOf(index)

  return { '--accent-from': from, '--accent-to': to } as CSSProperties
}

/** The card shared by every dashboard figure: rounded, lifts on hover, rises into place. */
export const DASHBOARD_CARD =
  'surface metric-card login-rise relative overflow-hidden rounded-2xl p-5 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-sky-200/50'

export const DASHBOARD_LABEL = 'text-xs font-semibold uppercase tracking-[0.14em] text-slate-500'
