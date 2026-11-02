import { cx } from '../../lib/format'
import { STATUS_LABELS, type SuggestionStatus } from './suggestionTypes'

const TONES: Record<SuggestionStatus, string> = {
  SUBMITTED: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  UNDER_REVIEW: 'bg-violet-50 text-violet-800 ring-violet-600/20',
  IN_PROGRESS: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  RESOLVED: 'bg-green-50 text-green-800 ring-green-600/20',
  CLOSED: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  REOPENED: 'bg-rose-50 text-rose-800 ring-rose-600/20',
}

export function SuggestionStatusBadge({ status }: { status: SuggestionStatus }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', TONES[status])}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-70" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  )
}
