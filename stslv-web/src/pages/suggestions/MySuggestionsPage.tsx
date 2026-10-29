import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Button, Card, EmptyState, PageHeader, Spinner, TableScroll } from '../../components/ui'
import { SuggestionFormModal } from '../../layout/FeedbackWidget'
import { api, ApiError } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { SuggestionStatusBadge } from './SuggestionStatusBadge'
import { CATEGORIES, CATEGORY_LABELS, STATUSES, STATUS_LABELS, SUGGESTIONS_QUERY_KEY, type SuggestionList, type SuggestionSummary } from './suggestionTypes'

const PAGE_SIZE = 20

/** The signed-in user's own suggestions, newest first, with their review status. */
export function MySuggestionsPage() {
  const [status, setStatus] = useState('')
  const [category, setCategory] = useState('')
  const [page, setPage] = useState(1)
  const [creating, setCreating] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const list = useQuery({
    queryKey: [...SUGGESTIONS_QUERY_KEY, 'mine', { status, category, search, page }],
    queryFn: () => api.get<SuggestionList>(`/suggestions/mine${queryString({ status, category, search, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
  })
  const unavailable = list.error instanceof ApiError && list.error.code === 'FEATURE_UNAVAILABLE'
  const data = list.data
  const filtered = [status, category, search].some((value) => value !== '')
  const change = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value)
    setPage(1)
  }

  return (
    <>
      <PageHeader
        title="My Suggestions"
        description="Suggestions, feedback and issues you have submitted, with their review status and responses."
        actions={<Button onClick={() => setCreating(true)}>New Suggestion</Button>}
      />

      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-3 sm:px-5">
          <Filter label="Search">
            {(id, className) => (
              <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Subject or reference" className={className} />
            )}
          </Filter>
          <Filter label="Status">
            {(id, className) => (
              <select id={id} value={status} onChange={change(setStatus)} className={className}>
                <option value="">All statuses</option>
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
        </div>

        {list.isPending && <Spinner label="Loading your suggestions" />}
        {unavailable && (
          <div className="p-5">
            <Alert tone="info">Suggestions need a database update that has not been applied to this database yet (migration 0085).</Alert>
          </div>
        )}
        {list.isError && !unavailable && <LoadError error={list.error} onRetry={() => void list.refetch()} />}
        {data && data.items.length === 0 && (
          <EmptyState
            title={filtered ? 'No suggestions match your filters' : 'You have not submitted any suggestions yet'}
            description={filtered ? 'Try a different filter.' : 'Use New Suggestion, or the light-bulb button in the header on any page.'}
          />
        )}
        {data && data.items.length > 0 && <SuggestionTable items={data.items} />}
        {data && data.items.length > 0 && <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />}
      </Card>

      {creating && <SuggestionFormModal onClose={() => setCreating(false)} />}
    </>
  )
}

/** The submitter's table. Each row opens the suggestion. */
function SuggestionTable({ items }: { items: SuggestionSummary[] }) {
  return (
    <TableScroll label="My suggestions">
      <table className={TABLE.table}>
        <thead>
          <tr>
            <th scope="col" className={TABLE.th}>Reference</th>
            <th scope="col" className={TABLE.th}>Subject</th>
            <th scope="col" className={TABLE.th}>Type</th>
            <th scope="col" className={TABLE.th}>Status</th>
            <th scope="col" className={TABLE.th}>Submitted</th>
            <th scope="col" className={TABLE.th}>Last response</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => (
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
              <td className={cx(TABLE.td, 'whitespace-nowrap')}>{formatDateTime(item.createdAt)}</td>
              <td className={cx(TABLE.td, 'whitespace-nowrap')}>{item.lastResponseAt ? formatDateTime(item.lastResponseAt) : <span className="text-slate-400">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  )
}
