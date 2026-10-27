import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api'
import { formatDateTime } from '../lib/format'
import { LoadError, Pager } from './records'
import { EmptyState, Spinner } from './ui'

// The activity recorded against one record (GET .../:id/history), newest
// first, with action, user, time, description and changed fields in words.

export interface HistoryEntry {
  id: string
  action: string
  description: string | null
  user: { id: string; fullName: string } | null
  changes: Record<string, { from: unknown; to: unknown }> | null
  reason: string | null
  createdAt: string
}

interface HistoryPage {
  items: HistoryEntry[]
  total: number
  page: number
  pageSize: number
}

const PAGE_SIZE = 20

function sentence(text: string): string {
  const words = text.replace(/[._]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()

  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—'
}

function show(value: unknown, format?: (value: unknown) => string | null): string {
  const formatted = format?.(value)

  if (formatted) return formatted
  if (value === null || value === undefined || value === '') return '—'

  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
}

interface RecordHistoryProps {
  /** For example "/clients/10/history". */
  path: string
  queryKey: readonly unknown[]
  /** Labels for actions ("client.updated" -> "Client updated"); others are spelled out. */
  actionLabels?: Record<string, string>
  /** Labels for changed fields; others are spelled out. */
  fieldLabels?: Record<string, string>
  /** Formats a changed value in the page's own words, or returns null for the default. */
  formatValue?: (field: string, value: unknown) => string | null
  /** Empty-state title. */
  emptyTitle?: string
}

export function RecordHistory({ path, queryKey, actionLabels = {}, fieldLabels = {}, formatValue, emptyTitle = 'No history recorded yet' }: RecordHistoryProps) {
  const [page, setPage] = useState(1)
  const history = useQuery({ queryKey: [...queryKey, page], queryFn: () => api.get<HistoryPage>(`${path}?page=${page}&pageSize=${PAGE_SIZE}`) })

  if (history.isPending) return <Spinner size="sm" label="Loading history" />
  if (history.isError) return <LoadError error={history.error} onRetry={() => void history.refetch()} />
  if (history.data.items.length === 0) return <EmptyState title={emptyTitle} />

  const data = history.data

  return (
    <>
      <ol className="relative py-2 before:absolute before:bottom-4 before:left-[1.65rem] before:top-4 before:w-px before:bg-slate-200" aria-label="History, newest first">
        {data.items.map((entry) => {
          const changes = entry.changes ? Object.entries(entry.changes) : []

          return (
            <li key={entry.id} className="relative py-3 pl-14 pr-6">
              <span className="absolute left-[1.15rem] top-[1.15rem] h-3.5 w-3.5 rounded-full bg-[#1479BD] ring-4 ring-sky-100" aria-hidden="true" />
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm font-bold text-[#0b3b66]">{actionLabels[entry.action] ?? sentence(entry.action)}</p>
                <p className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600">
                  <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                  {' · '}
                  {entry.user ? entry.user.fullName : 'System'}
                </p>
              </div>
              {entry.description && <p className="mt-1 text-sm text-slate-700">{entry.description}</p>}
              {changes.length > 0 && (
                <ul className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-sm text-slate-600" aria-label="Changed fields">
                  {changes.map(([field, change]) => (
                    <li key={field}>
                      <span className="font-medium text-slate-700">{fieldLabels[field] ?? sentence(field)}:</span>{' '}
                      {show(change?.from, (value) => formatValue?.(field, value) ?? null)} → {show(change?.to, (value) => formatValue?.(field, value) ?? null)}
                    </li>
                  ))}
                </ul>
              )}
              {entry.reason && (
                <p className="mt-1 text-sm text-slate-600">
                  <span className="font-medium text-slate-700">Reason:</span> {entry.reason}
                </p>
              )}
            </li>
          )
        })}
      </ol>
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
    </>
  )
}
