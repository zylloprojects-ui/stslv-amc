import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { ColumnsMenu } from '../clients/ColumnsMenu'
import { useHiddenColumns } from './useHiddenColumns'
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
const COLUMN_IDS = ['type', 'record', 'user', 'details'] as const
const COLUMNS: { key: (typeof COLUMN_IDS)[number]; label: string }[] = [
  { key: 'type', label: 'Record type' },
  { key: 'record', label: 'Record no.' },
  { key: 'user', label: 'User' },
  { key: 'details', label: 'Details' },
]
const KIND = { DELETED: { label: 'Deleted', tone: 'bg-red-100 text-red-800 ring-red-200' }, VOIDED: { label: 'Cancelled', tone: 'bg-amber-100 text-amber-900 ring-amber-200' }, DEACTIVATED: { label: 'Deactivated', tone: 'bg-slate-200 text-slate-800 ring-slate-300' } }

/**
 * Recycle Bin: the removals recorded in the activity log, newest first. Read-only; administrators only.
 * History only: nothing is held here to recover (see docs/RECYCLE_BIN.md). Its address and API keep the
 * former Deletion Log names, so saved links, permissions and existing audit entries stay valid.
 */
export function DeletionLogPage() {
  const auth = useAuth()
  const [hidden, setHidden] = useHiddenColumns('deletion-log', auth.user?.id ?? '', COLUMN_IDS)
  const show = (key: (typeof COLUMN_IDS)[number]) => !hidden.has(key)
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
        title="Recycle Bin"
        description="History of records that were deleted, cancelled, voided or deactivated: what, by whom and when. The Audit Log holds every other change."
        actions={<ExportButtons what="Recycle Bin" fileStem="recycle-bin" path={(format) => `/security/deletions/export${queryString({ search, kind, entityType, userId, from, to, format })}`} onError={setExportError} />}
      />
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      <div role="note" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-semibold">History only. Records cannot be recovered from this page.</p>
        <p className="mt-1">
          Deleted records no longer exist. Cancelled contracts and deactivated clients, master records and users stay on their own pages, where they can be switched back on. Cancelled invoices and voided expenses stay as records; a cancelled invoice's number can be entered again.
        </p>
      </div>
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
        {!rangeInvalid && log.isPending && <Spinner label="Loading Recycle Bin" />}
        {log.isError && <LoadError error={log.error} onRetry={() => void log.refetch()} />}
        {data && data.items.length === 0 && <EmptyState title={filtered ? 'No entries match your filters' : 'No removals recorded yet'} description={filtered ? 'Try a different filter or date range.' : undefined} />}
        {data && data.items.length > 0 && (
          <>
            <div className="flex justify-end border-b border-slate-100 px-5 py-2">
              <ColumnsMenu options={COLUMNS} hidden={hidden} onChange={setHidden} />
            </div>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Recycle Bin</caption>
                <thead>
                  <tr>
                    {['When', 'Action', ...COLUMNS.filter((column) => show(column.key)).map((column) => column.label)].map((heading) => (
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
                      {show('type') && <td className={TABLE.td}>{fieldLabel(entry.entityType)}</td>}
                      {show('record') && <td className={cx(TABLE.td, 'whitespace-nowrap font-mono text-sm')}>{entry.entityId ?? '—'}</td>}
                      {show('user') && <td className={TABLE.td}>{entry.user ?? 'System'}</td>}
                      {show('details') && (
                        <td className={cx(TABLE.td, TABLE.text)}>
                          {entry.description}
                          {entry.reason && <div className="mt-1 text-xs text-slate-600">Reason: {entry.reason}</div>}
                        </td>
                      )}
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
