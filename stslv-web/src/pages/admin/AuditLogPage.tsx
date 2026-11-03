import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from '../../auth/context'
import { ExportButtons } from '../../components/ExportButtons'
import { LoadError, Pager } from '../../components/records'
import { Alert, Card, EmptyState, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { cx, formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter, FilterPanel } from '../amc/components'
import { IconTile, type IconName } from '../dashboard/icons'
import { ColumnsMenu } from '../clients/ColumnsMenu'
import { useHiddenColumns } from './useHiddenColumns'
import { actionLabel, changeValue, fieldLabel, moduleLabel, type ActivityList, type ActivityOptions, type ActivityRecord } from './auditTypes'

const PAGE_SIZE = 25
// The log is a list, not a table, so its "columns" are the parts of each entry. The action, time and description always show.
const COLUMN_IDS = ['module', 'user', 'record', 'changes', 'reason', 'ip'] as const
type ColumnId = (typeof COLUMN_IDS)[number]
const COLUMNS: { key: ColumnId; label: string }[] = [
  { key: 'module', label: 'Module' },
  { key: 'user', label: 'User' },
  { key: 'record', label: 'Record' },
  { key: 'changes', label: 'Changes' },
  { key: 'reason', label: 'Reason' },
  { key: 'ip', label: 'Network address' },
]

type Tone = { dot: string; label: string }

// The kind of change an action records, read from its code ("amc_contract.update").
function toneOf(action: string): Tone {
  const verb = action.toLowerCase()

  if (/(delete|remove|cancel|deactivat|disable|reject|revoke|fail|lock)/.test(verb)) {
    return { dot: 'bg-red-500', label: 'Removed or blocked' }
  }
  if (/(create|add|approve|activate|enable|restore|import|issue)/.test(verb)) {
    return { dot: 'bg-emerald-500', label: 'Created or enabled' }
  }
  if (/(update|edit|change|reset|renew|assign|complete|record|status|reschedule|postpone)/.test(verb)) {
    return { dot: 'bg-sky-500', label: 'Changed' }
  }

  return { dot: 'bg-slate-400', label: 'Activity' }
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?'

interface Day {
  key: string
  day: string
  month: string
  weekday: string
}

const dayOf = (value: string): Day => {
  const date = new Date(value)

  return {
    key: date.toDateString(),
    day: String(date.getDate()),
    month: date.toLocaleString('en-GB', { month: 'short' }),
    weekday: date.toLocaleString('en-GB', { weekday: 'short', year: 'numeric' }),
  }
}

/** One entry on the timeline. The first entry of a day carries the day's date in the left column. */
function ActivityEntry({ entry, show, day }: { entry: ActivityRecord; show: (key: ColumnId) => boolean; day: Day | null }) {
  const changes = entry.changes ? Object.entries(entry.changes) : []
  const tone = toneOf(entry.action)
  const who = entry.user ? entry.user.fullName : 'System'

  return (
    <li className="group relative flex gap-3 sm:gap-4">
      <div className="hidden w-16 shrink-0 pt-1 text-right sm:block">
        {day && (
          <>
            <p className="text-2xl font-extrabold leading-none tabular-nums text-[#0b3b66]">{day.day}</p>
            <p className="mt-0.5 text-xs font-bold uppercase tracking-wide text-[#1479BD]">{day.month}</p>
            <p className="text-[10px] text-slate-500">{day.weekday}</p>
          </>
        )}
      </div>

      <div className="relative flex w-5 shrink-0 justify-center" aria-hidden="true">
        <span className="absolute inset-y-0 w-px bg-slate-300 group-first:top-3 group-last:bottom-auto group-last:h-4" />
        <span className={cx('relative z-10 mt-3 h-3.5 w-3.5 rounded-full ring-4 ring-white', tone.dot)} />
      </div>

      <div className="mb-3 min-w-0 flex-1 rounded-xl border-[1.5px] border-slate-200 bg-white p-3.5 shadow-sm transition-all group-hover:border-[#1479BD] group-hover:shadow-md">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#0b3b66] to-[#1479BD] text-[11px] font-bold text-white shadow-sm" aria-hidden="true">
              {entry.user ? initials(who) : 'SY'}
            </span>
            <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-bold text-slate-900">
              {actionLabel(entry.action)}
              {show('module') && <span className="rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-[#0b3b66]">{moduleLabel(entry.module)}</span>}
            </p>
          </div>
          <p className="text-xs text-slate-500">
            <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
            {show('user') && ` · ${who}`}
            {show('ip') && entry.ip ? ` · ${entry.ip}` : ''}
          </p>
        </div>
        {entry.description && <p className="mt-2 text-sm text-slate-700">{entry.description}</p>}
        {show('record') && (
          <p className="mt-1.5 text-xs text-slate-500">
            Record: {fieldLabel(entry.entityType)}
            {entry.entityId ? ` #${entry.entityId}` : ''}
          </p>
        )}
        {show('changes') && changes.length > 0 && (
          <ul className="mt-2.5 grid gap-1.5 text-sm text-slate-600 sm:grid-cols-2" aria-label="Changed fields">
            {changes.map(([field, change]) => (
              <li key={field} className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-1.5">
                <span className="font-semibold text-slate-700">{fieldLabel(field)}:</span> <span className="text-slate-500">{changeValue(change?.from)}</span>
                {' → '}
                <span className="font-semibold text-[#0b3b66]">{changeValue(change?.to)}</span>
              </li>
            ))}
          </ul>
        )}
        {show('reason') && entry.reason && (
          <p className="mt-2.5 rounded-lg border-l-4 border-amber-400 bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
            <span className="font-semibold">Reason:</span> {entry.reason}
          </p>
        )}
      </div>
    </li>
  )
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

const isoDay = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

/** The activity recorded by every module, newest first. Read-only; for the Admin role. */
export function AuditLogPage() {
  const auth = useAuth()
  const [hidden, setHidden] = useHiddenColumns('audit-log', auth.user?.id ?? '', COLUMN_IDS)
  const [exportError, setExportError] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [module, setModule] = useState('')
  const [entityType, setEntityType] = useState('')
  const [userId, setUserId] = useState('')
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

  const options = useQuery({ queryKey: ['audit', 'activity', 'options'], queryFn: () => api.get<ActivityOptions>('/audit/activity/options') })
  const rangeInvalid = from !== '' && to !== '' && from > to
  const activity = useQuery({
    queryKey: ['audit', 'activity', { search, module, entityType, userId, from, to, page }],
    queryFn: () => api.get<ActivityList>(`/audit/activity${queryString({ search, module, entityType, userId, from, to, page, pageSize: PAGE_SIZE })}`),
    placeholderData: keepPreviousData,
    enabled: !rangeInvalid,
  })
  const data = activity.data
  const filtered = [search, module, entityType, userId, from, to].some((value) => value !== '')
  const change = (set: (value: string) => void) => (event: { target: { value: string } }) => {
    set(event.target.value)
    setPage(1)
  }

  const rangeFrom = (days: number) => {
    const start = new Date()
    start.setDate(start.getDate() - days)
    setFrom(isoDay(start))
    setTo(isoDay(new Date()))
    setPage(1)
  }
  const today = isoDay(new Date())
  const counts = (data?.items ?? []).reduce(
    (sum, entry) => {
      const label = toneOf(entry.action).label

      return { ...sum, [label]: (sum[label] ?? 0) + 1 }
    },
    {} as Record<string, number>,
  )

  const resetFilters = () => {
    setSearchInput('')
    setSearch('')
    setModule('')
    setEntityType('')
    setUserId('')
    setFrom('')
    setTo('')
    setPage(1)
  }

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="What was changed, by whom and when, across every module. Newest first."
        actions={<ExportButtons what="Audit Log" fileStem="audit-log" path={(format) => `/audit/activity/export${queryString({ search, module, entityType, userId, from, to, format })}`} onError={setExportError} />}
      />
      {exportError && (
        <div className="mb-4">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}

      <dl className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Entries" value={String(data?.total ?? '—')} icon="contract" from="#1479BD" to="#4aa3df">
          <p className="text-[11px] text-slate-500">{filtered ? 'Matching your filters' : 'Recorded in total'}</p>
        </Stat>
        <Stat label="Modules" value={String(options.data?.modules.length ?? '—')} icon="project" from="#7C3AED" to="#A78BFA">
          <p className="text-[11px] text-slate-500">With recorded activity</p>
        </Stat>
        <Stat label="People" value={String(options.data?.users.length ?? '—')} icon="users" from="#059669" to="#34D399">
          <p className="text-[11px] text-slate-500">Who made changes</p>
        </Stat>
        <Stat label="On this page" value={String(data?.items.length ?? '—')} icon="pulse" from="#EA580C" to="#FBBF24">
          <p className="flex flex-wrap gap-x-2 text-[11px] font-semibold">
            <span className="text-emerald-700">{counts['Created or enabled'] ?? 0} created</span>
            <span className="text-sky-700">{counts['Changed'] ?? 0} changed</span>
            <span className="text-red-700">{counts['Removed or blocked'] ?? 0} removed</span>
          </p>
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
          {to === today && from !== '' && <span className="text-slate-500">Showing {from} to {to}</span>}
          <span className="ml-auto hidden items-center gap-3 font-semibold text-slate-500 md:flex" aria-hidden="true">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" />Created</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" />Changed</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" />Removed</span>
          </span>
        </div>
        <FilterPanel id="audit-log">
<div className="grid gap-4 border-b border-slate-200 bg-gradient-to-r from-sky-50 via-white to-white p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3 xl:grid-cols-6">
          <Filter label="Search">
            {(id, className) => (
              <input id={id} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Action or description" className={className} />
            )}
          </Filter>
          <Filter label="Module">
            {(id, className) => (
              <select id={id} value={module} onChange={change(setModule)} className={className}>
                <option value="">All modules</option>
                <OptionsNotice source={options} count={options.data?.modules.length ?? 0} empty="No activity recorded yet" />
                {(options.data?.modules ?? []).map((value) => (
                  <option key={value} value={value}>
                    {moduleLabel(value)}
                  </option>
                ))}
              </select>
            )}
          </Filter>
          <Filter label="Record type">
            {(id, className) => (
              <select id={id} value={entityType} onChange={change(setEntityType)} className={className}>
                <option value="">All record types</option>
                <OptionsNotice source={options} count={options.data?.entityTypes.length ?? 0} empty="No activity recorded yet" />
                {(options.data?.entityTypes ?? []).map((value) => (
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
                <OptionsNotice source={options} count={options.data?.users.length ?? 0} empty="No activity recorded yet" />
                {(options.data?.users ?? []).map((user, _, users) => (
                  <option key={user.id} value={user.id}>
                    {/* Two accounts can share a name: the email tells them apart. */}
                    {users.some((other) => other.id !== user.id && other.fullName === user.fullName) ? `${user.fullName} (${user.email})` : user.fullName}
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
        {!rangeInvalid && activity.isPending && <Spinner label="Loading activity" />}
        {activity.isError && <LoadError error={activity.error} onRetry={() => void activity.refetch()} />}
        {data && data.items.length === 0 && (
          <EmptyState title={filtered ? 'No activity matches your filters' : 'No activity recorded yet'} description={filtered ? 'Try a different filter or date range.' : undefined} />
        )}
        {data && data.items.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-5 py-3">
              <p className="text-sm text-slate-600" aria-live="polite">
                <span className="font-bold text-[#0b3b66]">{data.total}</span> {data.total === 1 ? 'entry' : 'entries'}
                {filtered ? ' match your filters' : ' recorded'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {filtered && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 shadow-sm hover:border-[#1479BD] hover:text-[#0b3b66]"
                  >
                    Reset filters
                  </button>
                )}
                <ColumnsMenu options={COLUMNS} hidden={hidden} onChange={setHidden} />
              </div>
            </div>
            <ol className="bg-gradient-to-b from-slate-50/60 to-white px-4 py-5 sm:px-6" aria-label="Activity, newest first">
              {data.items.map((entry, index) => {
                const day = dayOf(entry.createdAt)
                const previous = index > 0 ? dayOf(data.items[index - 1]!.createdAt) : null

                return <ActivityEntry key={entry.id} entry={entry} show={(key) => !hidden.has(key)} day={previous && previous.key === day.key ? null : day} />
              })}
            </ol>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  )
}
