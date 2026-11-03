import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/context'
import { isAdmin } from '../../auth/roles'
import { ExportButtons } from '../../components/ExportButtons'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter, FilterPanel } from '../amc/components'
import { ColumnsMenu } from '../clients/ColumnsMenu'
import { useHiddenColumns } from './useHiddenColumns'
import { FAILURE_REASON_LABELS, type LoginList } from './auditTypes'

const PAGE_SIZE = 25
const COLUMN_IDS = ['user', 'outcome', 'ip', 'userAgent'] as const
const COLUMNS: { key: (typeof COLUMN_IDS)[number]; label: string }[] = [
  { key: 'user', label: 'User' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'ip', label: 'Network address' },
  { key: 'userAgent', label: 'Browser / device' },
]

/** Successful and failed sign-ins, newest first. Read-only. */
export function LoginHistoryPage() {
  const auth = useAuth()
  const [hidden, setHidden] = useHiddenColumns('sign-in-history', auth.user?.id ?? '', COLUMN_IDS)
  const show = (key: (typeof COLUMN_IDS)[number]) => !hidden.has(key)
  const [exportError, setExportError] = useState<string | null>(null)
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
      <PageHeader
        title="Login History"
        description="Every sign-in to the application, successful or not, newest first."
        actions={isAdmin(auth.user) ? <ExportButtons what="Login History" fileStem="sign-in-history" path={(format) => `/audit/logins/export${queryString({ search, outcome, from, to, format })}`} onError={setExportError} /> : undefined}
      />
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <Card>
        <FilterPanel id="sign-in-history">
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
</FilterPanel>

        {rangeInvalid && <p className="px-5 py-4 text-sm text-red-700">The From date is after the To date.</p>}
        {!rangeInvalid && logins.isPending && <Spinner label="Loading sign-ins" />}
        {logins.isError && <LoadError error={logins.error} onRetry={() => void logins.refetch()} />}
        {data && data.items.length === 0 && (
          <EmptyState title={filtered ? 'No sign-ins match your filters' : 'No sign-ins recorded yet'} description={filtered ? 'Try a different search or date range.' : undefined} />
        )}
        {data && data.items.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-3">
              <p className="text-sm text-slate-600" aria-live="polite">
                {data.total} sign-in{data.total === 1 ? '' : 's'}, {data.failedTotal} failed.
              </p>
              <div className="ml-auto">
                <ColumnsMenu options={COLUMNS} hidden={hidden} onChange={setHidden} />
              </div>
            </div>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Sign-ins</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TABLE.th}>
                      Date and time
                    </th>
                    {COLUMNS.filter((column) => show(column.key)).map((column) => (
                      <th key={column.key} scope="col" className={TABLE.th}>
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((login) => (
                    <tr key={login.id}>
                      <td className={`${TABLE.td} whitespace-nowrap`}>{formatDateTime(login.createdAt)}</td>
                      {show('user') && <td className={TABLE.td}>
                        {login.user ? (
                          <>
                            <span className="block font-medium text-slate-900">{login.user.fullName}</span>
                            <span className="block text-xs text-slate-500">{login.user.email}</span>
                          </>
                        ) : (
                          <span className="text-slate-500">No account (email not recorded)</span>
                        )}
                      </td>}
                      {show('outcome') && <td className={TABLE.td}>
                        {login.outcome === 'SUCCESS' ? (
                          <Badge tone="green">Successful</Badge>
                        ) : (
                          <span className="flex flex-wrap items-center gap-2">
                            <Badge tone="amber">Failed</Badge>
                            {login.reason && <span className="text-xs text-slate-600">{FAILURE_REASON_LABELS[login.reason] ?? login.reason}</span>}
                          </span>
                        )}
                      </td>}
                      {show('ip') && <td className={`${TABLE.td} whitespace-nowrap font-mono text-xs`}>{login.ip ?? '—'}</td>}
                      {show('userAgent') && <td className={`${TABLE.td} ${TABLE.unbroken} text-xs`}>{login.userAgent ?? ''}</td>}
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
