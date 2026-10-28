/**
 * One line under a page's KPI cards that says which records the cards count
 * and which dates the list shows, so a card and the list beside it are never
 * read as the same figure when they are not.
 */
export function KpiScopeNote({ cards, rows }: { cards: string; rows: string }) {
  return (
    <p role="note" aria-label="What the figures count" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      <span>
        <span className="font-semibold text-slate-700">Cards:</span> {cards}
      </span>
      <span>
        <span className="font-semibold text-slate-700">List:</span> {rows}
      </span>
    </p>
  )
}
