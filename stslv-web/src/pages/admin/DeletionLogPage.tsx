import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ExportButtons } from '../../components/ExportButtons'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { actionLabel, fieldLabel } from './auditTypes'

interface DeletionEntry {
  id: string
  kind: 'DELETED' | 'VOIDED' | 'DEACTIVATED'
  action: string
  entityType: string
  entityId: string | null
  description: string | null
  reason: string | null
  user: string | null
  createdAt: string
}

interface DeletionList {
  items: DeletionEntry[]
  total: number
  page: number
  pageSize: number
  options: { entityTypes: string[]; users: { id: string; fullName: string }[] }
}

const PAGE_SIZE = 25
const KIND = { DELETED: { label: 'Deleted', tone: 'bg-red-100 text-red-800 ring-red-200' }, VOIDED: { label: 'Cancelled', tone: 'bg-amber-100 text-amber-900 ring-amber-200' }, DEACTIVATED: { label: 'Deactivated', tone: 'bg-slate-200 text-slate-800 ring-slate-300' } }

/** Removals recorded in the activity log, newest first. Read-only; administrators only. */
export function DeletionLogPage() {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [entityType, setEntityType] = useState('')
  const [userId, setUserId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)

    return () => clearTimeout(timer)
  }, [searchInput])

  const rangeInvalid = from !== '' && to !== '' && from > to
  const log = useQuery({
    queryKey: ['security', 'deletions', { search, kind, entityType, userId, from, to, page }],
    queryFn: () => api.get<DeletionList>(`/security/deletions${queryString({ search, kind, entityType, userId, from, to, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: !rangeInvalid,
  })
  const data = log.data
  const filtered = [search, kind, entityType, userId, from, to].some((value) => value !== '')
  const change = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value)
    setPage(1)
  }

  return (
    <>
      <PageHeader
        title="Deletion Log"
        description="Records that were deleted, cancelled, voided or deactivated: what, by whom and when. The Audit Log holds every other change."
        actions={<ExportButtons what="Deletion Log" fileStem="deletion-log" path={(format) => `/security/deletions/export${queryString({ search, kind, entityType, userId, from, to, format })}`} onError={setExportError} />}
      />
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3 xl:grid-cols-6">
          <Filter label="Search">
            {(id, className) => <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Details, user or record no." className={className} />}
          </Filter>
          <Filter label="Action">
            {(id, className) => (
              <select id={id} value={kind} onChange={change(setKind)} className={className}>
                <option value="">All actions</option>
                <option value="DELETED">Deleted</option>
                <option value="VOIDED">Cancelled or voided</option>
                <option value="DEACTIVATED">Deactivated</option>
              </select>
            )}
          </Filter>
          <Filter label="Record type">
            {(id, className) => (
              <select id={id} value={entityType} onChange={change(setEntityType)} className={className}>
                <option value="">All record types</option>
                {(data?.options.entityTypes ?? []).map((value) => (
                  <option key={value} value={value}>
                    {fieldLabel(value)}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="User">
            {(id, className) => (
              <select id={id} value={userId} onChange={change(setUserId)} className={className}>
                <option value="">All users</option>
                {(data?.options.users ?? []).map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.fullName}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="From">{(id, className) => <input id={id} type="date" value={from} onChange={change(setFrom)} className={className} />}</Filter>
          <Filter label="To">{(id, className) => <input id={id} type="date" value={to} onChange={change(setTo)} className={className} />}</Filter>
        </div>

        {rangeInvalid && <p className="px-5 py-4 text-sm text-red-700">The From date is after the To date.</p>}
        {!rangeInvalid && log.isPending && <Spinner label="Loading deletion log" />}
        {log.isError && <LoadError error={log.error} onRetry={() => void log.refetch()} />}
        {data && data.items.length === 0 && <EmptyState title={filtered ? 'No entries match your filters' : 'Nothing has been deleted yet'} description={filtered ? 'Try a different filter or date range.' : undefined} />}
        {data && data.items.length > 0 && (
          <>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Deletion Log</caption>
                <thead>
                  <tr>
                    {['When', 'Action', 'Record type', 'Record no.', 'User', 'Details'].map((heading) => (
                      <th key={heading} scope="col" className={TABLE.th}>
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((entry) => (
                    <tr key={entry.id} className={TABLE.row}>
                      <td className={cx(TABLE.td, 'whitespace-nowrap')}>
                        <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
                      </td>
                      <td className={TABLE.td}>
                        <span className={cx('inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', KIND[entry.kind].tone)}>{KIND[entry.kind].label}</span>
                        <div className="mt-1 text-xs text-slate-500">{actionLabel(entry.action)}</div>
                      </td>
                      <td className={TABLE.td}>{fieldLabel(entry.entityType)}</td>
                      <td className={cx(TABLE.td, 'whitespace-nowrap font-mono text-sm')}>{entry.entityId ?? '—'}</td>
                      <td className={TABLE.td}>{entry.user ?? 'System'}</td>
                      <td className={cx(TABLE.td, TABLE.text)}>
                        {entry.description}
                        {entry.reason && <div className="mt-1 text-xs text-slate-600">Reason: {entry.reason}</div>}
                      </td>
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
