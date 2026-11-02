import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Card, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { api, ApiError } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter, FilterPanel } from '../amc/components'
import { IconTile, type IconName } from '../dashboard/icons'
import { SuggestionStatusBadge } from './SuggestionStatusBadge'
import {
  CATEGORIES,
  CATEGORY_LABELS,
  STATUSES,
  STATUS_LABELS,
  SUGGESTIONS_QUERY_KEY,
  type ReviewList,
  type ReviewOptions,
  userOptionLabel,
  type SuggestionStatus,
} from './suggestionTypes'

const PAGE_SIZE = 25

const COUNT_TILES: { status: SuggestionStatus; icon: IconName; from: string; to: string; text: string; tint: string }[] = [
  { status: 'SUBMITTED', icon: 'invoice', from: '#0284C7', to: '#38BDF8', text: 'text-sky-800', tint: 'bg-sky-50' },
  { status: 'REOPENED', icon: 'execution', from: '#E11D48', to: '#FB7185', text: 'text-rose-800', tint: 'bg-rose-100' },
  { status: 'UNDER_REVIEW', icon: 'shield', from: '#7C3AED', to: '#A78BFA', text: 'text-violet-800', tint: 'bg-sky-50' },
  { status: 'IN_PROGRESS', icon: 'pulse', from: '#EA580C', to: '#FBBF24', text: 'text-amber-800', tint: 'bg-amber-50' },
  { status: 'RESOLVED', icon: 'contract', from: '#059669', to: '#34D399', text: 'text-green-800', tint: 'bg-emerald-50' },
  { status: 'CLOSED', icon: 'settings', from: '#64748B', to: '#94A3B8', text: 'text-slate-700', tint: 'bg-slate-100' },
]

