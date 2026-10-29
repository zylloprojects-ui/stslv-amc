import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { LoadError, Pager } from '../../components/records'
import { Card, EmptyState, OptionsNotice, PageHeader, Spinner } from '../../components/ui'
import { api } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { queryString } from '../amc/amcApi'
import { Filter } from '../amc/components'
import { actionLabel, changeValue, fieldLabel, moduleLabel, type ActivityList, type ActivityOptions, type ActivityRecord } from './auditTypes'

const PAGE_SIZE = 25

function ActivityEntry({ entry }: { entry: ActivityRecord }) {
  const changes = entry.changes ? Object.entries(entry.changes) : []

  return (
    <li className="px-5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold text-slate-900">
          {actionLabel(entry.action)}
          <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">{moduleLabel(entry.module)}</span>
        </p>
        <p className="text-xs text-slate-500">
          <time dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
          {' · '}
          {entry.user ? entry.user.fullName : 'System'}
        </p>
      </div>
      {entry.description && <p className="mt-1 text-sm text-slate-700">{entry.description}</p>}
      <p className="mt-1 text-xs text-slate-500">
        Record: {fieldLabel(entry.entityType)}
        {entry.entityId ? ` #${entry.entityId}` : ''}
      </p>
      {changes.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm text-slate-600" aria-label="Changed fields">
          {changes.map(([field, change]) => (
            <li key={field}>
              <span className="font-medium text-slate-700">{fieldLabel(field)}:</span> {changeValue(change?.from)} → {changeValue(change?.to)}
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
}

/** The activity recorded by every module, newest first. Read-only; for the Admin role. */
export function AuditLogPage() {
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

  return (
    <>
      <PageHeader title="Audit Log" description="What was changed, by whom and when, across every module. Newest first." />

      <Card>
        <div className="grid gap-4 border-b border-slate-200 p-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3 xl:grid-cols-6">
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

        {rangeInvalid && <p className="px-5 py-4 text-sm text-red-700">The From date is after the To date.</p>}
        {!rangeInvalid && activity.isPending && <Spinner label="Loading activity" />}
        {activity.isError && <LoadError error={activity.error} onRetry={() => void activity.refetch()} />}
        {data && data.items.length === 0 && (
          <EmptyState title={filtered ? 'No activity matches your filters' : 'No activity recorded yet'} description={filtered ? 'Try a different filter or date range.' : undefined} />
        )}
        {data && data.items.length > 0 && (
          <>
            <ol className="divide-y divide-slate-100" aria-label="Activity, newest first">
              {data.items.map((entry) => (
                <ActivityEntry key={entry.id} entry={entry} />
              ))}
            </ol>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} shown={data.items.length} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  )
}
