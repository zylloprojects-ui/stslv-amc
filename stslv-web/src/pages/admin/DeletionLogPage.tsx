import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/context'
import { isSuperAdmin } from '../../auth/roles'
import { ExportButtons } from '../../components/ExportButtons'
import { LoadError, Pager } from '../../components/records'
import { TABLE } from '../../components/table'
import { Alert, Card, EmptyState, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter, FilterPanel } from '../amc/components'
import { IconTile, type IconName } from '../dashboard/icons'
import { ColumnsMenu } from '../clients/ColumnsMenu'
import { useHiddenColumns } from './useHiddenColumns'
import { actionLabel, fieldLabel } from './auditTypes'
import { RecycleBin } from './RecycleBin'
import { addCalendarDays, businessDateOf } from '../../lib/businessDate'

type CurrentStatus = 'LIVE' | 'INACTIVE' | 'CANCELLED' | 'ARCHIVED' | 'IN_RECYCLE_BIN' | 'PERMANENTLY_DELETED'

interface DeletionEntry {
  id: string
  kind: 'DELETED' | 'VOIDED' | 'DEACTIVATED' | 'RESTORED'
  /** For DELETED: moved to the Recycle Bin, or removed for good. */
  deletion: 'RECYCLE_BIN' | 'PERMANENT' | null
  /** The record's status now, for the record types that have one. */
  currentStatus: CurrentStatus | null
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
const COLUMN_IDS = ['type', 'record', 'status', 'user', 'details'] as const
const COLUMNS: { key: (typeof COLUMN_IDS)[number]; label: string }[] = [
  { key: 'type', label: 'Record type' },
  { key: 'record', label: 'Record no.' },
  { key: 'status', label: 'Status now' },
  { key: 'user', label: 'User' },
  { key: 'details', label: 'Details' },
]
const KIND = {
  DELETED: { label: 'Deleted', tone: 'bg-red-100 text-red-800 ring-red-200', dot: 'bg-red-500', edge: '#ef4444', row: 'hover:bg-red-50/60', filter: 'kind-filter-deleted' },
  VOIDED: { label: 'Cancelled', tone: 'bg-amber-100 text-amber-900 ring-amber-200', dot: 'bg-amber-500', edge: '#f59e0b', row: 'hover:bg-amber-50/60', filter: 'kind-filter-voided' },
  DEACTIVATED: { label: 'Deactivated', tone: 'bg-slate-200 text-slate-800 ring-slate-300', dot: 'bg-slate-500', edge: '#64748b', row: 'hover:bg-slate-100/70', filter: 'kind-filter-deactivated' },
  RESTORED: { label: 'Restored', tone: 'bg-emerald-100 text-emerald-900 ring-emerald-200', dot: 'bg-emerald-500', edge: '#10b981', row: 'hover:bg-emerald-50/60', filter: 'kind-filter-restored' },
}

/** "To Recycle Bin" or "Deleted permanently" for a deletion; the kind's own label otherwise. */
function kindLabel(entry: DeletionEntry): string {
  if (entry.kind === 'DELETED' && entry.deletion === 'RECYCLE_BIN') return 'To Recycle Bin'
  if (entry.kind === 'DELETED' && entry.deletion === 'PERMANENT') return 'Deleted permanently'
  if (entry.kind === 'RESTORED') return entry.action.endsWith('.restored') ? 'Restored' : 'Reactivated'

  return KIND[entry.kind].label
}

const STATUS: Record<CurrentStatus, { label: string; tone: string }> = {
  LIVE: { label: 'Active', tone: 'border-emerald-200 bg-emerald-50 text-emerald-900' },
  INACTIVE: { label: 'Inactive', tone: 'border-slate-300 bg-slate-100 text-slate-700' },
  CANCELLED: { label: 'Cancelled', tone: 'border-amber-200 bg-amber-50 text-amber-900' },
  ARCHIVED: { label: 'Archived', tone: 'border-slate-300 bg-slate-100 text-slate-700' },
  IN_RECYCLE_BIN: { label: 'In Recycle Bin', tone: 'border-red-200 bg-red-50 text-red-800' },
  PERMANENTLY_DELETED: { label: 'Permanently deleted', tone: 'border-slate-400 bg-white text-slate-800' },
}

function Stat({ label, value, icon, from, to, children }: { label: string; value: string; icon: IconName; from: string; to: string; children?: ReactNode }) {
  return (
    <div className="relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-slate-200 bg-white px-3.5 py-3 shadow-sm transition-shadow hover:shadow-md">
      <span className="absolute inset-y-0 left-0 w-1" style={{ backgroundImage: `linear-gradient(180deg, ${from}, ${to})` }} aria-hidden="true" />
      <IconTile icon={icon} from={from} to={to} className="ml-1 h-9 w-9 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase leading-snug tracking-[0.12em] text-slate-500">{label}</p>
        <p className="text-lg font-extrabold leading-tight tabular-nums text-[#0b3b66]">{value}</p>
        {children}
      </div>
    </div>
  )
}

// Oman calendar days, the same days the API filters by (Asia/Muscat).
const isoDay = (date: Date) => businessDateOf(date)

type View = 'bin' | 'history'

/**
 * Two views (approved 2026-11-04, docs/RECYCLE_BIN.md):
 *   * Recycle Bin (Super Admin): the AMC contracts, clients, system types and sales engineers deleted now,
 *     read from their current state, with Restore and, for records never used, Delete permanently.
 *   * Deletion History (administrators): every deletion, cancellation, deactivation and their reversal,
 *     read from the activity log, newest first, with each record's status now. Nothing in it is removed.
 * The address and API keep the former Deletion Log names, so saved links, permissions and existing audit
 * entries stay valid.
 */
export function DeletionLogPage() {
  const auth = useAuth()
  const superAdmin = isSuperAdmin(auth.user)
  const [params, setParams] = useSearchParams()
  const view: View = superAdmin && params.get('view') !== 'history' ? 'bin' : 'history'
  const showView = (next: View) => setParams(next === 'bin' ? {} : { view: 'history' }, { replace: true })

  return (
    <>
      <PageHeader
        title="Recycle Bin"
        description={
          superAdmin
            ? 'Records deleted now, which you can restore, and the history of every deletion, cancellation, deactivation and restore.'
            : 'The history of every deletion, cancellation, deactivation and restore: what, by whom and when. Only Super Admin can open the Recycle Bin itself.'
        }
      />
      {superAdmin && (
        <div role="tablist" aria-label="Recycle Bin views" className="mb-4 flex gap-1 border-b border-slate-200">
          {(
            [
              ['bin', 'Recycle Bin'],
              ['history', 'Deletion History'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={view === value}
              onClick={() => showView(value)}
              className={cx(
                '-mb-px rounded-t-lg border border-b-0 px-4 py-2 text-sm font-semibold',
                view === value ? 'border-slate-200 bg-white text-[#0b3b66]' : 'border-transparent text-slate-600 hover:text-[#0b3b66]',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {view === 'bin' ? <RecycleBinView /> : <DeletionHistory />}
    </>
  )
}

function RecycleBinView() {
  return (
    <>
      <div role="note" className="mb-4 flex gap-3 rounded-xl border border-l-4 border-sky-200 border-l-[#1479BD] bg-sky-50 px-4 py-3 text-sm text-slate-800">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#1479BD] text-xs font-bold text-white" aria-hidden="true">i</span>
        <div>
          <p className="font-semibold">Only records deleted now are here.</p>
          <p className="mt-1 text-xs leading-relaxed">
            A record in the Recycle Bin is kept in full and can be restored with the same number and links. A client, system type or sales engineer that was never used can also be deleted
            permanently. AMC contracts are never deleted permanently. Deactivated records are not here: they stay on their own pages, where they can be switched back on. Every event stays in the
            Deletion History and the Audit Log.
          </p>
        </div>
      </div>
      <RecycleBin />
    </>
  )
}

function DeletionHistory() {
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

  const rangeFrom = (days: number) => {
    const today = isoDay(new Date())
    setFrom(addCalendarDays(today, -days))
    setTo(today)
    setPage(1)
  }
  const onPage = (type: DeletionEntry['kind']) => (data?.items ?? []).filter((entry) => entry.kind === type).length

  const resetFilters = () => {
    setSearchInput('')
    setSearch('')
    setKind('')
    setEntityType('')
    setUserId('')
    setFrom('')
    setTo('')
    setPage(1)
  }
  const chosen = kind in KIND ? KIND[kind as keyof typeof KIND] : null

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-slate-600">
          Every deletion, cancellation, deactivation and restore, newest first. It is history: an entry stays after the record is restored or reactivated, and its status now is shown beside it. The
          Audit Log holds every other change.
        </p>
        <ExportButtons what="Deletion History" fileStem="deletion-history" path={(format) => `/security/deletions/export${queryString({ search, kind, entityType, userId, from, to, format })}`} onError={setExportError} />
      </div>
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <dl className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Entries" value={String(data?.total ?? '—')} icon="invoice" from="#1479BD" to="#4aa3df">
          <p className="text-[11px] text-slate-500">{filtered ? 'Matching your filters' : 'Recorded in total'}</p>
        </Stat>
        <Stat label="Deleted" value={String(onPage('DELETED'))} icon="project" from="#DC2626" to="#F87171">
          <p className="text-[11px] text-slate-500">On this page</p>
        </Stat>
        <Stat label="Cancelled or voided" value={String(onPage('VOIDED'))} icon="execution" from="#EA580C" to="#FBBF24">
          <p className="text-[11px] text-slate-500">On this page</p>
        </Stat>
        <Stat label="Deactivated" value={String(onPage('DEACTIVATED'))} icon="shield" from="#64748B" to="#94A3B8">
          <p className="text-[11px] text-slate-500">On this page</p>
        </Stat>
        <Stat label="Restored or reactivated" value={String(onPage('RESTORED'))} icon="shield" from="#059669" to="#34D399">
          <p className="text-[11px] text-slate-500">On this page</p>
        </Stat>
      </dl>
      <Card className="overflow-hidden rounded-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50/70 px-5 py-2.5 text-xs">
          <span className="font-bold uppercase tracking-[0.12em] text-slate-500">Quick range</span>
          {[
            ['Today', 0],
            ['Last 7 days', 7],
            ['Last 30 days', 30],
          ].map(([label, days]) => (
            <button key={label} type="button" onClick={() => rangeFrom(days as number)} className="rounded-full border border-slate-300 bg-white px-3 py-1 font-semibold text-slate-700 shadow-sm hover:border-[#1479BD] hover:text-[#0b3b66]">
              {label}
            </button>
          ))}
          <span className="ml-auto hidden items-center gap-3 font-semibold text-slate-500 md:flex" aria-hidden="true">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" />Deleted</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" />Cancelled</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-500" />Deactivated</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Restored</span>
          </span>
        </div>
        <FilterPanel id="deletion-log">
<div className="grid gap-4 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3 xl:grid-cols-6">
          <Filter label="Search">
            {(id, className) => <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Details, user or record no." className={className} />}
          </Filter>
          <Filter label="Action" className={chosen?.filter}>
            {(id, className) => (
              <select id={id} value={kind} onChange={change(setKind)} className={className}>
                <option value="">All actions</option>
                <option value="DELETED" style={{ color: '#b91c1c', backgroundColor: '#fee2e2', fontWeight: 700 }}>Deleted</option>
                <option value="VOIDED" style={{ color: '#b45309', backgroundColor: '#fef3c7', fontWeight: 700 }}>Cancelled or voided</option>
                <option value="DEACTIVATED" style={{ color: '#334155', backgroundColor: '#e2e8f0', fontWeight: 700 }}>Deactivated</option>
                <option value="RESTORED" style={{ color: '#065f46', backgroundColor: '#d1fae5', fontWeight: 700 }}>Restored or reactivated</option>
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
</FilterPanel>

        {rangeInvalid && <p className="px-5 py-4 text-sm text-red-700">The From date is after the To date.</p>}
        {!rangeInvalid && log.isPending && <Spinner label="Loading Deletion History" />}
        {log.isError && <LoadError error={log.error} onRetry={() => void log.refetch()} />}
        {data && data.items.length === 0 && <EmptyState title={filtered ? 'No entries match your filters' : 'No removals recorded yet'} description={filtered ? 'Try a different filter or date range.' : undefined} />}
        {data && data.items.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-5 py-3">
              <p className="text-sm text-slate-600" aria-live="polite">
                <span className="font-bold text-[#0b3b66]">{data.total}</span> {data.total === 1 ? 'entry' : 'entries'}
                {chosen ? ` · ${chosen.label.toLowerCase()} only` : ''}
                {filtered ? ' match your filters' : ' recorded'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {filtered && (
                  <button type="button" onClick={resetFilters} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm hover:border-[#1479BD] hover:text-[#0b3b66]">
                    Reset filters
                  </button>
                )}
                <ColumnsMenu options={COLUMNS} hidden={hidden} onChange={setHidden} />
              </div>
            </div>
            <div className={TABLE.wrapper}>
              <table className={TABLE.table}>
                <caption className="sr-only">Deletion History</caption>
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
                  {data.items.map((entry) => {
                    const kind = KIND[entry.kind]
                    const who = entry.user ?? 'System'

                    return (
                      <tr key={entry.id} className={cx(TABLE.row, kind.row)}>
                        <td className={cx(TABLE.td, 'whitespace-nowrap')} style={{ boxShadow: `inset 5px 0 0 ${kind.edge}` }}>
                          <time dateTime={entry.createdAt} className="pl-1 text-[13px] font-semibold text-slate-800">
                            {formatDateTime(entry.createdAt)}
                          </time>
                        </td>
                        <td className={TABLE.td}>
                          <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-bold uppercase tracking-wide ring-1 ring-inset', kind.tone)}>
                            <span className={cx('h-2 w-2 rounded-full', kind.dot)} aria-hidden="true" />
                            {kindLabel(entry)}
                          </span>
                          <div className="mt-1.5 text-xs text-slate-500">{actionLabel(entry.action)}</div>
                        </td>
                        {show('type') && (
                          <td className={TABLE.td}>
                            <span className="inline-flex whitespace-nowrap rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-[#0b3b66]">{fieldLabel(entry.entityType)}</span>
                          </td>
                        )}
                        {show('record') && (
                          <td className={cx(TABLE.td, 'whitespace-nowrap')}>
                            {entry.entityId ? <span className="inline-flex rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-bold text-slate-700 ring-1 ring-inset ring-slate-200">{entry.entityId}</span> : '—'}
                          </td>
                        )}
                        {show('status') && (
                          <td className={cx(TABLE.td, 'whitespace-nowrap')}>
                            {entry.currentStatus ? (
                              <span className={cx('inline-flex rounded-md border px-2 py-0.5 text-xs font-semibold', STATUS[entry.currentStatus].tone)}>{STATUS[entry.currentStatus].label}</span>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                        )}
                        {show('user') && (
                          <td className={cx(TABLE.td, 'whitespace-nowrap')}>
                            <span className="inline-flex items-center gap-2">
                              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-[#0b3b66] to-[#1479BD] text-[10px] font-bold text-white" aria-hidden="true">
                                {entry.user ? who.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') : 'SY'}
                              </span>
                              {who}
                            </span>
                          </td>
                        )}
                        {show('details') && (
                          <td className={cx(TABLE.td, TABLE.text)}>
                            <span className="text-slate-800">{entry.description}</span>
                            {entry.reason && <div className="mt-1.5 rounded-md border-l-4 border-amber-400 bg-amber-50 px-2.5 py-1 text-xs text-amber-900">Reason: {entry.reason}</div>}
                          </td>
                        )}
                      </tr>
                    )
                  })}
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