/** Every suggestion, for reviewers (the Admin role): filter, open, respond, change status. */
export function SuggestionReviewPage() {
  // The tab lives in the URL (?view=all), so a link back from a resolved or closed suggestion opens All, where it still shows.
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'all' ? 'ALL' : 'OPEN'
  const setView = (next: 'OPEN' | 'ALL') => setParams(next === 'ALL' ? { view: 'all' } : {}, { replace: true })
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [submittedBy, setSubmittedBy] = useState('')
  const [assignedTo, setAssignedTo] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const options = useQuery({ queryKey: [...SUGGESTIONS_QUERY_KEY, 'review', 'options'], queryFn: () => api.get<ReviewOptions>('/suggestions/review/options') })
  const rangeInvalid = from !== '' && to !== '' && from > to
  const filters = { view, status, category, submittedBy, assignedTo, from, to, search, page }
  const list = useQuery({
    queryKey: [...SUGGESTIONS_QUERY_KEY, 'review', filters],
    queryFn: () => api.get<ReviewList>(`/suggestions/review${queryString({ ...filters, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: !rangeInvalid,
  })
  const unavailable = list.error instanceof ApiError && list.error.code === 'FEATURE_UNAVAILABLE'
  const data = list.data
  const filtered = [status, category, submittedBy, assignedTo, from, to, search].some((value) => value !== '')
  const change = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value)
    setPage(1)
  }
  const showStatus = (next: SuggestionStatus) => {
    setView('ALL')
    setStatus(next)
    setPage(1)
  }

  return (
    <>
      <PageHeader title="Suggestions Review" description="Suggestions, feedback and issues from every user. Open ones first; nothing is ever deleted." />

      {data && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6" aria-label="Suggestions by status">
          {COUNT_TILES.map((tile) => {
            const active = status === tile.status

            return (
              <button
                key={tile.status}
                type="button"
                onClick={() => showStatus(tile.status)}
                aria-pressed={active}
                className={cx(
                  'group relative flex min-w-0 items-center gap-3 overflow-hidden rounded-2xl border-[1.5px] px-3.5 py-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1479BD]',
                  active ? `border-[#1479BD] ring-2 ring-[#1479BD]/25 ${tile.tint}` : 'border-slate-200 bg-white hover:border-[#1479BD]/60',
                )}
              >
                <span className="absolute inset-x-0 top-0 h-1" style={{ backgroundImage: `linear-gradient(90deg, ${tile.from}, ${tile.to})` }} aria-hidden="true" />
                <IconTile icon={tile.icon} from={tile.from} to={tile.to} className="h-10 w-10 shrink-0 rounded-xl" />
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-[10px] font-bold uppercase tracking-[0.12em]', tile.text)}>{STATUS_LABELS[tile.status]}</span>
                  <span className="block text-2xl font-extrabold leading-tight tabular-nums text-slate-900">{data.counts[tile.status]}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}

      <Card>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 px-4 pt-4 sm:px-5" role="group" aria-label="Show">
          {(['OPEN', 'ALL'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value && status === ''}
              onClick={() => {
                setView(value)
                setStatus('')
                setPage(1)
              }}
              className={cx(
                '-mb-px border-b-2 px-3 pb-2 text-sm font-semibold',
                view === value && status === '' ? 'border-[#1479BD] text-[#0f62a3]' : 'border-transparent text-slate-500 hover:text-slate-800',
              )}
            >
              {value === 'OPEN' ? 'Open' : 'All'}
            </button>
          ))}
        </div>
        <FilterPanel id="suggestions-review">
<div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          <Filter label="Search">
            {(id, className) => (
              <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Subject or reference" className={className} />
            )}
          </Filter>
          <Filter label="Status">
            {(id, className) => (
              <select id={id} value={status} onChange={change(setStatus)} className={className}>
                <option value="">{view === 'OPEN' ? 'All open statuses' : 'All statuses'}</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Type">
            {(id, className) => (
              <select id={id} value={category} onChange={change(setCategory)} className={className}>
                <option value="">All types</option>
                {CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Submitted by">
            {(id, className) => (
              <select id={id} value={submittedBy} onChange={change(setSubmittedBy)} className={className}>
                <option value="">Everyone</option>
                {(options.data?.submitters ?? []).map((user, _, users) => (
                  <option key={user.id} value={user.id}>
                    {userOptionLabel(user, users)}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Assigned to">
            {(id, className) => (
              <select id={id} value={assignedTo} onChange={change(setAssignedTo)} className={className}>
                <option value="">Anyone</option>
                <option value="none">Not assigned</option>
                {(options.data?.reviewers ?? []).map((user, _, users) => (
                  <option key={user.id} value={user.id}>
                    {userOptionLabel(user, users)}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Submitted from">{(id, className) => <input id={id} type="date" value={from} onChange={change(setFrom)} className={className} />}</Filter>
          <Filter label="Submitted to">{(id, className) => <input id={id} type="date" value={to} onChange={change(setTo)} className={className} />}</Filter>
        </div>
</FilterPanel>

        {rangeInvalid && <p className="px-5 py-4 text-sm text-red-700">The From date is after the To date.</p>}
        {!rangeInvalid && list.isPending && <Spinner label="Loading suggestions" />}
        {unavailable && (
          <div className="p-5">
            <Alert tone="info">Suggestions need a database update that has not been applied to this database yet (migration 0085).</Alert>
          </div>
        )}
        {list.isError && !unavailable && <LoadError error={list.error} onRetry={() => void list.refetch()} />}
        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No suggestions match your filters' : view === 'OPEN' ? 'No open suggestions' : 'No suggestions yet'}
            description={filtered ? 'Try a different filter or date range.' : view === 'OPEN' ? 'Everything submitted has been resolved or closed.' : undefined}
          />
        )}
        {data && data.items.length > 0 && (
          <>
            <TableScroll label="Suggestions">
              <table className={TABLE.table}>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>Reference</th>
                    <th scope="col" className={TABLE.th}>Subject</th>
                    <th scope="col" className={TABLE.th}>Type</th>
                    <th scope="col" className={TABLE.th}>Status</th>
                    <th scope="col" className={TABLE.th}>Submitted by</th>
                    <th scope="col" className={TABLE.th}>Submitted</th>
                    <th scope="col" className={TABLE.th}>Assigned to</th>
                    <th scope="col" className={TABLE.th}>Last change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((item) => (
                    <tr key={item.id} className={TABLE.row}>
                      <td className={cx(TABLE.td, 'whitespace-nowrap font-semibold')}>
                        <Link to={`/suggestions/${item.id}`} className="text-[#0f62a3] hover:underline">
                          {item.reference}
                        </Link>
                      </td>
                      <td className={cx(TABLE.td, TABLE.text)}>{item.subject}</td>
                      <td className={cx(TABLE.td, 'whitespace-nowrap')}>{CATEGORY_LABELS[item.category]}</td>
                      <td className={TABLE.td}>
                        <SuggestionStatusBadge status={item.status} />
                      </td>
                      <td className={cx(TABLE.td, TABLE.text)}>{item.submittedBy.fullName}</td>
                      <td className={cx(TABLE.td, 'whitespace-nowrap')}>{formatDateTime(item.createdAt)}</td>
                      <td className={cx(TABLE.td, TABLE.text)}>{item.assignedTo ? item.assignedTo.fullName : <span className="text-slate-400">—</span>}</td>
                      <td className={cx(TABLE.td, 'whitespace-nowrap')}>{formatDateTime(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  )
}
