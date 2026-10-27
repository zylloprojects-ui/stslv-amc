import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { FAILURE_REASON_LABELS, type LoginList } from './auditTypes'

const PAGE_SIZE = 25

/** Successful and failed sign-ins, newest first. Read-only. */
export function LoginHistoryPage() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const rangeInvalid = from !== '' && to !== '' && from > to
  const logins = useQuery({
    queryKey: ['audit', 'logins', { search, outcome, from, to, page }],
    queryFn: () => api.get<LoginList>(`/audit/logins${queryString({ search, outcome, from, to, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: !rangeInvalid,
  })
  const data = logins.data
  const filtered = search !== '' || outcome !== '' || from !== '' || to !== ''

  return (
    <>
      <PageHeader title="Login History" description="Every sign-in to the application, successful or not, newest first." />

      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
          <Filter label="Search">
            {(id, className) => (
              <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Name, email or address" className={className} />
            )}
          </Filter>
          <Filter label="Outcome">
            {(id, className) => (
              <select
                id={id}
                value={outcome}
                onChange={(event) => {
                  setOutcome(event.target.value)
                  setPage(1)
                }}
                className={className}
              >
                <option value="">All sign-ins</option>
                <option value="SUCCESS">Successful</option>
                <option value="FAILED">Failed</option>
              </select>
            )}
          </Filter>
          <Filter label="From">
            {(id, className) => (
              <input
                id={id}
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value)
                  setPage(1)
                }}
                className={className}
              />
            )}
          </Filter>
          <Filter label="To">
            {(id, className) => (
              <input
                id={id}
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value)
                  setPage(1)
                }}
                className={className}
              />
            )}
          </Filter>
        </div>

        {rangeInvalid && <p className="px-5 py-4 text-sm text-red-700">The From date is after the To date.</p>}
        {!rangeInvalid && logins.isPending && <Spinner label="Loading sign-ins" />}
        {logins.isError && <LoadError error={logins.error} onRetry={() => void logins.refetch()} />}
        {data && data.items.length === 0 && (
          <EmptyState title={filtered ? 'No sign-ins match your filters' : 'No sign-ins recorded yet'} description={filtered ? 'Try a different search or date range.' : undefined} />
        )}
        {data && data.items.length > 0 && (
          <>
            <p className="px-5 pt-3 text-sm text-slate-600" aria-live="polite">
              {data.total} sign-in{data.total === 1 ? '' : 's'}, {data.failedTotal} failed.
            </p>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Sign-ins</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      Date and time
                    </th>
                    <th scope="col" className={TABLE.th}>
                      User
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Outcome
                    </th>
                    <th scope="col" className={TABLE.th}>
                      Network address
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((login) => (
                    <tr key={login.id}>
                      <td className={`${TABLE.td} whitespace-nowrap`}>{formatDateTime(login.createdAt)}</td>
                      <td className={TABLE.td}>
                        {login.user ? (
                          <>
                            <span className="block font-medium text-slate-900">{login.user.fullName}</span>
                            <span className="block text-xs text-slate-500">{login.user.email}</span>
                          </>
                        ) : (
                          <span className="text-slate-500">No account (email not recorded)</span>
                        )}
                      </td>
                      <td className={TABLE.td}>
                        {login.outcome === 'SUCCESS' ? (
                          <Badge tone="green">Successful</Badge>
                        ) : (
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone="amber">Failed</Badge>
                            {login.reason && <span className="text-xs text-slate-600">{FAILURE_REASON_LABELS[login.reason] ?? login.reason}</span>}
                          </span>
                        )}
                      </td>
                      <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs`}>{login.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  )
}
